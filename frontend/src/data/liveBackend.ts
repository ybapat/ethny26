/**
 * data/liveBackend.ts — the LIVE data source: talks to the backend gateway
 * (backend/src/gateway.ts), which owns the real Canton ledger + keeper loop.
 *
 * It implements the SAME surface as MockEngine (snapshot/subscribe/placeOrder/…)
 * so swapping it in (via data/api.ts) needs zero component changes. Reads come
 * from GET /api/snapshot (polled); writes POST to /api/{order,cancel,close,…}.
 *
 * Actions return synchronously (optimistic) and fire the HTTP request in the
 * background; the next poll reflects the authoritative on-ledger state. The
 * gateway already validates and only mutates the ledger on success.
 */
import { INSTRUMENTS, MARKETS, SEED_PRICE } from "../domain/config.ts";
import type { EngineSnapshot, PlaceOrderInput } from "./mockEngine.ts";
import type { OraclePrice, Party, Side } from "../domain/types.ts";

type Listener = (s: EngineSnapshot) => void;

const POLL_MS = 2000;

/** Roles shown before the first snapshot arrives (real party ids fill in on poll). */
const PLACEHOLDER_PARTIES: Party[] = [
  { role: "trader", partyId: "", label: "Alice" },
  { role: "trader", partyId: "", label: "Bob" },
  { role: "venue", partyId: "", label: "Venue Operator" },
  { role: "regulator", partyId: "", label: "Regulator" },
  { role: "outsider", partyId: "", label: "Outsider" },
];

function defaultSnapshot(): EngineSnapshot {
  const now = Math.floor(Date.now() / 1000);
  const prices: Record<string, OraclePrice> = {};
  for (const m of MARKETS) prices[m.market] = { feedId: m.underlyingFeedId, price: SEED_PRICE[m.market] ?? 0, asOf: now };
  const navs: Record<string, OraclePrice> = {};
  for (const meta of Object.values(INSTRUMENTS)) navs[meta.instrument] = { feedId: meta.instrument, price: meta.nav, asOf: now };
  return {
    now, running: true, parties: PLACEHOLDER_PARTIES, markets: MARKETS,
    prices, candles: {}, navs, orders: [], pairs: [], closeRequests: [],
    fills: [], liquidations: [], settlements: [], holdings: {}, por: {},
    lastCycle: null, fundingByMarket: {},
  };
}

export class LiveBackend {
  private base: string;
  private snap: EngineSnapshot = defaultSnapshot();
  private listeners = new Set<Listener>();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(base: string) {
    this.base = base.replace(/\/+$/, "");
  }

  /* ------------------------------ lifecycle ------------------------------ */

  start(): void {
    if (this.timer) return;
    void this.poll();
    this.timer = setInterval(() => void this.poll(), POLL_MS);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Mirrors MockEngine: true=resume, false=pause the keeper loop (server-side). */
  setRunning(on: boolean): void {
    this.send("/api/running", { on });
  }

  subscribe(cb: Listener): () => void {
    this.listeners.add(cb);
    cb(this.snap);
    return () => { this.listeners.delete(cb); };
  }

  snapshot(): EngineSnapshot {
    return this.snap;
  }

  private emit(): void {
    for (const l of this.listeners) l(this.snap);
  }

  private async poll(): Promise<void> {
    try {
      const res = await fetch(`${this.base}/api/snapshot`, { headers: { accept: "application/json" } });
      if (!res.ok) return;
      const j = (await res.json()) as EngineSnapshot;
      if (j && Array.isArray(j.parties) && j.parties.length) {
        this.snap = j;
        this.emit();
      }
    } catch {
      /* gateway not up yet — keep last snapshot, retry next tick */
    }
  }

  /** Fire an action, then poll immediately so the UI updates without waiting. */
  private send(path: string, body: unknown): Promise<{ ok: boolean; error?: string; party?: string }> {
    return fetch(`${this.base}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(body),
    })
      .then(async (r) => (await r.json()) as { ok: boolean; error?: string; party?: string })
      .catch((e) => ({ ok: false, error: String(e) }))
      .then((out) => { void this.poll(); return out; });
  }

  /* ------------------------------- actions ------------------------------- */

  placeOrder(input: PlaceOrderInput): { ok: boolean; error?: string } {
    if (input.size <= 0) return { ok: false, error: "Size must be positive" };
    void this.send("/api/order", input);
    return { ok: true }; // optimistic; the order appears on the next poll if accepted
  }

  cancelOrder(contractId: string): void {
    void this.send("/api/cancel", { contractId });
  }

  requestClose(matchedPairContractId: string, side: Side): void {
    void this.send("/api/close", { contractId: matchedPairContractId, side });
  }

  liquidate(matchedPairContractId: string, side: Side): void {
    void this.send("/api/liquidate", { contractId: matchedPairContractId, side });
  }

  async createWallet(name: string): Promise<string | null> {
    const out = (await this.send("/api/create-wallet", { name })) as { ok: boolean; party?: string };
    return out.ok && out.party ? out.party : null;
  }

  applyFunding(market: string): void {
    void this.send("/api/funding", { market });
  }

  shockPrice(market: string, pct: number): void {
    void this.send("/api/shock", { market, pct });
  }

  deposit(party: string, instrument: string, amount: number): void {
    void this.send("/api/deposit", { party, instrument, amount });
  }

  withdraw(party: string, instrument: string, amount: number): boolean {
    void this.send("/api/withdraw", { party, instrument, amount });
    return true; // optimistic; balance reconciles on the next poll
  }
}
