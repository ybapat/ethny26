#include "engine.hpp"
#include "orderbook.hpp"
#include "types.hpp"
#include <cassert>
#include <functional>
#include <iostream>
#include <optional>
#include <stdexcept>
#include <vector>

using namespace dex;

// ── Test harness ───────────────────────────────────────────────────────────

static int passed = 0;
static int failed = 0;

#define ASSERT_TRUE(expr) \
    do { \
        if (expr) { ++passed; } \
        else { \
            std::cerr << "FAIL: " #expr " at " __FILE__ ":" << __LINE__ << "\n"; \
            ++failed; \
        } \
    } while (0)

#define ASSERT_EQ(a, b) \
    do { \
        auto _a = (a); auto _b = (b); \
        if (_a == _b) { ++passed; } \
        else { \
            std::cerr << "FAIL: " #a " == " #b \
                      << "  (got " << _a << " != " << _b << ")" \
                      << " at " __FILE__ ":" << __LINE__ << "\n"; \
            ++failed; \
        } \
    } while (0)

// ── Mock ledger ────────────────────────────────────────────────────────────

struct CapturedSubmit {
    std::string contractId;
    std::string choice;
    std::string shortOrderCid;
    std::string fillSize;
    std::string executionPrice;
};

class MockLedger final : public ILedgerClient {
public:
    // Each call to submitAndWait pops the next behaviour from the queue.
    // Default (empty queue) = success.
    struct Behaviour {
        enum class Kind { Success, ContractNotFound, DuplicateCommand, Transient } kind;
    };

    std::vector<Behaviour>      queue;
    std::vector<CapturedSubmit> submits;

    nlohmann::json submitAndWait(const nlohmann::json& body) override {
        // Capture what was submitted
        const auto& cmd = body["commands"][0]["ExerciseCommand"];
        CapturedSubmit s;
        s.contractId     = cmd["contractId"].get<std::string>();
        s.choice         = cmd["choice"].get<std::string>();
        s.shortOrderCid  = cmd["choiceArgument"]["shortOrderCid"].get<std::string>();
        s.fillSize       = cmd["choiceArgument"]["fillSize"].get<std::string>();
        s.executionPrice = cmd["choiceArgument"]["executionPrice"].get<std::string>();
        submits.push_back(s);

        Behaviour beh = queue.empty()
                        ? Behaviour{Behaviour::Kind::Success}
                        : (queue.erase(queue.begin()), queue.empty()
                              ? Behaviour{Behaviour::Kind::Success}
                              : *queue.begin());
        // Actually pop correctly:
        // (Redo: pop from front of queue if non-empty)
        return dispatch(beh);
    }

    int64_t getLedgerEnd() override { return 0; }

    std::vector<nlohmann::json> getActiveOrders(int64_t) override {
        return {};
    }

    void subscribeUpdates(int64_t, std::function<void(const nlohmann::json&)>) override {}

private:
    nlohmann::json dispatch(const Behaviour& b) {
        switch (b.kind) {
        case Behaviour::Kind::Success:
            return {{"updateId", "tx1"}, {"completionOffset", 1}};
        case Behaviour::Kind::ContractNotFound:
            throw LedgerError("CONTRACT_NOT_FOUND", LedgerErrorCode::ContractNotFound, 404);
        case Behaviour::Kind::DuplicateCommand:
            throw LedgerError("DUPLICATE_COMMAND", LedgerErrorCode::DuplicateCommand, 409);
        case Behaviour::Kind::Transient:
            throw LedgerError("SERVICE_UNAVAILABLE", LedgerErrorCode::Unknown, 503);
        }
        return {};
    }
};

// Fix the mock's pop logic — let's rewrite submitAndWait cleanly:
// (The above has a logic bug — let's use a cleaner MockLedger)

class MockLedger2 final : public ILedgerClient {
public:
    using ThrowFn = std::function<void()>;

    std::vector<ThrowFn>        behaviours;  // empty = success
    std::vector<CapturedSubmit> submits;
    size_t callCount = 0;

    nlohmann::json submitAndWait(const nlohmann::json& body) override {
        const auto& cmd = body["commands"][0]["ExerciseCommand"];
        CapturedSubmit s;
        s.contractId     = cmd["contractId"].get<std::string>();
        s.choice         = cmd["choice"].get<std::string>();
        s.shortOrderCid  = cmd["choiceArgument"]["shortOrderCid"].get<std::string>();
        s.fillSize       = cmd["choiceArgument"]["fillSize"].get<std::string>();
        s.executionPrice = cmd["choiceArgument"]["executionPrice"].get<std::string>();
        submits.push_back(s);

        if (callCount < behaviours.size()) {
            auto fn = behaviours[callCount++];
            if (fn) fn();  // throws if behaviour is an error
        } else {
            ++callCount;
        }
        return {{"updateId", "tx" + std::to_string(callCount)}, {"completionOffset", (int)callCount}};
    }

