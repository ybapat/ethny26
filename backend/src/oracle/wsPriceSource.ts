/**
 * wsPriceSource.ts — REAL-TIME Chainlink Data Streams price source over WebSocket.
 *
 * Instead of polling REST every few seconds, we hold an authenticated WS
 * subscription (CHAINLINK.md §3) and react to each pushed signed report
 * (sub-second). The latest decoded price is cached per market; `getPerpPrice`
 * returns it instantly (no network in the hot path), and `onUpdate` lets the
 * trigger loop run a liquidation check the moment the price moves.
 *
 * Resilience: auto-reconnect with backoff (headers are re-signed each connect,
 * since the HMAC timestamp must be fresh). Pair this with a fallback timer in the
 * loop so funding still fires and risk checks continue if the socket goes quiet.
 *
 * Node's built-in `WebSocket` (undici) supports the `headers` option needed for
 * HMAC auth — no extra dependency.
 */
import type { OraclePrice, PriceSource } from "../types.ts";
import { signRequest } from "./hmac.ts";
import { decodeV3Report } from "./reportV3.ts";
import { DATA_STREAMS } from "../config.ts";

/** Pure: parse one WS frame's text into a decoded price. Exported for testing. */
export function parseWsFrame(
  text: string,
  decimals: number,
): { feedId: string; price: number; asOf: number; signedReport: string } {
  const json = JSON.parse(text) as { report?: { feedID?: string; fullReport?: string } };
  const r = json.report;
  if (!r || typeof r.fullReport !== "string") {
    throw new Error("WS frame missing report.fullReport");
  }
  const decoded = decodeV3Report(r.fullReport, decimals);
  return {
    feedId: (r.feedID ?? decoded.feedId).toLowerCase(),
    price: decoded.price,
    asOf: decoded.observationsTimestamp,
    // Preserve the signed blob for the on-ledger Verify choice (CHAINLINK.md §6).
    signedReport: r.fullReport,
  };
}

type UpdateHandler = (market: string, price: OraclePrice) => void;
type Waiter = { market: string; resolve: (p: OraclePrice) => void };

// Node global WebSocket typed to accept the undici `headers` option.
const WS = WebSocket as unknown as {
  new (url: string, opts: { headers: Record<string, string> }): WebSocket;
};

export class DataStreamsWsPriceSource implements PriceSource {
  private readonly wsBase: string;
  private readonly apiKey: string;
  private readonly apiSecret: string;
  private readonly decimals: number;
  private readonly maxStalenessMs: number;
  private readonly marketToFeedId: Map<string, string>;
  private readonly feedIdToMarket: Map<string, string>;
  private readonly cache: Map<string, OraclePrice> = new Map();
  private waiters: Waiter[] = [];
  private socket: WebSocket | null = null;
  private reconnectDelayMs = 1000;
  private stopped = false;
  /** Set this to be notified on every price update (for event-driven loops). */
  public onUpdate: UpdateHandler | null = null;

  constructor(opts: {
    wsBase: string;
    apiKey: string;
    apiSecret: string;
    marketToFeedId: Record<string, string>;
    decimals?: number;
    /** Reject getPerpPrice if the cached price is older than this. Default 30s. */
    maxStalenessMs?: number;
  }) {
    this.wsBase = opts.wsBase.replace(/\/+$/, "");
    this.apiKey = opts.apiKey;
    this.apiSecret = opts.apiSecret;
    this.decimals = opts.decimals ?? 18;
    this.maxStalenessMs = opts.maxStalenessMs ?? 30_000;
    this.marketToFeedId = new Map(Object.entries(opts.marketToFeedId));
    this.feedIdToMarket = new Map(
      Object.entries(opts.marketToFeedId).map(([m, f]) => [f.toLowerCase(), m]),
    );
  }

  /** Open the subscription. Idempotent-ish: call once. */
  start(): void {
    this.stopped = false;
    this.connect();
  }

  /** Close the subscription and stop reconnecting. */
  stop(): void {
    this.stopped = true;
    if (this.socket) {
      try {
        this.socket.close();
      } catch {
        /* ignore */
      }
      this.socket = null;
    }
  }

  private connect(): void {
    const feedIds = Array.from(this.marketToFeedId.values()).join(",");
    const path = `${DATA_STREAMS.paths.ws}?feedIDs=${feedIds}`;
    const headers = signRequest({
      method: "GET",
      path,
      apiKey: this.apiKey,
      apiSecret: this.apiSecret,
      timestampMs: Date.now(),
    });
    const sock = new WS(`${this.wsBase}${path}`, { headers });
    sock.binaryType = "arraybuffer";
    this.socket = sock;

    sock.addEventListener("open", () => {
      this.reconnectDelayMs = 1000; // reset backoff on success
    });
    sock.addEventListener("message", (ev: MessageEvent) => {
      void this.handleMessage(ev.data);
    });
    sock.addEventListener("close", () => this.scheduleReconnect());
    sock.addEventListener("error", () => {
      try {
        sock.close();
      } catch {
        /* ignore */
      }
    });
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    const delay = this.reconnectDelayMs;
    this.reconnectDelayMs = Math.min(this.reconnectDelayMs * 2, 15_000);
    setTimeout(() => {
      if (!this.stopped) this.connect();
    }, delay);
  }

  private async handleMessage(data: unknown): Promise<void> {
    let text: string;
    if (typeof data === "string") text = data;
    else if (data instanceof ArrayBuffer) text = new TextDecoder().decode(new Uint8Array(data));
    else if (typeof (data as Blob)?.text === "function") text = await (data as Blob).text();
    else return;

    let parsed: ReturnType<typeof parseWsFrame>;
    try {
      parsed = parseWsFrame(text, this.decimals);
    } catch {
      return; // ignore non-report frames / parse errors
    }
    const market = this.feedIdToMarket.get(parsed.feedId);
    if (!market) return;
    const price: OraclePrice = {
      feedId: parsed.feedId,
      price: parsed.price,
      asOf: parsed.asOf,
      signedReport: parsed.signedReport,
    };
    this.cache.set(market, price);

    // wake waiters + notify subscriber
    if (this.waiters.length) {
      const still: Waiter[] = [];
      for (const w of this.waiters) {
        if (w.market === market) w.resolve(price);
        else still.push(w);
      }
      this.waiters = still;
    }
    if (this.onUpdate) this.onUpdate(market, price);
  }

  /** Resolve once a first price for `market` is cached (or reject on timeout). */
  waitForFirst(market: string, timeoutMs = 15_000): Promise<OraclePrice> {
    const existing = this.cache.get(market);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const waiter: Waiter = { market, resolve };
      this.waiters.push(waiter);
      setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w !== waiter);
        reject(new Error(`timeout waiting for first WS price for "${market}"`));
      }, timeoutMs);
    });
  }

  async getPerpPrice(market: string): Promise<OraclePrice> {
    const p = this.cache.get(market);
    if (!p) throw new Error(`DataStreamsWsPriceSource: no price yet for "${market}"`);
    const ageMs = Date.now() - p.asOf * 1000;
    if (ageMs > this.maxStalenessMs) {
      throw new Error(`DataStreamsWsPriceSource: price for "${market}" is stale (${ageMs}ms)`);
    }
    return p;
  }

  async getRwaNav(_instrument: string): Promise<OraclePrice> {
    throw new Error("RWA NAV via Chainlink V9/SmartData is not wired yet (CHAINLINK.md §8)");
  }
}
