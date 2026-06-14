/** ConnectScreen.tsx — the Connect-Wallet landing. Pick (or create) which Canton
 * party you are; the whole app then runs from that wallet's point of view. This is
 * also the privacy demo — each wallet sees only what it's a stakeholder on. */
import { useState } from "react";
import { useStore } from "../store/store.tsx";
import { shortParty } from "../lib/format.ts";
import type { Party, PartyRole } from "../domain/types.ts";

const ROLE_META: Record<PartyRole, { emoji: string; tag: string; sees: string; color: string }> = {
  trader: { emoji: "🔵", tag: "Trader", sees: "Trade, hold a position, fund RWA collateral. Sees only your own orders & position.", color: "var(--blue)" },
  venue: { emoji: "⚙️", tag: "Operator", sees: "Runs the matching engine + risk loop. Sees the full dark order book and every position.", color: "var(--green)" },
  regulator: { emoji: "🛡️", tag: "Observer", sees: "Audit-only. Sees every position, counterparty and PnL — but cannot trade or interfere.", color: "var(--amber)" },
  outsider: { emoji: "👁️", tag: "Public", sees: "Not a stakeholder. Sees only the public price feed — positions are invisible.", color: "var(--down)" },
};

export function ConnectScreen() {
  const { snap, connect, createWallet, isMock } = useStore();
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);

  const traders = snap.parties.filter((p) => p.role === "trader");
  const roles = (["venue", "regulator", "outsider"] as PartyRole[])
    .map((r) => snap.parties.find((p) => p.role === r))
    .filter((p): p is Party => !!p);

  const create = async () => {
    const n = name.trim();
    if (!n || creating) return;
    setCreating(true);
    const id = await createWallet(n);
    setCreating(false);
    setName("");
    if (id) connect(id);
  };

  return (
    <div className="connect">
      <div className="connect-inner">
        <div className="connect-head">
          <div className="brand-mark" style={{ width: 44, height: 44, fontSize: 22 }}>◈</div>
          <div>
            <h1 className="connect-title">Darkpool</h1>
            <p className="connect-sub">Private Perpetual Futures on Canton · Chainlink-priced · RWA-collateralised</p>
          </div>
          <span className="chip" style={{ marginLeft: "auto" }}>
            <span className="dot live" style={{ background: isMock ? "var(--amber)" : "var(--green)" }} />
            {isMock ? "SIMULATED" : "LIVE · CANTON"}
          </span>
        </div>

        <p className="connect-cta">Connect a wallet to begin — each identity sees only what Canton lets it see.</p>

        <div className="connect-section-label">Trader wallets</div>
        <div className="wallet-grid">
          {traders.map((party) => (
            <WalletCard key={party.partyId} party={party} onConnect={() => connect(party.partyId)} />
          ))}
          <div className="wallet-card create" style={{ ["--accent" as any]: "var(--blue)" }}>
            <div className="wallet-top"><span className="wallet-emoji">＋</span><span className="wallet-tag" style={{ color: "var(--blue)" }}>New trader</span></div>
            <div className="wallet-name">Create a wallet</div>
            <div className="wallet-sees">Allocates a real Canton party and mints starting RWA collateral.</div>
            <input className="input" placeholder="Name (e.g. Charlie)" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && create()} />
            <button className="btn btn-long" style={{ height: 38 }} disabled={!name.trim() || creating} onClick={create}>
              {creating ? "Creating…" : "Create & connect →"}
            </button>
          </div>
        </div>

        <div className="connect-section-label" style={{ marginTop: 22 }}>Operator & observers</div>
        <div className="wallet-grid">
          {roles.map((party) => (
            <WalletCard key={party.partyId} party={party} onConnect={() => connect(party.partyId)} />
          ))}
        </div>
      </div>
    </div>
  );
}

function WalletCard({ party, onConnect }: { party: Party; onConnect: () => void }) {
  const m = ROLE_META[party.role];
  return (
    <button className="wallet-card" onClick={onConnect} style={{ ["--accent" as any]: m.color }}>
      <div className="wallet-top">
        <span className="wallet-emoji">{m.emoji}</span>
        <span className="wallet-tag" style={{ color: m.color }}>{m.tag}</span>
      </div>
      <div className="wallet-name">{party.label}</div>
      <div className="wallet-id">{party.partyId ? shortParty(party.partyId) : "…"}</div>
      <div className="wallet-sees">{m.sees}</div>
      <div className="wallet-connect">Connect →</div>
    </button>
  );
}
