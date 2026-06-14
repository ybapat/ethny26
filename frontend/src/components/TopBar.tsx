/** TopBar.tsx — slim header: brand, the live market, and the connected identity
 * with a Disconnect (switch wallet) button. Tabs/market-switch removed for the
 * clean demo; each role gets a single focused screen (see App.tsx). */
import { useStore } from "../store/store.tsx";
import { fmtUsd, shortParty } from "../lib/format.ts";
import { usePriceFlash } from "../lib/hooks.ts";

const ROLE_COLOR: Record<string, string> = {
  trader: "var(--blue)", venue: "var(--green)",
  regulator: "var(--amber)", outsider: "var(--down)",
};

export function TopBar() {
  const { snap, market, party, role, disconnect } = useStore();
  const price = snap.prices[market]?.price ?? 0;
  const flash = usePriceFlash(price);
  const color = ROLE_COLOR[role] ?? "var(--text)";

  return (
    <header className="topbar">
      <div className="brand">
        <div className="brand-mark">◈</div>
        <div className="col">
          <span className="brand-name">Darkpool</span>
          <span className="brand-sub">Private Perpetuals</span>
        </div>
      </div>

      <div className="market-select" style={{ cursor: "default" }} title="The live perpetual market">
        <span className="sym">{market}</span>
        <span className={`tnum ${flash ? `flash-${flash}` : ""}`} style={{ fontWeight: 700 }}>{fmtUsd(price)}</span>
      </div>

      <div className="grow" />

      <div className="conn-pill" style={{ ["--accent" as any]: color }}>
        <span className="pdot" style={{ background: color }} />
        <div className="col" style={{ gap: 1 }}>
          <span style={{ fontWeight: 700, fontSize: 13 }}>{party.label}</span>
          <span className="muted tnum" style={{ fontSize: 10 }}>{party.partyId ? shortParty(party.partyId) : "connecting…"}</span>
        </div>
      </div>
      <button className="btn btn-sm btn-ghost" onClick={disconnect} title="Switch to another wallet">Disconnect</button>
    </header>
  );
}
