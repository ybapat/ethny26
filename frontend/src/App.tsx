/** App.tsx — Connect-Wallet gate + one focused screen per connected role.
 *  - trader (Alice/Bob): chart · collateral+ticket · positions/orders/book
 *  - venue (Operator):   chart · venue controls · full book & positions
 *  - regulator:          audit (see-all) view
 *  - outsider:           public price only
 */
import { useStore } from "./store/store.tsx";
import { TopBar } from "./components/TopBar.tsx";
import { ConnectScreen } from "./components/ConnectScreen.tsx";
import { ChartPanel } from "./components/ChartPanel.tsx";
import { OrderForm } from "./components/OrderForm.tsx";
import { CollateralCard } from "./components/CollateralCard.tsx";
import { MarketTabs } from "./components/MarketTabs.tsx";
import { OrdersTable, PositionsTable } from "./components/PositionsPanel.tsx";
import { VenuePanel } from "./components/VenuePanel.tsx";

export function App() {
  const { connected, role } = useStore();
  if (!connected) return <ConnectScreen />;

  return (
    <div className="app">
      <TopBar />
      <main className="main">
        {role === "trader" && <TraderView />}
        {role === "venue" && <VenueView />}
        {role === "regulator" && <AuditView />}
        {role === "outsider" && <OutsiderView />}
      </main>
    </div>
  );
}

function TraderView() {
  return (
    <div className="trade-grid">
      <div className="area-chart"><ChartPanel /></div>
      <div className="area-ticket ticket-col">
        <CollateralCard />
        <OrderForm />
      </div>
      <div className="area-bottom"><MarketTabs /></div>
    </div>
  );
}

function VenueView() {
  return (
    <div className="trade-grid">
      <div className="area-chart"><ChartPanel /></div>
      <div className="area-ticket ticket-col scroll-y"><VenuePanel /></div>
      <div className="area-bottom"><MarketTabs /></div>
    </div>
  );
}

function AuditView() {
  const { visiblePositions, visibleOrders } = useStore();
  const openOrders = visibleOrders.filter((o) => o.status === "Resting" || o.status === "PartiallyFilled");
  return (
    <div className="page page-2">
      <div className="span-2 audit-banner">
        <span className="chip chip-amber">REGULATOR · OBSERVER</span>
        <span className="muted" style={{ fontSize: 12 }}>
          Full audit visibility — every position, counterparty, order and PnL across all traders, with
          no ability to trade or interfere. Audit without participation.
        </span>
      </div>
      <div className="panel span-2 fill">
        <div className="panel-head"><span className="panel-title">All Positions · Both Legs</span><span className="label">{visiblePositions.length} legs</span></div>
        <div className="panel-body scroll-y" style={{ padding: 0 }}>
          <PositionsTable rows={visiblePositions} showCounterparty />
        </div>
      </div>
      <div className="panel span-2 fill">
        <div className="panel-head"><span className="panel-title">All Resting Orders</span><span className="label">{openOrders.length}</span></div>
        <div className="panel-body scroll-y" style={{ padding: 0 }}>
          <OrdersTable orders={openOrders} showOwner />
        </div>
      </div>
    </div>
  );
}

function OutsiderView() {
  return (
    <div className="trade-grid" style={{ gridTemplateColumns: "1fr", gridTemplateAreas: '"chart"' }}>
      <div className="area-chart"><ChartPanel /></div>
    </div>
  );
}