    int64_t getLedgerEnd() override { return 0; }
    std::vector<nlohmann::json> getActiveOrders(int64_t) override { return {}; }
    void subscribeUpdates(int64_t, std::function<void(const nlohmann::json&)>) override {}
};

// ── Test helpers ───────────────────────────────────────────────────────────

static constexpr int64_t P(double p) { return static_cast<int64_t>(p * PRICE_SCALE); }
static constexpr int64_t Sz(double s){ return static_cast<int64_t>(s * SIZE_SCALE);  }

static nlohmann::json makeCreatedEvent(const std::string& cid, const std::string& side,
                                       double price, double size,
                                       int64_t createdAtMs = 1000) {
    (void)createdAtMs;
    return {
        {"contractId",      cid},
        {"templateId",      "perp-dex:PerpDex:Order"},
        {"createArguments", {
            {"trader",                  "Alice::1"},
            {"side",                    {{side, nlohmann::json::object()}}},
            {"size",                    fmtSize(Sz(size))},
            {"limitPrice",              fmtPrice(P(price))},
            {"collateralAllocationCid", "alloc-" + cid},
            {"timeInForce",             {{"GTC", nlohmann::json::object()}}},
            {"expiresAt",               nullptr},
            {"createdAt",               "2026-01-01T00:00:01Z"}
        }}
    };
}

static EngineConfig makeConfig() {
    EngineConfig c;
    c.ledgerHost         = "localhost";
    c.ledgerPort         = "7575";
    c.venueParty         = "Venue::1";
    c.userId             = "venue";
    c.orderTemplateId    = "perp-dex:PerpDex:Order";
    c.matchOrdersChoice  = "MatchOrders";
    c.maxRetryAttempts   = 3;
    return c;
}

// ── Tests ──────────────────────────────────────────────────────────────────

void test_created_event_adds_to_book() {
    OrderBook book;
    MockLedger2 ledger;
    MatchingEngine eng(book, ledger, makeConfig());

    eng.onOrderCreated(makeCreatedEvent("L1", "Long", 200.0, 10.0));
    ASSERT_TRUE(book.hasOrder("L1"));
    ASSERT_EQ(book.snapshot().longCount, (size_t)1);
}

void test_archived_event_removes_from_book() {
    OrderBook book;
    MockLedger2 ledger;
    MatchingEngine eng(book, ledger, makeConfig());

    eng.onOrderCreated(makeCreatedEvent("L1", "Long", 200.0, 10.0));
    eng.onOrderArchived("L1");
    ASSERT_TRUE(!book.hasOrder("L1"));
}

void test_archived_unknown_cid_is_noop() {
    OrderBook book;
    MockLedger2 ledger;
    MatchingEngine eng(book, ledger, makeConfig());
    // Must not throw
    eng.onOrderArchived("ghost-cid");
    ASSERT_TRUE(true);
}

void test_matching_cycle_submits_correct_exercise() {
    OrderBook book;
    MockLedger2 ledger;
    MatchingEngine eng(book, ledger, makeConfig());

    // Short placed first (maker), long placed after (taker) → exec at short's price.
    auto evtShort = makeCreatedEvent("S1", "Short", 200.0, 10.0);
    evtShort["createArguments"]["createdAt"] = "2026-01-01T00:00:01Z";
    auto evtLong  = makeCreatedEvent("L1", "Long",  205.0, 10.0);
    evtLong["createArguments"]["createdAt"]  = "2026-01-01T00:00:02Z";

    eng.onOrderCreated(evtShort);
    ASSERT_EQ((int)ledger.submits.size(), 0);  // no cross yet

    eng.onOrderCreated(evtLong);
    ASSERT_EQ((int)ledger.submits.size(), 1);  // cross triggered

    const auto& sub = ledger.submits[0];
    ASSERT_EQ(sub.contractId,    std::string("L1"));  // exercised on long
    ASSERT_EQ(sub.choice,        std::string("MatchOrders"));
    ASSERT_EQ(sub.shortOrderCid, std::string("S1"));
    ASSERT_EQ(sub.fillSize,      std::string("10.000000"));
    ASSERT_EQ(sub.executionPrice, std::string("200.00000000"));  // short's price
}

void test_no_match_when_no_cross() {
    OrderBook book;
    MockLedger2 ledger;
    MatchingEngine eng(book, ledger, makeConfig());

    eng.onOrderCreated(makeCreatedEvent("L1", "Long",  199.0, 10.0));
    eng.onOrderCreated(makeCreatedEvent("S1", "Short", 205.0, 10.0));

    ASSERT_EQ((int)ledger.submits.size(), 0);
}

