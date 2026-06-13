#pragma once
#include "types.hpp"
#include <boost/beast/http.hpp>
#include <functional>
#include <stdexcept>
#include <string>
#include <vector>
#include <nlohmann/json.hpp>

namespace dex {

// ── Error type for Canton Ledger API failures ──────────────────────────────

enum class LedgerErrorCode {
    ContractNotFound,   // gRPC NOT_FOUND / "CONTRACT_NOT_FOUND" — stale CID
    DuplicateCommand,   // idempotent: the command already committed
    Unknown,
};

struct LedgerError : std::runtime_error {
    LedgerError(const std::string& msg, LedgerErrorCode c, int http)
        : std::runtime_error(msg), code(c), httpStatus(http) {}
    LedgerErrorCode code;
    int             httpStatus;
};

// ── Abstract ledger interface (implemented by LedgerClient; mockable in tests)

class ILedgerClient {
public:
    virtual ~ILedgerClient() = default;

    // POST /v2/commands/submit-and-wait — throws LedgerError on failure.
    virtual nlohmann::json submitAndWait(const nlohmann::json& body) = 0;

    // GET  /v2/state/ledger-end — returns the current numeric offset.
    virtual int64_t getLedgerEnd() = 0;

    // POST /v2/state/active-contracts filtered to the Order template.
    // Returns one JSON object per active Order contract (handles pagination).
    virtual std::vector<nlohmann::json> getActiveOrders(int64_t activeAtOffset) = 0;

    // Block on the /v2/updates WebSocket, calling `onFrame` for each JSON frame.
    // Throws on connection loss — caller reconnects from the last seen offset.
    virtual void subscribeUpdates(
        int64_t beginExclusive,
        std::function<void(const nlohmann::json&)> onFrame) = 0;
};

// ── Concrete implementation (Boost.Beast HTTP + WebSocket) ─────────────────
// Defined in ledger.cpp; only included in main.cpp and recovery.cpp.
// Engine and tests depend only on ILedgerClient.

class LedgerClient final : public ILedgerClient {
public:
    explicit LedgerClient(const EngineConfig& cfg);

    nlohmann::json submitAndWait(const nlohmann::json& body) override;
    int64_t        getLedgerEnd() override;
    std::vector<nlohmann::json> getActiveOrders(int64_t activeAtOffset) override;
    void subscribeUpdates(
        int64_t beginExclusive,
        std::function<void(const nlohmann::json&)> onFrame) override;

private:
    template<typename Fn>    void           withStream(Fn fn) const;
    nlohmann::json                          httpGet (const std::string& path) const;
    nlohmann::json                          httpPost(const std::string& path,
                                                     const nlohmann::json& body) const;
    template<typename Body, typename Fields>
    void addAuthHeader(boost::beast::http::request<Body, Fields>& req) const;

    std::string host_;
    std::string port_;
    bool        useTls_;
    std::string jwtToken_;
    std::string orderTemplateId_;
    std::string venueParty_;
    std::string userId_;
    int         timeoutSecs_;
};

} // namespace dex
