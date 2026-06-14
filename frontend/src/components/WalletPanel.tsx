/** WalletPanel.tsx — Token-Standard holdings (RWA collateral + USDCx), free vs
 * locked (Allocation escrow), RWA yield, and the Proof-of-Reserve / whitelist gate
 * (CANTON-RWA.md §3, §5, §6). Deposit / withdraw act on the free balance. */
import { useState } from "react";
import { useStore } from "../store/store.tsx";
import { INSTRUMENTS } from "../domain/config.ts";
import { fmtPct, fmtQty, fmtUsd } from "../lib/format.ts";

export function WalletPanel() {
  const { snap, party, role, deposit, withdraw } = useStore();
  const holdings = snap.holdings[party.partyId] ?? [];
  const isTrader = role === "trader";

  const totalValue = holdings.reduce((s, h) => {
    const nav = snap.navs[h.instrument]?.price ?? (h.instrument === "USDCx" ? 1 : 0);
    return s + (h.amount + h.locked) * nav;
  }, 0);

  return (
    <>
      <div className="panel">
        <div className="panel-head">
          <span className="panel-title">Wallet · {party.label.split(" — ")[0]}</span>
          <span className="chip">{party.partyId.split("::")[0]}::{party.partyId.split("::")[1]?.slice(0, 4)}</span>
        </div>
        <div className="panel-body col gap-md">
          <div className="net-value">
            <span className="label">Net account value</span>
            <span className="display tnum" style={{ fontSize: 30, fontWeight: 800 }}>{fmtUsd(totalValue)}</span>
          </div>
          {holdings.length === 0 && <div className="empty">This party holds no tokens.</div>}
          {holdings.map((h) => {
            const meta = INSTRUMENTS[h.instrument];
            const nav = snap.navs[h.instrument]?.price ?? 1;
            return (
              <div key={h.instrument} className="holding">
                <div className="row between">
                  <div className="row gap-sm">
                    <div className="token-badge" style={{ background: h.isCollateral ? "var(--green-deep)" : "var(--bg-hover)" }}>
                      {meta?.symbol?.slice(0, 2) ?? "??"}
                    </div>
                    <div className="col">
                      <span style={{ fontWeight: 600 }}>{meta?.symbol ?? h.instrument}</span>
                      <span className="muted" style={{ fontSize: 10.5 }}>{meta?.name}</span>
                    </div>
                  </div>
                  <div className="col" style={{ alignItems: "flex-end" }}>
                    <span className="tnum" style={{ fontWeight: 600 }}>{fmtQty(h.amount + h.locked)}</span>
                    <span className="muted tnum" style={{ fontSize: 10.5 }}>≈ {fmtUsd((h.amount + h.locked) * nav)}</span>
                  </div>
                </div>
                <div className="holding-meta">
                  <Meta label="Free" value={fmtQty(h.amount)} />
                  <Meta label="Locked (escrow)" value={fmtQty(h.locked)} accent={h.locked > 0 ? "var(--amber)" : undefined} />
                  <Meta label="NAV" value={fmtUsd(nav, 4)} />
                  {h.isCollateral && <Meta label="Yield" value={fmtPct(meta!.apy, 2) + " APY"} accent="var(--green)" />}
                </div>
                {isTrader && (
                  <DepositWithdraw
                    onDeposit={(amt) => deposit(party.partyId, h.instrument, amt)}
                    onWithdraw={(amt) => withdraw(party.partyId, h.instrument, amt)}
                  />
                )}
              </div>
            );
          })}
        </div>
      </div>

      <PoRCard />
    </>
  );
}

function PoRCard() {
  const { snap } = useStore();
  const por = Object.values(snap.por);
  return (
    <div className="panel">
      <div className="panel-head">
        <span className="panel-title">Collateral Gate · Proof of Reserve</span>
        <span className="label">CheckSolvency</span>
      </div>
      <div className="panel-body col gap-md">
        {por.map((p) => {
          const ratio = p.reserves / p.issuedSupply;
          return (
            <div key={p.instrument} className="por">
              <div className="row between">
                <span style={{ fontWeight: 600 }}>{p.instrument}</span>
                <div className="row gap-xs">
                  {p.whitelisted && <span className="chip chip-long">WHITELISTED</span>}
                  <span className={`chip ${p.solvent ? "chip-long" : "chip-short"}`}>{p.solvent ? "SOLVENT" : "UNDER-RESERVED"}</span>
                </div>
              </div>
              {p.source && <span className="chip" style={{ marginTop: 6, fontSize: 10 }} title="Live Chainlink Proof-of-Reserve feed read on-chain">📡 {p.source}</span>}
              <div className="holding-meta">
                <Meta label="Reserves" value={fmtUsd(p.reserves, 0)} />
                <Meta label="Issued supply" value={fmtUsd(p.issuedSupply, 0)} />
                <Meta label="Coverage" value={fmtPct(ratio - 1, 2) + " over"} accent="var(--green)" />
              </div>
              <div className="por-bar">
                <span className="por-fill" style={{ width: `${Math.min(100, (1 / ratio) * 100)}%` }} />
              </div>
              <span className="muted" style={{ fontSize: 10.5 }}>
                reserves ≥ issuedSupply asserted before any collateral is accepted as margin.
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function Meta({ label, value, accent }: { label: string; value: string; accent?: string }) {
  return (
    <div className="col" style={{ gap: 2 }}>
      <span className="label">{label}</span>
      <span className="tnum" style={{ color: accent ?? "var(--text)", fontSize: 12 }}>{value}</span>
    </div>
  );
}

function DepositWithdraw({ onDeposit, onWithdraw }: { onDeposit: (n: number) => void; onWithdraw: (n: number) => boolean | void }) {
  const [amt, setAmt] = useState("");
  const n = parseFloat(amt) || 0;
  return (
    <div className="row gap-sm" style={{ marginTop: 10 }}>
      <div className="input-affix grow" style={{ height: 32 }}>
        <input className="input tnum" style={{ height: 30, fontSize: 12 }} placeholder="0.00" value={amt} onChange={(e) => setAmt(e.target.value)} inputMode="decimal" />
      </div>
      <button className="btn btn-sm" disabled={n <= 0} onClick={() => { onDeposit(n); setAmt(""); }}>Deposit</button>
      <button className="btn btn-sm btn-ghost" disabled={n <= 0} onClick={() => { onWithdraw(n); setAmt(""); }}>Withdraw</button>
    </div>
  );
}
