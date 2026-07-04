import { Link } from "react-router-dom";
import { NyxMark } from "../components/NyxMark.tsx";
import { IS_MOCK } from "../data/api.ts";
import { useAuth } from "../store/authStore.tsx";

const FEATURES = [
  {
    mark: "◈",
    color: "var(--green)",
    title: "Structural Privacy",
    body: "Positions are visible only to you, your counterparty, and a regulated observer. Privacy is enforced on-chain by Canton — not by policy.",
  },
  {
    mark: "◆",
    color: "var(--up)",
    title: "Yield-Bearing Margin",
    body: "Your collateral is a tokenised T-bill that earns real yield while it backs your position. Your margin works even when you're not trading.",
  },
  {
    mark: "⬡",
    color: "var(--blue)",
    title: "Self-Custody Keys",
    body: "An Ed25519 keypair is generated in your browser and never sent anywhere. You sign every trade. Not your keys, not your trades.",
  },
  {
    mark: "●",
    color: "var(--amber)",
    title: "Chainlink-Priced",
    body: "Real-time ETH/USD from Chainlink Data Streams. Proof-of-Reserve gates collateral acceptance. On-chain data you can verify.",
  },
] as const;

export function LandingPage() {
  const { session } = useAuth();

  return (
    <div className="lp">
      <div className="lp-bg" aria-hidden />

      <header className="lp-nav">
        <div className="brand">
          <NyxMark />
          <span className="brand-name">nyx</span>
        </div>
        <div className="row gap-sm">
          <span className="lp-network">{IS_MOCK ? "SIMULATED" : "LIVE · CANTON"}</span>
          {session ? (
            <Link to="/wallets" className="btn btn-sm btn-primary">Go to app →</Link>
          ) : (
            <>
              <Link to="/login" className="btn btn-sm btn-ghost">Sign in</Link>
              <Link to="/signup" className="btn btn-sm btn-primary">Start trading →</Link>
            </>
          )}
        </div>
      </header>

      <main className="lp-main">
        <section className="lp-hero">
          <span className="lp-eyebrow">Private Perpetuals · Canton Network · Chainlink-Priced</span>
          <h1 className="lp-title">Private Perps.<br />Earn Yield with Leverage.</h1>
          <p className="lp-sub">
            Leveraged perpetuals that stay private — visible only to you, your counterparty,
            and a regulator. Your margin is a yield-bearing real-world asset that keeps earning
            while it backs your position.
          </p>
          <div className="lp-cta">
            {session ? (
              <Link to="/wallets" className="btn btn-primary lp-cta-main">Go to your wallets →</Link>
            ) : (
              <>
                <Link to="/signup" className="btn btn-primary lp-cta-main">Get started →</Link>
                <Link to="/login" className="lp-cta-link">Already have an account ↗</Link>
              </>
            )}
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

        <section className="lp-features" id="features">
          <div className="lp-section-head">
            <h2 className="lp-h2">Built different</h2>
            <p className="lp-section-sub">Four properties that no other perps platform has at once.</p>
          </div>
          <div className="lp-feat-grid">
            {FEATURES.map((f) => (
              <div className="lp-feat" key={f.title}>
                <span className="lp-feat-mark" style={{ color: f.color }}>{f.mark}</span>
                <div className="lp-feat-title">{f.title}</div>
                <p className="lp-feat-body">{f.body}</p>
              </div>
            ))}
          </div>
        </section>

        <section className="lp-bottom">
          <h2 className="lp-h2">Ready to trade privately?</h2>
          <p className="lp-section-sub" style={{ marginTop: 10, marginBottom: 28, marginLeft: "auto", marginRight: "auto" }}>
            Create an account, generate a self-custody wallet, and open your first position in under two minutes.
          </p>
          {session ? (
            <Link to="/wallets" className="btn btn-primary lp-cta-main">Go to your wallets →</Link>
          ) : (
            <Link to="/signup" className="btn btn-primary lp-cta-main">Create free account →</Link>
          )}
        </section>
      </main>

      <footer className="lp-footer">
        <span>© 2026 nyx</span>
        <span>Built for ETHGlobal NYC · Canton Network · Chainlink</span>
      </footer>
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
