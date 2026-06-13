#include "recovery.hpp"
#include <chrono>
#include <iostream>

namespace dex {

int64_t buildBookFromACS(ILedgerClient& ledger, OrderBook& book, const EngineConfig& cfg) {
    // Step 1: get the current ledger tip so we have a consistent snapshot point.
    int64_t offset = ledger.getLedgerEnd();
    std::cout << "[recovery] ledger end = " << offset << "\n";

    // Step 2: fetch all active Order contracts at that offset.
    std::vector<nlohmann::json> contracts = ledger.getActiveOrders(offset);
    std::cout << "[recovery] ACS returned " << contracts.size() << " contract(s)\n";

    // Step 3: parse and insert into the book.
    int64_t nowMs = std::chrono::duration_cast<std::chrono::milliseconds>(
                        std::chrono::system_clock::now().time_since_epoch())
                        .count();
    size_t loaded  = 0;
    size_t skipped = 0;

    for (const auto& c : contracts) {
        // Normalise: the ACS entry may be wrapped as {"created": {...}} or be
        // the contract itself. Both cases are handled in getActiveOrders, but
        // guard here in case the caller passes raw frames.
        const nlohmann::json* entry = &c;
        nlohmann::json tmp;
        if (c.contains("created")) { tmp = c["created"]; entry = &tmp; }

        if (!entry->contains("contractId") || !entry->contains("createArguments")) {
            ++skipped;
            continue;
        }

        // Skip if wrong template (shouldn't happen with ACS filter, but be safe).
        std::string tmpl = entry->value("templateId", "");
        if (!tmpl.empty() && tmpl != cfg.orderTemplateId) { ++skipped; continue; }

        try {
            Order o = parseOrder(entry->at("contractId").get<std::string>(),
                                 entry->at("createArguments"));

            // Skip orders that have already expired.
            if (o.expiresAt.has_value()) {
                int64_t expMs = parseIso8601Ms(*o.expiresAt);
                if (nowMs > expMs) { ++skipped; continue; }
            }

            if (book.addOrder(o)) ++loaded;
        } catch (const std::exception& e) {
            std::cerr << "[recovery] skip contract "
                      << (*entry)["contractId"].get<std::string>().substr(0, 12)
                      << "…: " << e.what() << "\n";
            ++skipped;
        }
    }

    auto snap = book.snapshot();
    std::cout << "[recovery] loaded " << loaded << " order(s), skipped " << skipped
              << " — book: " << snap.longCount << " long(s), "
              << snap.shortCount << " short(s)\n";

    // Step 4: return the offset so the caller can open the WS from exactly here,
    // giving a gapless view: ACS accurate at `offset`, WS delivers all updates
    // with offset > `offset` (beginExclusive semantics).
    return offset;
}

} // namespace dex
