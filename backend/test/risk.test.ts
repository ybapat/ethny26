/**
 * risk.test.ts — correctness tests for the risk-math core.
 *
 * Encodes DEX.md §9 worked examples (A long, B short) plus formula/edge-case
 * checks. Floats are compared with a 1e-6 tolerance.
 *
 * Run: `node --test test/risk.test.ts` from backend/.
 */

import test from "node:test";
import assert from "node:assert/strict";

import type { MarketConfig } from "../src/types.ts";
import {
  risk,
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
  liquidationPrice,
  netSettlement,
  clamp,
  round6,
  round8,
} from "../src/risk/math.ts";

const EPS = 1e-6;
function close(a: number, b: number, eps = EPS): void {
  assert.ok(Math.abs(a - b) < eps, `expected ${a} ≈ ${b} (|Δ|=${Math.abs(a - b)})`);
}

/** Demo market config matching DEX.md §9 params (F=+0.02%/hr demo, MMR 5%). */
const cfg: MarketConfig = {
  market: "BTC-USD",
  underlyingFeedId: "0xfeed",
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
};

/* ------------------------------------------------------------------ *
 * Example A — Long → fund → close profit (DEX.md §9 A)
 * ------------------------------------------------------------------ */
test("Example A (long): UPnL, funding, collateral, equity, MM", () => {
  // +1h: mark 201 → UPnL = (201−200)·50 = +50
  close(unrealizedPnl("Long", 50, 200, 201), 50);

  // funding at rate 0.0002, size 50, index 200 = 2.00 (long pays)
  close(fundingPayment(0.0002, 50, 200), 2.0);

  // collateralValue(2.0, 520) = 1040 (no haircut)
  close(collateralValue(2.0, 520), 1040);

  // equity(1040, +50, −2) = 1088  (long paid funding ⇒ netFunding −2)
  close(equity(1040, 50, -2), 1088);

  // MM(50, 201, 0.05) = 502.5 → safe
  close(maintenanceMargin(50, 201, 0.05), 502.5);
  assert.equal(isLiquidatable(1088, 502.5), false);
});

test("Example A (long): close @205 → realizedPnl +250, net settlement", () => {
  close(realizedPnl("Long", 50, 200, 205), 250);

  // fees: open = S·P_e·fee = 50·200·0.0005 = 5.00; close = 50·205·0.0005 = 5.125
  const openFee = 50 * 200 * cfg.takerFeeRate;
  const closeFee = 50 * 205 * cfg.takerFeeRate;
  close(openFee, 5.0);
  close(closeFee, 5.125);

  // funding over 3h = −6.00 (long paid). NetProfit = 250 − 6 − 5 − 5.125 = 233.875
  const net = netSettlement("Long", 50, 200, 205, -6.0, openFee, closeFee);
  close(net, 233.875);
});

/* ------------------------------------------------------------------ *
 * Example B — Short → mark up → near-liq → close loss (DEX.md §9 B)
 * ------------------------------------------------------------------ */
test("Example B (short): UPnL, funding sign, MM, liq price", () => {
  // mark 215 → UPnL = (200−215)·100 = −1500
  close(unrealizedPnl("Short", 100, 200, 215), -1500);

  // single-interval funding: 0.0002·100·200 = 4.0; short RECEIVES (long pays) ⇒ +4 for short
  // (DEX.md §9 B: 24 intervals · 0.0002·100·200 = +96 ⇒ 96/24 = 4.0 per interval)
  close(fundingPayment(0.0002, 100, 200), 4.0);

  // MM(100, 215, 0.05) = 1075
  close(maintenanceMargin(100, 215, 0.05), 1075);

  // P_liq_short with CollateralValue=4160, netFunding 0:
  //   (4160 + 0 + 100·200) / (100·1.05) = 24160/105 = 230.0952381
  close(liquidationPrice("Short", 100, 200, 4160, 0, 0.05), 24160 / 105);
  close(liquidationPrice("Short", 100, 200, 4160, 0, 0.05), 230.0952380952381);
});

test("Example B (short): equity with cumulative funding stays safe", () => {
  // 24 intervals, short receives each: netFunding_short = +24·2.0 = +96
  const netFundingShort = 24 * fundingPayment(0.0002, 100, 200);
  close(netFundingShort, 96);

  // E = CollateralValue + UPnL + netFunding = 4160 + (−1500) + 96 = 2756
  // (DEX.md uses 4160.45 incl. 1d yield; we assert the formula on the base coll value)
  const e = equity(collateralValue(8.0, 520), unrealizedPnl("Short", 100, 200, 215), netFundingShort);
  close(e, 2756);
  assert.equal(isLiquidatable(e, maintenanceMargin(100, 215, 0.05)), false);
});

test("Example B (short): close @217 → realizedPnl −1700", () => {
  close(realizedPnl("Short", 100, 200, 217), -1700);
});

