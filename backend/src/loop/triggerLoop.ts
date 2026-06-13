/**
 * loop/triggerLoop.ts — the risk/trigger loop (Person 3 / Agent C).
 *
 * One deterministic pass over every active `MatchedPair`: refresh prices,
 * enforce staleness guards (DEX.md §10.1), apply per-interval funding
 * (DEX.md §5), then check liquidation (DEX.md §7) — strictly in that order
 * ("SettleFunding before Liquidate", DEX.md §7.4 / §10.1.3).
 *
 * The loop is parameterized by the `LedgerClient` / `PriceSource` / `RiskApi`
 * interfaces (dependency injection) so it is unit-testable with mocks. It never
 * recomputes risk math itself — every formula comes from the injected `RiskApi`
 * (src/risk/math.ts) and is authoritatively re-checked on-ledger in Daml.
 *
 * Erasable-syntax-only TS (no enum/namespace/param-properties); all relative
 * imports carry the `.ts` extension.
 */

import type {
  LedgerClient,
  PriceSource,
  RiskApi,
  MarketConfig,
  CycleResult,
  PairEvaluation,
} from "../types.ts";

/** Injected dependencies for a trigger cycle. */
export interface TriggerDeps {
  ledger: LedgerClient;
  prices: PriceSource;
  risk: RiskApi;
  config: MarketConfig;
  /** Clock source (unix seconds). Injectable for deterministic tests. */
  now: () => number;
  /** When true, push the fresh perp price to the on-ledger oracle each cycle. */
  pushPriceOnLedger?: boolean;
}

/**
 * Run one deterministic risk/trigger pass over all active matched pairs.
 *
 * Per pair: refresh perp mark + RWA NAV, apply staleness guards (DEX.md §10.1 —
 * mark-stale halts both funding and liquidation; NAV-stale is treated as a soft
 * skip), apply due funding (DEX.md §5) BEFORE evaluating liquidation
 * (DEX.md §7, ordering per §7.4/§10.1.3), then liquidate the breaching leg if
 * its post-funding equity drops below maintenance margin.
 */
export async function runTriggerCycle(deps: TriggerDeps): Promise<CycleResult> {
  const { ledger, prices, risk, config } = deps;
  const now = deps.now();

  const pairs = await ledger.getActiveMatchedPairs();
  const perPair: PairEvaluation[] = [];

  let fundingApplied = 0;
  let liquidated = 0;
  let skippedStale = 0;

  // Optionally publish the fresh perp price to the on-ledger oracle once per
  // cycle (the market mark is shared across all pairs of this market).
  let oraclePushed = false;

  for (const pair of pairs) {
    const perp = await prices.getPerpPrice(pair.market);
    const nav = await prices.getRwaNav(pair.collateralInstrument);

    const mark = perp.price;
    const index = perp.price; // MVP: mark = index.

    const evaluation: PairEvaluation = {
      contractId: pair.contractId,
      market: pair.market,
      markPrice: mark,
      rwaNav: nav.price,
      longEquity: 0,
      shortEquity: 0,
      maintenanceMargin: 0,
      fundingApplied: false,
      fundingRate: null,
      fundingPayment: null,
      liquidated: false,
      liquidatedSide: null,
      skippedStale: false,
    };

    // Staleness guards (DEX.md §10.1): mark-stale halts funding + liquidation;
    // NAV-stale is a soft skip (NAV feeds collateral value, can't act safely).
    const markStale = now - perp.asOf > config.maxMarkStalenessSeconds;
    const navStale = now - nav.asOf > config.maxNavStalenessSeconds;
    if (markStale || navStale) {
      evaluation.skippedStale = true;
      skippedStale += 1;
      perPair.push(evaluation);
      continue;
    }

    // Push the fresh, non-stale mark on-ledger once per cycle (before acting).
    if (deps.pushPriceOnLedger && !oraclePushed) {
      await ledger.updateOraclePrice(perp);
      oraclePushed = true;
    }

    // Net funding received by the LONG so far (signed USDCx). The short's net
    // funding is exactly the negation (DEX.md §5 / types.ts).
    let netFundingLong = pair.accruedFundingLong;

    // Funding (DEX.md §5) — applied BEFORE liquidation (DEX.md §7.4 / §10.1.3).
    if (now - pair.lastFundingTime >= config.fundingIntervalSeconds) {
      const rate = risk.fundingRate(mark, index, config);
      const payment = risk.fundingPayment(rate, pair.size, index);
      await ledger.applyFunding(pair.contractId, {
        fundingRate: rate,
        fundingPayment: payment,
        indexPrice: index,
        at: now,
      });
      // Positive payment => long pays short => long's net funding decreases.
      // Mirror MockLedger's mutation so liquidation uses the post-funding value.
      netFundingLong = netFundingLong - payment;
      evaluation.fundingApplied = true;
      evaluation.fundingRate = rate;
      evaluation.fundingPayment = payment;
      fundingApplied += 1;
    }

    // Liquidation (DEX.md §7) using the post-funding net funding.
    const longCV = risk.collateralValue(pair.long.collateralQty, nav.price);
    const shortCV = risk.collateralValue(pair.short.collateralQty, nav.price);
    const longUPnL = risk.unrealizedPnl("Long", pair.size, pair.entryPrice, mark);
    const shortUPnL = risk.unrealizedPnl("Short", pair.size, pair.entryPrice, mark);
    const longEq = risk.equity(longCV, longUPnL, netFundingLong);
    const shortEq = risk.equity(shortCV, shortUPnL, -netFundingLong);
    const mm = risk.maintenanceMargin(pair.size, mark, config.maintenanceMarginRate);

    evaluation.longEquity = longEq;
    evaluation.shortEquity = shortEq;
    evaluation.maintenanceMargin = mm;

    if (risk.isLiquidatable(longEq, mm)) {
      await ledger.liquidate(pair.contractId, {
        side: "Long",
        markPrice: mark,
        equity: longEq,
        maintenanceMargin: mm,
        at: now,
      });
      evaluation.liquidated = true;
      evaluation.liquidatedSide = "Long";
      liquidated += 1;
    } else if (risk.isLiquidatable(shortEq, mm)) {
      await ledger.liquidate(pair.contractId, {
        side: "Short",
        markPrice: mark,
        equity: shortEq,
        maintenanceMargin: mm,
        at: now,
      });
      evaluation.liquidated = true;
      evaluation.liquidatedSide = "Short";
      liquidated += 1;
    }

    perPair.push(evaluation);
  }

  return {
    at: now,
    evaluated: perPair.length,
    fundingApplied,
    liquidated,
    skippedStale,
    perPair,
  };
}

/**
 * Thin wrapper that runs `runTriggerCycle` on a fixed interval. Guards against
 * overlapping runs with a `running` flag and swallows per-cycle errors (logged)
 * so a single bad cycle never kills the loop. The tests target
 * `runTriggerCycle` directly; this is for the live daemon.
 */
export function startTriggerLoop(
  deps: TriggerDeps,
  intervalMs: number,
): { stop: () => void } {
  let running = false;
  const timer = setInterval(async () => {
    if (running) return; // skip if the previous cycle is still in flight.
    running = true;
    try {
      await runTriggerCycle(deps);
    } catch (err) {
      console.error("[triggerLoop] cycle failed:", err);
    } finally {
      running = false;
    }
  }, intervalMs);

  return {
    stop: () => clearInterval(timer),
  };
}
