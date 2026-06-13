#pragma once
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <ctime>
#include <optional>
#include <stdexcept>
#include <string>
#include <nlohmann/json.hpp>

namespace dex {

// ── Fixed-point decimal scales ─────────────────────────────────────────────
// All prices/sizes stored as int64 to avoid floating-point comparison errors.
// Daml Decimal convention: prices 8 dp, sizes 6 dp.

static constexpr int64_t PRICE_SCALE = 100'000'000LL; // 1e8
static constexpr int64_t SIZE_SCALE  =   1'000'000LL; // 1e6

inline int64_t parseScaled(const std::string& s, int64_t scale, int dp) {
    if (s.empty()) throw std::invalid_argument("empty decimal string");
    auto dot = s.find('.');
    std::string ipart = (dot == std::string::npos) ? s : s.substr(0, dot);
    std::string fpart = (dot == std::string::npos) ? "" : s.substr(dot + 1);
    if (static_cast<int>(fpart.size()) > dp) fpart = fpart.substr(0, dp);
    while (static_cast<int>(fpart.size()) < dp) fpart.push_back('0');
    return std::stoll(ipart) * scale + std::stoll(fpart);
}

inline int64_t parsePrice(const std::string& s) { return parseScaled(s, PRICE_SCALE, 8); }
inline int64_t parseSize (const std::string& s) { return parseScaled(s, SIZE_SCALE,  6); }

inline std::string fmtPrice(int64_t v) {
    char buf[64];
    std::snprintf(buf, sizeof(buf), "%lld.%08lld",
                  (long long)(v / PRICE_SCALE), (long long)(v % PRICE_SCALE));
    return buf;
}
inline std::string fmtSize(int64_t v) {
    char buf[64];
    std::snprintf(buf, sizeof(buf), "%lld.%06lld",
                  (long long)(v / SIZE_SCALE), (long long)(v % SIZE_SCALE));
    return buf;
}

// ── Domain types ───────────────────────────────────────────────────────────

enum class Side { Long, Short };

inline Side parseSide(const nlohmann::json& j) {
    if (j.contains("Long"))  return Side::Long;
    if (j.contains("Short")) return Side::Short;
    throw std::invalid_argument("unknown Side variant: " + j.dump());
}

struct Order {
    std::string              contractId;
    std::string              trader;
    Side                     side;
    int64_t                  priceScaled;           // limitPrice * PRICE_SCALE
    int64_t                  sizeScaled;            // size        * SIZE_SCALE
    std::string              collateralAllocationCid;
    std::string              timeInForce;           // "GTC"|"IOC"|"FOK"
    std::optional<std::string> expiresAt;           // nullopt = no deadline
    std::string              createdAt;             // ISO8601 (for logs)
    int64_t                  createdAtMs;           // ms since epoch — FIFO sort key
};

// A matchable cross found by OrderBook::findCross().
struct Cross {
    Order   longOrder;
    Order   shortOrder;
    int64_t fillSizeScaled;        // min(long.sizeScaled, short.sizeScaled)
    int64_t executionPriceScaled;  // maker's priceScaled
    Side    makerSide;             // Long if long placed first
};

// ── Engine configuration ───────────────────────────────────────────────────

struct EngineConfig {
    std::string ledgerHost;           // "localhost"
    std::string ledgerPort;           // "7575"
    bool        useTls{false};        // true when LEDGER_BASE_URL starts with "https://"
    std::string jwtToken;             // optional; set from LEDGER_JWT_TOKEN for DevNet
    std::string venueParty;
    std::string userId;
    std::string orderTemplateId;      // "perp-dex:PerpDex:Order"
    std::string matchOrdersChoice;    // "MatchOrders"
    int         submitTimeoutSecs{10};
    int         maxRetryAttempts{3};
};

// ── ISO8601 → milliseconds since epoch (POSIX: timegm) ────────────────────
// Handles "YYYY-MM-DDTHH:MM:SS[.sss]Z" as used by the Canton Ledger API.
inline int64_t parseIso8601Ms(const std::string& s) {
    struct tm tm{};
    std::string t = s;
    if (!t.empty() && t.back() == 'Z') t.pop_back();

    std::string frac;
    auto dot = t.find('.');
    if (dot != std::string::npos) {
        frac = t.substr(dot + 1);
        t    = t.substr(0, dot);
    }

    if (!strptime(t.c_str(), "%Y-%m-%dT%H:%M:%S", &tm))
        throw std::invalid_argument("cannot parse ISO8601: " + s);

    int64_t ms = static_cast<int64_t>(timegm(&tm)) * 1000;
    if (!frac.empty()) {
        while (frac.size() < 3) frac.push_back('0');
        frac = frac.substr(0, 3);
        ms  += std::stoll(frac);
    }
    return ms;
}

// ── Parse a CreatedEvent JSON into an Order ────────────────────────────────
inline Order parseOrder(const std::string& cid, const nlohmann::json& args) {
    Order o;
    o.contractId              = cid;
    o.trader                  = args.at("trader").get<std::string>();
    o.side                    = parseSide(args.at("side"));
    o.priceScaled             = parsePrice(args.at("limitPrice").get<std::string>());
    o.sizeScaled              = parseSize (args.at("size").get<std::string>());
    o.collateralAllocationCid = args.at("collateralAllocationCid").get<std::string>();

    const auto& tif = args.at("timeInForce");
    if      (tif.contains("GTC")) o.timeInForce = "GTC";
    else if (tif.contains("IOC")) o.timeInForce = "IOC";
    else                          o.timeInForce = "FOK";

    const auto& exp = args.at("expiresAt");
    if (!exp.is_null()) o.expiresAt = exp.get<std::string>();

    o.createdAt   = args.at("createdAt").get<std::string>();
    o.createdAtMs = parseIso8601Ms(o.createdAt);

    if (o.priceScaled <= 0) throw std::invalid_argument("non-positive limitPrice");
    if (o.sizeScaled  <= 0) throw std::invalid_argument("non-positive size");
    return o;
}

} // namespace dex
