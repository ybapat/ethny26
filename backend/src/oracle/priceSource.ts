/**
 * priceSource.ts — the REAL Chainlink Data Streams price source (`PriceSource`).
 *
 * There is no mock price source in the product. Build this from env credentials
 * via `dataStreamsPriceSourceFromEnv` (oracle/fromEnv.ts). Tests that need a
 * deterministic price use a small in-test stub, not a product class.
 */
import type { OraclePrice, PriceSource } from "../types.ts";
import { DataStreamsClient } from "./dataStreams.ts";
import { decodeV3Report } from "./reportV3.ts";

/**
 * Live price source backed by Chainlink Data Streams. Maps a market id to its
 * V3 feed id, fetches the latest signed report, decodes it, and returns the
 * benchmark price with `asOf = observationsTimestamp`.
 */
export class DataStreamsPriceSource implements PriceSource {
  private readonly client: DataStreamsClient;
  private readonly marketToFeedId: Map<string, string>;
  private readonly decimals: number;

  constructor(opts: {
    client: DataStreamsClient;
    /** market id (e.g. "ETH-USD") -> V3 feed id (hex). */
    marketToFeedId: Record<string, string> | Map<string, string>;
    /** price scaling decimals (default 18, ETH/USD per CHAINLINK.md §4). */
    decimals?: number;
  }) {
    this.client = opts.client;
    this.marketToFeedId =
      opts.marketToFeedId instanceof Map
        ? new Map(opts.marketToFeedId)
        : new Map(Object.entries(opts.marketToFeedId));
    this.decimals = opts.decimals ?? 18;
  }

  async getPerpPrice(market: string): Promise<OraclePrice> {
    const feedId = this.marketToFeedId.get(market);
    if (!feedId) {
      throw new Error(`DataStreamsPriceSource: no feedId mapped for market "${market}"`);
    }
    const envelope = await this.client.fetchLatestReport(feedId);
    const report = decodeV3Report(envelope.fullReport, this.decimals);
    return {
      feedId: report.feedId,
      price: report.price,
      asOf: report.observationsTimestamp,
      // Preserve the signed blob for the on-ledger Verify choice (CHAINLINK.md §6).
      signedReport: envelope.fullReport,
    };
  }

  /**
   * RWA collateral NAV. Chainlink delivers NAV via the V9/SmartData schema, which
   * is not yet wired on Canton (CHAINLINK.md §8). Until then the product loop
   * supplies a stable configured NAV for the whitelisted (stable) collateral;
   * see liveChainlink.ts. This method is intentionally not implemented here.
   */
  async getRwaNav(_instrument: string): Promise<OraclePrice> {
    throw new Error("RWA NAV via Chainlink V9/SmartData is not wired yet (CHAINLINK.md §8)");
  }
}
