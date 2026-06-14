/** TopBar.tsx — slim header: brand, the live market, and the connected identity
 * with a Disconnect (switch wallet) button. Each role gets a single focused
 * screen (see App.tsx). */
import { useStore } from "../store/store.tsx";
import { fmtUsd } from "../lib/format.ts";
import { usePriceFlash } from "../lib/hooks.ts";

export function TopBar() {
  const { snap, market, party, disconnect } = useStore();
  const price = snap.prices[market]?.price ?? 0;
  const flash = usePriceFlash(price);
  const hash = party.partyId.split("::")[1] ?? "";
  const addr = hash ? `${hash.slice(0, 6)}…${hash.slice(-4)}` : "connecting…";
  const [base, quote] = market.split("-");

  return (
    <header className="topbar">
      <div className="brand">
        <div className="brand-mark">◈</div>
        <div className="col">
          <span className="brand-name">Darkpool</span>
          <span className="brand-sub">Private Perpetuals</span>
        </div>
      </div>

      <div className="market-tag" title="The live perpetual market">
        <span className="mk-sym">{base}<span className="mk-quote">/{quote}</span></span>
        <span className="mk-perp">PERP</span>
        <span className={`mk-px tnum ${flash ? `flash-${flash}` : ""}`}>{fmtUsd(price)}</span>
      </div>

      <div className="grow" />

      <div className="conn-pill" title={party.partyId}>
        <span className="conn-name">{party.label}</span>
        <span className="conn-addr tnum">{addr}</span>
      </div>
      <button className="btn btn-sm btn-disconnect" onClick={disconnect} title="Switch to another wallet">Disconnect</button>
    </header>
  );
}
