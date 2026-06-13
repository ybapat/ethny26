/**
 * types.ts — the FROZEN integration contract for the Person-3 backend track
 * (Chainlink oracle feed + risk / trigger loop).
 *
 * Everything else in this package programs against these types. They mirror the
 * Daml template/choice signatures from DEX.md §11 and CANTON-RWA.md §3, so when
 * Person 1's real DAR + generated TS types land, the only swap is replacing the
 * `LedgerClient` implementation (MockLedger -> a real @c7-digital/ledger client).
 *
 * NOTE on numbers: the off-ledger risk engine computes *decisions* in float64,
 * which is exact enough for demo magnitudes (values < 1e9 with cents). The
 * authoritative re-computation happens on-ledger in Daml `Decimal`; this engine
 * only triggers choices. Use `round8` / `round6` (see risk/math.ts) at output
 * boundaries.
 *
 * IMPORTANT (Node native TypeScript): all relative imports in this package MUST
 * include the `.ts` extension (e.g. `import { foo } from "./bar.ts"`), and the
 * code must be erasable-syntax-only (no `enum`, no constructor parameter
 * properties, no `namespace`). `node --test` runs the .ts files directly.
 */

/** Which way the position bets. */
export type Side = "Long" | "Short";

/** A single verified/posted price point. `price` is in USDCx; `asOf` is unix seconds. */
export interface OraclePrice {
  /** Chainlink feed id (hex) for the perp underlying, or the RWA instrument id for NAV. */
  feedId: string;
  /** Price / NAV in USDCx. */
  price: number;
  /** Observation time, unix seconds. */
  asOf: number;
  /**
   * The raw Chainlink Data Streams `fullReport` hex (the signed blob), when this
   * price came from a live Chainlink feed. The real ledger client passes this
   * UNMODIFIED to the on-ledger Daml `Verify` choice so the price is
   * cryptographically verified in-transaction (CHAINLINK.md §6). Absent for the
   * mock/NAV path.
   */
  signedReport?: string;
}

/** One leg of a matched pair. */
export interface PositionSide {
  /** Canton party id of the trader. */
  trader: string;
  /** Units of the RWA collateral token escrowed for this leg. */
  collateralQty: number;
}

/**
 * A `MatchedPair` (DEX.md §11) — one long bound to one short. This is the unit
 * the risk/trigger loop acts on. Mirrors the on-ledger contract's relevant fields.
 */
export interface MatchedPair {
  /** On-ledger contract id. */
  contractId: string;
  /** Perp market id, e.g. "BTC-USD". */
  market: string;
  /** RWA collateral instrument id (used to look up its NAV), e.g. "tMMF-USD". */
  collateralInstrument: string;
  /** Position size in units of the underlying (contracts). */
  size: number;
  /** Execution / entry price in USDCx. */
  entryPrice: number;
  long: PositionSide;
  short: PositionSide;
  /**
   * Net funding received by the LONG so far, signed USDCx (negative = long has
   * paid). The short's net funding is exactly `-accruedFundingLong`.
   */
  accruedFundingLong: number;
  /** Unix seconds of the last funding application. */
  lastFundingTime: number;
  /** Unix seconds when the pair was opened. */
  openedAt: number;
}

/** Per-market risk + funding parameters (subset of `Market` config, DEX.md §11). */
export interface MarketConfig {
  market: string;
  /** Perp underlying Chainlink feed id (hex). */
  underlyingFeedId: string;
  /** RWA collateral instrument id for NAV lookups. */
  collateralInstrument: string;
  /** Initial-margin rate (= 1/leverage), e.g. 0.10. */
  initialMarginRate: number;
  /** Maintenance-margin rate, e.g. 0.05. Convention: IMR = 2*MMR. */
  maintenanceMarginRate: number;
  /** Funding interval in seconds (demo: 3600). */
  fundingIntervalSeconds: number;
  /** Funding demo formula: damping factor on premium, e.g. 0.3. */
  fundingDampingFactor: number;
  /** Funding demo formula: per-interval base rate, e.g. 0.0001. */
  fundingBaseRate: number;
  /** Funding demo formula: absolute clamp per interval, e.g. 0.0075. */
  fundingClamp: number;
  /** Taker fee rate, e.g. 0.0005. */
  takerFeeRate: number;
  /** Liquidation penalty rate (fraction of notional), e.g. 0.0 for the demo. */
  liqPenaltyRate: number;
  /** Max age (seconds) a perp mark may be before trading/liq halts, e.g. 300. */
  maxMarkStalenessSeconds: number;
  /** Max age (seconds) an RWA NAV may be before opens freeze, e.g. 90000 (25h). */
  maxNavStalenessSeconds: number;
}

/* ------------------------------------------------------------------ *
 * Pure risk API — implemented by src/risk/math.ts (Person 3 / Agent B)
 * The trigger loop is parameterized by this interface so it can be
 * unit-tested with a stub.
 * ------------------------------------------------------------------ */
