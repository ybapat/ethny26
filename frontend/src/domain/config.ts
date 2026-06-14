/**
 * domain/config.ts — demo market configs + instrument metadata.
 * ETH-USD mirrors backend/src/config.ts DEFAULT_MARKET exactly; BTC-USD is a
 * second market so the multi-market loop (backend commit: "multi-market loop")
 * has something to switch between in the UI.
 */
import type { MarketConfig } from "./types.ts";

export const FEED_IDS = {
  ETH_USD: "0x000359843a543ee2fe414dc14c7e7920ef10f4372990b79d6361cdc0dd1ba782",
  // BTC/USD full id is UNCONFIRMED in CHAINLINK.md §5 — placeholder for the demo.
  BTC_USD: "0x00037da06d56d083fe599397a4769a042d63aa73dc4ef57709d31e9971a5b439",
} as const;

export const MARKETS: MarketConfig[] = [
  {
    market: "ETH-USD",
    underlyingFeedId: FEED_IDS.ETH_USD,
    collateralInstrument: "tMMF-USD",
    initialMarginRate: 0.1,
    maintenanceMarginRate: 0.05,
    fundingIntervalSeconds: 3600,
    fundingDampingFactor: 0.3,
    fundingBaseRate: 0.0001,
    fundingClamp: 0.0075,
    takerFeeRate: 0.0005,
    liqPenaltyRate: 0.0,
    maxMarkStalenessSeconds: 300,
    maxNavStalenessSeconds: 90000,
  },
  {
    market: "BTC-USD",
    underlyingFeedId: FEED_IDS.BTC_USD,
    collateralInstrument: "tMMF-USD",
    initialMarginRate: 0.05, // 20x max
    maintenanceMarginRate: 0.025,
    fundingIntervalSeconds: 3600,
    fundingDampingFactor: 0.3,
    fundingBaseRate: 0.0001,
    fundingClamp: 0.0075,
    takerFeeRate: 0.0005,
    liqPenaltyRate: 0.0,
    maxMarkStalenessSeconds: 300,
    maxNavStalenessSeconds: 90000,
  },
];

/** Reference spot used to seed the simulated price walk. */
export const SEED_PRICE: Record<string, number> = {
  "ETH-USD": 3120.42,
  "BTC-USD": 64850.0,
};

/** Instrument display metadata. */
export interface InstrumentMeta {
  instrument: string;
  symbol: string;
  name: string;
  /** USDCx per token (NAV for the RWA; 1.0 for USDCx). */
  nav: number;
  /** APY shown for the yield-bearing RWA (CANTON-RWA.md §5). */
  apy: number;
  isCollateral: boolean;
}

export const INSTRUMENTS: Record<string, InstrumentMeta> = {
  "tMMF-USD": {
    instrument: "tMMF-USD",
    symbol: "tMMF",
    name: "Tokenized Money-Market Fund",
    nav: 1.042,
    apy: 0.0481,
    isCollateral: true,
  },
  USDCx: {
    instrument: "USDCx",
    symbol: "USDCx",
    name: "USDC-backed settlement stablecoin",
    nav: 1.0,
    apy: 0,
    isCollateral: false,
  },
};
