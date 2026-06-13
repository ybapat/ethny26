#pragma once
#include "ledger.hpp"
#include "orderbook.hpp"
#include "types.hpp"

namespace dex {

// Rebuild the in-memory orderbook from the Canton ledger's active-contract-set.
// Should be called once at startup, before opening the WebSocket subscription.
//
// Returns the ledger offset at which the ACS was snapshotted.
// The caller should use this as `beginExclusive` for subscribeUpdates() so the
// WS stream resumes exactly where the ACS left off — no gap, no double-count.
int64_t buildBookFromACS(ILedgerClient& ledger, OrderBook& book, const EngineConfig& cfg);

} // namespace dex
