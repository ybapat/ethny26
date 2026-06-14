/**
 * data/api.ts — the single seam between the UI and "the backend".
 *
 * Two interchangeable data sources implement the same `Backend` surface:
 *   • MockEngine   — the in-browser simulation (default, no backend needed).
 *   • LiveBackend  — talks to backend/src/gateway.ts, which owns the real Canton
 *                    ledger + keeper loop (Chainlink → match → funding → liq).
 *
 * Flip to live by setting VITE_BACKEND_URL to the gateway (e.g. http://localhost:8080):
 *   VITE_BACKEND_URL=http://localhost:8080 npm run dev
 * No component changes — they all go through useStore(), which talks to whatever
 * getBackend() returns.
 */
import { engine, type EngineSnapshot, type MockEngine, type PlaceOrderInput } from "./mockEngine.ts";
import { LiveBackend } from "./liveBackend.ts";
import type { Side } from "../domain/types.ts";

/** The structural surface both MockEngine and LiveBackend satisfy. */
export interface Backend {
  snapshot(): EngineSnapshot;
  subscribe(cb: (s: EngineSnapshot) => void): () => void;
  start(): void;
  stop(): void;
  setRunning(on: boolean): void;
  placeOrder(input: PlaceOrderInput): { ok: boolean; error?: string };
  cancelOrder(contractId: string): void;
  requestClose(matchedPairContractId: string, side: Side): void;
  /** Force/simulate a liquidation of one side of a matched pair. */
  liquidate(matchedPairContractId: string, side: Side): void;
  applyFunding(market: string): void;
  shockPrice(market: string, pct: number): void;
  deposit(party: string, instrument: string, amount: number): void;
  withdraw(party: string, instrument: string, amount: number): boolean;
  /** Allocate a new trader wallet (a real Canton party, live) and return its id. */
  createWallet(name: string): Promise<string | null>;
  /** Create a SELF-CUSTODY wallet — keypair generated + held in the browser. */
  createSelfCustodyWallet(name: string): Promise<string | null>;
}

const BACKEND_URL = import.meta.env.VITE_BACKEND_URL as string | undefined;
const USE_MOCK = !BACKEND_URL;

// type-only assertion that MockEngine satisfies Backend
const _mockIsBackend: Backend = engine as MockEngine;
void _mockIsBackend;

let live: LiveBackend | null = null;

export function getBackend(): Backend {
  if (USE_MOCK) return engine;
  if (!live) live = new LiveBackend(BACKEND_URL!);
  return live;
}

export const IS_MOCK = USE_MOCK;