/* ------------------------------------------------------------------ *
 * Liquidation price — long form sanity (DEX.md §7.2)
 * ------------------------------------------------------------------ */
test("liquidationPrice long: (collVal + funding + S·Pe)/(S·(1−MMR))", () => {
  // Example A: collVal 1040, funding 0, S 50, Pe 200, MMR 0.05
  //   (1040 + 0 + 10000) / (50·0.95) = 11040/47.5 = 232.4210526...
  close(liquidationPrice("Long", 50, 200, 1040, 0, 0.05), 11040 / 47.5);
});

/* ------------------------------------------------------------------ *
 * fundingRate — clamping + base-rate + sign (DEX.md §5.2)
 * ------------------------------------------------------------------ */
test("fundingRate: huge positive premium clamps to +fundingClamp", () => {
  close(fundingRate(1000, 200, cfg), cfg.fundingClamp); // +0.0075
});

test("fundingRate: huge negative premium clamps to −fundingClamp", () => {
  close(fundingRate(1, 200, cfg), -cfg.fundingClamp); // −0.0075
});

test("fundingRate: zero premium ≈ base rate", () => {
  close(fundingRate(200, 200, cfg), cfg.fundingBaseRate); // 0.0001
});

test("fundingRate: tiny premium ≈ base rate", () => {
  // premium = (200.001−200)/200 = 5e-6 ; 0.3·5e-6 = 1.5e-6 + base 1e-4
  close(fundingRate(200.001, 200, cfg), 0.3 * (0.001 / 200) + cfg.fundingBaseRate);
});

test("fundingRate: mark>index → positive (long pays); mark<index → negative", () => {
  assert.ok(fundingRate(210, 200, cfg) > 0);
  assert.ok(fundingRate(190, 200, cfg) < 0);
});

/* ------------------------------------------------------------------ *
 * isLiquidatable — strict boundary (DEX.md §7.1)
 * ------------------------------------------------------------------ */
test("isLiquidatable: equity just below MM → true; equal/above → false", () => {
  assert.equal(isLiquidatable(99.999999, 100), true);
  assert.equal(isLiquidatable(100, 100), false); // equal is healthy (strict <)
  assert.equal(isLiquidatable(100.000001, 100), false);
});

/* ------------------------------------------------------------------ *
 * sideSign / unrealizedPnl sign correctness (DEX.md §1, §4)
 * ------------------------------------------------------------------ */
test("sideSign: +1 Long, −1 Short", () => {
  assert.equal(sideSign("Long"), 1);
  assert.equal(sideSign("Short"), -1);
});

test("unrealizedPnl sign: DEX.md §4 examples", () => {
  // Long 10 @ 100, mark 110 ⇒ +100 ; mark 90 ⇒ −100
  close(unrealizedPnl("Long", 10, 100, 110), 100);
  close(unrealizedPnl("Long", 10, 100, 90), -100);
  // Short is the mirror
  close(unrealizedPnl("Short", 10, 100, 110), -100);
  close(unrealizedPnl("Short", 10, 100, 90), 100);
});

test("notional = size · price", () => {
  close(notional(50, 200), 10000);
});

/* ------------------------------------------------------------------ *
 * Helpers: clamp / round
 * ------------------------------------------------------------------ */
test("clamp bounds", () => {
  close(clamp(5, 0, 10), 5);
  close(clamp(-1, 0, 10), 0);
  close(clamp(11, 0, 10), 10);
});

test("round8 / round6", () => {
  close(round8(1.123456789), 1.12345679);
  close(round6(1.1234564), 1.123456);
});

/* ------------------------------------------------------------------ *
 * risk object methods equal the named-function results
 * ------------------------------------------------------------------ */
test("risk object methods match named functions", () => {
  assert.equal(risk.sideSign("Long"), sideSign("Long"));
  assert.equal(risk.sideSign("Short"), sideSign("Short"));
  close(risk.notional(50, 200), notional(50, 200));
  close(risk.unrealizedPnl("Short", 100, 200, 215), unrealizedPnl("Short", 100, 200, 215));
  close(risk.collateralValue(2.0, 520), collateralValue(2.0, 520));
  close(risk.equity(1040, 50, -2), equity(1040, 50, -2));
  close(risk.maintenanceMargin(50, 201, 0.05), maintenanceMargin(50, 201, 0.05));
  assert.equal(risk.isLiquidatable(1088, 502.5), isLiquidatable(1088, 502.5));
  close(risk.fundingRate(210, 200, cfg), fundingRate(210, 200, cfg));
  close(risk.fundingPayment(0.0002, 50, 200), fundingPayment(0.0002, 50, 200));
  close(risk.realizedPnl("Long", 50, 200, 205), realizedPnl("Long", 50, 200, 205));
});
