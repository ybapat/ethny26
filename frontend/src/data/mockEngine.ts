/**
 * data/mockEngine.ts — an in-browser simulation of the entire venue.
 *
 * It stands in for the not-yet-wired backend (matching engine + risk/trigger loop
 * + Canton ledger) so the UI can exercise EVERY flow today: place/cancel orders,
 * dark-CLOB matching into MatchedPairs, the funding tick, liquidation, and P2P
 * close/settle — all using the real DEX.md math (domain/risk.ts).
 *
 * It plays the role of the VENUE (it can see the whole book). Per-party privacy
 * filtering happens above this layer, in the store's selectors — exactly how
 * Canton stakeholder visibility would gate what each party sees.
 *
 * Seam for going live: this whole module is hidden behind src/data/api.ts. Swap it
 * for a client that calls the JSON Ledger API / PQS and nothing in the UI changes.
 */

import {
  collateralValue,
  equity,
  fundingPayment,
  fundingRate,
  isLiquidatable,
  liquidationPrice,
  maintenanceMargin,
  marginRatio,
  minCollateralQty,
  realizedPnl,
  round6,
  round8,
  unrealizedPnl,
} from "../domain/risk.ts";
import { INSTRUMENTS, MARKETS, SEED_PRICE } from "../domain/config.ts";
import type {
  Candle,
  CloseRequest,
  CycleResult,
  DerivedPosition,
  Fill,
  Holding,
  LiquidationEvent,
  MarketConfig,
  MatchedPair,
  OraclePrice,
  Order,
  PairEvaluation,
  Party,
  PoRStatus,
  SettlementEvent,
  Side,
} from "../domain/types.ts";

const TICK_MS = 1500; // price tick cadence
const TICKS_PER_CANDLE = 8;
const MAX_CANDLES = 120;
const DEMO_FUNDING_MS = 30_000; // accelerated funding cadence for the demo
const MAX_TAPE = 60;

const now = () => Math.floor(Date.now() / 1000);

/** Default demo parties. Alice & Bob are `trader` wallets; venue/regulator see
 * all; outsider sees none. More traders can be created at runtime (createWallet). */
export const ALICE = "alice::1220a1f0";
export const BOB = "bob::1220b2e1";
export const PARTIES: Party[] = [
  { role: "trader", partyId: ALICE, label: "Alice" },
  { role: "trader", partyId: BOB, label: "Bob" },
  { role: "venue", partyId: "venue::1220ce00", label: "Venue Operator" },
  { role: "regulator", partyId: "regulator::1220d9aa", label: "Regulator" },
  { role: "outsider", partyId: "mallory::1220ff77", label: "Outsider" },
];

/** Extra makers whose orders populate the book but who are NOT demo viewpoints. */
const MAKERS = ["carol::1220c3d2", "dave::1220e4c3"];

export interface EngineSnapshot {
  now: number;
  running: boolean;
  parties: Party[];
  markets: MarketConfig[];
  prices: Record<string, OraclePrice>;
  candles: Record<string, Candle[]>;
  navs: Record<string, OraclePrice>;
  orders: Order[];
  pairs: MatchedPair[];
  closeRequests: CloseRequest[];
  fills: Fill[];
  liquidations: LiquidationEvent[];
  settlements: SettlementEvent[];
  holdings: Record<string, Holding[]>;
  por: Record<string, PoRStatus>;
  lastCycle: CycleResult | null;
  fundingByMarket: Record<string, { rate: number; nextAt: number }>;
  /** Real money-market APY the RWA NAV accrues at (live gateway sources it from the US Treasury). */
  rwaApy?: number;
}

export interface PlaceOrderInput {
  market: string;
  trader: string;
  side: Side;
  size: number;
  limitPrice: number;
  leverage: number;
}

type Listener = (s: EngineSnapshot) => void;

