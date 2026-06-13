#include "orderbook.hpp"
#include <cassert>
#include <iostream>
#include <string>

using namespace dex;

// ── Minimal test harness ───────────────────────────────────────────────────

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

// ── Test helpers ───────────────────────────────────────────────────────────

static Order makeOrder(const std::string& cid, Side side,
                       int64_t priceScaled, int64_t sizeScaled,
                       int64_t createdAtMs = 1000) {
    Order o{};
    o.contractId   = cid;
    o.trader       = "Alice::1";
    o.side         = side;
    o.priceScaled  = priceScaled;
    o.sizeScaled   = sizeScaled;
    o.timeInForce  = "GTC";
    o.createdAt    = "2026-01-01T00:00:00Z";
    o.createdAtMs  = createdAtMs;
    return o;
}

static constexpr int64_t P(double price) {
    return static_cast<int64_t>(price * PRICE_SCALE);
}
static constexpr int64_t S(double size) {
    return static_cast<int64_t>(size * SIZE_SCALE);
}

// ── Tests ──────────────────────────────────────────────────────────────────

void test_add_long_visible_as_best_long() {
    OrderBook book;
    book.addOrder(makeOrder("L1", Side::Long, P(200.0), S(10.0)));
    auto best = book.bestLong();
    ASSERT_TRUE(best.has_value());
    ASSERT_EQ(best->contractId, std::string("L1"));
}

void test_add_short_visible_as_best_short() {
    OrderBook book;
    book.addOrder(makeOrder("S1", Side::Short, P(210.0), S(5.0)));
    auto best = book.bestShort();
    ASSERT_TRUE(best.has_value());
    ASSERT_EQ(best->contractId, std::string("S1"));
}

void test_add_is_idempotent() {
    OrderBook book;
    Order o = makeOrder("L1", Side::Long, P(200.0), S(10.0));
    ASSERT_TRUE(book.addOrder(o));
    ASSERT_TRUE(!book.addOrder(o));  // second add returns false
    ASSERT_EQ(book.snapshot().longCount, (size_t)1);
}

void test_remove_order() {
    OrderBook book;
    book.addOrder(makeOrder("L1", Side::Long, P(200.0), S(10.0)));
    ASSERT_TRUE(book.removeOrder("L1"));
    ASSERT_TRUE(!book.bestLong().has_value());
    ASSERT_EQ(book.snapshot().longCount, (size_t)0);
}

void test_remove_unknown_cid_is_noop() {
    OrderBook book;
    ASSERT_TRUE(!book.removeOrder("ghost"));  // returns false, does not throw
}

void test_has_order() {
    OrderBook book;
    book.addOrder(makeOrder("L1", Side::Long, P(200.0), S(10.0)));
    ASSERT_TRUE(book.hasOrder("L1"));
    ASSERT_TRUE(!book.hasOrder("X"));
    book.removeOrder("L1");
    ASSERT_TRUE(!book.hasOrder("L1"));
}

void test_long_price_priority() {
    // Higher price long should be the best bid.
    OrderBook book;
    book.addOrder(makeOrder("L1", Side::Long, P(200.0), S(10.0), 1000));
    book.addOrder(makeOrder("L2", Side::Long, P(201.0), S(10.0), 2000));
    ASSERT_EQ(book.bestLong()->contractId, std::string("L2"));
}

void test_long_time_priority_at_same_price() {
    // Among equal-price longs, earliest createdAtMs wins (FIFO).
    OrderBook book;
    book.addOrder(makeOrder("L1", Side::Long, P(200.0), S(10.0), 2000));
    book.addOrder(makeOrder("L2", Side::Long, P(200.0), S(10.0), 1000));
    ASSERT_EQ(book.bestLong()->contractId, std::string("L2"));  // earlier time
}

