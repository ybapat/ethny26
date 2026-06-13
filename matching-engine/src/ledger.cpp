#include "ledger.hpp"

#include <boost/asio/connect.hpp>
#include <boost/asio/ip/tcp.hpp>
#include <boost/beast/core.hpp>
#include <boost/beast/http.hpp>
#include <boost/beast/websocket.hpp>

#include <iostream>
#include <sstream>

namespace beast = boost::beast;
namespace http  = beast::http;
namespace ws    = beast::websocket;
namespace net   = boost::asio;
using     tcp   = net::ip::tcp;

namespace dex {

// ── Error detection ────────────────────────────────────────────────────────

static LedgerErrorCode detectCode(const std::string& body, int httpStatus) {
    if (body.find("CONTRACT_NOT_FOUND") != std::string::npos ||
        body.find("NOT_FOUND")          != std::string::npos) {
        return LedgerErrorCode::ContractNotFound;
    }
    if (body.find("DUPLICATE_COMMAND") != std::string::npos ||
        httpStatus == 409) {
        return LedgerErrorCode::DuplicateCommand;
    }
    return LedgerErrorCode::Unknown;
}

// ── Constructor ────────────────────────────────────────────────────────────

LedgerClient::LedgerClient(const EngineConfig& cfg)
    : host_(cfg.ledgerHost), port_(cfg.ledgerPort),
      orderTemplateId_(cfg.orderTemplateId),
      venueParty_(cfg.venueParty),
      userId_(cfg.userId) {}

// ── Synchronous HTTP helpers ───────────────────────────────────────────────

nlohmann::json LedgerClient::httpGet(const std::string& path) {
    net::io_context ioc;
    tcp::resolver   resolver{ioc};
    beast::tcp_stream stream{ioc};

    stream.connect(resolver.resolve(host_, port_));

    http::request<http::empty_body> req{http::verb::get, path, 11};
    req.set(http::field::host, host_);
    req.set(http::field::accept, "application/json");
    http::write(stream, req);

    beast::flat_buffer buf;
    http::response<http::string_body> res;
    http::read(stream, buf, res);

    if (res.result_int() / 100 != 2) {
        throw LedgerError(
            "GET " + path + " → HTTP " + std::to_string(res.result_int()) + ": " + res.body(),
            detectCode(res.body(), res.result_int()),
            res.result_int());
    }
    return nlohmann::json::parse(res.body());
}

nlohmann::json LedgerClient::httpPost(const std::string& path, const nlohmann::json& body) {
    net::io_context ioc;
    tcp::resolver   resolver{ioc};
    beast::tcp_stream stream{ioc};

    stream.connect(resolver.resolve(host_, port_));

    std::string bodyStr = body.dump();
    http::request<http::string_body> req{http::verb::post, path, 11};
    req.set(http::field::host,         host_);
    req.set(http::field::content_type, "application/json");
    req.set(http::field::accept,       "application/json");
    req.body() = bodyStr;
    req.prepare_payload();
    http::write(stream, req);

    beast::flat_buffer buf;
    http::response<http::string_body> res;
    http::read(stream, buf, res);

    if (res.result_int() / 100 != 2) {
        throw LedgerError(
            "POST " + path + " → HTTP " + std::to_string(res.result_int()) + ": " + res.body(),
            detectCode(res.body(), res.result_int()),
            res.result_int());
    }
    return nlohmann::json::parse(res.body());
}

// ── Public API ─────────────────────────────────────────────────────────────

nlohmann::json LedgerClient::submitAndWait(const nlohmann::json& body) {
    return httpPost("/v2/commands/submit-and-wait", body);
}

int64_t LedgerClient::getLedgerEnd() {
    auto res = httpGet("/v2/state/ledger-end");
    // Response: { "offset": <number> }
    return res.at("offset").get<int64_t>();
}

std::vector<nlohmann::json> LedgerClient::getActiveOrders(int64_t activeAtOffset) {
    // POST /v2/state/active-contracts filtered to the Order template.
    // The endpoint may return a streaming response (newline-delimited JSON) or a
    // single JSON object with an "activeContracts" array — handle both.
    nlohmann::json reqBody = {
        {"activeAtOffset", activeAtOffset},
        // readAs scopes the ACS to contracts visible to the venue party.
        {"readAs",  {venueParty_}},
        {"userId",  userId_},
        {"eventFormat", {
            {"filtersByParty", {
                {venueParty_, {
                    {"cumulative", {{
                        {"identifierFilter", {
                            {"TemplateFilter", {
                                {"value", {
                                    {"templateId",              orderTemplateId_},
                                    {"includeCreatedEventBlob", false}
                                }}
                            }}
                        }}
                    }}}
                }}
            }},
            {"verbose", true}
        }}
    };

    // Perform the POST and get the raw response body.
    net::io_context ioc;
    tcp::resolver   resolver{ioc};
    beast::tcp_stream stream{ioc};
    stream.connect(resolver.resolve(host_, port_));

    std::string bodyStr = reqBody.dump();
    http::request<http::string_body> req{http::verb::post,
                                         "/v2/state/active-contracts", 11};
    req.set(http::field::host,         host_);
    req.set(http::field::content_type, "application/json");
    req.set(http::field::accept,       "application/json");
    req.body() = bodyStr;
    req.prepare_payload();
    http::write(stream, req);

    beast::flat_buffer buf;
    http::response<http::string_body> res;
    http::read(stream, buf, res);

    if (res.result_int() / 100 != 2) {
        throw LedgerError(
            "GET active-contracts → HTTP " + std::to_string(res.result_int()),
            detectCode(res.body(), res.result_int()),
            res.result_int());
    }

    std::vector<nlohmann::json> contracts;
    const std::string& raw = res.body();

    // Try single-object response first: { "activeContracts": [...] }
    try {
        auto j = nlohmann::json::parse(raw);
        if (j.contains("activeContracts") && j["activeContracts"].is_array()) {
            for (const auto& c : j["activeContracts"]) contracts.push_back(c);
            return contracts;
        }
    } catch (...) {}

    // Fall back to newline-delimited JSON stream.
    std::istringstream ss(raw);
    for (std::string line; std::getline(ss, line);) {
        if (line.empty()) continue;
        try {
            auto j = nlohmann::json::parse(line);
            // Each line is either a contract create event or an offset marker.
            if (j.contains("created")) contracts.push_back(j["created"]);
            else if (j.contains("contractId")) contracts.push_back(j);
        } catch (const std::exception& e) {
            std::cerr << "[ledger] skip unparseable ACS line: " << e.what() << "\n";
        }
    }
    return contracts;
}

void LedgerClient::subscribeUpdates(
        int64_t beginExclusive,
        std::function<void(const nlohmann::json&)> onFrame) {

    net::io_context ioc;
    tcp::resolver   resolver{ioc};
    tcp::socket     sock{ioc};
    net::connect(sock, resolver.resolve(host_, port_));

    // Upgrade to WebSocket on /v2/updates
    ws::stream<tcp::socket> wsStream{std::move(sock)};
    wsStream.handshake(host_, "/v2/updates");

    // Send subscription frame (Canton v2 WS: first client message = subscription params).
    // readAs tells the participant which party's view to use — without this, the
    // sandbox returns no events because it doesn't know whose contracts to deliver.
    nlohmann::json subFrame = {
        {"beginExclusive", beginExclusive},
        // readAs: the venue party — Canton will project only events where
        // the venue is a stakeholder, which covers every Order (venue is signatory).
        {"readAs",  {venueParty_}},
        {"userId",  userId_},
        {"updateFormat", {
            {"includeTransactions", {
                {"eventFormat", {
                    {"filtersByParty", {
                        {venueParty_, {
                            {"cumulative", {{
                                {"identifierFilter", {
                                    {"TemplateFilter", {
                                        {"value", {
                                            {"templateId",              orderTemplateId_},
                                            {"includeCreatedEventBlob", false}
                                        }}
                                    }}
                                }}
                            }}}
                        }}
                    }},
                    {"verbose", true}
                }}
            }}
        }}
    };
    wsStream.write(net::buffer(subFrame.dump()));

    std::cout << "[ledger] WS subscribed from offset " << beginExclusive << "\n";

    // Read loop — blocks until error or connection close.
    // Caller catches exceptions and reconnects.
    while (true) {
        beast::flat_buffer buf;
        wsStream.read(buf);  // blocking; throws on close/error

        std::string text = beast::buffers_to_string(buf.data());
        if (text.empty()) continue;
        try {
            onFrame(nlohmann::json::parse(text));
        } catch (const std::exception& e) {
            std::cerr << "[ledger] skip unparseable WS frame: " << e.what() << "\n";
        }
    }
}

} // namespace dex
