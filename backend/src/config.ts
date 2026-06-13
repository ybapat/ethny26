/**
 * config.ts — default market config + Chainlink Data Streams endpoints / feed ids.
 * Values are sourced from CHAINLINK.md (verified 2026-06-13) and DEX.md §9 params.
 */
import type { MarketConfig } from "./types.ts";

/** Chainlink Data Streams hosts (CHAINLINK.md §1). */
export const DATA_STREAMS = {
  testnetRest: "https://api.testnet-dataengine.chain.link",
  testnetWs: "wss://ws.testnet-dataengine.chain.link",
  mainnetRest: "https://api.dataengine.chain.link",
  mainnetWs: "wss://ws.dataengine.chain.link",
  /** REST paths (CHAINLINK.md §1). */
  paths: {
    latest: "/api/v1/reports/latest",
    byTimestamp: "/api/v1/reports",
    bulk: "/api/v1/reports/bulk",
    ws: "/api/v1/ws",
  },
} as const;

/**
 * Verified feed ids (CHAINLINK.md §5).
 * ETH/USD is CONFIRMED. BTC/USD full id is UNCONFIRMED — re-verify at
 * docs.chain.link/data-streams/stream-ids before using; ETH/USD is the safe default.
 */
export const FEED_IDS = {
  ETH_USD: "0x000359843a543ee2fe414dc14c7e7920ef10f4372990b79d6361cdc0dd1ba782",
} as const;

/** SHA-256 of the empty string — the BODY_HASH for all GET/WS requests (CHAINLINK.md §2). */
export const EMPTY_BODY_SHA256 =
  "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

/** Demo market config: ETH/USD perp, tokenized money-market collateral. */
export const DEFAULT_MARKET: MarketConfig = {
  market: "ETH-USD",
  underlyingFeedId: FEED_IDS.ETH_USD,
  collateralInstrument: "tMMF-USD",
  initialMarginRate: 0.1, // 10x max
  maintenanceMarginRate: 0.05, // IMR = 2*MMR
  fundingIntervalSeconds: 3600,
  fundingDampingFactor: 0.3,
  fundingBaseRate: 0.0001,
  fundingClamp: 0.0075,
  takerFeeRate: 0.0005,
  liqPenaltyRate: 0.0,
  maxMarkStalenessSeconds: 300,
  maxNavStalenessSeconds: 90000, // 25h
};