export class MockEngine {
  private prices = new Map<string, OraclePrice>();
  private candles = new Map<string, Candle[]>();
  private navs = new Map<string, OraclePrice>();
  private orders: Order[] = [];
  private pairs: MatchedPair[] = [];
  private closeRequests: CloseRequest[] = [];
  private fills: Fill[] = [];
  private liquidations: LiquidationEvent[] = [];
  private settlements: SettlementEvent[] = [];
  private holdings = new Map<string, Holding[]>();
  private por = new Map<string, PoRStatus>();
  private lastCycle: CycleResult | null = null;
  private fundingNext = new Map<string, number>();
  private lastFundingRate = new Map<string, number>();

  private tickCount = 0;
  private idSeq = 1;
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private listeners = new Set<Listener>();
  private extraTraders: Party[] = []; // traders created at runtime via createWallet

  constructor() {
    this.seed();
  }

  /* --------------------- runtime wallets / liquidation ----------------- */

  /** Create a new trader wallet (mock: a synthetic party with seeded collateral). */
  async createWallet(name: string): Promise<string | null> {
    const slug = name.toLowerCase().replace(/[^a-z0-9]/g, "") || "trader";
    const id = `${slug}::1220${this.id("w")}`;
    this.extraTraders.push({ role: "trader", partyId: id, label: name });
    this.holdings.set(id, [
      { instrument: "tMMF-USD", symbol: "tMMF", owner: id, amount: 5000, locked: 0, isCollateral: true },
    ]);
    this.emit();
    return id;
  }

  /** Force/simulate a liquidation of one side of a pair (drives the demo path). */
  liquidate(contractId: string, side: Side): void {
    const pair = this.pairs.find((p) => p.contractId === contractId);
    if (!pair) return;
    const cfg = this.cfg(pair.market);
    if (!cfg) return;
    const navPrice = this.navs.get(pair.collateralInstrument)!.price;
    const crash = round8(pair.entryPrice * (side === "Long" ? 0.85 : 1.15));
    this.prices.set(pair.market, { ...this.prices.get(pair.market)!, price: crash, asOf: now() });
    const leg = side === "Long" ? pair.long : pair.short;
    const eq = equity(collateralValue(leg.collateralQty, navPrice), unrealizedPnl(side, pair.size, pair.entryPrice, crash), 0);
    const mm = maintenanceMargin(pair.size, crash, cfg.maintenanceMarginRate);
    this.liquidatePair(pair, side, crash, eq, mm);
    this.emit();
  }

  /* ----------------------------- lifecycle ----------------------------- */

  start(): void {
    if (this.timer) return;
    this.running = true;
    this.timer = setInterval(() => this.tick(), TICK_MS);
    this.emit();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.running = false;
    this.emit();
  }

  setRunning(on: boolean): void {
    on ? this.start() : this.stop();
  }

  subscribe(cb: Listener): () => void {
    this.listeners.add(cb);
    cb(this.snapshot());
    return () => this.listeners.delete(cb);
  }

  private emit(): void {
    const snap = this.snapshot();
    for (const l of this.listeners) l(snap);
  }

  private id(prefix: string): string {
    return `${prefix}-${(this.idSeq++).toString(36).padStart(4, "0")}`;
  }

  /* ------------------------------- seed -------------------------------- */

