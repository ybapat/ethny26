/** CollateralCard.tsx — your RWA collateral at a glance + a faucet to fund it.
 * This is the yield-bearing tokenized RWA used as margin (CANTON-RWA.md). The
 * "Get test RWA" faucet tops up your free collateral so you can open a trade. */
import { useState } from "react";
import { useStore } from "../store/store.tsx";
import { INSTRUMENTS, MARKETS } from "../domain/config.ts";
import { fmtPct, fmtQty, fmtUsd } from "../lib/format.ts";

const FAUCET_AMOUNT = 10;

export function CollateralCard() {
  const { snap, party, market, deposit } = useStore();
  const cfg = MARKETS.find((m) => m.market === market)!;
  const inst = cfg.collateralInstrument;
  const meta = INSTRUMENTS[inst];
  const nav = snap.navs[inst]?.price ?? meta?.nav ?? 1;
  const apy = snap.rwaApy ?? meta?.apy ?? 0;
  const holding = (snap.holdings[party.partyId] ?? []).find((h) => h.instrument === inst);
  const free = holding?.amount ?? 0;
  const locked = holding?.locked ?? 0;
  const por = snap.por[inst];
  const [flash, setFlash] = useState(false);

  const fund = () => {
    deposit(party.partyId, inst, FAUCET_AMOUNT);
    setFlash(true);
    setTimeout(() => setFlash(false), 1200);
  };

  return (
    <div className="card coll-card">
      <div className="coll-head">
        <div className="row gap-sm">
          <div className="token-badge" style={{ background: "var(--green-dim)" }}>{meta?.symbol?.slice(0, 2) ?? "RW"}</div>
          <div className="col">
            <span style={{ fontWeight: 700, fontSize: 13.5 }}>{meta?.symbol ?? inst} collateral</span>
            <span className="muted" style={{ fontSize: 10.5 }}>{meta?.name ?? "Tokenized RWA"}</span>
          </div>
        </div>
        {por?.whitelisted && <span className="chip chip-long" title="On the collateral whitelist; reserves ≥ supply">WHITELISTED</span>}
      </div>

      <div className="coll-stats">
        <div className="coll-stat">
          <span className="label">Free</span>
          <span className={`tnum ${flash ? "flash-up" : ""}`} style={{ fontSize: 18, fontWeight: 800 }}>{fmtQty(free, 2)}</span>
          <span className="muted tnum" style={{ fontSize: 10 }}>≈ {fmtUsd(free * nav)}</span>
        </div>
        <div className="coll-stat">
          <span className="label">Locked (margin)</span>
          <span className="tnum" style={{ fontSize: 18, fontWeight: 800, color: locked > 0 ? "var(--amber)" : "var(--text)" }}>{fmtQty(locked, 2)}</span>
          <span className="muted tnum" style={{ fontSize: 10 }}>≈ {fmtUsd(locked * nav)}</span>
        </div>
        <div className="coll-stat">
          <span className="label">NAV · Yield</span>
          <span className="tnum" style={{ fontSize: 18, fontWeight: 800 }}>{fmtUsd(nav)}</span>
          {apy ? <span className="tnum" style={{ fontSize: 10, color: "var(--up)" }} title="Real US Treasury bill rate">{fmtPct(apy, 2)} APY · T-bill</span> : null}
        </div>
      </div>

      <button className="btn btn-primary faucet-btn" onClick={fund}>＋ Get {FAUCET_AMOUNT.toLocaleString()} test {meta?.symbol ?? "RWA"}</button>
      <p className="muted" style={{ fontSize: 10.5, lineHeight: 1.5, marginTop: 8 }}>
        Yield-bearing margin — locked when you trade, unlocked on close.
      </p>
    </div>
  );
}
