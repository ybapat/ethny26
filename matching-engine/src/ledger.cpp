#include "ledger.hpp"

#include <boost/asio/connect.hpp>
#include <boost/asio/ip/tcp.hpp>
#include <boost/asio/ssl.hpp>
#include <boost/beast/core.hpp>
#include <boost/beast/http.hpp>
#include <boost/beast/ssl.hpp>
#include <boost/beast/websocket.hpp>
#include <boost/beast/websocket/ssl.hpp>

#include <iostream>
#include <sstream>

namespace beast = boost::beast;
namespace http  = beast::http;
namespace ws    = beast::websocket;
namespace net   = boost::asio;
namespace ssl   = net::ssl;
using     tcp   = net::ip::tcp;

namespace dex {

// ── Error detection ────────────────────────────────────────────────────────

static LedgerErrorCode detectCode(const std::string& body, int httpStatus) {
    if (body.find("CONTRACT_NOT_FOUND") != std::string::npos ||
        body.find("NOT_FOUND")          != std::string::npos) {
        return LedgerErrorCode::ContractNotFound;
    }
    if (body.find("DUPLICATE_COMMAND") != std::string::npos || httpStatus == 409) {
        return LedgerErrorCode::DuplicateCommand;
    }
    return LedgerErrorCode::Unknown;
}

// ── Offset: Canton may return int or string depending on version ───────────
// Some Canton 3.5.x builds switched the offset field to a string.
static int64_t parseOffset(const nlohmann::json& j) {
    if (j.is_number_integer()) return j.get<int64_t>();
    if (j.is_string())         return std::stoll(j.get<std::string>());
    throw std::runtime_error("unexpected offset type: " + j.dump());
}

// ── Constructor ────────────────────────────────────────────────────────────

LedgerClient::LedgerClient(const EngineConfig& cfg)
    : host_(cfg.ledgerHost), port_(cfg.ledgerPort),
      useTls_(cfg.useTls), jwtToken_(cfg.jwtToken),
      orderTemplateId_(cfg.orderTemplateId),
      venueParty_(cfg.venueParty), userId_(cfg.userId),
      timeoutSecs_(cfg.submitTimeoutSecs) {}

// ── Auth header ────────────────────────────────────────────────────────────

template<typename Body, typename Fields>
void LedgerClient::addAuthHeader(http::request<Body, Fields>& req) const {
    if (!jwtToken_.empty())
        req.set(http::field::authorization, "Bearer " + jwtToken_);
}

// ── HTTP helpers (HTTP and HTTPS via template) ─────────────────────────────

// Execute `fn(stream)` with a freshly-connected plain-TCP or TLS stream.
// Separating connection logic from request/response logic avoids duplicating
// the http::write + http::read + error-check sequence for both schemes.
template<typename Fn>
void LedgerClient::withStream(Fn fn) const {
    net::io_context ioc;
    tcp::resolver   resolver{ioc};
    auto            resolved = resolver.resolve(host_, port_);
    auto            timeout  = std::chrono::seconds(timeoutSecs_);

    if (useTls_) {
        ssl::context sslCtx{ssl::context::tlsv12_client};
        sslCtx.set_default_verify_paths();
        beast::ssl_stream<beast::tcp_stream> stream{ioc, sslCtx};
        // SNI — required by most TLS servers.
        SSL_set_tlsext_host_name(stream.native_handle(), host_.c_str());
        beast::get_lowest_layer(stream).expires_after(timeout);
        beast::get_lowest_layer(stream).connect(resolved);
        stream.handshake(ssl::stream_base::client);
        fn(stream);
    } else {
        beast::tcp_stream stream{ioc};
        stream.expires_after(timeout);
        stream.connect(resolved);
        fn(stream);
    }
}

nlohmann::json LedgerClient::httpGet(const std::string& path) const {
    nlohmann::json result;
    withStream([&](auto& stream) {
        http::request<http::empty_body> req{http::verb::get, path, 11};
        req.set(http::field::host,   host_);
        req.set(http::field::accept, "application/json");
        addAuthHeader(req);
        http::write(stream, req);

        beast::flat_buffer buf;
        http::response<http::string_body> res;
        http::read(stream, buf, res);

        if (res.result_int() / 100 != 2)
            throw LedgerError(
                "GET " + path + " → HTTP " + std::to_string(res.result_int()) + ": " + res.body(),
                detectCode(res.body(), res.result_int()), res.result_int());
        result = nlohmann::json::parse(res.body());
    });
    return result;
}

nlohmann::json LedgerClient::httpPost(const std::string& path,
                                      const nlohmann::json& body) const {
    nlohmann::json result;
    withStream([&](auto& stream) {
        std::string bodyStr = body.dump();
        http::request<http::string_body> req{http::verb::post, path, 11};
        req.set(http::field::host,         host_);
        req.set(http::field::content_type, "application/json");
        req.set(http::field::accept,       "application/json");
        addAuthHeader(req);
        req.body() = bodyStr;
        req.prepare_payload();
        http::write(stream, req);

        beast::flat_buffer buf;
        http::response<http::string_body> res;
        http::read(stream, buf, res);

        if (res.result_int() / 100 != 2)
            throw LedgerError(
                "POST " + path + " → HTTP " + std::to_string(res.result_int()) + ": " + res.body(),
                detectCode(res.body(), res.result_int()), res.result_int());
        result = nlohmann::json::parse(res.body());
    });
    return result;
}

// ── Public API ─────────────────────────────────────────────────────────────

nlohmann::json LedgerClient::submitAndWait(const nlohmann::json& body) {
    return httpPost("/v2/commands/submit-and-wait", body);
}

int64_t LedgerClient::getLedgerEnd() {
    auto res = httpGet("/v2/state/ledger-end");
    return parseOffset(res.at("offset"));
}

std::vector<nlohmann::json> LedgerClient::getActiveOrders(int64_t activeAtOffset) {
    nlohmann::json reqBody = {
        {"activeAtOffset", activeAtOffset},
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

    // getActiveOrders needs a raw response body (may be NDJSON stream), so
    // use withStream directly rather than httpPost.
    std::string rawBody;
    withStream([&](auto& stream) {
        std::string bodyStr = reqBody.dump();
        http::request<http::string_body> req{http::verb::post,
                                             "/v2/state/active-contracts", 11};
        req.set(http::field::host,         host_);
        req.set(http::field::content_type, "application/json");
        req.set(http::field::accept,       "application/json");
        addAuthHeader(req);
        req.body() = bodyStr;
        req.prepare_payload();
        http::write(stream, req);

        beast::flat_buffer buf;
        http::response<http::string_body> res;
        http::read(stream, buf, res);

        if (res.result_int() / 100 != 2)
            throw LedgerError(
                "POST /v2/state/active-contracts → HTTP " + std::to_string(res.result_int()),
                detectCode(res.body(), res.result_int()), res.result_int());
        rawBody = res.body();
    });

    std::vector<nlohmann::json> contracts;

    // Try single-object response: { "activeContracts": [...] }
    try {
        auto j = nlohmann::json::parse(rawBody);
        if (j.contains("activeContracts") && j["activeContracts"].is_array()) {
            for (const auto& c : j["activeContracts"]) contracts.push_back(c);
            return contracts;
        }
    } catch (...) {}

    // Fall back to newline-delimited JSON stream.
    std::istringstream ss(rawBody);
    for (std::string line; std::getline(ss, line);) {
        if (line.empty()) continue;
        try {
            auto j = nlohmann::json::parse(line);
            if      (j.contains("created"))    contracts.push_back(j["created"]);
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
    auto            resolved = resolver.resolve(host_, port_);

    // Build subscription frame — sent as the first WS message after handshake.
    // readAs scopes delivery to contracts where the venue is a stakeholder
    // (venue is signatory on every Order, so it sees the full book).
    nlohmann::json subFrame = {
        {"beginExclusive", beginExclusive},
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
    std::string subJson = subFrame.dump();

    if (useTls_) {
        ssl::context sslCtx{ssl::context::tlsv12_client};
        sslCtx.set_default_verify_paths();
        ws::stream<beast::ssl_stream<beast::tcp_stream>> wsStream{ioc, sslCtx};
        SSL_set_tlsext_host_name(
            wsStream.next_layer().native_handle(), host_.c_str());
        beast::get_lowest_layer(wsStream).connect(resolved);
        wsStream.next_layer().handshake(ssl::stream_base::client);
        wsStream.handshake(host_, "/v2/updates");
        wsStream.write(net::buffer(subJson));
        std::cout << "[ledger] WSS subscribed from offset " << beginExclusive << "\n";
        while (true) {
            beast::flat_buffer buf;
            wsStream.read(buf);
            std::string text = beast::buffers_to_string(buf.data());
            if (text.empty()) continue;
            try { onFrame(nlohmann::json::parse(text)); }
            catch (const std::exception& e) {
                std::cerr << "[ledger] skip unparseable WS frame: " << e.what() << "\n";
            }
        }
    } else {
        tcp::socket sock{ioc};
        net::connect(sock, resolved);
        ws::stream<tcp::socket> wsStream{std::move(sock)};
        wsStream.handshake(host_, "/v2/updates");
        wsStream.write(net::buffer(subJson));
        std::cout << "[ledger] WS subscribed from offset " << beginExclusive << "\n";
        while (true) {
            beast::flat_buffer buf;
            wsStream.read(buf);
            std::string text = beast::buffers_to_string(buf.data());
            if (text.empty()) continue;
            try { onFrame(nlohmann::json::parse(text)); }
            catch (const std::exception& e) {
                std::cerr << "[ledger] skip unparseable WS frame: " << e.what() << "\n";
            }
        }
    }
}

} // namespace dex