void test_short_price_priority() {
    // Lower price short should be the best ask.
    OrderBook book;
    book.addOrder(makeOrder("S1", Side::Short, P(210.0), S(5.0), 1000));
    book.addOrder(makeOrder("S2", Side::Short, P(205.0), S(5.0), 2000));
    ASSERT_EQ(book.bestShort()->contractId, std::string("S2"));
}

void test_short_time_priority_at_same_price() {
    OrderBook book;
    book.addOrder(makeOrder("S1", Side::Short, P(205.0), S(5.0), 2000));
    book.addOrder(makeOrder("S2", Side::Short, P(205.0), S(5.0), 1000));
    ASSERT_EQ(book.bestShort()->contractId, std::string("S2"));
}

void test_no_cross_when_only_longs() {
    OrderBook book;
    book.addOrder(makeOrder("L1", Side::Long, P(200.0), S(10.0)));
    ASSERT_TRUE(!book.findCross().has_value());
}

void test_no_cross_when_only_shorts() {
    OrderBook book;
    book.addOrder(makeOrder("S1", Side::Short, P(205.0), S(5.0)));
    ASSERT_TRUE(!book.findCross().has_value());
}

void test_no_cross_when_bid_below_ask() {
    OrderBook book;
    book.addOrder(makeOrder("L1", Side::Long,  P(200.0), S(10.0)));
    book.addOrder(makeOrder("S1", Side::Short, P(205.0), S(5.0)));
    ASSERT_TRUE(!book.findCross().has_value());
}

void test_cross_when_bid_equals_ask() {
    OrderBook book;
    book.addOrder(makeOrder("L1", Side::Long,  P(200.0), S(10.0)));
    book.addOrder(makeOrder("S1", Side::Short, P(200.0), S(10.0)));
    auto cross = book.findCross();
    ASSERT_TRUE(cross.has_value());
    ASSERT_EQ(cross->longOrder.contractId,  std::string("L1"));
    ASSERT_EQ(cross->shortOrder.contractId, std::string("S1"));
}

void test_cross_when_bid_above_ask() {
    OrderBook book;
    book.addOrder(makeOrder("L1", Side::Long,  P(210.0), S(10.0)));
    book.addOrder(makeOrder("S1", Side::Short, P(200.0), S(10.0)));
    ASSERT_TRUE(book.findCross().has_value());
}

void test_fill_size_is_min_of_sizes() {
    OrderBook book;
    book.addOrder(makeOrder("L1", Side::Long,  P(200.0), S(10.0)));
    book.addOrder(makeOrder("S1", Side::Short, P(200.0), S(6.0)));
    auto cross = book.findCross();
    ASSERT_TRUE(cross.has_value());
    ASSERT_EQ(cross->fillSizeScaled, S(6.0));  // min(10,6)
}

void test_execution_price_long_is_maker() {
    // Long placed first (lower createdAtMs) → long is maker → exec at long's price.
    OrderBook book;
    book.addOrder(makeOrder("L1", Side::Long,  P(210.0), S(10.0), 1000));
    book.addOrder(makeOrder("S1", Side::Short, P(200.0), S(10.0), 2000));
    auto cross = book.findCross();
    ASSERT_TRUE(cross.has_value());
    ASSERT_EQ(cross->makerSide, Side::Long);
    ASSERT_EQ(cross->executionPriceScaled, P(210.0));
}

void test_execution_price_short_is_maker() {
    // Short placed first → short is maker → exec at short's price.
    OrderBook book;
    book.addOrder(makeOrder("L1", Side::Long,  P(210.0), S(10.0), 2000));
    book.addOrder(makeOrder("S1", Side::Short, P(200.0), S(10.0), 1000));
    auto cross = book.findCross();
    ASSERT_TRUE(cross.has_value());
    ASSERT_EQ(cross->makerSide, Side::Short);
    ASSERT_EQ(cross->executionPriceScaled, P(200.0));
}

