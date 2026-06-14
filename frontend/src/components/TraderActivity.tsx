/** TraderActivity.tsx — the trader's activity panel. A light 3-tab split keeps
 * Positions (default), Open Orders, and Trade History cleanly separated. Positions
 * is the default, so your position is never hidden. */
import { useState } from "react";
import { useStore } from "../store/store.tsx";
import { PositionsTable, OrdersTable } from "./PositionsPanel.tsx";
import { fmtQty, fmtSignedUsd, fmtUsd } from "../lib/format.ts";
import type { SettlementEvent } from "../domain/types.ts";

export function TraderActivity() {
  const { visiblePositions, visibleOrders, visibleSettlements, party } = useStore();
  const openOrders = visibleOrders.filter((o) => o.status === "Resting" || o.status === "PartiallyFilled");
  const [tab, setTab] = useState<"pos" | "ord" | "his">("pos");

  return (
    <div className="panel fill">
      <div className="panel-head">
        <div className="seg">
          <button className={tab === "pos" ? "on" : ""} onClick={() => setTab("pos")}>
            Positions{visiblePositions.length > 0 && <span className="badge">{visiblePositions.length}</span>}
          </button>
          <button className={tab === "ord" ? "on" : ""} onClick={() => setTab("ord")}>
            Open Orders{openOrders.length > 0 && <span className="badge">{openOrders.length}</span>}
          </button>
          <button className={tab === "his" ? "on" : ""} onClick={() => setTab("his")}>
            History{visibleSettlements.length > 0 && <span className="badge">{visibleSettlements.length}</span>}
          </button>
        </div>
      </div>
      <div className="panel-body scroll-y" style={{ padding: 0 }}>
        {tab === "pos" ? (
          visiblePositions.length === 0 ? (
            <Empty title="No open position" sub="Fund collateral, then place a trade." />
          ) : (
            <PositionsTable rows={visiblePositions} showCounterparty={false} />
          )
        ) : tab === "ord" ? (
          openOrders.length === 0 ? (
            <Empty title="No open orders" sub="Your resting orders appear here, private to the dark book." />
          ) : (
            <OrdersTable orders={openOrders} showOwner={false} />
          )
        ) : visibleSettlements.length === 0 ? (
          <Empty title="No trade history" sub="Closed and liquidated trades appear here." />
        ) : (
          <HistoryTable rows={visibleSettlements} me={party.partyId} />
        )}
      </div>
    </div>
  );
}

function Empty({ title, sub }: { title: string; sub: string }) {
  return (
    <div className="guided-empty">
      <div className="ge-title">{title}</div>
      <div className="ge-sub">{sub}</div>
    </div>
  );
}

const pad2 = (n: number) => n.toString().padStart(2, "0");
function fmtTime(unixSec: number): string {
  const d = new Date(unixSec * 1000);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

function HistoryTable({ rows, me }: { rows: SettlementEvent[]; me: string }) {
  return (
    <table className="tbl pos-table">
      <thead>
        <tr>
          <th>Time</th>
          <th>Side</th>
          <th>Size</th>
          <th>Entry</th>
          <th>Exit</th>
          <th>Result</th>
          <th>PnL</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((s) => {
          const longPnl = s.closingSide === "Long" ? s.realizedPnl : -s.realizedPnl;
          const mine = s.long === me ? "Long" : "Short";
          const pnl = mine === "Long" ? longPnl : -longPnl;
          const liquidated = s.kind === "Liquidation";
          return (
            <tr key={s.id}>
              <td className="tnum muted">{fmtTime(s.at)}</td>
              <td><span className={`chip ${mine === "Long" ? "chip-long" : "chip-short"}`}>{mine}</span></td>
              <td className="tnum">{s.size != null ? fmtQty(s.size) : "—"}</td>
              <td className="tnum">{s.entryPrice != null ? fmtUsd(s.entryPrice) : "—"}</td>
              <td className="tnum">{fmtUsd(s.exitPrice)}</td>
              <td><span className={liquidated ? "tnum down" : "muted"} style={{ fontSize: 11.5 }}>{liquidated ? "Liquidated" : "Closed"}</span></td>
              <td className={`tnum ${pnl >= 0 ? "pos" : "neg"}`}>{fmtSignedUsd(pnl)}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
