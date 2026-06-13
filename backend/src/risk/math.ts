/**
 * risk/math.ts — the correctness-critical risk-math core (Person 3 track).
 *
 * Pure, dependency-free implementation of the `RiskApi` interface plus a few
 * helpers used by the trigger loop / settlement. Every formula here is a direct
 * transcription of DEX.md; section references are cited per function.
 *
 * Numbers are float64 (see types.ts header): exact enough for demo magnitudes
 * (< 1e9 with cents). The authoritative re-computation happens on-ledger in
 * Daml `Decimal`; this engine only triggers choices. Round at output
 * boundaries with `round8` (prices) / `round6` (quantities) per DEX.md §1.
 *
 * Erasable-syntax-only TS (no enum/namespace/param-properties); all relative
 * imports carry the `.ts` extension.
 */

import type { MarketConfig, RiskApi, Side } from "../types.ts";

/* ------------------------------------------------------------------ *
 * Generic numeric helpers
 * ------------------------------------------------------------------ */

/**
 * Clamp `x` into the inclusive range `[lo, hi]`.
 * Used by `fundingRate` (DEX.md §5.2) and at any payout/debt boundary.
 */
export function clamp(x: number, lo: number, hi: number): number {
  return Math.min(Math.max(x, lo), hi);
}

/**
 * Round to 8 decimal places — the price precision policy (DEX.md §1).
 * Use at output boundaries for any USDCx price value.
 */
export function round8(x: number): number {
  return Math.round((x + Number.EPSILON) * 1e8) / 1e8;
}

/**
 * Round to 6 decimal places — the quantity precision policy (DEX.md §1).
 * Use at output boundaries for any size / token-quantity value.
 */
export function round6(x: number): number {
  return Math.round((x + Number.EPSILON) * 1e6) / 1e6;
}

/* ------------------------------------------------------------------ *
 * RiskApi — named functions (DEX.md §3–§7)
 * ------------------------------------------------------------------ */

/**
 * Side sign: +1 for Long, -1 for Short (DEX.md §1 glossary, §4).
 */
export function sideSign(side: Side): number {
  return side === "Long" ? 1 : -1;
}

/**
 * Notional value `N = S · price` (DEX.md §1, §3.1).
 * `price` is `P_e` at open or `P_m` for live notional.
 */
export function notional(size: number, price: number): number {
  return size * price;
}

/**
 * Unrealized PnL `UPnL = (P_m − P_e) · S · sideSign` (DEX.md §4).
 * Long profits when mark > entry; short profits when mark < entry.
 */
export function unrealizedPnl(
  side: Side,
  size: number,
  entryPrice: number,
  markPrice: number,
): number {
  return (markPrice - entryPrice) * size * sideSign(side);
}

/**
 * Collateral value `CollateralValue = collateralQty · P_rwa` (DEX.md §6).
 * NO haircut — the collateral whitelist is restricted to a stable, yield-bearing
 * NAV asset, so full oracle value is used (haircut = 1.0).
 */
export function collateralValue(collateralQty: number, rwaNav: number): number {
  return collateralQty * rwaNav;
}

/**
 * Equity `E = CollateralValue + UPnL + netFunding` (DEX.md §6).
 *
 * DEX.md writes `E = CollateralValue + UPnL − accruedFundingOwed`. Here
 * `netFunding` is the SIGNED net funding for the side (+ = received, − = paid),
 * which equals `−accruedFundingOwed`; so it is added directly.
 */
export function equity(
  collateralValue: number,
  unrealizedPnl: number,
  netFunding: number,
): number {
  return collateralValue + unrealizedPnl + netFunding;
}

/**
 * Maintenance margin `MM = S · P_m · MMR` (DEX.md §1, §7.1).
 */
export function maintenanceMargin(
  size: number,
  markPrice: number,
  maintenanceMarginRate: number,
): number {
  return size * markPrice * maintenanceMarginRate;
}

