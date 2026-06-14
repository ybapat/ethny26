/** Feeds.tsx — the venue/regulator event tapes: recent fills, liquidations, and
 * settlements. Each row cites the on-ledger action that produced it. */
import { useStore } from "../store/store.tsx";
import { fmtAgo, fmtQty, fmtSignedUsd, fmtUsd } from "../lib/format.ts";

export function TapeFeed() {
  const { snap, market } = useStore();
  const fills = snap.fills.filter((f) => f.market === market).slice(0, 24);
  return (
    <div className="panel fill">
      <div className="panel-head">
        <span className="panel-title">Recent Fills · {market}</span>
        <span className="label">MatchOrders</span>
      </div>
      <div className="panel-body scroll-y" style={{ padding: 0 }}>
        {fills.length === 0 ? (
          <div className="empty">No fills yet. Place crossing orders to print the tape.</div>
        ) : (
          <table className="tbl">
            <thead>
              <tr><th>Time</th><th>Price</th><th>Size</th><th>Aggressor</th></tr>
            </thead>
            <tbody>
              {fills.map((f) => (
                <tr key={f.id}>
                  <td className="tnum muted" style={{ textAlign: "left" }}>{fmtAgo(f.at, snap.now)}</td>
                  <td className={`tnum ${f.takerSide === "Long" ? "pos" : "neg"}`}>{fmtUsd(f.price)}</td>
                  <td className="tnum">{fmtQty(f.size)}</td>
                  <td><span className={`chip ${f.takerSide === "Long" ? "chip-long" : "chip-short"}`}>{f.takerSide}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

export function LiquidationsFeed() {
  const { snap } = useStore();
  return (
    <div className="panel fill">
      <div className="panel-head">
        <span className="panel-title"><span className="dot" style={{ background: "var(--short)", boxShadow: "0 0 8px var(--short-glow)" }} /> Liquidations</span>
        <span className="label">MatchedPair.Liquidate</span>
      </div>
      <div className="panel-body scroll-y" style={{ padding: 0 }}>
        {snap.liquidations.length === 0 ? (
          <div className="empty">No liquidations. Healthy positions cannot be liquidated (E ≥ MM asserted on-ledger).</div>
        ) : (
          <table className="tbl">
            <thead>
              <tr><th>Time</th><th>Market</th><th>Side</th><th>Mark</th><th>Equity</th><th>Seized</th></tr>
            </thead>
            <tbody>
              {snap.liquidations.map((l) => (
                <tr key={l.id}>
                  <td className="tnum muted" style={{ textAlign: "left" }}>{fmtAgo(l.at, snap.now)}</td>
                  <td>{l.market}</td>
                  <td><span className={`chip ${l.side === "Long" ? "chip-long" : "chip-short"}`}>{l.side}</span></td>
                  <td className="tnum">{fmtUsd(l.markPrice)}</td>
                  <td className="tnum neg">{fmtUsd(l.equity)}</td>
                  <td className="tnum" style={{ color: "var(--amber)" }}>{fmtUsd(l.seized)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

export function SettlementsFeed() {
  const { snap } = useStore();
  return (
    <div className="panel fill">
      <div className="panel-head">
        <span className="panel-title">Settlements · Atomic DvP</span>
        <span className="label">SettleClose</span>
      </div>
      <div className="panel-body scroll-y" style={{ padding: 0 }}>
        {snap.settlements.length === 0 ? (
          <div className="empty">No settlements yet. Close a position to settle PnL peer-to-peer.</div>
        ) : (
          <table className="tbl">
            <thead>
              <tr><th>Time</th><th>Market</th><th>Closed</th><th>Exit</th><th>Realized PnL</th><th>Funding</th></tr>
            </thead>
            <tbody>
              {snap.settlements.map((s) => (
                <tr key={s.id}>
                  <td className="tnum muted" style={{ textAlign: "left" }}>{fmtAgo(s.at, snap.now)}</td>
                  <td>{s.market}</td>
                  <td><span className={`chip ${s.closingSide === "Long" ? "chip-long" : "chip-short"}`}>{s.closingSide}</span></td>
                  <td className="tnum">{fmtUsd(s.exitPrice)}</td>
                  <td className={`tnum ${s.realizedPnl >= 0 ? "pos" : "neg"}`}>{fmtSignedUsd(s.realizedPnl)}</td>
                  <td className={`tnum ${s.netFunding >= 0 ? "pos" : "neg"}`}>{fmtSignedUsd(s.netFunding)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
