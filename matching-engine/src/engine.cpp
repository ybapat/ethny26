#include "engine.hpp"
#include <chrono>
#include <iostream>
#include <thread>

namespace dex {

// ── helpers ────────────────────────────────────────────────────────────────

static void sleepMs(int ms) {
    std::this_thread::sleep_for(std::chrono::milliseconds(ms));
}

// ── public API ─────────────────────────────────────────────────────────────

void MatchingEngine::onOrderCreated(const nlohmann::json& event) {
    const std::string cid      = event.at("contractId").get<std::string>();
    const auto&       args     = event.at("createArguments");

    // Skip non-Order template events that slip through the WS filter.
    const std::string templateId = event.value("templateId", "");
    if (!templateId.empty() && templateId != cfg_.orderTemplateId) return;

    Order o;
    try {
        o = parseOrder(cid, args);
    } catch (const std::exception& e) {
        std::cerr << "[engine] skip unparseable order " << cid << ": " << e.what() << "\n";
        return;
    }

    // Skip already-expired orders (IOC/FOK that the Daml layer didn't archive yet,
    // or GTC orders with an explicit expiresAt in the past).
    if (o.expiresAt.has_value()) {
        try {
            int64_t expMs = parseIso8601Ms(*o.expiresAt);
            auto nowMs = std::chrono::duration_cast<std::chrono::milliseconds>(
                             std::chrono::system_clock::now().time_since_epoch())
                             .count();
            if (nowMs > expMs) {
                std::cerr << "[engine] skip expired order " << cid << "\n";
                return;
            }
        } catch (...) {}  // if we can't parse expiry, let it through
    }

    book_.addOrder(o);
    std::cout << "[engine] + " << (o.side == Side::Long ? "LONG " : "SHORT")
              << " " << cid.substr(0, 8) << "… price=" << fmtPrice(o.priceScaled)
              << " size=" << fmtSize(o.sizeScaled) << "\n";

    runMatchingCycle();
}

void MatchingEngine::onOrderArchived(const std::string& cid) {
    if (book_.removeOrder(cid)) {
        std::cout << "[engine] - archived " << cid.substr(0, 8) << "…\n";
    }
    // No matching cycle needed — archiving never creates new crosses.
}

int MatchingEngine::runMatchingCycle() {
    if (isMatching_) return 0;  // re-entrancy guard
    isMatching_ = true;

    int matches = 0;
    while (true) {
        auto cross = book_.findCross();
        if (!cross) break;

        if (!submitMatch(*cross)) break;  // stale CID or exhausted retries
        applyFillToBook(*cross);
        ++matches;
    }

    isMatching_ = false;
    return matches;
}

// ── private implementation ─────────────────────────────────────────────────

bool MatchingEngine::submitMatch(const Cross& cross) {
    const std::string cmdId = "match-" + std::to_string(++cmdSeq_);

    nlohmann::json body = {
        {"commands", {{
            {"ExerciseCommand", {
                {"contractId",    cross.longOrder.contractId},
                {"templateId",    cfg_.orderTemplateId},
                {"choice",        cfg_.matchOrdersChoice},
                {"choiceArgument", {
                    {"shortOrderCid",   cross.shortOrder.contractId},
                    {"fillSize",        fmtSize(cross.fillSizeScaled)},
                    {"executionPrice",  fmtPrice(cross.executionPriceScaled)}
                }}
            }}
        }}},
        {"userId",    cfg_.userId},
        {"commandId", cmdId},
        {"actAs",     {cfg_.venueParty}},
        {"readAs",    nlohmann::json::array()}
    };

    std::cout << "[engine] match cmd=" << cmdId
              << " long=" << cross.longOrder.contractId.substr(0, 8) << "…"
              << " short=" << cross.shortOrder.contractId.substr(0, 8) << "…"
              << " price=" << fmtPrice(cross.executionPriceScaled)
              << " fill="  << fmtSize(cross.fillSizeScaled) << "\n";

    for (int attempt = 0; attempt < cfg_.maxRetryAttempts; ++attempt) {
        try {
            ledger_.submitAndWait(body);
            std::cout << "[engine] matched cmd=" << cmdId << " (attempt " << attempt + 1 << ")\n";
            return true;
        } catch (const LedgerError& e) {
            if (e.code == LedgerErrorCode::ContractNotFound) {
                // Cancel race: one or both orders were already consumed on-ledger.
                // Remove both from our book; the WS stream will confirm with
                // ArchivedEvents (removeOrder is idempotent so double-remove is safe).
                std::cerr << "[engine] stale CID on cmd=" << cmdId
                          << " — removing both orders from book\n";
                book_.removeOrder(cross.longOrder.contractId);
                book_.removeOrder(cross.shortOrder.contractId);
                return false;
            }
            if (e.code == LedgerErrorCode::DuplicateCommand) {
                // The first submission committed; treat as success.
                std::cout << "[engine] duplicate cmd=" << cmdId << " (idempotent OK)\n";
                return true;
            }
            if (attempt < cfg_.maxRetryAttempts - 1) {
                std::cerr << "[engine] transient error on cmd=" << cmdId
                          << " (attempt " << attempt + 1 << "): " << e.what()
                          << " — retrying\n";
                sleepMs(200 * (attempt + 1));  // linear back-off: 200ms, 400ms, …
                // Generate a new commandId on retry to avoid duplicate-command
                // ambiguity when we don't know if the previous attempt committed.
                body["commandId"] = "match-" + std::to_string(++cmdSeq_);
                continue;
            }
            std::cerr << "[engine] exhausted retries for cmd=" << cmdId
                      << ": " << e.what() << "\n";
        } catch (const std::exception& e) {
            std::cerr << "[engine] unexpected error submitting cmd=" << cmdId
                      << ": " << e.what() << "\n";
        }
        return false;
    }
    return false;
}

void MatchingEngine::applyFillToBook(const Cross& cross) {
    // Remove both orders from the book. For partial fills we re-insert the
    // residual — the WS stream will separately deliver the archive of the
    // original and the create of the remainder, but those events are idempotent
    // so the net result is correct either way.

    const bool longFullFill  = cross.longOrder.sizeScaled  == cross.fillSizeScaled;
    const bool shortFullFill = cross.shortOrder.sizeScaled == cross.fillSizeScaled;

    book_.removeOrder(cross.longOrder.contractId);
    book_.removeOrder(cross.shortOrder.contractId);

    if (!longFullFill) {
        Order residual          = cross.longOrder;
        residual.sizeScaled    -= cross.fillSizeScaled;
        book_.addOrder(residual);
    }
    if (!shortFullFill) {
        Order residual          = cross.shortOrder;
        residual.sizeScaled    -= cross.fillSizeScaled;
        book_.addOrder(residual);
    }
}

} // namespace dex
