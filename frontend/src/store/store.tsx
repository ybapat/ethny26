/**
 * store/store.tsx — React state layer + Canton-style privacy filtering.
 *
 * Subscribes to the backend (mock engine, or the live gateway) and exposes:
 *   • the connected wallet (a Canton party, picked on the Connect screen)
 *   • the selected market
 *   • PRIVACY-FILTERED selectors: what each party is actually a stakeholder on.
 *
 * The filtering here is the UI mirror of Canton sub-transaction privacy:
 *   venue / regulator → see the whole book + every position
 *   trader            → sees ONLY their own orders + their own positions
 *   outsider          → sees ONLY the public price feed (no orders, no positions)
 */
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { getBackend, IS_MOCK } from "../data/api.ts";
import {
  derivePosition,
  PARTIES,
  type EngineSnapshot,
} from "../data/mockEngine.ts";
import type {
  DerivedPosition,
  Order,
  Party,
  PartyRole,
  SettlementEvent,
  Side,
} from "../domain/types.ts";

const backend = getBackend();

interface StoreValue {
  snap: EngineSnapshot;
  isMock: boolean;
  /** Derived role of the connected wallet. */
  role: PartyRole;
  /** The connected wallet (a Canton party). */
  party: Party;
  /** True once a wallet is connected (Connect-Wallet landing passed). */
  connected: boolean;
  /** Connect as a specific party id (from the Connect screen). */
  connect: (partyId: string) => void;
  /** Disconnect → back to the Connect-Wallet screen (switch identity). */
  disconnect: () => void;
  market: string;
  setMarket: (m: string) => void;
  /** True for parties that can see all contracts (venue, regulator). */
  isAuthority: boolean;
  /** Orders this party is a stakeholder on (privacy-filtered). */
  visibleOrders: Order[];
  /** Positions this party can see (own legs for traders; both for authorities). */
  visiblePositions: DerivedPosition[];
  /** Settled/liquidated trades this party can see (own for traders; all for authorities). */
  visibleSettlements: SettlementEvent[];
  /** Aggregated dark-CLOB depth — only authorities may see the full book. */
  book: { bids: DepthLevel[]; asks: DepthLevel[] } | null;
  // actions (thin pass-throughs to the backend)
  placeOrder: typeof backend.placeOrder;
  cancelOrder: typeof backend.cancelOrder;
  requestClose: typeof backend.requestClose;
  liquidate: typeof backend.liquidate;
  applyFunding: typeof backend.applyFunding;
  shockPrice: typeof backend.shockPrice;
  deposit: typeof backend.deposit;
  withdraw: typeof backend.withdraw;
  setRunning: typeof backend.setRunning;
  createWallet: typeof backend.createWallet;
  createSelfCustodyWallet: typeof backend.createSelfCustodyWallet;
}

export interface DepthLevel {
  price: number;
  size: number;
  total: number;
  ownSize: number;
}

const Ctx = createContext<StoreValue | null>(null);

export function StoreProvider({ children }: { children: ReactNode }) {
  const [snap, setSnap] = useState<EngineSnapshot>(() => backend.snapshot());
  const [market, setMarket] = useState<string>("ETH-USD");
  const [partyId, setPartyId] = useState<string | null>(null); // connected wallet
  const connect = (id: string) => setPartyId(id);
  const disconnect = () => setPartyId(null);
  const connected = partyId !== null;

  useEffect(() => {
    const unsub = backend.subscribe(setSnap);
    backend.start();
    return () => {
      unsub();
    };
  }, []);

  // Resolve the connected wallet by party id (live snapshot first, mock fallback).
  // Created wallets briefly miss the snapshot → assume a trader until the next poll.
  const party = useMemo<Party>(
    () =>
      snap.parties.find((p) => p.partyId === partyId) ??
      PARTIES.find((p) => p.partyId === partyId) ??
      { role: "trader", partyId: partyId ?? "", label: "Connecting…" },
    [snap.parties, partyId],
  );
  const role = party.role;
  const isAuthority = role === "venue" || role === "regulator";

  const visibleOrders = useMemo<Order[]>(() => {
    if (role === "outsider") return [];
    if (isAuthority) return snap.orders;
    return snap.orders.filter((o) => o.trader === party.partyId);
  }, [snap.orders, role, isAuthority, party.partyId]);

  const visiblePositions = useMemo<DerivedPosition[]>(() => {
    if (role === "outsider") return [];
    const out: DerivedPosition[] = [];
    for (const pair of snap.pairs) {
      const amLong = pair.long.trader === party.partyId;
      const amShort = pair.short.trader === party.partyId;
      if (isAuthority) {
        out.push(derivePosition(pair, "Long", snap));
        out.push(derivePosition(pair, "Short", snap));
      } else if (amLong) {
        out.push(derivePosition(pair, "Long", snap));
      } else if (amShort) {
        out.push(derivePosition(pair, "Short", snap));
      }
    }
    return out;
  }, [snap, role, isAuthority, party.partyId]);

  const visibleSettlements = useMemo<SettlementEvent[]>(() => {
    if (role === "outsider") return [];
    const all = snap.settlements ?? [];
    if (isAuthority) return all;
    return all.filter((s) => s.long === party.partyId || s.short === party.partyId);
  }, [snap.settlements, role, isAuthority, party.partyId]);

  const book = useMemo(() => {
    if (role === "outsider") return null;
    const source = isAuthority
      ? snap.orders.filter((o) => o.market === market)
      : snap.orders.filter((o) => o.market === market && o.trader === party.partyId);
    return aggregateBook(source, party.partyId);
  }, [snap.orders, market, role, isAuthority, party.partyId]);

  const value: StoreValue = {
    snap,
    isMock: IS_MOCK,
    role,
    party,
    connected,
    connect,
    disconnect,
    market,
    setMarket,
    isAuthority,
    visibleOrders,
    visiblePositions,
    visibleSettlements,
    book,
    placeOrder: backend.placeOrder.bind(backend),
    cancelOrder: backend.cancelOrder.bind(backend),
    requestClose: backend.requestClose.bind(backend),
    liquidate: backend.liquidate.bind(backend),
    applyFunding: backend.applyFunding.bind(backend),
    shockPrice: backend.shockPrice.bind(backend),
    deposit: backend.deposit.bind(backend),
    withdraw: backend.withdraw.bind(backend),
    setRunning: backend.setRunning.bind(backend),
    createWallet: backend.createWallet.bind(backend),
    createSelfCustodyWallet: backend.createSelfCustodyWallet.bind(backend),
  };

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useStore(): StoreValue {
  const v = useContext(Ctx);
  if (!v) throw new Error("useStore must be used within StoreProvider");
  return v;
}

function aggregateBook(orders: Order[], me: string) {
  const side = (s: Side) => {
    const levels = new Map<number, { size: number; ownSize: number }>();
    for (const o of orders.filter((x) => x.side === s)) {
      const cur = levels.get(o.limitPrice) ?? { size: 0, ownSize: 0 };
      cur.size += o.remaining;
      if (o.trader === me) cur.ownSize += o.remaining;
      levels.set(o.limitPrice, cur);
    }
    const sorted = [...levels.entries()].sort((a, b) =>
      s === "Long" ? b[0] - a[0] : a[0] - b[0],
    );
    let total = 0;
    return sorted.map(([price, v]): DepthLevel => {
      total += v.size;
      return { price, size: v.size, total, ownSize: v.ownSize };
    });
  };
  return { bids: side("Long"), asks: side("Short") };
}