  private seed(): void {
    for (const m of MARKETS) {
      const p = SEED_PRICE[m.market];
      this.prices.set(m.market, { feedId: m.underlyingFeedId, price: p, asOf: now() });
      this.candles.set(m.market, this.seedCandles(p));
      this.fundingNext.set(m.market, Date.now() + DEMO_FUNDING_MS);
      this.lastFundingRate.set(m.market, 0);
    }
    for (const meta of Object.values(INSTRUMENTS)) {
      this.navs.set(meta.instrument, {
        feedId: meta.instrument,
        price: meta.nav,
        asOf: now(),
      });
    }

    // PoR attestations (CANTON-RWA.md §6).
    this.por.set("tMMF-USD", {
      instrument: "tMMF-USD",
      reserves: 128_400_000,
      issuedSupply: 121_900_000,
      solvent: true,
      whitelisted: true,
      asOf: now(),
    });

    // Wallets: every demo trader holds RWA collateral + some USDCx.
    for (const party of [ALICE, BOB, ...MAKERS]) {
      this.holdings.set(party, [
        {
          instrument: "tMMF-USD",
          symbol: "tMMF",
          owner: party,
          amount: 5000,
          locked: 0,
          isCollateral: true,
        },
        {
          instrument: "USDCx",
          symbol: "USDCx",
          owner: party,
          amount: 25000,
          locked: 0,
          isCollateral: false,
        },
      ]);
    }

    // Seed a live ETH-USD pair (Alice long vs Bob short) so positions show on load.
    const eth = SEED_PRICE["ETH-USD"];
    const cfg = MARKETS[0];
    const size = 4;
    const qty = round6(minCollateralQty(size, eth, 1 / cfg.initialMarginRate, INSTRUMENTS["tMMF-USD"].nav) * 1.4);
    this.lock(ALICE, "tMMF-USD", qty);
    this.lock(BOB, "tMMF-USD", qty);
    this.pairs.push({
      contractId: this.id("pair"),
      market: "ETH-USD",
      collateralInstrument: "tMMF-USD",
      size,
      entryPrice: eth,
      long: { trader: ALICE, collateralQty: qty },
      short: { trader: BOB, collateralQty: qty },
      accruedFundingLong: 0,
      lastFundingTime: now(),
      openedAt: now() - 3600,
    });

    // Seed resting maker orders on both markets (book depth; private to venue).
    this.seedBook("ETH-USD", eth);
    this.seedBook("BTC-USD", SEED_PRICE["BTC-USD"]);
  }

  private seedCandles(p: number): Candle[] {
    const out: Candle[] = [];
    let prev = p * 0.985;
    const t0 = now() - MAX_CANDLES * (TICK_MS / 1000) * TICKS_PER_CANDLE;
    for (let i = 0; i < MAX_CANDLES; i++) {
      const drift = (p - prev) * 0.05;
      const open = prev;
      const close = prev + drift + (Math.random() - 0.5) * p * 0.004;
      const high = Math.max(open, close) + Math.random() * p * 0.002;
      const low = Math.min(open, close) - Math.random() * p * 0.002;
      out.push({ time: t0 + i * (TICK_MS / 1000) * TICKS_PER_CANDLE, open, high, low, close });
      prev = close;
    }
    return out;
  }

  private seedBook(market: string, mid: number): void {
    const cfg = this.cfg(market)!;
    const lev = 1 / cfg.initialMarginRate;
    const mk = (trader: string, side: Side, off: number, size: number) => {
      const limitPrice = round8(mid * (1 + off));
      const qty = round6(minCollateralQty(size, limitPrice, lev, INSTRUMENTS["tMMF-USD"].nav) * 1.3);
      this.lock(trader, "tMMF-USD", qty);
      this.orders.push({
        contractId: this.id("ord"),
        market,
        trader,
        side,
        size,
        remaining: size,
        limitPrice,
        leverage: lev,
        collateralInstrument: "tMMF-USD",
        collateralQty: qty,
        status: "Resting",
        createdAt: now(),
      });
    };
    // Bids (long) below mid, asks (short) above mid — a non-crossing resting book.
    mk(MAKERS[0], "Long", -0.0015, 3);
    mk(MAKERS[0], "Long", -0.0040, 6);
    mk(MAKERS[1], "Long", -0.0075, 9);
    mk(MAKERS[1], "Short", 0.0015, 3);
    mk(MAKERS[0], "Short", 0.0042, 6);
    mk(MAKERS[1], "Short", 0.0080, 9);
  }

  /* --------------------------- holdings utils -------------------------- */

