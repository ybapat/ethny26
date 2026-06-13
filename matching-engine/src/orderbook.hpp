#pragma once
#include "types.hpp"
#include <deque>
#include <functional>
#include <map>
#include <optional>
#include <unordered_map>

namespace dex {

// Price-time-priority in-memory orderbook.
//
// Bids (longs)  sorted descending by price — highest price at front.
// Asks (shorts) sorted ascending  by price — lowest  price at front.
// Within a price level, orders are FIFO (earliest createdAtMs first).
//
// All methods are O(log P) in the number of distinct price levels P,
// except snapshot() which is O(1).
class OrderBook {
public:
    // Add an order. Returns false and is a no-op if contractId already present
    // (idempotent — safe to call again after ACS + WS overlap on startup).
    bool addOrder(const Order& o);

    // Remove an order by contractId. Returns false if not present (safe to
    // call on stale CIDs from cancel-race or post-crash duplicate archives).
    bool removeOrder(const std::string& cid);

    bool hasOrder(const std::string& cid) const noexcept;

    // Best resting long (highest price, earliest time if tied). nullopt if empty.
    std::optional<Order> bestLong()  const noexcept;
    // Best resting short (lowest price, earliest time if tied). nullopt if empty.
    std::optional<Order> bestShort() const noexcept;

    // Returns the first matchable cross, or nullopt if none.
    //   cross ⟺ bestLong().priceScaled >= bestShort().priceScaled
    //   fillSize = min(long.sizeScaled, short.sizeScaled)
    //   executionPrice = maker's price  (maker = whoever has smaller createdAtMs)
    std::optional<Cross> findCross() const noexcept;

    struct Snapshot { size_t longCount; size_t shortCount; };
    Snapshot snapshot() const noexcept;

private:
    // Bids: highest price first (std::greater comparator).
    std::map<int64_t, std::deque<Order>, std::greater<int64_t>> bids_;
    // Asks: lowest price first (default ascending comparator).
    std::map<int64_t, std::deque<Order>> asks_;

    struct IndexEntry { Side side; int64_t priceScaled; };
    std::unordered_map<std::string, IndexEntry> index_;  // contractId → location

    size_t longCount_  = 0;
    size_t shortCount_ = 0;
};

} // namespace dex
