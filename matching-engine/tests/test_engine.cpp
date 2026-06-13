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

void test_partial_fill_both_orders_removed_from_book() {
    // BUG-2 fix: on a partial fill, the engine removes BOTH orders from the book.
    // It does NOT re-insert the residual under the old CID. The Daml MatchOrders
    // choice creates a fresh Order contract for the residual; the WS delivers that
    // as a new CreatedEvent (simulated below with "L1-r").
    OrderBook book;
    MockLedger2 ledger;
    MatchingEngine eng(book, ledger, makeConfig());

    eng.onOrderCreated(makeCreatedEvent("L1", "Long",  200.0, 10.0));
    eng.onOrderCreated(makeCreatedEvent("S1", "Short", 200.0, 6.0));

    ASSERT_EQ((int)ledger.submits.size(), 1);
    ASSERT_EQ(ledger.submits[0].fillSize, std::string("6.000000"));

    // Both removed — no stale CID left to cause a double-eviction next cycle.
    ASSERT_TRUE(!book.hasOrder("L1"));
    ASSERT_TRUE(!book.hasOrder("S1"));

    // WS delivers the residual as a brand-new contract ("L1-r", size 4, new CID).
    eng.onOrderCreated(makeCreatedEvent("L1-r", "Long", 200.0, 4.0));
    ASSERT_TRUE(book.hasOrder("L1-r"));
    ASSERT_EQ(book.bestLong()->sizeScaled, Sz(4.0));
}

void test_multiple_full_full_matches_drain_in_one_cycle() {
    // Two longs + two shorts, all same size (full fills only) → 2 matches in one cycle.
    // Partial fills require a WS round-trip for the residual (see test above);
    // full fills do not, so consecutive full-full crosses drain in a single cycle.
    OrderBook book;
    MockLedger2 ledger;
    MatchingEngine eng(book, ledger, makeConfig());

    // Pre-load two longs and one short so the cycle is triggered by the second short.
    eng.onOrderCreated(makeCreatedEvent("L1", "Long",  205.0, 10.0));
    eng.onOrderCreated(makeCreatedEvent("L2", "Long",  204.0, 10.0));
    eng.onOrderCreated(makeCreatedEvent("S1", "Short", 200.0, 10.0));
    // S2 arrives → triggers cycle → L1 vs S1 (full-full) then L2 vs S2 (full-full).
    eng.onOrderCreated(makeCreatedEvent("S2", "Short", 201.0, 10.0));

    ASSERT_EQ((int)ledger.submits.size(), 2);
    auto snap = book.snapshot();
    ASSERT_EQ(snap.longCount,  (size_t)0);
    ASSERT_EQ(snap.shortCount, (size_t)0);
}

void test_partial_fill_then_residual_matches_next_short_via_ws() {
    // Demonstrates correct multi-match flow with a partial fill:
    // each partial fill needs a WS round-trip before the next match.
    OrderBook book;
    MockLedger2 ledger;
    MatchingEngine eng(book, ledger, makeConfig());

    // Big short (30) as maker; three small longs (10 each) arrive one by one.
    auto s1 = makeCreatedEvent("S1", "Short", 200.0, 30.0);
    s1["createArguments"]["createdAt"] = "2026-01-01T00:00:01Z";
    eng.onOrderCreated(s1);

    auto l1 = makeCreatedEvent("L1", "Long", 205.0, 10.0);
    l1["createArguments"]["createdAt"] = "2026-01-01T00:00:02Z";
    eng.onOrderCreated(l1);  // → match L1 vs S1, fill 10; both removed

    ASSERT_EQ((int)ledger.submits.size(), 1);
    ASSERT_TRUE(!book.hasOrder("L1"));
    ASSERT_TRUE(!book.hasOrder("S1"));

    // WS: S1 residual arrives as fresh contract (size 20).
    auto s1r = makeCreatedEvent("S1-r1", "Short", 200.0, 20.0);
    s1r["createArguments"]["createdAt"] = "2026-01-01T00:00:01Z";
    eng.onOrderCreated(s1r);

    auto l2 = makeCreatedEvent("L2", "Long", 205.0, 10.0);
    l2["createArguments"]["createdAt"] = "2026-01-01T00:00:03Z";
    eng.onOrderCreated(l2);  // → match L2 vs S1-r1, fill 10; both removed

    ASSERT_EQ((int)ledger.submits.size(), 2);

    // WS: S1-r1 residual (size 10).
    auto s1r2 = makeCreatedEvent("S1-r2", "Short", 200.0, 10.0);
    s1r2["createArguments"]["createdAt"] = "2026-01-01T00:00:01Z";
    eng.onOrderCreated(s1r2);

    auto l3 = makeCreatedEvent("L3", "Long", 205.0, 10.0);
    l3["createArguments"]["createdAt"] = "2026-01-01T00:00:04Z";
    eng.onOrderCreated(l3);  // → match L3 vs S1-r2, fill 10; both fully consumed

    ASSERT_EQ((int)ledger.submits.size(), 3);
    ASSERT_TRUE(!book.hasOrder("S1-r2"));
    ASSERT_TRUE(!book.hasOrder("L3"));
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
    test_partial_fill_both_orders_removed_from_book();
    test_multiple_full_full_matches_drain_in_one_cycle();
    test_partial_fill_then_residual_matches_next_short_via_ws();
    test_template_id_mismatch_is_skipped();

    std::cout << "\nEngine tests: " << passed << " passed, " << failed << " failed\n";
    return failed == 0 ? 0 : 1;
}