  private wallet(party: string): Holding[] {
    if (!this.holdings.has(party)) this.holdings.set(party, []);
    return this.holdings.get(party)!;
  }

  private holding(party: string, instrument: string): Holding {
    const w = this.wallet(party);
    let h = w.find((x) => x.instrument === instrument);
    if (!h) {
      const meta = INSTRUMENTS[instrument];
      h = {
        instrument,
        symbol: meta?.symbol ?? instrument,
        owner: party,
        amount: 0,
        locked: 0,
        isCollateral: meta?.isCollateral ?? false,
      };
      w.push(h);
    }
    return h;
  }

  private lock(party: string, instrument: string, qty: number): boolean {
    const h = this.holding(party, instrument);
    if (h.amount + 1e-9 < qty) return false;
    h.amount = round6(h.amount - qty);
    h.locked = round6(h.locked + qty);
    return true;
  }

  private unlock(party: string, instrument: string, qty: number): void {
    const h = this.holding(party, instrument);
    const q = Math.min(qty, h.locked);
    h.locked = round6(h.locked - q);
    h.amount = round6(h.amount + q);
  }

  private credit(party: string, instrument: string, qty: number): void {
    const h = this.holding(party, instrument);
    h.amount = round6(h.amount + qty);
  }

  private seizeLocked(party: string, instrument: string, qty: number): number {
    const h = this.holding(party, instrument);
    const q = Math.min(qty, h.locked);
    h.locked = round6(h.locked - q);
    return q;
  }

  /* ------------------------------- ticking ----------------------------- */

  private tick(): void {
    this.tickCount++;
    const t = now();

    // Random-walk every market's price + roll candles.
    for (const m of this.markets()) {
      const cur = this.prices.get(m.market)!;
      const vol = m.market === "BTC-USD" ? 0.0016 : 0.0022;
      const drift = (Math.random() - 0.5) * 2 * vol;
      const next = round8(Math.max(1, cur.price * (1 + drift)));
      this.prices.set(m.market, { feedId: m.underlyingFeedId, price: next, asOf: t });
      this.rollCandle(m.market, next);
    }

    // RWA NAV drifts gently upward (yield accrual, CANTON-RWA.md §5).
    const nav = this.navs.get("tMMF-USD")!;
    const perTick = INSTRUMENTS["tMMF-USD"].apy / (365 * 24 * 3600) * (TICK_MS / 1000);
    this.navs.set("tMMF-USD", {
      feedId: "tMMF-USD",
      price: round8(nav.price * (1 + perTick)),
      asOf: t,
    });

    // Accelerated demo funding.
    for (const m of this.markets()) {
      if (Date.now() >= (this.fundingNext.get(m.market) ?? Infinity)) {
        this.applyFunding(m.market);
        this.fundingNext.set(m.market, Date.now() + DEMO_FUNDING_MS);
      }
    }

    this.runCycle();
    this.emit();
  }

  private rollCandle(market: string, price: number): void {
    const arr = this.candles.get(market)!;
    const last = arr[arr.length - 1];
    if (this.tickCount % TICKS_PER_CANDLE === 0 || !last) {
      arr.push({ time: now(), open: price, high: price, low: price, close: price });
      if (arr.length > MAX_CANDLES) arr.shift();
    } else {
      last.close = price;
      last.high = Math.max(last.high, price);
      last.low = Math.min(last.low, price);
    }
  }

  /* ------------------- trigger loop (mirrors triggerLoop.ts) ----------- */

