/**
 * loop.test.ts — integration tests for the risk/trigger loop (Person 3).
 * Run: `node --test test/loop.test.ts` from backend/.
 *
 * Wires the REAL risk math (src/risk/math.ts) + MockLedger + an in-test price
 * stub through `runTriggerCycle` and asserts funding / liquidation / staleness
 * behaviour per DEX.md §5, §7, §10.1.
 *
 * The price stub is test-only (the product has no mock price source — prices come
 * from live Chainlink). Loop logic must be deterministic to assert, so the test
 * controls the price here.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { risk } from "../src/risk/math.ts";
import { MockLedger } from "../src/ledger/mockLedger.ts";
import { DEFAULT_MARKET } from "../src/config.ts";
import { runTriggerCycle, type TriggerDeps } from "../src/loop/triggerLoop.ts";
import type { MatchedPair, OraclePrice, PriceSource } from "../src/types.ts";

/** Deterministic in-test price source (not part of the product). */
class StubPriceSource implements PriceSource {
  private readonly perp: OraclePrice;
  private readonly nav: OraclePrice;
  constructor(perp: OraclePrice, nav: OraclePrice) {
    this.perp = perp;
    this.nav = nav;
  }
  async getPerpPrice(_market: string): Promise<OraclePrice> {
    return this.perp;
  }
  async getRwaNav(_instrument: string): Promise<OraclePrice> {
    return this.nav;
  }
}

const NOW = 1_750_000_000; // fixed clock (unix seconds)
const SIZE = 10;
const ENTRY = 2000;
// Initial margin satisfied at NAV 1.0: collateralQty = S·P_e·IMR = 10·2000·0.10.
const COLLATERAL = SIZE * ENTRY * DEFAULT_MARKET.initialMarginRate; // 2000 tokens

/** Seed a healthy ETH-USD long/short MatchedPair. */
function healthyPair(overrides: Partial<MatchedPair> = {}): MatchedPair {
  return {
    contractId: "pair-1",
    market: DEFAULT_MARKET.market,
    collateralInstrument: DEFAULT_MARKET.collateralInstrument,
    size: SIZE,
    entryPrice: ENTRY,
    long: { trader: "alice", collateralQty: COLLATERAL },
    short: { trader: "bob", collateralQty: COLLATERAL },
    accruedFundingLong: 0,
    lastFundingTime: NOW - 60, // not due by default
    openedAt: NOW - 7200,
    ...overrides,
  };
}

/**
 * Build deps with fresh prices by default. `markAsOf`/`navAsOf` control
 * staleness relative to NOW; `mark`/`nav` control the price levels.
 */
function makeDeps(opts: {
  pair: MatchedPair;
  mark?: number;
  nav?: number;
  markAsOf?: number;
  navAsOf?: number;
  pushPriceOnLedger?: boolean;
}): { deps: TriggerDeps; ledger: MockLedger } {
  const ledger = new MockLedger([opts.pair]);
  const prices = new StubPriceSource(
    { feedId: DEFAULT_MARKET.market, price: opts.mark ?? ENTRY, asOf: opts.markAsOf ?? NOW },
    { feedId: DEFAULT_MARKET.collateralInstrument, price: opts.nav ?? 1.0, asOf: opts.navAsOf ?? NOW },
  );
  const deps: TriggerDeps = {
    ledger,
    prices,
    risk,
    config: DEFAULT_MARKET,
    now: () => NOW,
    pushPriceOnLedger: opts.pushPriceOnLedger,
  };
  return { deps, ledger };
}

/* ----------------------------- 1. funding due ---------------------------- */

test("funding fires when due, no liquidation", async () => {
  const pair = healthyPair({ lastFundingTime: NOW - 3600 });
  const { deps, ledger } = makeDeps({ pair, mark: ENTRY });

  const result = await runTriggerCycle(deps);

  const fundings = ledger.actionsOfKind("applyFunding");
  assert.equal(fundings.length, 1, "one applyFunding action");
  assert.equal(fundings[0].contractId, "pair-1");
  assert.equal(result.fundingApplied, 1);
  assert.equal(result.liquidated, 0);
  assert.equal(ledger.actionsOfKind("liquidate").length, 0);

  const ev = result.perPair[0];
  assert.equal(ev.fundingApplied, true);
  assert.equal(ev.liquidated, false);
  assert.equal(ev.skippedStale, false);
  assert.notEqual(ev.fundingRate, null);
  assert.notEqual(ev.fundingPayment, null);

  // Loop's recorded payment matches what the risk math produces.
  const expectedRate = risk.fundingRate(ENTRY, ENTRY, DEFAULT_MARKET);
  const expectedPay = risk.fundingPayment(expectedRate, SIZE, ENTRY);
  assert.equal(ev.fundingRate, expectedRate);
  assert.equal(ev.fundingPayment, expectedPay);
  assert.equal(fundings[0].args.fundingPayment, expectedPay);
});