void test_after_full_fill_no_cross() {
    OrderBook book;
    book.addOrder(makeOrder("L1", Side::Long,  P(200.0), S(10.0)));
    book.addOrder(makeOrder("S1", Side::Short, P(200.0), S(10.0)));
    // Simulate full fill: remove both
    book.removeOrder("L1");
    book.removeOrder("S1");
    ASSERT_TRUE(!book.findCross().has_value());
}

void test_partial_fill_residual_can_cross_again() {
    // Long 10, Short 6 → fill 6 (partial on long side).
    // After fill, long residual (size 4) can match a new short (size 3).
    OrderBook book;
    book.addOrder(makeOrder("L1", Side::Long,  P(200.0), S(10.0)));
    book.addOrder(makeOrder("S1", Side::Short, P(200.0), S(6.0)));

    auto cross1 = book.findCross();
    ASSERT_TRUE(cross1.has_value());
    ASSERT_EQ(cross1->fillSizeScaled, S(6.0));

    // Simulate partial fill: remove S1 (fully filled), update L1 residual
    book.removeOrder("S1");
    book.removeOrder("L1");
    Order residual = makeOrder("L1", Side::Long, P(200.0), S(4.0));
    book.addOrder(residual);

    // No cross without a new short
    ASSERT_TRUE(!book.findCross().has_value());

    // New short arrives
    book.addOrder(makeOrder("S2", Side::Short, P(200.0), S(3.0)));
    auto cross2 = book.findCross();
    ASSERT_TRUE(cross2.has_value());
    ASSERT_EQ(cross2->fillSizeScaled, S(3.0));
}

void test_snapshot_counts() {
    OrderBook book;
    book.addOrder(makeOrder("L1", Side::Long,  P(200.0), S(10.0)));
    book.addOrder(makeOrder("L2", Side::Long,  P(201.0), S(5.0)));
    book.addOrder(makeOrder("S1", Side::Short, P(205.0), S(7.0)));
    auto snap = book.snapshot();
    ASSERT_EQ(snap.longCount,  (size_t)2);
    ASSERT_EQ(snap.shortCount, (size_t)1);
    book.removeOrder("L1");
    ASSERT_EQ(book.snapshot().longCount, (size_t)1);
}

void test_decimal_parsing_roundtrip() {
    ASSERT_EQ(parsePrice("50000.00000000"), (int64_t)50000LL * PRICE_SCALE);
    ASSERT_EQ(parsePrice("0.00000001"), (int64_t)1);
    ASSERT_EQ(parseSize("100.000000"),  (int64_t)100LL  * SIZE_SCALE);
    ASSERT_EQ(parseSize("0.000001"),   (int64_t)1);

    ASSERT_EQ(fmtPrice(50000LL * PRICE_SCALE), std::string("50000.00000000"));
    ASSERT_EQ(fmtSize(100LL   * SIZE_SCALE),  std::string("100.000000"));
}

// ── Main ───────────────────────────────────────────────────────────────────

int main() {
    test_add_long_visible_as_best_long();
    test_add_short_visible_as_best_short();
    test_add_is_idempotent();
    test_remove_order();
    test_remove_unknown_cid_is_noop();
    test_has_order();
    test_long_price_priority();
    test_long_time_priority_at_same_price();
    test_short_price_priority();
    test_short_time_priority_at_same_price();
    test_no_cross_when_only_longs();
    test_no_cross_when_only_shorts();
    test_no_cross_when_bid_below_ask();
    test_cross_when_bid_equals_ask();
    test_cross_when_bid_above_ask();
    test_fill_size_is_min_of_sizes();
    test_execution_price_long_is_maker();
    test_execution_price_short_is_maker();
    test_after_full_fill_no_cross();
    test_partial_fill_residual_can_cross_again();
    test_snapshot_counts();
    test_decimal_parsing_roundtrip();

    std::cout << "\nOrderbook tests: " << passed << " passed, " << failed << " failed\n";
    return failed == 0 ? 0 : 1;
}