void test_cancel_race_contract_not_found_removes_both() {
    OrderBook book;
    MockLedger2 ledger;
    // First submitAndWait throws CONTRACT_NOT_FOUND
    ledger.behaviours.push_back([]() {
        throw LedgerError("CONTRACT_NOT_FOUND", LedgerErrorCode::ContractNotFound, 404);
    });

    MatchingEngine eng(book, ledger, makeConfig());

    eng.onOrderCreated(makeCreatedEvent("S1", "Short", 200.0, 10.0));
    eng.onOrderCreated(makeCreatedEvent("L1", "Long",  205.0, 10.0));

    ASSERT_EQ((int)ledger.submits.size(), 1);
    ASSERT_TRUE(!book.hasOrder("L1"));   // both removed
    ASSERT_TRUE(!book.hasOrder("S1"));
}

void test_duplicate_command_is_success() {
    OrderBook book;
    MockLedger2 ledger;
    ledger.behaviours.push_back([]() {
        throw LedgerError("DUPLICATE_COMMAND", LedgerErrorCode::DuplicateCommand, 409);
    });

    MatchingEngine eng(book, ledger, makeConfig());

    eng.onOrderCreated(makeCreatedEvent("S1", "Short", 200.0, 5.0));
    eng.onOrderCreated(makeCreatedEvent("L1", "Long",  205.0, 5.0));

    // Duplicate = success, so book should have applied the fill (both orders removed).
    ASSERT_EQ((int)ledger.submits.size(), 1);
    ASSERT_TRUE(!book.hasOrder("L1"));
    ASSERT_TRUE(!book.hasOrder("S1"));
}

void test_partial_fill_residual_stays_in_book() {
    OrderBook book;
    MockLedger2 ledger;
    MatchingEngine eng(book, ledger, makeConfig());

    // Long 10, Short 6 → fill 6; long residual (4) stays.
    eng.onOrderCreated(makeCreatedEvent("L1", "Long",  200.0, 10.0));
    eng.onOrderCreated(makeCreatedEvent("S1", "Short", 200.0, 6.0));

    ASSERT_EQ((int)ledger.submits.size(), 1);
    ASSERT_EQ(ledger.submits[0].fillSize, std::string("6.000000"));

    // Short fully filled → gone; long residual (4) still in book.
    ASSERT_TRUE(!book.hasOrder("S1"));
    // Long residual still tracked (same contractId, smaller size).
    ASSERT_TRUE(book.hasOrder("L1"));
    ASSERT_EQ(book.bestLong()->sizeScaled, Sz(4.0));
}

void test_multiple_consecutive_matches() {
    // Three short orders all crossing one big long → 3 submissions.
    OrderBook book;
    MockLedger2 ledger;
    MatchingEngine eng(book, ledger, makeConfig());

    // Big long placed first
    auto evtLong = makeCreatedEvent("L1", "Long", 205.0, 30.0);
    evtLong["createArguments"]["createdAt"] = "2026-01-01T00:00:01Z";
    eng.onOrderCreated(evtLong);

    auto addShort = [&](const std::string& cid, const std::string& ts) {
        auto ev = makeCreatedEvent(cid, "Short", 200.0, 10.0);
        ev["createArguments"]["createdAt"] = ts;
        eng.onOrderCreated(ev);
    };
    addShort("S1", "2026-01-01T00:00:02Z");
    addShort("S2", "2026-01-01T00:00:03Z");
    addShort("S3", "2026-01-01T00:00:04Z");

    // Each short triggers another cycle filling 10 units.
    ASSERT_EQ((int)ledger.submits.size(), 3);
    ASSERT_TRUE(!book.hasOrder("L1"));  // long fully consumed after 3×10=30
}

void test_template_id_mismatch_is_skipped() {
    OrderBook book;
    MockLedger2 ledger;
    MatchingEngine eng(book, ledger, makeConfig());

    auto evt = makeCreatedEvent("X1", "Long", 200.0, 10.0);
    evt["templateId"] = "perp-dex:PerpDex:MatchedPair";  // wrong template
    eng.onOrderCreated(evt);

    ASSERT_EQ(book.snapshot().longCount, (size_t)0);
    ASSERT_EQ((int)ledger.submits.size(), 0);
}

// ── Main ───────────────────────────────────────────────────────────────────

int main() {
    test_created_event_adds_to_book();
    test_archived_event_removes_from_book();
    test_archived_unknown_cid_is_noop();
    test_matching_cycle_submits_correct_exercise();
    test_no_match_when_no_cross();
    test_cancel_race_contract_not_found_removes_both();
    test_duplicate_command_is_success();
    test_partial_fill_residual_stays_in_book();
    test_multiple_consecutive_matches();
    test_template_id_mismatch_is_skipped();

    std::cout << "\nEngine tests: " << passed << " passed, " << failed << " failed\n";
    return failed == 0 ? 0 : 1;
}