/* --------------------------- 2. funding not due -------------------------- */

test("funding does NOT fire when interval not elapsed", async () => {
  const pair = healthyPair({ lastFundingTime: NOW - 60 });
  const { deps, ledger } = makeDeps({ pair, mark: ENTRY });

  const result = await runTriggerCycle(deps);

  assert.equal(ledger.actionsOfKind("applyFunding").length, 0);
  assert.equal(result.fundingApplied, 0);
  assert.equal(result.perPair[0].fundingApplied, false);
});

/* --------------------------- 3. short liquidated ------------------------- */

test("short is liquidated on a large upward price spike", async () => {
  // mark > ~2095 makes shortEq < MM (see derivation in comments).
  const pair = healthyPair({ lastFundingTime: NOW - 60 });
  const { deps, ledger } = makeDeps({ pair, mark: 3000 });

  const result = await runTriggerCycle(deps);

  const liqs = ledger.actionsOfKind("liquidate");
  assert.equal(liqs.length, 1, "one liquidate action");
  assert.equal(liqs[0].args.side, "Short");
  assert.equal(liqs[0].args.markPrice, 3000);
  assert.equal(result.liquidated, 1);

  const ev = result.perPair[0];
  assert.equal(ev.liquidated, true);
  assert.equal(ev.liquidatedSide, "Short");

  // Pair removed from the active set after liquidation.
  const active = await ledger.getActiveMatchedPairs();
  assert.equal(active.length, 0);
  assert.equal(ledger.peek("pair-1"), undefined);
});

/* ---------------------------- 4. long liquidated ------------------------- */

test("long is liquidated on a large downward price crash", async () => {
  // mark < ~1894 makes longEq < MM.
  const pair = healthyPair({ lastFundingTime: NOW - 60 });
  const { deps, ledger } = makeDeps({ pair, mark: 1000 });

  const result = await runTriggerCycle(deps);

  const liqs = ledger.actionsOfKind("liquidate");
  assert.equal(liqs.length, 1);
  assert.equal(liqs[0].args.side, "Long");
  assert.equal(result.liquidated, 1);
  assert.equal(result.perPair[0].liquidatedSide, "Long");

  const active = await ledger.getActiveMatchedPairs();
  assert.equal(active.length, 0);
});

/* ----------------------------- 5. healthy ------------------------------- */

test("healthy pair: small move => no liquidation", async () => {
  const pair = healthyPair({ lastFundingTime: NOW - 60 });
  const { deps, ledger } = makeDeps({ pair, mark: 2050 });

  const result = await runTriggerCycle(deps);

  assert.equal(ledger.actionsOfKind("liquidate").length, 0);
  assert.equal(result.liquidated, 0);
  assert.equal(result.perPair[0].liquidated, false);
  assert.equal((await ledger.getActiveMatchedPairs()).length, 1);
});

/* ----------------------------- 6. stale mark ---------------------------- */

test("stale mark price => pair skipped, no funding, no liquidation", async () => {
  // Funding would be due AND price would liquidate the short — but staleness
  // must halt both (DEX.md §10.1).
  const pair = healthyPair({ lastFundingTime: NOW - 3600 });
  const { deps, ledger } = makeDeps({
    pair,
    mark: 3000,
    markAsOf: NOW - 10000, // > 300s stale
  });

  const result = await runTriggerCycle(deps);

  assert.equal(ledger.actionsOfKind("applyFunding").length, 0);
  assert.equal(ledger.actionsOfKind("liquidate").length, 0);
  assert.equal(result.skippedStale, 1);
  assert.equal(result.fundingApplied, 0);
  assert.equal(result.liquidated, 0);

  const ev = result.perPair[0];
  assert.equal(ev.skippedStale, true);
  assert.equal(ev.fundingApplied, false);
  assert.equal(ev.liquidated, false);

  // Still active.
  assert.equal((await ledger.getActiveMatchedPairs()).length, 1);
});

/* -------------------------- 7. CycleResult counts ----------------------- */

test("CycleResult counts are consistent with perPair array", async () => {
  const pair = healthyPair({ lastFundingTime: NOW - 3600 });
  const { deps } = makeDeps({ pair, mark: ENTRY });

  const result = await runTriggerCycle(deps);

  assert.equal(result.at, NOW);
  assert.equal(result.evaluated, result.perPair.length);
  assert.equal(
    result.fundingApplied,
    result.perPair.filter((p) => p.fundingApplied).length,
  );
  assert.equal(
    result.liquidated,
    result.perPair.filter((p) => p.liquidated).length,
  );
  assert.equal(
    result.skippedStale,
    result.perPair.filter((p) => p.skippedStale).length,
  );
});
