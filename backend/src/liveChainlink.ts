/**
 * liveChainlink.ts — the REAL product loop, EVENT-DRIVEN off Chainlink Data Streams.
 *
 * Architecture (CHAINLINK.md §3, DEX.md §5/§7/§10.1):
 *   - A WebSocket subscription receives signed price pushes sub-second and caches
 *     the latest price (no polling).
 *   - PUSH-DRIVEN: every price update triggers a (throttled) trigger cycle, so
 *     LIQUIDATION reacts within ~1s of a price move.
 *   - TIMER-DRIVEN: a fallback interval also runs a cycle so FUNDING fires on its
 *     schedule and the keeper stays alive even if the socket goes quiet.
 *
 * The only remaining stand-in is the ledger (MockLedger) — swap it for the real
 * @c7-digital/ledger Canton client once Person 1's Daml DAR lands.
 *
 * Run:  DS_API_KEY=… DS_USER_SECRET=… npm run live:chainlink   (loads .env)
 */
import readline from "node:readline";
import { MockLedger } from "./ledger/mockLedger.ts";
import { risk } from "./risk/math.ts";
import { runTriggerCycle } from "./loop/triggerLoop.ts";
import { DEFAULT_MARKET, FEED_IDS } from "./config.ts";
import { dataStreamsWsPriceSourceFromEnv, readDsEnv } from "./oracle/fromEnv.ts";
import type { MatchedPair, OraclePrice, PriceSource } from "./types.ts";
import type { DataStreamsWsPriceSource } from "./oracle/wsPriceSource.ts";

const nowSec = () => Math.floor(Date.now() / 1000);

// --- Run config (kept here in the file; .env holds ONLY Chainlink credentials) ---
const market = "ETH-USD"; // perp market; maps to the ETH/USD V3 feed
const navValue = 1.0; // stable-collateral NAV placeholder until the V9/SmartData NAV feed is wired
const throttleMs = 1000; // min gap between push-driven cycles (liquidation reactivity)
const fallbackMs = 5000; // safety cycle so funding fires + loop survives a quiet socket
const fundingSeconds = 30; // funding cadence for the demo (production: 3600 = 1h)
const cfg = { ...DEFAULT_MARKET, market, fundingIntervalSeconds: fundingSeconds };

/** Perp price from live Chainlink WS; RWA NAV is a stable placeholder (V9 stretch). */
class LivePerpStableNav implements PriceSource {
  private readonly real: PriceSource;
  private readonly nav: number;
  constructor(real: PriceSource, nav: number) {
    this.real = real;
    this.nav = nav;
  }
  getPerpPrice(m: string): Promise<OraclePrice> {
    return this.real.getPerpPrice(m);
  }
  async getRwaNav(instrument: string): Promise<OraclePrice> {
    return { feedId: instrument, price: this.nav, asOf: nowSec() };
  }
}

async function main() {
  try {
    readDsEnv(); // validate creds early with a clear error
  } catch (e) {
    console.error(String((e as Error).message));
    process.exit(2);
  }

  const ws: DataStreamsWsPriceSource = dataStreamsWsPriceSourceFromEnv({ [market]: FEED_IDS.ETH_USD });
  const prices = new LivePerpStableNav(ws, navValue);

  console.log(`Live Chainlink trigger loop (event-driven WS) — market=${market}`);
  console.log("Subscribing to Chainlink Data Streams and waiting for the first push…");
  ws.start();
  const open = await ws.waitForFirst(market, 15_000);

  const entry = open.price;
  const size = 10;
  const collateralQty = (size * entry * cfg.initialMarginRate) / navValue;
  const t = nowSec();
  const pair: MatchedPair = {
    contractId: "pair-1",
    market,
    collateralInstrument: cfg.collateralInstrument,
    size,
    entryPrice: entry,
    long: { trader: "Alice", collateralQty },
    short: { trader: "Bob", collateralQty },
    accruedFundingLong: 0,
    lastFundingTime: t,
    openedAt: t,
  };
  const ledger = new MockLedger([pair]);
  console.log(
    `Opened: Alice LONG / Bob SHORT ${size} @ ${entry} (live), ${collateralQty.toFixed(2)} collateral each. ` +
      `Liq ~±${(cfg.initialMarginRate - cfg.maintenanceMarginRate) * 100}% move.\n`,
  );

  // Throttled cycle runner shared by the push handler and the fallback timer.
  let lastRun = 0;
  let running = false;
  let pendingTimer: ReturnType<typeof setTimeout> | null = null;

  async function runCycle(reason: string) {
    if (running) return;
    running = true;
    lastRun = Date.now();
    try {
      const r = await runTriggerCycle({ ledger, prices, risk, markets: [cfg], now: nowSec, pushPriceOnLedger: true });
      if (r.evaluated === 0) {
        console.log(`[${nowSec()}] (${reason}) no active pairs — type 'q' to quit.`);
        return;
      }
      const e = r.perPair[0];
      const parts = [
        `[${nowSec()}] (${reason}) ETH=${e.markPrice}`,
        `longEq=${e.longEquity.toFixed(0)}`,
        `shortEq=${e.shortEquity.toFixed(0)}`,
        `MM=${e.maintenanceMargin.toFixed(0)}`,
      ];
      if (e.fundingApplied) parts.push(`FUNDING(${e.fundingPayment?.toFixed(2)})`);
      if (e.liquidated) parts.push(`*** LIQUIDATED ${e.liquidatedSide} ***`);
      if (e.skippedStale) parts.push(`STALE-skip`);
      console.log(parts.join("  "));
    } catch (err) {
      console.error(`[${nowSec()}] cycle error: ${String((err as Error).message)}`);
    } finally {
      running = false;
    }
  }

  /** Throttle: run now if enough time passed, else schedule a trailing run. */
  function schedule(reason: string) {
    const since = Date.now() - lastRun;
    if (since >= throttleMs) {
      void runCycle(reason);
    } else if (!pendingTimer) {
      pendingTimer = setTimeout(() => {
        pendingTimer = null;
        void runCycle(reason);
      }, throttleMs - since);
    }
  }

  // PUSH-DRIVEN: react to every Chainlink price update (liquidation reactivity).
  ws.onUpdate = () => schedule("push");
  // TIMER-DRIVEN: guarantees funding + liveness even if pushes pause.
  const fallback = setInterval(() => schedule("timer"), fallbackMs);

  await runCycle("open"); // initial mark

  const rl = readline.createInterface({ input: process.stdin });
  rl.on("line", (line) => {
    if (line.trim() === "q" || line.trim() === "quit") {
      clearInterval(fallback);
      ws.stop();
      rl.close();
      process.exit(0);
    }
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