/**
 * Liquidation condition: `E < MM` (DEX.md §7.1, exact). Strictly less-than —
 * equal-to-MM is still healthy.
 */
export function isLiquidatable(equity: number, maintenanceMargin: number): boolean {
  return equity < maintenanceMargin;
}

/**
 * Demo funding rate per interval (DEX.md §5.2):
 *   F = clamp( damping·(P_m − P_i)/P_i + base, −clamp, +clamp )
 * `F > 0` (perp above spot) ⇒ longs pay shorts.
 */
export function fundingRate(
  markPrice: number,
  indexPrice: number,
  cfg: MarketConfig,
): number {
  const premium = (markPrice - indexPrice) / indexPrice;
  const raw = cfg.fundingDampingFactor * premium + cfg.fundingBaseRate;
  return clamp(raw, -cfg.fundingClamp, cfg.fundingClamp);
}

/**
 * Funding payment `FundingPayment = F · S · P_i` (DEX.md §5.2).
 * Computed on the INDEX (not mark) to avoid a circular dependency.
 * Positive ⇒ the long pays this amount to the short.
 */
export function fundingPayment(rate: number, size: number, indexPrice: number): number {
  return rate * size * indexPrice;
}

/**
 * Realized PnL on close `RealizedPnL = (P_x − P_e) · S · sideSign` (DEX.md §8).
 */
export function realizedPnl(
  side: Side,
  size: number,
  entryPrice: number,
  exitPrice: number,
): number {
  return (exitPrice - entryPrice) * size * sideSign(side);
}

/* ------------------------------------------------------------------ *
 * Extra helpers (used by trigger loop / settlement / tests)
 * ------------------------------------------------------------------ */

/**
 * Closed-form liquidation price (DEX.md §7.2, no haircut):
 *   P_liq_long  = (CollateralValue + accruedFundingForSide + S·P_e) / (S·(1 − MMR))
 *   P_liq_short = (CollateralValue + accruedFundingForSide + S·P_e) / (S·(1 + MMR))
 *
 * Note on sign: DEX.md §7.2 writes `(CollateralValue − accruedFunding + S·P_e)`
 * where `accruedFunding` there is the amount OWED. `accruedFundingForSide` here
 * is the SIGNED net funding for the side (+ = received), i.e. `−accruedFundingOwed`,
 * so it is ADDED. (Owed funding lowers the position's resilience and pushes the
 * long's liq price up / the short's liq price down, as expected.)
 */
export function liquidationPrice(
  side: Side,
  size: number,
  entryPrice: number,
  collateralValue: number,
  accruedFundingForSide: number,
  mmr: number,
): number {
  const numerator = collateralValue + accruedFundingForSide + size * entryPrice;
  const denom = side === "Long" ? size * (1 - mmr) : size * (1 + mmr);
  return numerator / denom;
}

/**
 * Net settlement for the closing side (DEX.md §8):
 *   NetProfit = RealizedPnL + netFunding − openFee − closeFee
 * `netFunding` is signed (+ = received). Fees are `S · price · feeRate` and are
 * passed in already computed.
 */
export function netSettlement(
  side: Side,
  size: number,
  entryPrice: number,
  exitPrice: number,
  netFunding: number,
  openFee: number,
  closeFee: number,
): number {
  return realizedPnl(side, size, entryPrice, exitPrice) + netFunding - openFee - closeFee;
}

/* ------------------------------------------------------------------ *
 * Bundled RiskApi object — imported by the trigger-loop integration test.
 * ------------------------------------------------------------------ */

/** Single object satisfying `RiskApi` (DEX.md §3–§7). */
export const risk: RiskApi = {
  sideSign,
  notional,
  unrealizedPnl,
  collateralValue,
  equity,
  maintenanceMargin,
  isLiquidatable,
  fundingRate,
  fundingPayment,
  realizedPnl,
};