  private runCycle(): void {
    const t = now();
    const perPair: PairEvaluation[] = [];
    let liquidated = 0;
    let settled = 0;
    const closeByPair = new Map<string, CloseRequest>();
    for (const c of this.closeRequests) closeByPair.set(c.matchedPairContractId, c);

    for (const pair of [...this.pairs]) {
      const cfg = this.cfg(pair.market);
      const ev = this.blankEval(pair);
      if (!cfg) {
        ev.skippedNoConfig = true;
        perPair.push(ev);
        continue;
      }
      const mark = this.prices.get(pair.market)!.price;
      const navPrice = this.navs.get(pair.collateralInstrument)!.price;
      ev.markPrice = mark;
      ev.rwaNav = navPrice;

      const netFundingLong = pair.accruedFundingLong;
      const longCV = collateralValue(pair.long.collateralQty, navPrice);
      const shortCV = collateralValue(pair.short.collateralQty, navPrice);
      const longUPnL = unrealizedPnl("Long", pair.size, pair.entryPrice, mark);
      const shortUPnL = unrealizedPnl("Short", pair.size, pair.entryPrice, mark);
      const longEq = equity(longCV, longUPnL, netFundingLong);
      const shortEq = equity(shortCV, shortUPnL, -netFundingLong);
      const mm = maintenanceMargin(pair.size, mark, cfg.maintenanceMarginRate);
      ev.longEquity = longEq;
      ev.shortEquity = shortEq;
      ev.maintenanceMargin = mm;

      const close = closeByPair.get(pair.contractId);
      if (close) {
        this.settle(pair, close.closingSide, mark, netFundingLong);
        ev.settled = true;
        ev.settledSide = close.closingSide;
        settled++;
        perPair.push(ev);
        continue;
      }

      if (isLiquidatable(longEq, mm)) {
        this.liquidatePair(pair, "Long", mark, longEq, mm);
        ev.liquidated = true;
        ev.liquidatedSide = "Long";
        liquidated++;
      } else if (isLiquidatable(shortEq, mm)) {
        this.liquidatePair(pair, "Short", mark, shortEq, mm);
        ev.liquidated = true;
        ev.liquidatedSide = "Short";
        liquidated++;
      }
      perPair.push(ev);
    }

    this.lastCycle = {
      at: t,
      evaluated: perPair.length,
      fundingApplied: 0,
      liquidated,
      settled,
      skippedStale: 0,
      skippedNoConfig: perPair.filter((e) => e.skippedNoConfig).length,
      perPair,
    };
  }

