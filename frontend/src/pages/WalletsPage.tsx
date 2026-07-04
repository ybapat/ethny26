import { useState, useEffect, useCallback } from "react";
import { useNavigate, Link } from "react-router-dom";
import { useStore } from "../store/store.tsx";
import { useAuth } from "../store/authStore.tsx";
import { supabase } from "../lib/supabase.ts";
import { knownWallets } from "../data/wallet.ts";
import { NyxMark } from "../components/NyxMark.tsx";
import { IS_MOCK } from "../data/api.ts";

interface WalletRow {
  id: string;
  party_id: string;
  name: string;
  created_at: string;
  hasKey: boolean;
}

export function WalletsPage() {
  const { session, signOut } = useAuth();
  const { createSelfCustodyWallet, connect } = useStore();
  const navigate = useNavigate();

  const [wallets, setWallets] = useState<WalletRow[]>([]);
  const [pageLoading, setPageLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);
  const [newName, setNewName] = useState("");
  const [creating, setCreating] = useState(false);
  const [createErr, setCreateErr] = useState<string | null>(null);

  const loadWallets = useCallback(async () => {
    if (!session) return;
    const { data } = await supabase
      .from("wallets")
      .select("id, party_id, name, created_at")
      .order("created_at", { ascending: true });
    const keys = new Set(knownWallets());
    setWallets((data ?? []).map((w) => ({ ...w, hasKey: keys.has(w.party_id) })));
    setPageLoading(false);
  }, [session]);

  useEffect(() => { void loadWallets(); }, [loadWallets]);

  const handleTrade = (partyId: string) => {
    connect(partyId);
    navigate("/trade");
  };

  const handleCreate = async () => {
    const name = newName.trim();
    if (!name || creating) return;
    setCreateErr(null);
    setCreating(true);
    try {
      const partyId = await createSelfCustodyWallet(name);
      if (!partyId) { setCreateErr("Onboarding failed — please try again."); return; }
      await supabase.from("wallets").insert({
        user_id: session!.user.id,
        party_id: partyId,
        name,
      });
      setNewName("");
      setShowModal(false);
      await loadWallets();
    } catch (e) {
      setCreateErr((e as Error)?.message ?? "Unknown error");
    } finally {
      setCreating(false);
    }
  };

  const handleSignOut = async () => {
    await signOut();
    navigate("/");
  };

  return (
    <div className="wshell">
      <div className="lp-bg" aria-hidden />

      <header className="lp-nav">
        <Link to="/" className="brand" style={{ textDecoration: "none" }}>
          <NyxMark />
          <span className="brand-name">nyx</span>
        </Link>
        <div className="row gap-sm" style={{ marginLeft: "auto" }}>
          <span className="wshell-email">{session?.user.email}</span>
          <button className="btn btn-sm btn-ghost" onClick={handleSignOut}>Sign out</button>
        </div>
      </header>

      <main className="wallets-main">
        <div className="wallets-head">
          <div>
            <h1 className="wallets-title">Your Wallets</h1>
            <p className="wallets-sub">
              Self-custody Ed25519 keys held in your browser.
              {IS_MOCK && <span className="wallets-mode-chip">SIMULATED</span>}
              {!IS_MOCK && <span className="wallets-mode-chip live">LIVE · CANTON</span>}
            </p>
          </div>
          <button className="btn btn-primary" onClick={() => { setShowModal(true); setCreateErr(null); }}>
            + New Wallet
          </button>
        </div>

        {pageLoading ? (
          <div className="wallets-loading">Loading wallets…</div>
        ) : wallets.length === 0 ? (
          <div className="wallets-empty">
            <div className="we-icon">◈</div>
            <p className="we-title">No wallets yet</p>
            <p className="we-sub">Create your first self-custody wallet to start trading privately.</p>
            <button className="btn btn-primary" style={{ marginTop: 20 }} onClick={() => setShowModal(true)}>
              Create wallet →
            </button>
          </div>
        ) : (
          <div className="wcard-grid">
            {wallets.map((w) => (
              <div className="wcard" key={w.id}>
                <div className="wcard-top">
                  <span className="wcard-mark">◆</span>
                  <span className="wcard-tag">Trader</span>
                </div>
                <div className="wcard-name">{w.name}</div>
                <div className="wcard-id tnum">{shortId(w.party_id)}</div>
                <div className={`wcard-key-status ${w.hasKey ? "ok" : "warn"}`}>
                  {w.hasKey ? "✓ Key available" : "⚠ Key not on this device"}
                </div>
                <button
                  className="btn btn-primary wcard-trade"
                  disabled={!w.hasKey}
                  onClick={() => handleTrade(w.party_id)}
                  title={w.hasKey ? undefined : "Private key not stored on this device"}
                >
                  Trade →
                </button>
              </div>
            ))}
          </div>
        )}
      </main>

      {showModal && (
        <div className="wmodal-backdrop" onClick={() => setShowModal(false)}>
          <div className="wmodal" onClick={(e) => e.stopPropagation()}>
            <div className="wmodal-head">
              <span className="lp-h2">New wallet</span>
              <button className="lp-modal-x" onClick={() => setShowModal(false)}>✕</button>
            </div>
            <p className="lp-modal-sub">
              A fresh Ed25519 keypair is generated <b>in your browser</b> and a real Canton party
              is onboarded on-ledger. The private key never leaves this device.
            </p>
            <div className="auth-field">
              <label className="auth-label">Wallet name</label>
              <input
                className="input"
                placeholder="e.g. Alice"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleCreate()}
                autoFocus
              />
            </div>
            <button
              className="btn btn-primary lp-modal-create"
              disabled={!newName.trim() || creating}
              onClick={handleCreate}
            >
              {creating ? "Creating… (~15s)" : "Create wallet →"}
            </button>
            {createErr && <div className="lp-modal-err">{createErr}</div>}
          </div>
        </div>
      )}
    </div>
  );
}

function shortId(partyId: string): string {
  const hash = partyId.split("::")[1] ?? partyId;
  if (hash.length <= 12) return hash;
  return `${hash.slice(0, 8)}…${hash.slice(-4)}`;
}
