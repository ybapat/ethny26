/** MarketTabs.tsx — one tidy bottom panel for the trade view: Positions, Open
 * Orders, Order Book and Trades. Privacy-filtered like everything else (a trader
 * sees only their own; the venue/regulator see all). */
import { useState } from "react";
import { useStore } from "../store/store.tsx";
import { OrdersTable, PositionsTable } from "./PositionsPanel.tsx";
import { fmtAgo, fmtQty, fmtUsd } from "../lib/format.ts";
import type { DepthLevel } from "../store/store.tsx";

type Tab = "positions" | "orders" | "book" | "trades";

export function MarketTabs() {
  const { visiblePositions, visibleOrders, isAuthority } = useStore();
  const [tab, setTab] = useState<Tab>("positions");
  const openOrders = visibleOrders.filter((o) => o.status === "Resting" || o.status === "PartiallyFilled");

  return (
    <div className="card fill">
      <div className="card-head">
        <div className="seg">
          <button className={tab === "positions" ? "on" : ""} onClick={() => setTab("positions")}>
            Positions {visiblePositions.length > 0 && <b className="cnt">{visiblePositions.length}</b>}
          </button>
          <button className={tab === "orders" ? "on" : ""} onClick={() => setTab("orders")}>
            Orders {openOrders.length > 0 && <b className="cnt">{openOrders.length}</b>}
          </button>
          <button className={tab === "book" ? "on" : ""} onClick={() => setTab("book")}>Order Book</button>
          <button className={tab === "trades" ? "on" : ""} onClick={() => setTab("trades")}>Trades</button>
        </div>
        {isAuthority && <span className="chip chip-amber">Seeing all traders</span>}
      </div>
      <div className="card-body scroll-y" style={{ padding: 0 }}>
        {tab === "positions" && <PositionsTable rows={visiblePositions} showCounterparty={isAuthority} />}
        {tab === "orders" && <OrdersTable orders={openOrders} showOwner={isAuthority} />}
        {tab === "book" && <BookView />}
        {tab === "trades" && <TradesView />}
      </div>
    </div>
  );
}

function BookView() {
  const { book, isAuthority } = useStore();
  if (!book) return null;
  const max = Math.max(1, ...book.bids.map((b) => b.total), ...book.asks.map((a) => a.total));
  if (book.bids.length === 0 && book.asks.length === 0)
    return <div className="empty">{isAuthority ? "The book is empty." : "You have no resting orders. Other traders' orders are private to you."}</div>;
  return (
    <div className="book-grid">
      <BookSide title="Bids (buyers)" levels={book.bids} side="bid" max={max} />
      <BookSide title="Asks (sellers)" levels={book.asks} side="ask" max={max} />
    </div>
  );
}

function BookSide({ title, levels, side, max }: { title: string; levels: DepthLevel[]; side: "bid" | "ask"; max: number }) {
  const col = side === "bid" ? "var(--up)" : "var(--down)";
  return (
    <div className="book-col">
      <div className="book-col-head">{title}</div>
      {levels.length === 0 && <div className="empty" style={{ padding: 18 }}>none</div>}
      {levels.slice(0, 8).map((l) => (
        <div key={l.price} className={`book-row ${l.ownSize > 0 ? "own" : ""}`}>
          <span className="book-depth" style={{ width: `${(l.total / max) * 100}%`, background: side === "bid" ? "var(--up-soft)" : "var(--down-soft)" }} />
          <span className="tnum" style={{ color: col }}>{fmtUsd(l.price)}</span>
          <span className="tnum">{fmtQty(l.size, 2)}{l.ownSize > 0 ? " (you)" : ""}</span>
        </div>
      ))}
    </div>
  );
}

function TradesView() {
  const { snap, market } = useStore();
  const fills = snap.fills.filter((f) => f.market === market).slice(0, 30);
  if (fills.length === 0) return <div className="empty">No trades yet. Place crossing orders to print the tape.</div>;
  return (
    <table className="tbl">
      <thead><tr><th>Time</th><th>Price</th><th>Size</th><th>Side</th></tr></thead>
      <tbody>
        {fills.map((f) => (
          <tr key={f.id}>
            <td className="tnum muted" style={{ textAlign: "left" }}>{fmtAgo(f.at, snap.now)}</td>
            <td className={`tnum ${f.takerSide === "Long" ? "up" : "down"}`}>{fmtUsd(f.price)}</td>
            <td className="tnum">{fmtQty(f.size)}</td>
            <td><span className={`chip ${f.takerSide === "Long" ? "chip-long" : "chip-short"}`}>{f.takerSide === "Long" ? "Buy" : "Sell"}</span></td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
