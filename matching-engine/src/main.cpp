#include "engine.hpp"
#include "ledger.hpp"
#include "orderbook.hpp"
#include "recovery.hpp"
#include "types.hpp"

#include <atomic>
#include <chrono>
#include <cstdlib>
#include <csignal>
#include <iostream>
#include <stdexcept>
#include <string>
#include <thread>

// ── Global shutdown flag ───────────────────────────────────────────────────

static std::atomic<bool> g_running{true};

static void onSignal(int) {
    g_running.store(false);
    std::cout << "\n[main] shutting down…\n";
}

// ── Config loader ──────────────────────────────────────────────────────────

static std::string requireEnv(const char* key) {
    const char* val = std::getenv(key);
    if (!val || val[0] == '\0')
        throw std::runtime_error(std::string("Missing required env var: ") + key);
    return val;
}

static std::string optEnv(const char* key, const char* def) {
    const char* val = std::getenv(key);
    return (val && val[0] != '\0') ? val : def;
}

// Parse "http://host:port" → (host, port).
static std::pair<std::string, std::string> parseBaseUrl(const std::string& url) {
    // Strip "http://" or "https://"
    std::string rest = url;
    for (auto prefix : {"https://", "http://"}) {
        if (rest.substr(0, std::strlen(prefix)) == prefix)
            rest = rest.substr(std::strlen(prefix));
    }
    // Strip trailing slash or path
    auto slash = rest.find('/');
    if (slash != std::string::npos) rest = rest.substr(0, slash);
    // Split host:port
    auto colon = rest.find(':');
    if (colon == std::string::npos) return {rest, "80"};
    return {rest.substr(0, colon), rest.substr(colon + 1)};
}

static dex::EngineConfig loadConfig() {
    dex::EngineConfig cfg;
    std::string baseUrl = requireEnv("LEDGER_BASE_URL");
    auto [host, port]   = parseBaseUrl(baseUrl);
    cfg.ledgerHost        = host;
    cfg.ledgerPort        = port;
    cfg.useTls            = (baseUrl.substr(0, 8) == "https://");
    cfg.jwtToken          = optEnv("LEDGER_JWT_TOKEN", "");
    cfg.venueParty        = requireEnv("VENUE_PARTY");
    cfg.userId            = requireEnv("USER_ID");
    cfg.orderTemplateId   = requireEnv("ORDER_TEMPLATE_ID");
    cfg.matchOrdersChoice = optEnv("MATCH_ORDERS_CHOICE", "MatchOrders");
    cfg.submitTimeoutSecs = std::stoi(optEnv("SUBMIT_TIMEOUT_MS",  "10000")) / 1000;
    cfg.maxRetryAttempts  = std::stoi(optEnv("MAX_RETRY_ATTEMPTS", "3"));
    return cfg;
}

// ── WS event dispatch ──────────────────────────────────────────────────────

// Process a single /v2/updates frame. Updates `currentOffset` on Transaction
// and OffsetCheckpoint frames. Returns false if the engine should stop.
static bool processFrame(const nlohmann::json& frame,
                         dex::MatchingEngine& engine,
                         const dex::EngineConfig& cfg,
                         int64_t& currentOffset) {
    if (!g_running.load()) return false;

    // OffsetCheckpoint — update our resume point.
    // Helper: Canton may return offset as int64 or as a string ("12345") depending
    // on the Canton version. Handle both.
    auto getOffset = [](const nlohmann::json& j) -> int64_t {
        if (j.is_number_integer()) return j.get<int64_t>();
        if (j.is_string())         return std::stoll(j.get<std::string>());
        return -1;
    };

    if (frame.contains("OffsetCheckpoint")) {
        int64_t off = getOffset(frame["OffsetCheckpoint"]["offset"]);
        if (off >= 0) currentOffset = off;
        return true;
    }

    // Transaction — the only frame type that carries Order events.
    if (!frame.contains("Transaction")) return true;

    const auto& tx = frame["Transaction"];
    if (tx.contains("offset")) {
        int64_t off = getOffset(tx["offset"]);
        if (off >= 0) currentOffset = off;
    }

    if (!tx.contains("events")) return true;

    for (const auto& ev : tx["events"]) {
        if (ev.contains("CreatedEvent")) {
            const auto& ce = ev["CreatedEvent"];
            const std::string tmpl = ce.value("templateId", "");
            if (tmpl == cfg.orderTemplateId) engine.onOrderCreated(ce);
        } else if (ev.contains("ArchivedEvent")) {
            const auto& ae = ev["ArchivedEvent"];
            const std::string tmpl = ae.value("templateId", "");
            if (tmpl == cfg.orderTemplateId) {
                engine.onOrderArchived(ae["contractId"].get<std::string>());
            }
        }
    }
    return true;
}