export interface RiskApi {
  /** +1 for Long, -1 for Short. */
  sideSign(side: Side): number;
  /** Notional value = size * price. */
  notional(size: number, price: number): number;
  /** Unrealized PnL = (mark - entry) * size * sideSign. */
  unrealizedPnl(side: Side, size: number, entryPrice: number, markPrice: number): number;
  /** Collateral value = collateralQty * rwaNav. NO haircut (stable-collateral whitelist). */
  collateralValue(collateralQty: number, rwaNav: number): number;
  /** Equity = collateralValue + unrealizedPnl + netFunding (netFunding signed; + = received). */
  equity(collateralValue: number, unrealizedPnl: number, netFunding: number): number;
  /** Maintenance margin = size * markPrice * maintenanceMarginRate. */
  maintenanceMargin(size: number, markPrice: number, maintenanceMarginRate: number): number;
  /** True when equity < maintenance margin (DEX.md §7.1). */
  isLiquidatable(equity: number, maintenanceMargin: number): boolean;
  /**
   * Demo funding rate per interval (DEX.md §5.2):
   *   clamp(damping*(mark-index)/index + base, -clamp, +clamp)
   */
  fundingRate(markPrice: number, indexPrice: number, cfg: MarketConfig): number;
  /** Funding payment = rate * size * indexPrice. Positive => long pays short. */
  fundingPayment(rate: number, size: number, indexPrice: number): number;
  /** Realized PnL on close = (exit - entry) * size * sideSign. */
  realizedPnl(side: Side, size: number, entryPrice: number, exitPrice: number): number;
}

/* ------------------------------------------------------------------ *
 * Price source — implemented by src/oracle/* (Person 3 / Agent A)
 * ------------------------------------------------------------------ */
export interface PriceSource {
  /** Latest perp index/mark price for a market (MVP: mark = index). */
  getPerpPrice(market: string): Promise<OraclePrice>;
  /** Latest NAV (USDCx per token) for an RWA collateral instrument. */
  getRwaNav(instrument: string): Promise<OraclePrice>;
}

/* ------------------------------------------------------------------ *
 * Ledger client — the only thing that talks to Canton. MockLedger
 * (src/ledger/mockLedger.ts) implements it for tests/demo; the real
 * @c7-digital/ledger client drops in later with the same shape.
 * ------------------------------------------------------------------ */
export interface ApplyFundingArgs {
  fundingRate: number;
  /** Signed USDCx; positive => long pays short. */
  fundingPayment: number;
  indexPrice: number;
  /** Unix seconds of application. */
  at: number;
  /** Signed Chainlink `fullReport` hex for on-ledger Verify (absent on mock path). */
  signedReport?: string;
}

export interface LiquidateArgs {
  /** Which leg breached. */
  side: Side;
  markPrice: number;
  equity: number;
  maintenanceMargin: number;
  at: number;
  /** Signed Chainlink `fullReport` hex for on-ledger Verify (absent on mock path). */
  signedReport?: string;
}

export interface SettleCloseArgs {
  closingSide: Side;
  exitPrice: number;
  realizedPnl: number;
  /** Net funding for the closing side (signed USDCx). */
  netFunding: number;
  at: number;
  /** Signed Chainlink `fullReport` hex for on-ledger Verify (absent on mock path). */
  signedReport?: string;
}

/**
 * A trader's pending request to close a position (DEX.md §8: `PerpPosition.RequestClose`
 * → venue `SettleClose`). The keeper watches for these and settles them P2P.
 */
export interface CloseRequest {
  /** Contract id of the close-request contract (consumed on settle). */
  contractId: string;
  /** The MatchedPair this close targets. */
  matchedPairContractId: string;
  /** Which side asked to close. */
  closingSide: Side;
  /** Unix seconds the close was requested. */
  requestedAt: number;
}

export interface LedgerClient {
  /** All active MatchedPairs visible to the venue party. */
  getActiveMatchedPairs(): Promise<MatchedPair[]>;
  /** All pending close requests visible to the venue party (DEX.md §8). */
  getCloseRequests(): Promise<CloseRequest[]>;
  /** Post a verified/mock price to the on-ledger oracle (MockOraclePrice.UpdatePrice / Verify). */
  updateOraclePrice(price: OraclePrice): Promise<void>;
  /** Exercise MatchedPair.ApplyFunding. */
  applyFunding(contractId: string, args: ApplyFundingArgs): Promise<void>;
  /** Exercise MatchedPair.Liquidate. */
  liquidate(contractId: string, args: LiquidateArgs): Promise<void>;
  /** Exercise MatchedPair.SettleClose (closes & settles the pair P2P). */
  settleClose(contractId: string, args: SettleCloseArgs): Promise<void>;
}

/* ------------------------------------------------------------------ *
 * Trigger loop output — what one cycle did (for observability/tests).
 * Produced by src/loop/triggerLoop.ts (Person 3 / Agent C).
 * ------------------------------------------------------------------ */
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
  /** Set when the pair was closed & settled this cycle (DEX.md §8). */
  settled: boolean;
  settledSide: Side | null;
  /** Set when a price was too stale to act on this pair. */
  skippedStale: boolean;
  /** Set when no MarketConfig is registered for the pair's market. */
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
