import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useAuth } from "../store/authStore.tsx";
import { NyxMark } from "../components/NyxMark.tsx";

interface Props { mode: "signin" | "signup"; }

export function AuthPage({ mode: initialMode }: Props) {
  const { signIn, signUp } = useAuth();
  const navigate = useNavigate();
  const [mode, setMode] = useState(initialMode);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const switchMode = (next: "signin" | "signup") => {
    setMode(next);
    setErr(null);
    navigate(next === "signin" ? "/login" : "/signup", { replace: true });
  };

  const submit = async () => {
    const e = email.trim();
    if (!e || !password || loading) return;
    setErr(null);
    setLoading(true);
    try {
      const error = mode === "signin"
        ? await signIn(e, password)
        : await signUp(e, password);
      if (error) { setErr(error); return; }
      navigate("/wallets", { replace: true });
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="auth-shell">
      <div className="lp-bg" aria-hidden />

      <header className="lp-nav">
        <Link to="/" className="brand" style={{ textDecoration: "none" }}>
          <NyxMark />
          <span className="brand-name">nyx</span>
        </Link>
      </header>

      <div className="auth-center">
        <div className="auth-card">
          <div className="auth-card-head">
            <div className="auth-logo-wrap">
              <NyxMark />
            </div>
            <h1 className="auth-card-title">
              {mode === "signin" ? "Welcome back" : "Create account"}
            </h1>
            <p className="auth-card-sub">
              {mode === "signin"
                ? "Sign in to access your wallets and positions."
                : "Join nyx and start trading perpetuals in private."}
            </p>
          </div>

          {/* tab toggle */}
          <div className="auth-tabs">
            <button
              className={`auth-tab ${mode === "signin" ? "on" : ""}`}
              onClick={() => switchMode("signin")}
            >
              Sign in
            </button>
            <button
              className={`auth-tab ${mode === "signup" ? "on" : ""}`}
              onClick={() => switchMode("signup")}
            >
              Create account
            </button>
            <div className="auth-tab-pill" style={{ transform: mode === "signup" ? "translateX(100%)" : "none" }} />
          </div>

          <div className="auth-form">
            <div className="auth-field">
              <label className="auth-label">Email</label>
              <input
                className="input"
                type="email"
                placeholder="you@example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && submit()}
                autoComplete="email"
                autoFocus
              />
            </div>
            <div className="auth-field">
              <label className="auth-label">Password</label>
              <input
                className="input"
                type="password"
                placeholder={mode === "signup" ? "At least 6 characters" : "Your password"}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && submit()}
                autoComplete={mode === "signin" ? "current-password" : "new-password"}
              />
            </div>

            {err && <div className="auth-err">⚠ {err}</div>}

            <button
              className="auth-submit"
              disabled={!email.trim() || !password || loading}
              onClick={submit}
            >
              {loading
                ? (mode === "signin" ? "Signing in…" : "Creating account…")
                : (mode === "signin" ? "Sign in →" : "Create account →")}
            </button>
          </div>

          <p className="auth-switch">
            {mode === "signin" ? (
              <>Don't have an account? <button className="auth-switch-btn" onClick={() => switchMode("signup")}>Sign up →</button></>
            ) : (
              <>Already have an account? <button className="auth-switch-btn" onClick={() => switchMode("signin")}>Sign in →</button></>
            )}
          </p>
        </div>
      </div>
    </div>
  );
}