// ── Main ───────────────────────────────────────────────────────────────────

int main() {
    // Load .env if present — simple "KEY=VALUE" parser.
    if (FILE* f = std::fopen(".env", "r")) {
        char line[512];
        while (std::fgets(line, sizeof(line), f)) {
            std::string s(line);
            while (!s.empty() && (s.back() == '\n' || s.back() == '\r')) s.pop_back();
            if (s.empty() || s[0] == '#') continue;
            auto eq = s.find('=');
            if (eq == std::string::npos) continue;
            std::string key = s.substr(0, eq);
            std::string val = s.substr(eq + 1);
            setenv(key.c_str(), val.c_str(), 0);  // don't overwrite existing env
        }
        std::fclose(f);
    }

    std::signal(SIGINT,  onSignal);
    std::signal(SIGTERM, onSignal);

    dex::EngineConfig cfg;
    try {
        cfg = loadConfig();
    } catch (const std::exception& e) {
        std::cerr << "[main] config error: " << e.what() << "\n";
        return 1;
    }

    std::cout << "[main] venue=" << cfg.venueParty
              << " ledger=" << cfg.ledgerHost << ":" << cfg.ledgerPort
              << " template=" << cfg.orderTemplateId << "\n";

    dex::LedgerClient ledger{cfg};
    dex::OrderBook    book;
    dex::MatchingEngine engine{book, ledger, cfg};

    // ── Crash recovery ────────────────────────────────────────────────────
    int64_t resumeOffset = 0;
    try {
        resumeOffset = dex::buildBookFromACS(ledger, book, cfg);
    } catch (const std::exception& e) {
        std::cerr << "[main] ACS recovery failed: " << e.what()
                  << " — starting from offset 0\n";
        resumeOffset = 0;
    }

    // ── WebSocket event loop with exponential backoff reconnect ──────────
    // Back-off: 1s → 2s → 4s → … capped at 60s. Resets to 1s on success.
    static constexpr int kBackoffInitMs = 1000;
    static constexpr int kBackoffMaxMs  = 60000;
    int     backoffMs     = kBackoffInitMs;
    int64_t currentOffset = resumeOffset;

    while (g_running.load()) {
        try {
            ledger.subscribeUpdates(currentOffset,
                [&](const nlohmann::json& frame) {
                    processFrame(frame, engine, cfg, currentOffset);
                    if (!g_running.load())
                        throw std::runtime_error("shutdown requested");
                });
            // subscribeUpdates returned cleanly (shouldn't happen unless we throw
            // for shutdown above). Reset backoff.
            backoffMs = kBackoffInitMs;
        } catch (const std::exception& e) {
            if (!g_running.load()) break;
            std::cerr << "[main] WS error: " << e.what()
                      << " — reconnecting in " << backoffMs << "ms"
                      << " (offset=" << currentOffset << ")\n";
            std::this_thread::sleep_for(std::chrono::milliseconds(backoffMs));
            backoffMs = std::min(backoffMs * 2, kBackoffMaxMs);
        }
    }

    std::cout << "[main] stopped at offset " << currentOffset << "\n";
    return 0;
}
