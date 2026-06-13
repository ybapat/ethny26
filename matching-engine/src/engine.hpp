#pragma once
#include "ledger.hpp"
#include "orderbook.hpp"
#include "types.hpp"
#include <atomic>
#include <nlohmann/json.hpp>

namespace dex {

// MatchingEngine: consumes Order created/archived events from the WS stream,
// maintains the orderbook, and submits MatchOrders choices to the ledger.
//
// Single-threaded: all public methods must be called from the same thread.
// The `isMatching_` guard prevents re-entrant cycle invocations across await
// points if the caller ever uses coroutines.
class MatchingEngine {
public:
    MatchingEngine(OrderBook& book, ILedgerClient& ledger, const EngineConfig& cfg)
        : book_(book), ledger_(ledger), cfg_(cfg) {}

    // Called for every CreatedEvent whose templateId matches ORDER_TEMPLATE_ID.
    // Parses the event into an Order, adds it to the book, then runs a cycle.
    void onOrderCreated(const nlohmann::json& event);

    // Called for every ArchivedEvent whose templateId matches ORDER_TEMPLATE_ID.
    // Removes the order from the book. Safe to call for unknown CIDs.
    void onOrderArchived(const std::string& contractId);

    // Find all crosses and submit MatchOrders for each. Loops until no cross
    // remains or a submission error breaks the cycle. Returns match count.
    int runMatchingCycle();

private:
    // Submit a single cross. Returns true on success (or idempotent duplicate).
    // On CONTRACT_NOT_FOUND: removes both stale CIDs, returns false.
    // On other errors: logs and returns false after maxRetryAttempts.
    bool submitMatch(const Cross& cross);

    // Optimistically update the in-memory book after a successful submission.
    void applyFillToBook(const Cross& cross);

    OrderBook&      book_;
    ILedgerClient&  ledger_;
    const EngineConfig& cfg_;
    bool            isMatching_ = false;

    // Monotonic command counter for unique commandIds.
    uint64_t cmdSeq_ = 0;
};

} // namespace dex