  private blankEval(pair: MatchedPair): PairEvaluation {
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

  /* ------------------------- mechanics: funding ------------------------ */

  applyFunding(market: string): void {
    const cfg = this.cfg(market);
    if (!cfg) return;
    const mark = this.prices.get(market)!.price;
    const index = mark; // MVP: mark = index.
    const rate = fundingRate(mark, index, cfg);
    this.lastFundingRate.set(market, rate);
    for (const pair of this.pairs) {
      if (pair.market !== market) continue;
      const payment = fundingPayment(rate, pair.size, index);
      // Positive payment ⇒ long pays short. Settle in USDCx between the two.
      pair.accruedFundingLong = round8(pair.accruedFundingLong - payment);
      if (payment >= 0) {
        this.credit(pair.short.trader, "USDCx", payment);
        this.credit(pair.long.trader, "USDCx", -payment);
      } else {
        this.credit(pair.long.trader, "USDCx", -payment);
        this.credit(pair.short.trader, "USDCx", payment);
      }
      pair.lastFundingTime = now();
    }
    this.emit();
  }

  /* ----------------------- mechanics: liquidation ---------------------- */

  private liquidatePair(pair: MatchedPair, side: Side, mark: number, eq: number, mm: number): void {
    const loser = side === "Long" ? pair.long : pair.short;
    const winner = side === "Long" ? pair.short : pair.long;
    const navPrice = this.navs.get(pair.collateralInstrument)!.price;
    const owed = Math.abs(unrealizedPnl(side, pair.size, pair.entryPrice, mark));

    // Seize the breaching side's collateral, pay the solvent counterparty (P2P, no pool).
    const seizedTokens = this.seizeLocked(loser.trader, pair.collateralInstrument, loser.collateralQty);
    const seizedValue = round8(seizedTokens * navPrice);
    const payout = Math.min(seizedValue, owed);
    this.credit(winner.trader, "USDCx", payout);
    // Surplus (if any) returns to the liquidated trader as USDCx.
    if (seizedValue > owed) this.credit(loser.trader, "USDCx", round8(seizedValue - owed));
    // Winner's own collateral is unlocked back to them.
    this.unlock(winner.trader, pair.collateralInstrument, winner.collateralQty);

    this.liquidations.unshift({
      id: this.id("liq"),
      market: pair.market,
      contractId: pair.contractId,
      side,
      markPrice: mark,
      equity: eq,
      maintenanceMargin: mm,
      seized: seizedValue,
      at: now(),
    });
    this.liquidations = this.liquidations.slice(0, MAX_TAPE);
    this.pairs = this.pairs.filter((p) => p.contractId !== pair.contractId);
    this.closeRequests = this.closeRequests.filter((c) => c.matchedPairContractId !== pair.contractId);
  }

  /* ----------------------- mechanics: close/settle --------------------- */

  requestClose(pairContractId: string, side: Side): void {
    if (this.closeRequests.some((c) => c.matchedPairContractId === pairContractId)) return;
    this.closeRequests.push({
      contractId: this.id("close"),
      matchedPairContractId: pairContractId,
      closingSide: side,
      requestedAt: now(),
    });
    this.emit();
  }

  private settle(pair: MatchedPair, side: Side, exit: number, netFundingLong: number): void {
    const navPrice = this.navs.get(pair.collateralInstrument)!.price;
    const rpnl = realizedPnl(side, pair.size, pair.entryPrice, exit);
    const winner = rpnl >= 0 ? (side === "Long" ? pair.long : pair.short) : side === "Long" ? pair.short : pair.long;
    const loser = winner === pair.long ? pair.short : pair.long;
    const amount = Math.abs(rpnl);

    // DvP: loser's collateral pays the winner in USDCx; both legs return collateral.
    const seizedTokens = Math.min(amount / navPrice, loser.collateralQty);
    this.seizeLocked(loser.trader, pair.collateralInstrument, seizedTokens);
    this.credit(winner.trader, "USDCx", round8(seizedTokens * navPrice));
    // Return each side's remaining locked collateral (now yield-richer).
    this.unlock(pair.long.trader, pair.collateralInstrument, pair.long.collateralQty);
    this.unlock(pair.short.trader, pair.collateralInstrument, pair.short.collateralQty);

    const netFunding = side === "Long" ? netFundingLong : -netFundingLong;
    this.settlements.unshift({
      id: this.id("set"),
      market: pair.market,
      contractId: pair.contractId,
      closingSide: side,
      exitPrice: exit,
      realizedPnl: rpnl,
      netFunding,
      at: now(),
    });
    this.settlements = this.settlements.slice(0, MAX_TAPE);
    this.pairs = this.pairs.filter((p) => p.contractId !== pair.contractId);
    this.closeRequests = this.closeRequests.filter((c) => c.matchedPairContractId !== pair.contractId);
  }

  /* ------------------------- orders + matching ------------------------- */

  placeOrder(input: PlaceOrderInput): { ok: boolean; error?: string } {
    const cfg = this.cfg(input.market);
    if (!cfg) return { ok: false, error: "Unknown market" };
    if (input.size <= 0) return { ok: false, error: "Size must be positive" };

    const por = this.por.get(cfg.collateralInstrument);
    if (!por || !por.solvent || !por.whitelisted) {
      return { ok: false, error: "Collateral failed PoR / whitelist gate" };
    }

    const navPrice = this.navs.get(cfg.collateralInstrument)!.price;
    const qty = round6(minCollateralQty(input.size, input.limitPrice, input.leverage, navPrice) * 1.05);
    if (!this.lock(input.trader, cfg.collateralInstrument, qty)) {
      return { ok: false, error: "Insufficient collateral to escrow initial margin" };
    }

    this.orders.push({
      contractId: this.id("ord"),
      market: input.market,
      trader: input.trader,
      side: input.side,
      size: input.size,
      remaining: input.size,
      limitPrice: round8(input.limitPrice),
      leverage: input.leverage,
      collateralInstrument: cfg.collateralInstrument,
      collateralQty: qty,
      status: "Resting",
      createdAt: now(),
    });

    this.match(input.market);
    this.emit();
    return { ok: true };
  }

  cancelOrder(contractId: string): void {
    const o = this.orders.find((x) => x.contractId === contractId);
    if (!o || o.status === "Filled" || o.status === "Cancelled") return;
    // Return the proportional escrowed collateral for the unfilled remainder.
    const refund = round6((o.collateralQty * o.remaining) / o.size);
    this.unlock(o.trader, o.collateralInstrument, refund);
    o.status = "Cancelled";
    o.remaining = 0;
    this.orders = this.orders.filter((x) => x.contractId !== contractId);
    this.emit();
  }

  /** Price-time-priority matching: cross longs against shorts into MatchedPairs. */
  private match(market: string): void {
    const bids = () =>
      this.orders
        .filter((o) => o.market === market && o.side === "Long" && o.remaining > 0 && o.status !== "Cancelled")
        .sort((a, b) => b.limitPrice - a.limitPrice || a.createdAt - b.createdAt);
    const asks = () =>
      this.orders
        .filter((o) => o.market === market && o.side === "Short" && o.remaining > 0 && o.status !== "Cancelled")
        .sort((a, b) => a.limitPrice - b.limitPrice || a.createdAt - b.createdAt);

    let guard = 0;
    while (guard++ < 100) {
      const b = bids()[0];
      const a = asks()[0];
      if (!b || !a || b.limitPrice < a.limitPrice) break;

      const fillSize = round6(Math.min(b.remaining, a.remaining));
      // Maker = the earlier resting order; execution at the maker's price.
      const maker = b.createdAt <= a.createdAt ? b : a;
      const px = maker.limitPrice;

      const longQty = round6((b.collateralQty * fillSize) / b.size);
      const shortQty = round6((a.collateralQty * fillSize) / a.size);

      this.pairs.push({
        contractId: this.id("pair"),
        market,
        collateralInstrument: b.collateralInstrument,
        size: fillSize,
        entryPrice: px,
        long: { trader: b.trader, collateralQty: longQty },
        short: { trader: a.trader, collateralQty: shortQty },
        accruedFundingLong: 0,
        lastFundingTime: now(),
        openedAt: now(),
      });

      this.fills.unshift({
        id: this.id("fill"),
        market,
        price: px,
        size: fillSize,
        takerSide: maker === b ? "Short" : "Long",
        at: now(),
      });
      this.fills = this.fills.slice(0, MAX_TAPE);

      this.consume(b, fillSize);
      this.consume(a, fillSize);
    }
    this.orders = this.orders.filter((o) => o.remaining > 1e-9 && o.status !== "Cancelled");
  }

  private consume(o: Order, fillSize: number): void {
    o.remaining = round6(o.remaining - fillSize);
    o.status = o.remaining <= 1e-9 ? "Filled" : "PartiallyFilled";
  }

  /* --------------------------- wallet actions -------------------------- */

  deposit(party: string, instrument: string, amount: number): void {
    this.credit(party, instrument, amount);
    this.emit();
  }

  withdraw(party: string, instrument: string, amount: number): boolean {
    const h = this.holding(party, instrument);
    if (h.amount + 1e-9 < amount) return false;
    h.amount = round6(h.amount - amount);
    this.emit();
    return true;
  }

  /* --------------------------- demo helpers ---------------------------- */

  /** Demo: shove a market's price by a % to force funding/liquidation paths. */
  shockPrice(market: string, pct: number): void {
    const cur = this.prices.get(market);
    if (!cur) return;
    const next = round8(Math.max(1, cur.price * (1 + pct)));
    this.prices.set(market, { ...cur, price: next, asOf: now() });
    this.rollCandle(market, next);
    this.runCycle();
    this.emit();
  }

  /* ------------------------------ readers ------------------------------ */

  private markets(): MarketConfig[] {
    return MARKETS;
  }
  private cfg(market: string): MarketConfig | undefined {
    return MARKETS.find((m) => m.market === market);
  }

  snapshot(): EngineSnapshot {
    const obj = <T,>(map: Map<string, T>): Record<string, T> => Object.fromEntries(map);
    const fundingByMarket: Record<string, { rate: number; nextAt: number }> = {};
    for (const m of MARKETS) {
      fundingByMarket[m.market] = {
        rate: this.lastFundingRate.get(m.market) ?? 0,
        nextAt: Math.floor((this.fundingNext.get(m.market) ?? Date.now()) / 1000),
      };
    }
    return {
      now: now(),
      running: this.running,
      parties: [...PARTIES, ...this.extraTraders],
      markets: MARKETS,
      prices: obj(this.prices),
      candles: obj(this.candles),
      navs: obj(this.navs),
      orders: this.orders.map((o) => ({ ...o })),
      pairs: this.pairs.map((p) => ({ ...p, long: { ...p.long }, short: { ...p.short } })),
      closeRequests: this.closeRequests.map((c) => ({ ...c })),
      fills: this.fills.map((f) => ({ ...f })),
      liquidations: this.liquidations.map((l) => ({ ...l })),
      settlements: this.settlements.map((s) => ({ ...s })),
      holdings: Object.fromEntries([...this.holdings].map(([k, v]) => [k, v.map((h) => ({ ...h }))])),
      por: obj(this.por),
      lastCycle: this.lastCycle,
      fundingByMarket,
      rwaApy: INSTRUMENTS["tMMF-USD"].apy,
    };
  }
}

/* ----------------------- pure derived selectors ----------------------- */

/** Build a trader-facing position from a pair leg, with live risk numbers. */
export function derivePosition(
  pair: MatchedPair,
  side: Side,
  snap: EngineSnapshot,
): DerivedPosition {
  const cfg = snap.markets.find((m) => m.market === pair.market)!;
  const leg = side === "Long" ? pair.long : pair.short;
  const counter = side === "Long" ? pair.short : pair.long;
  const mark = snap.prices[pair.market]?.price ?? pair.entryPrice;
  const navPrice = snap.navs[pair.collateralInstrument]?.price ?? 1;
  const cv = collateralValue(leg.collateralQty, navPrice);
  const upnl = unrealizedPnl(side, pair.size, pair.entryPrice, mark);
  const netFunding = side === "Long" ? pair.accruedFundingLong : -pair.accruedFundingLong;
  const eq = equity(cv, upnl, netFunding);
  const mm = maintenanceMargin(pair.size, mark, cfg.maintenanceMarginRate);
  const lev = 1 / cfg.initialMarginRate;
  const liq = liquidationPrice(side, pair.size, pair.entryPrice, cv, netFunding, cfg.maintenanceMarginRate);
  return {
    contractId: pair.contractId,
    market: pair.market,
    side,
    trader: leg.trader,
    size: pair.size,
    entryPrice: pair.entryPrice,
    markPrice: mark,
    leverage: lev,
    collateralInstrument: pair.collateralInstrument,
    collateralQty: leg.collateralQty,
    collateralValue: cv,
    unrealizedPnl: upnl,
    netFunding,
    equity: eq,
    maintenanceMargin: mm,
    marginRatio: marginRatio(eq, pair.size, mark),
    liquidationPrice: liq,
    counterparty: counter.trader,
    openedAt: pair.openedAt,
    closePending: snap.closeRequests.some((c) => c.matchedPairContractId === pair.contractId),
  };
}

export const engine = new MockEngine();
