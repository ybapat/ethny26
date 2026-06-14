/** ConnectScreen.tsx — the Nyx landing page. Sells the product, puts a
 * Connect-Wallet CTA where users expect it, and makes the privacy viewpoints a
 * first-class section: step into any party and see only what Canton lets it see. */
import { useState } from "react";
import { useStore } from "../store/store.tsx";
import { NyxMark } from "./NyxMark.tsx";
import type { Party, PartyRole } from "../domain/types.ts";

const VIEW_META: Record<PartyRole, { tag: string; mark: string; color: string; sees: string }> = {
  trader: { tag: "Trader", mark: "◆", color: "var(--green)", sees: "Trades and holds a position. Sees only their own orders and position." },
  venue: { tag: "Operator", mark: "⚙", color: "var(--green)", sees: "Runs the matching engine and risk loop. Sees the full dark book and every position." },
  regulator: { tag: "Observer", mark: "⬡", color: "var(--amber)", sees: "Audits everything — every position, counterparty and PnL. Cannot trade or interfere." },
  outsider: { tag: "Public", mark: "○", color: "var(--down)", sees: "Not a stakeholder. Sees only the public price feed — positions are invisible." },
};

export function ConnectScreen() {
  const { snap, connect, isMock } = useStore();
  const [modal, setModal] = useState(false);

  const traders = snap.parties.filter((p) => p.role === "trader");
  const roles = (["venue", "regulator", "outsider"] as PartyRole[])
    .map((r) => snap.parties.find((p) => p.role === r))
    .filter((p): p is Party => !!p);

  return (
    <div className="lp">
      <div className="lp-bg" aria-hidden />
      <header className="lp-nav">
        <div className="brand">
          <NyxMark />
          <span className="brand-name">nyx</span>
        </div>
        <div className="row gap-sm">
          <span className="lp-status"><span className="dot live" style={{ background: isMock ? "var(--amber)" : "var(--up)" }} />{isMock ? "SIMULATED" : "LIVE · CANTON"}</span>
          <button className="btn btn-primary" onClick={() => setModal(true)}>Connect Wallet</button>
        </div>
      </header>

      <main className="lp-main">
        <section className="lp-hero">
          <span className="lp-eyebrow">Private Perpetuals · Canton Network · Chainlink-Priced</span>
          <h1 className="lp-title">Private Perps.<br />Earn Yield with Leverage.</h1>
          <p className="lp-sub">
            Leveraged perpetuals that stay private — visible only to you, your counterparty, and a
            regulator. Your margin is a yield-bearing real-world asset that keeps earning while it
            backs your position.
          </p>
          <div className="lp-cta">
            <button className="btn btn-primary lp-cta-main" onClick={() => setModal(true)}>Connect Wallet →</button>
            <a className="lp-cta-link" href="#viewpoints">Explore the viewpoints ↓</a>
          </div>

          <div className="lp-privacy">
            <span className="label">Who can see your position?</span>
            <div className="lp-views">
              <Vis label="You" ok />
              <Vis label="Counterparty" ok />
              <Vis label="Venue" ok />
              <Vis label="Regulator" ok />
              <Vis label="Everyone else" />
            </div>
          </div>
        </section>

        <section className="lp-section" id="viewpoints">
          <div className="lp-section-head">
            <h2 className="lp-h2">See it from every side</h2>
            <p className="lp-section-sub">Privacy is structural here — each party sees only what Canton lets it. Step into any viewpoint.</p>
          </div>
          <div className="lp-tiles">
            {traders.map((p) => <ViewTile key={p.partyId} party={p} onConnect={() => connect(p.partyId)} />)}
            {roles.map((p) => <ViewTile key={p.partyId} party={p} onConnect={() => connect(p.partyId)} />)}
          </div>
          {traders.length === 0 && (
            <p className="lp-hint">No trader wallets yet — connect one to take the first private position.</p>
          )}
        </section>
      </main>

      {modal && <ConnectModal traders={traders} onClose={() => setModal(false)} />}
    </div>
  );
}

function Vis({ label, ok }: { label: string; ok?: boolean }) {
  return (
    <span className={`lp-vis ${ok ? "yes" : "no"}`}>
      <span className="lp-vis-mark">{ok ? "●" : "○"}</span>{label}
    </span>
  );
}

function ViewTile({ party, onConnect }: { party: Party; onConnect: () => void }) {
  const m = VIEW_META[party.role];
  return (
    <button className="lp-tile" onClick={onConnect}>
      <div className="lp-tile-top">
        <span className="lp-tile-mark" style={{ color: m.color }}>{m.mark}</span>
        <span className="lp-tile-tag" style={{ color: m.color }}>{m.tag}</span>
      </div>
      <div className="lp-tile-name">{party.label}</div>
      <div className="lp-tile-sees">{m.sees}</div>
      <div className="lp-tile-go">Enter →</div>
    </button>
  );
}

function ConnectModal({ traders, onClose }: { traders: Party[]; onClose: () => void }) {
  const { connect, createSelfCustodyWallet } = useStore();
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const create = async () => {
    const n = name.trim();
    if (!n || creating) return;
    setErr(null);
    setCreating(true);
    try {
      const id = await createSelfCustodyWallet(n);
      if (id) connect(id);
      else setErr("Onboarding failed — please try again.");
    } catch (e) {
      setErr("Onboarding error: " + ((e as Error)?.message ?? String(e)));
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="lp-modal-backdrop" onClick={onClose}>
      <div className="lp-modal" onClick={(e) => e.stopPropagation()}>
        <div className="lp-modal-head">
          <span className="lp-h2">Connect a wallet</span>
          <button className="lp-modal-x" onClick={onClose} aria-label="Close">✕</button>
        </div>
        <p className="lp-modal-sub">A self-custody Ed25519 key is generated and held <b>in your browser</b> — you sign your own trades.</p>

        <div className="field">
          <input className="input" placeholder="Name (e.g. Alice)" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && create()} autoFocus />
        </div>
        <button className="btn btn-primary lp-modal-create" disabled={!name.trim() || creating} onClick={create}>
          {creating ? "Onboarding… (~15s)" : "Create & connect →"}
        </button>
        {err && <div className="lp-modal-err">{err}</div>}

        {traders.length > 0 && (
          <>
            <div className="lp-modal-divider"><span>or reconnect</span></div>
            <div className="lp-modal-wallets">
              {traders.map((p) => (
                <button key={p.partyId} className="lp-modal-wallet" onClick={() => connect(p.partyId)}>
                  <span className="lp-mw-mark">◆</span>
                  <span className="lp-mw-name">{p.label}</span>
                  <span className="lp-mw-go">→</span>
                </button>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
