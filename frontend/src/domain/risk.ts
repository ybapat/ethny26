/**
 * domain/risk.ts — risk math, ported VERBATIM from backend/src/risk/math.ts.
 *
 * The UI must show the exact equity / PnL / liquidation numbers the backend's
 * trigger loop and the on-ledger Daml `Decimal` math will produce, so these are
 * line-for-line the same formulas (each cites its DEX.md section). When the real
 * backend lands, these stay as the optimistic client-side preview; the ledger is
 * authoritative.
 */

import type { MarketConfig, Side } from "./types.ts";

export function clamp(x: number, lo: number, hi: number): number {
  return Math.min(Math.max(x, lo), hi);
}

export function round8(x: number): number {
  return Math.round((x + Number.EPSILON) * 1e8) / 1e8;
}

export function round6(x: number): number {
  return Math.round((x + Number.EPSILON) * 1e6) / 1e6;
}

/** +1 Long, -1 Short (DEX.md §1). */
export function sideSign(side: Side): number {
  return side === "Long" ? 1 : -1;
}

/** Notional N = S·price (DEX.md §3.1). */
export function notional(size: number, price: number): number {
  return size * price;
}

/** UPnL = (P_m − P_e)·S·sideSign (DEX.md §4). */
export function unrealizedPnl(
  side: Side,
  size: number,
  entryPrice: number,
  markPrice: number,
): number {
  return (markPrice - entryPrice) * size * sideSign(side);
}

/** CollateralValue = qty·P_rwa — NO haircut (DEX.md §6). */
export function collateralValue(collateralQty: number, rwaNav: number): number {
  return collateralQty * rwaNav;
}

/** E = CollateralValue + UPnL + netFunding (DEX.md §6; netFunding signed, + = received). */
export function equity(cv: number, upnl: number, netFunding: number): number {
  return cv + upnl + netFunding;
}

/** MM = S·P_m·MMR (DEX.md §7.1). */
export function maintenanceMargin(size: number, markPrice: number, mmr: number): number {
  return size * markPrice * mmr;
}

/** Liquidatable ⟺ E < MM (DEX.md §7.1, strict). */
export function isLiquidatable(eq: number, mm: number): boolean {
  return eq < mm;
}

/** Demo funding rate per interval (DEX.md §5.2). */
export function fundingRate(markPrice: number, indexPrice: number, cfg: MarketConfig): number {
  const premium = (markPrice - indexPrice) / indexPrice;
  const raw = cfg.fundingDampingFactor * premium + cfg.fundingBaseRate;
  return clamp(raw, -cfg.fundingClamp, cfg.fundingClamp);
}

/** FundingPayment = F·S·P_i (DEX.md §5.2). Positive ⇒ long pays short. */
export function fundingPayment(rate: number, size: number, indexPrice: number): number {
  return rate * size * indexPrice;
}

/** RealizedPnL = (P_x − P_e)·S·sideSign (DEX.md §8). */
export function realizedPnl(side: Side, size: number, entryPrice: number, exitPrice: number): number {
  return (exitPrice - entryPrice) * size * sideSign(side);
}

/**
 * Closed-form liquidation price (no haircut). Derived from the liquidation
 * condition `Equity < MM`, i.e. `CV + UPnL + netFunding = S·P_liq·MMR`:
 *   Long : P_liq = (S·P_e − CV − netFunding) / (S·(1 − MMR))   → below entry
 *   Short: P_liq = (S·P_e + CV + netFunding) / (S·(1 + MMR))   → above entry
 *
 * NOTE: DEX.md §7.2 (and backend/src/risk/math.ts) write the LONG numerator as
 * `CV + S·P_e`, which is a sign error — it only validates against the §9 Example B
 * *short* case and yields a liq price ABOVE entry for a long. Corrected here so the
 * UI shows the right number; the backend formula should be fixed to match.
 */
export function liquidationPrice(
  side: Side,
  size: number,
  entryPrice: number,
  cv: number,
  accruedFundingForSide: number,
  mmr: number,
): number {
  if (size <= 0) return 0;
  if (side === "Long") {
    return (size * entryPrice - cv - accruedFundingForSide) / (size * (1 - mmr));
  }
  return (size * entryPrice + cv + accruedFundingForSide) / (size * (1 + mmr));
}

/** Margin ratio E/(S·P_m) — compared against MMR (DEX.md §7.1). */
export function marginRatio(eq: number, size: number, markPrice: number): number {
  const denom = size * markPrice;
  return denom === 0 ? 0 : eq / denom;
}

/** Minimum collateral tokens to open at a given leverage (DEX.md §3.1). */
export function minCollateralQty(
  size: number,
  entryPrice: number,
  leverage: number,
  rwaNav: number,
): number {
  if (leverage <= 0 || rwaNav <= 0) return 0;
  return (size * entryPrice) / (leverage * rwaNav);
}
