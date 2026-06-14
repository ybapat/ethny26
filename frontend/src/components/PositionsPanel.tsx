/** PositionsPanel.tsx — tabbed Positions / Open Orders with live risk + actions
 * (RequestClose, Cancel). Privacy-filtered: a trader sees only their own legs. */
import { useState } from "react";
import { useStore } from "../store/store.tsx";
import { MARKETS } from "../domain/config.ts";
import { fmtPct, fmtQty, fmtSignedUsd, fmtUsd, shortParty } from "../lib/format.ts";
import type { DerivedPosition } from "../domain/types.ts";

export function PositionsPanel() {
  const { visiblePositions, visibleOrders, isAuthority } = useStore();
  const [tab, setTab] = useState<"pos" | "ord">("pos");
  const openOrders = visibleOrders.filter((o) => o.status === "Resting" || o.status === "PartiallyFilled");

  return (
    <div className="panel fill">
      <div className="panel-head">
        <div className="seg">
          <button className={tab === "pos" ? "on" : ""} onClick={() => setTab("pos")}>
            Positions <span className="badge">{visiblePositions.length}</span>
          </button>
          <button className={tab === "ord" ? "on" : ""} onClick={() => setTab("ord")}>
            Open Orders <span className="badge">{openOrders.length}</span>
          </button>
        </div>
        {isAuthority && <span className="chip chip-amber">AUTHORITY · ALL TRADERS</span>}
      </div>
      <div className="panel-body scroll-y" style={{ padding: 0 }}>
        {tab === "pos" ? <PositionsTable rows={visiblePositions} showCounterparty={isAuthority} /> : <OrdersTable orders={openOrders} showOwner={isAuthority} />}
      </div>
    </div>
  );
}

export function PositionsTable({ rows, showCounterparty }: { rows: DerivedPosition[]; showCounterparty: boolean }) {
  const { requestClose, liquidate, party, isAuthority } = useStore();
  if (rows.length === 0) return <div className="empty">No open positions.</div>;
  return (
    <table className="tbl">
      <thead>
        <tr>
          <th>Market</th>
          <th>Side</th>
          <th>Size</th>
          <th>Entry</th>
          <th>Mark</th>
          <th>Liq. Price</th>
          <th>Collateral</th>
          <th>uPnL</th>
          <th>Funding</th>
          <th>Margin</th>
          {showCounterparty && <th>Counterparty</th>}
          <th></th>
        </tr>
      </thead>
      <tbody>
        {rows.map((p) => {
          const cfg = MARKETS.find((m) => m.market === p.market)!;
          const healthy = p.marginRatio > cfg.maintenanceMarginRate * 1.5;
          const near = p.marginRatio <= cfg.maintenanceMarginRate * 1.5;
          const mine = p.trader === party.partyId;
          return (
            <tr key={p.contractId + p.side}>
              <td style={{ fontWeight: 600 }}>{p.market}</td>
              <td>
                <span className={`chip ${p.side === "Long" ? "chip-long" : "chip-short"}`}>{p.side}</span>
              </td>
              <td className="tnum">{fmtQty(p.size)}</td>
              <td className="tnum">{fmtUsd(p.entryPrice)}</td>
              <td className="tnum">{fmtUsd(p.markPrice)}</td>
              <td className="tnum" style={{ color: "var(--short)" }}>{fmtUsd(p.liquidationPrice)}</td>
              <td className="tnum">{fmtQty(p.collateralQty)} <span className="muted">≈{fmtUsd(p.collateralValue)}</span></td>
              <td className={`tnum ${p.unrealizedPnl >= 0 ? "pos" : "neg"}`}>{fmtSignedUsd(p.unrealizedPnl)}</td>
              <td className={`tnum ${p.netFunding >= 0 ? "pos" : "neg"}`}>{fmtSignedUsd(p.netFunding)}</td>
              <td>
                <div className="row gap-xs" style={{ justifyContent: "flex-end" }}>
                  <span className={`tnum ${healthy ? "pos" : near ? "neg" : ""}`}>{fmtPct(p.marginRatio)}</span>
                  <span className="health-bar">
                    <span
                      className="health-fill"
                      style={{
                        width: `${Math.min(100, (p.marginRatio / (cfg.maintenanceMarginRate * 4)) * 100)}%`,
                        background: healthy ? "var(--up)" : "var(--short)",
                      }}
                    />
                  </span>
                </div>
              </td>
              {showCounterparty && <td className="tnum muted">{shortParty(p.counterparty)}</td>}
              <td>
                {mine && !isAuthority ? (
                  p.closePending ? (
                    <span className="chip chip-amber">SETTLING…</span>
                  ) : (
                    <div className="row gap-xs" style={{ justifyContent: "flex-end" }}>
                      <button className="btn btn-sm btn-ghost" onClick={() => requestClose(p.contractId, p.side)}>Close</button>
                      <button className="btn btn-sm btn-short" title="Simulate a liquidation of this position" onClick={() => liquidate(p.contractId, p.side)}>Liquidate</button>
                    </div>
                  )
                ) : p.closePending ? (
                  <span className="chip chip-amber">CLOSE REQ</span>
                ) : null}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

export function OrdersTable({ orders, showOwner }: { orders: ReturnType<typeof useStore>["visibleOrders"]; showOwner: boolean }) {
  const { cancelOrder, party, isAuthority } = useStore();
  if (orders.length === 0) return <div className="empty">No resting orders.</div>;
  return (
    <table className="tbl">
      <thead>
        <tr>
          <th>Market</th>
          <th>Side</th>
          {showOwner && <th>Trader</th>}
          <th>Limit</th>
          <th>Size</th>
          <th>Remaining</th>
          <th>Lev</th>
          <th>Status</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        {orders.map((o) => (
          <tr key={o.contractId}>
            <td style={{ fontWeight: 600 }}>{o.market}</td>
            <td><span className={`chip ${o.side === "Long" ? "chip-long" : "chip-short"}`}>{o.side}</span></td>
            {showOwner && <td className="tnum muted">{shortParty(o.trader)}</td>}
            <td className="tnum">{fmtUsd(o.limitPrice)}</td>
            <td className="tnum">{fmtQty(o.size)}</td>
            <td className="tnum">{fmtQty(o.remaining)}</td>
            <td className="tnum">{o.leverage}×</td>
            <td className="muted" style={{ fontSize: 10, letterSpacing: "0.08em" }}>{o.status}</td>
            <td>
              {o.trader === party.partyId && !isAuthority && (
                <button className="btn btn-sm btn-ghost" onClick={() => cancelOrder(o.contractId)}>Cancel</button>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
