/** VenuePanel.tsx — the venue operator's control surface: the off-ledger trigger
 * loop (Canton has no keepers) + manual funding + demo price shocks to drive the
 * liquidation / settlement paths. Mirrors backend/src/loop/triggerLoop.ts. */
import { useStore } from "../store/store.tsx";
import { MARKETS } from "../domain/config.ts";
import { fmtBps, fmtClock, fmtUsd } from "../lib/format.ts";

export function VenuePanel() {
  const { snap, applyFunding, shockPrice, setRunning, market } = useStore();
  const cycle = snap.lastCycle;

  return (
    <>
      <div className="panel">
        <div className="panel-head">
          <span className="panel-title"><span className={`dot ${snap.running ? "live" : ""}`} style={{ background: snap.running ? "var(--green)" : "var(--text-dim)" }} /> Risk / Trigger Loop</span>
          <button className="btn btn-sm" onClick={() => setRunning(!snap.running)}>{snap.running ? "❚❚ Pause" : "▶ Resume"}</button>
        </div>
        <div className="panel-body">
          <div className="loop-grid">
            <LoopStat label="Last cycle" value={cycle ? fmtClock(cycle.at) : "—"} />
            <LoopStat label="Pairs evaluated" value={String(cycle?.evaluated ?? 0)} />
            <LoopStat label="Funding applied" value={String(cycle?.fundingApplied ?? 0)} />
            <LoopStat label="Liquidated" value={String(cycle?.liquidated ?? 0)} accent="var(--short)" />
            <LoopStat label="Settled" value={String(cycle?.settled ?? 0)} accent="var(--up)" />
            <LoopStat label="Stale skips" value={String(cycle?.skippedStale ?? 0)} />
          </div>
          <p className="muted" style={{ fontSize: 11, marginTop: 12, lineHeight: 1.6 }}>
            One deterministic pass per tick: refresh mark + NAV → staleness guard → apply funding →
            settle close requests → check <code>E &lt; MM</code> and liquidate. The fresh signed Chainlink
            report is threaded into every choice for in-transaction verification.
          </p>
        </div>
      </div>

      <div className="panel">
        <div className="panel-head">
          <span className="panel-title">Funding Control</span>
          <span className="label">MatchedPair.ApplyFunding</span>
        </div>
        <div className="panel-body col gap-sm">
          {MARKETS.map((m) => {
            const f = snap.fundingByMarket[m.market];
            return (
              <div key={m.market} className="row between ctl-row">
                <div className="col">
                  <span style={{ fontWeight: 600 }}>{m.market}</span>
                  <span className="muted" style={{ fontSize: 10.5 }}>rate {fmtBps(f?.rate ?? 0)} · {snap.pairs.filter((p) => p.market === m.market).length} pairs</span>
                </div>
                <button className="btn btn-sm" onClick={() => applyFunding(m.market)}>Apply Funding Now</button>
              </div>
            );
          })}
        </div>
      </div>

      <div className="panel">
        <div className="panel-head">
          <span className="panel-title">Demo · Oracle Shock</span>
          <span className="label">drive liquidation / settle</span>
        </div>
        <div className="panel-body col gap-sm">
          <p className="muted" style={{ fontSize: 11, lineHeight: 1.5 }}>
            Push the <strong>{market}</strong> mark to force a maintenance-margin breach. The loop will
            verify the price, assert <code>E &lt; MM</code>, and seize the breaching side's collateral.
          </p>
          <div className="row gap-sm wrap">
            <button className="btn btn-sm btn-short" onClick={() => shockPrice(market, -0.06)}>−6% Crash</button>
            <button className="btn btn-sm btn-short" onClick={() => shockPrice(market, -0.12)}>−12% Crash</button>
            <button className="btn btn-sm btn-long" onClick={() => shockPrice(market, 0.06)}>+6% Spike</button>
            <button className="btn btn-sm btn-long" onClick={() => shockPrice(market, 0.12)}>+12% Spike</button>
          </div>
          <div className="row between" style={{ marginTop: 6 }}>
            <span className="label">Current mark</span>
            <span className="tnum">{fmtUsd(snap.prices[market]?.price ?? 0)}</span>
          </div>
        </div>
      </div>
    </>
  );
}

function LoopStat({ label, value, accent }: { label: string; value: string; accent?: string }) {
  return (
    <div className="loop-stat">
      <span className="label">{label}</span>
      <span className="tnum" style={{ fontSize: 18, fontWeight: 700, color: accent ?? "var(--text)" }}>{value}</span>
    </div>
  );
}
