#include "orderbook.hpp"
#include <algorithm>

namespace dex {

bool OrderBook::addOrder(const Order& o) {
    if (index_.count(o.contractId)) return false;  // already present — idempotent

    if (o.side == Side::Long) {
        bids_[o.priceScaled].push_back(o);
        ++longCount_;
    } else {
        asks_[o.priceScaled].push_back(o);
        ++shortCount_;
    }
    index_[o.contractId] = {o.side, o.priceScaled};
    return true;
}

bool OrderBook::removeOrder(const std::string& cid) {
    auto it = index_.find(cid);
    if (it == index_.end()) return false;  // not present — safe no-op

    const auto [side, priceScaled] = it->second;

    auto removeFromDeque = [&](auto& levelMap) {
        auto levelIt = levelMap.find(priceScaled);
        if (levelIt == levelMap.end()) return;
        auto& dq = levelIt->second;
        dq.erase(std::remove_if(dq.begin(), dq.end(),
                                [&cid](const Order& o) { return o.contractId == cid; }),
                 dq.end());
        if (dq.empty()) levelMap.erase(levelIt);
    };

    if (side == Side::Long) {
        removeFromDeque(bids_);
        --longCount_;
    } else {
        removeFromDeque(asks_);
        --shortCount_;
    }

    index_.erase(it);
    return true;
}

bool OrderBook::hasOrder(const std::string& cid) const noexcept {
    return index_.count(cid) > 0;
}

std::optional<Order> OrderBook::bestLong() const noexcept {
    if (bids_.empty()) return std::nullopt;
    const auto& dq = bids_.begin()->second;
    if (dq.empty()) return std::nullopt;  // shouldn't happen, but be safe
    return dq.front();
}

std::optional<Order> OrderBook::bestShort() const noexcept {
    if (asks_.empty()) return std::nullopt;
    const auto& dq = asks_.begin()->second;
    if (dq.empty()) return std::nullopt;
    return dq.front();
}

std::optional<Cross> OrderBook::findCross() const noexcept {
    if (bids_.empty() || asks_.empty()) return std::nullopt;

    const int64_t bestBidPrice = bids_.begin()->first;
    const int64_t bestAskPrice = asks_.begin()->first;

    if (bestBidPrice < bestAskPrice) return std::nullopt;  // no cross

    const Order& longOrd  = bids_.begin()->second.front();
    const Order& shortOrd = asks_.begin()->second.front();

    int64_t fillSize = std::min(longOrd.sizeScaled, shortOrd.sizeScaled);

    // Maker = whichever order arrived on the ledger first (smaller createdAtMs).
    // On exact tie, the long is maker (arbitrary but deterministic).
    Side    makerSide  = (longOrd.createdAtMs <= shortOrd.createdAtMs) ? Side::Long : Side::Short;
    int64_t execPrice  = (makerSide == Side::Long) ? longOrd.priceScaled : shortOrd.priceScaled;

    return Cross{longOrd, shortOrd, fillSize, execPrice, makerSide};
}

OrderBook::Snapshot OrderBook::snapshot() const noexcept {
    return {longCount_, shortCount_};
}

} // namespace dex
