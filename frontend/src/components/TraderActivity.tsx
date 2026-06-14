/** TraderActivity.tsx — the trader's activity panel. A light 2-tab split keeps
 * Positions (default) and Open Orders cleanly separated without the old 4-way
 * tab-hunting. Positions is the default, so your position is never hidden. */
import { useState } from "react";
import { useStore } from "../store/store.tsx";
import { PositionsTable, OrdersTable } from "./PositionsPanel.tsx";

export function TraderActivity() {
  const { visiblePositions, visibleOrders } = useStore();
  const openOrders = visibleOrders.filter((o) => o.status === "Resting" || o.status === "PartiallyFilled");
  const [tab, setTab] = useState<"pos" | "ord">("pos");

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
        </div>
      </div>
      <div className="panel-body scroll-y" style={{ padding: 0 }}>
        {tab === "pos" ? (
          visiblePositions.length === 0 ? (
            <div className="guided-empty">
              <div className="ge-title">No open position</div>
              <div className="ge-sub">Fund collateral, then place a trade.</div>
            </div>
          ) : (
            <PositionsTable rows={visiblePositions} showCounterparty={false} />
          )
        ) : openOrders.length === 0 ? (
          <div className="guided-empty">
            <div className="ge-title">No open orders</div>
            <div className="ge-sub">Your resting orders appear here, private to the dark book.</div>
          </div>
        ) : (
          <OrdersTable orders={openOrders} showOwner={false} />
        )}
      </div>
    </div>
  );
}
