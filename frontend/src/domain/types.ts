/**
 * domain/types.ts — the frontend's view of the system's data model.
 *
 * The MatchedPair / MarketConfig / OraclePrice / *Args / CycleResult shapes are
 * COPIED VERBATIM from backend/src/types.ts (the "frozen integration contract").
 * Keeping them identical means the data layer (src/data/) can swap the in-browser
 * mock engine for the real backend with zero changes to components.
 *
 * The Order / Holding / Party / Fill / LiquidationEvent types are frontend-facing
 * projections of the on-ledger `Order`, Token-Standard `Holding`, and the demo's
 * five Canton parties (DEX.md §3, CANTON-RWA.md §2-3).
 */

/* ===================== mirrored from backend/src/types.ts ===================== */

export type Side = "Long" | "Short";

export interface OraclePrice {
  feedId: string;
  price: number;
  asOf: number;
  signedReport?: string;
}

export interface PositionSide {
  trader: string;
  collateralQty: number;
}

export interface MatchedPair {
  contractId: string;
  market: string;
  collateralInstrument: string;
  size: number;
  entryPrice: number;
  long: PositionSide;
  short: PositionSide;
  accruedFundingLong: number;
  lastFundingTime: number;
  openedAt: number;
}

export interface MarketConfig {
  market: string;
  underlyingFeedId: string;
  collateralInstrument: string;
  initialMarginRate: number;
  maintenanceMarginRate: number;
  fundingIntervalSeconds: number;
  fundingDampingFactor: number;
  fundingBaseRate: number;
  fundingClamp: number;
  takerFeeRate: number;
  liqPenaltyRate: number;
  maxMarkStalenessSeconds: number;
  maxNavStalenessSeconds: number;
}

export interface CloseRequest {
  contractId: string;
  matchedPairContractId: string;
  closingSide: Side;
  requestedAt: number;
}

export interface PairEvaluation {
  contractId: string;
  market: string;
  markPrice: number;
  rwaNav: number;
  longEquity: number;
  shortEquity: number;
  maintenanceMargin: number;
  fundingApplied: boolean;
  fundingRate: number | null;
  fundingPayment: number | null;
  liquidated: boolean;
  liquidatedSide: Side | null;
  settled: boolean;
  settledSide: Side | null;
  skippedStale: boolean;
  skippedNoConfig: boolean;
}

export interface CycleResult {
  at: number;
  evaluated: number;
  fundingApplied: number;
  liquidated: number;
  settled: number;
  skippedStale: number;
  skippedNoConfig: number;
  perPair: PairEvaluation[];
}

/* ===================== frontend-facing on-ledger projections ===================== */

/** Viewpoint roles. Any number of `trader` wallets (Alice, Bob, …); plus the
 * venue operator, the regulator (observer), and a public `outsider`. */
export type PartyRole = "trader" | "venue" | "regulator" | "outsider";

/** A Canton party identity. */
export interface Party {
  role: PartyRole;
  /** Canton party id, e.g. "alice::1220ab..". */
  partyId: string;
  /** Human label for the UI. */
  label: string;
}

/**
 * A resting limit order (the private/dark CLOB `Order`, DEX.md §3.1).
 * Stakeholders are {trader, venue, Regulator} only — invisible to outsiders.
 */
export interface Order {
  contractId: string;
  market: string;
  /** Owning trader's party id. */
  trader: string;
  side: Side;
  size: number;
  /** Remaining unfilled size (partial fills split the order). */
  remaining: number;
  limitPrice: number;
  leverage: number;
  collateralInstrument: string;
  /** RWA tokens escrowed via the Allocation workflow for this order. */
  collateralQty: number;
  status: "Resting" | "PartiallyFilled" | "Filled" | "Cancelled";
  createdAt: number;
}

/** A completed fill produced when the venue crosses two orders (tape / recent trades). */
export interface Fill {
  id: string;
  market: string;
  price: number;
  size: number;
  /** The aggressor side that crossed the book. */
  takerSide: Side;
  at: number;
}

/** A liquidation event (DEX.md §7) surfaced to the venue/regulator + the liquidated trader. */
export interface LiquidationEvent {
  id: string;
  market: string;
  contractId: string;
  side: Side;
  markPrice: number;
  /** Equity at seizure (negative-ish, below MM). */
  equity: number;
  maintenanceMargin: number;
  /** Collateral seized from the breaching side, USDCx. */
  seized: number;
  at: number;
}

/** A settled close (DEX.md §8) — realized PnL via atomic DvP. */
export interface SettlementEvent {
  id: string;
  market: string;
  contractId: string;
  closingSide: Side;
  exitPrice: number;
  realizedPnl: number;
  netFunding: number;
  at: number;
}

/**
 * A Token-Standard Holding (CIP-0056, CANTON-RWA.md §3) — UTXO of either the RWA
 * collateral token or the USDCx cash token. `locked` reflects the Allocation escrow.
 */
export interface Holding {
  instrument: string;
  /** Display symbol e.g. "tMMF" or "USDCx". */
  symbol: string;
  owner: string;
  /** Free (unlocked) quantity. */
  amount: number;
  /** Quantity escrowed via Allocation against open orders/positions. */
  locked: number;
  /** True for the yield-bearing RWA collateral token (NAV appreciates). */
  isCollateral: boolean;
}

/** Proof-of-Reserve attestation for an RWA instrument (CANTON-RWA.md §6). */
export interface PoRStatus {
  instrument: string;
  reserves: number;
  issuedSupply: number;
  /** reserves >= issuedSupply. */
  solvent: boolean;
  /** On the collateral whitelist (gates acceptance). */
  whitelisted: boolean;
  asOf: number;
}

/** One OHLC candle for the price chart. */
export interface Candle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

/** A derived, UI-friendly position (one leg of a MatchedPair from a trader's view). */
export interface DerivedPosition {
  contractId: string;
  market: string;
  side: Side;
  trader: string;
  size: number;
  entryPrice: number;
  markPrice: number;
  leverage: number;
  collateralInstrument: string;
  collateralQty: number;
  collateralValue: number;
  unrealizedPnl: number;
  netFunding: number;
  equity: number;
  maintenanceMargin: number;
  marginRatio: number;
  liquidationPrice: number;
  /** Counterparty party id (revealed only to stakeholders). */
  counterparty: string;
  openedAt: number;
  /** True when a close has been requested and is pending settlement. */
  closePending: boolean;
}
