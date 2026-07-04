import { useNavigate } from "react-router-dom";
import { useStore } from "../store/store.tsx";
import { useAuth } from "../store/authStore.tsx";
import { fmtUsd } from "../lib/format.ts";
import { usePriceFlash } from "../lib/hooks.ts";
import { NyxMark } from "./NyxMark.tsx";

export function TopBar() {
  const { snap, market, party, disconnect } = useStore();
  const { signOut } = useAuth();
  const navigate = useNavigate();
  const price = snap.prices[market]?.price ?? 0;
  const flash = usePriceFlash(price);
  const hash = party.partyId.split("::")[1] ?? "";
  const addr = hash ? `${hash.slice(0, 6)}…${hash.slice(-4)}` : "connecting…";
  const [base, quote] = market.split("-");

  const goWallets = () => { disconnect(); navigate("/wallets"); };
  const handleSignOut = async () => { disconnect(); await signOut(); navigate("/"); };

  return (
    <header className="topbar">
      <div className="brand">
        <NyxMark />
        <div className="col">
          <span className="brand-name">nyx</span>
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
      <button className="btn btn-sm btn-ghost" onClick={goWallets} title="Back to wallet list">
        ← Wallets
      </button>
      <button className="btn btn-sm btn-disconnect" onClick={handleSignOut} title="Sign out">
        Sign out
      </button>
    </header>
  );
}
