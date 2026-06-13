/**
 * loop/triggerLoop.ts — the risk/trigger loop (Person 3).
 *
 * One deterministic pass over every active `MatchedPair`:
 *   1. route the pair to its market's config (multi-market),
 *   2. refresh perp mark + RWA NAV, enforce staleness guards (DEX.md §10.1),
 *   3. apply per-interval funding (DEX.md §5) — always before settle/liquidation
 *      ("SettleFunding before ...", DEX.md §7.4),
 *   4. if the pair has a pending close request → SettleClose P2P (DEX.md §8),
 *      else check liquidation (DEX.md §7).
 *
 * The fresh Chainlink `signedReport` (fullReport hex) is threaded into the
 * on-ledger choices so the price is verified in-transaction (CHAINLINK.md §6).
 *
 * Parameterized by the LedgerClient / PriceSource / RiskApi interfaces for
 * deterministic testing; it never recomputes risk math (uses the injected RiskApi).
 * Erasable-syntax-only TS; relative imports carry `.ts`.
 */

import type {
  LedgerClient,
  PriceSource,
  RiskApi,
  MarketConfig,
  CycleResult,
  PairEvaluation,
  CloseRequest,
} from "../types.ts";

/** Injected dependencies for a trigger cycle. */
export interface TriggerDeps {
  ledger: LedgerClient;
  prices: PriceSource;
  risk: RiskApi;
  /** One config per market; pairs route by `pair.market`. */
  markets: MarketConfig[];
  /** Clock source (unix seconds). Injectable for deterministic tests. */
  now: () => number;
  /** When true, push the fresh perp price to the on-ledger oracle each cycle. */
  pushPriceOnLedger?: boolean;
}

function blankEval(pair: { contractId: string; market: string }): PairEvaluation {
  return {
    contractId: pair.contractId,
    market: pair.market,
    markPrice: 0,
    rwaNav: 0,
    longEquity: 0,
    shortEquity: 0,
    maintenanceMargin: 0,
    fundingApplied: false,
    fundingRate: null,
    fundingPayment: null,
    liquidated: false,
    liquidatedSide: null,
    settled: false,
    settledSide: null,
    skippedStale: false,
    skippedNoConfig: false,
  };
}

/** Run one deterministic risk/trigger pass over all active matched pairs. */
export async function runTriggerCycle(deps: TriggerDeps): Promise<CycleResult> {
  const { ledger, prices, risk } = deps;
  const now = deps.now();

  const configByMarket = new Map<string, MarketConfig>();
  for (const m of deps.markets) configByMarket.set(m.market, m);

  const pairs = await ledger.getActiveMatchedPairs();
  const closeRequests = await ledger.getCloseRequests();
  const closeByPair = new Map<string, CloseRequest>();
  for (const c of closeRequests) closeByPair.set(c.matchedPairContractId, c);

  const perPair: PairEvaluation[] = [];
  let fundingApplied = 0;
  let liquidated = 0;
  let settled = 0;
  let skippedStale = 0;
  let skippedNoConfig = 0;
  const pushedMarkets = new Set<string>();

  for (const pair of pairs) {
    const evaluation = blankEval(pair);
    const config = configByMarket.get(pair.market);
    if (!config) {
      evaluation.skippedNoConfig = true;
      skippedNoConfig += 1;
      perPair.push(evaluation);
      continue;
    }

    const perp = await prices.getPerpPrice(pair.market);
    const nav = await prices.getRwaNav(pair.collateralInstrument);
    const mark = perp.price;
    const index = perp.price; // MVP: mark = index.
    evaluation.markPrice = mark;
    evaluation.rwaNav = nav.price;

    // Staleness guards (DEX.md §10.1).
    const markStale = now - perp.asOf > config.maxMarkStalenessSeconds;
    const navStale = now - nav.asOf > config.maxNavStalenessSeconds;
    if (markStale || navStale) {
      evaluation.skippedStale = true;
      skippedStale += 1;
      perPair.push(evaluation);
      continue;
    }

    // Push the fresh, non-stale, signed mark on-ledger once per market per cycle.
    if (deps.pushPriceOnLedger && !pushedMarkets.has(pair.market)) {
      await ledger.updateOraclePrice(perp);
      pushedMarkets.add(pair.market);
    }

    // Net funding received by the LONG so far (short's = negation; DEX.md §5).
    let netFundingLong = pair.accruedFundingLong;

    // Funding (DEX.md §5) — always before settle/liquidation (DEX.md §7.4).
    if (now - pair.lastFundingTime >= config.fundingIntervalSeconds) {
      const rate = risk.fundingRate(mark, index, config);
      const payment = risk.fundingPayment(rate, pair.size, index);
      await ledger.applyFunding(pair.contractId, {
        fundingRate: rate,
        fundingPayment: payment,
        indexPrice: index,
        at: now,
        signedReport: perp.signedReport,
      });
      netFundingLong = netFundingLong - payment; // positive payment => long pays.
      evaluation.fundingApplied = true;
      evaluation.fundingRate = rate;
      evaluation.fundingPayment = payment;
      fundingApplied += 1;
    }

    // Equities (post-funding) for observability + the liquidation decision.
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

    // Close request takes priority over liquidation (DEX.md §8).
    const close = closeByPair.get(pair.contractId);
    if (close) {
      const side = close.closingSide;
      const realizedPnl = risk.realizedPnl(side, pair.size, pair.entryPrice, mark);
      const netFunding = side === "Long" ? netFundingLong : -netFundingLong;
      await ledger.settleClose(pair.contractId, {
        closingSide: side,
        exitPrice: mark,
        realizedPnl,
        netFunding,
        at: now,
        signedReport: perp.signedReport,
      });
      evaluation.settled = true;
      evaluation.settledSide = side;
      settled += 1;
      perPair.push(evaluation);
      continue;
    }

    // Liquidation (DEX.md §7).
    if (risk.isLiquidatable(longEq, mm)) {
      await ledger.liquidate(pair.contractId, {
        side: "Long",
        markPrice: mark,
        equity: longEq,
        maintenanceMargin: mm,
        at: now,
        signedReport: perp.signedReport,
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
        signedReport: perp.signedReport,
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
    settled,
    skippedStale,
    skippedNoConfig,
    perPair,
  };
}

/**
 * Thin wrapper that runs `runTriggerCycle` on a fixed interval. Guards against
 * overlapping runs and swallows per-cycle errors so one bad cycle never kills the
 * loop. Tests target `runTriggerCycle` directly; this is for the live daemon.
 */
export function startTriggerLoop(deps: TriggerDeps, intervalMs: number): { stop: () => void } {
  let running = false;
  const timer = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      await runTriggerCycle(deps);
    } catch (err) {
      console.error("[triggerLoop] cycle failed:", err);
    } finally {
      running = false;
    }
  }, intervalMs);
  return { stop: () => clearInterval(timer) };
}
