import { useState } from "react";
import { Routes, Route, Navigate } from "react-router-dom";
import { useAuth } from "./store/authStore.tsx";
import { useStore } from "./store/store.tsx";
import { LandingPage } from "./pages/LandingPage.tsx";
import { LoginPage } from "./pages/LoginPage.tsx";
import { SignupPage } from "./pages/SignupPage.tsx";
import { WalletsPage } from "./pages/WalletsPage.tsx";
import { TopBar } from "./components/TopBar.tsx";
import { ChartPanel } from "./components/ChartPanel.tsx";
import { OrderForm } from "./components/OrderForm.tsx";
import { CollateralCard } from "./components/CollateralCard.tsx";
import { TraderActivity } from "./components/TraderActivity.tsx";

export function App() {
  return (
    <Routes>
      <Route path="/"        element={<LandingPage />} />
      <Route path="/login"   element={<PublicOnly><LoginPage /></PublicOnly>} />
      <Route path="/signup"  element={<PublicOnly><SignupPage /></PublicOnly>} />
      <Route path="/wallets" element={<AuthRequired><WalletsPage /></AuthRequired>} />
      <Route path="/trade"   element={<AuthRequired><TradePage /></AuthRequired>} />
      <Route path="*"        element={<Navigate to="/" replace />} />
    </Routes>
  );
}

function AuthRequired({ children }: { children: React.ReactNode }) {
  const { session, loading } = useAuth();
  if (loading) return <FullPageSpinner />;
  if (!session) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

function PublicOnly({ children }: { children: React.ReactNode }) {
  const { session, loading } = useAuth();
  if (loading) return <FullPageSpinner />;
  if (session) return <Navigate to="/wallets" replace />;
  return <>{children}</>;
}

function FullPageSpinner() {
  return (
    <div style={{ height: "100vh", display: "grid", placeItems: "center", color: "var(--text-dim)", fontSize: 13 }}>
      Loading…
    </div>
  );
}

function TradePage() {
  const { connected, snap } = useStore();
  if (!connected) return <Navigate to="/wallets" replace />;

  return (
    <div className="app">
      <TopBar />
      {snap.error && <ErrorBanner msg={snap.error} />}
      <main className="main">
        <div className="trade-grid">
          <div className="area-chart"><ChartPanel /></div>
          <div className="area-ticket ticket-col">
            <CollateralCard />
            <OrderForm />
          </div>
          <div className="area-bottom"><TraderActivity /></div>
        </div>
      </main>
    </div>
  );
}

function ErrorBanner({ msg }: { msg: string }) {
  const [hidden, setHidden] = useState("");
  if (hidden === msg) return null;
  return (
    <div style={{ padding: "8px 16px", background: "var(--down-soft)", color: "var(--down)", fontSize: 12.5, display: "flex", alignItems: "center", gap: 10, borderBottom: "1px solid var(--down)" }}>
      <span style={{ flex: 1 }}>⚠ {msg}</span>
      <button className="btn btn-sm btn-ghost" onClick={() => setHidden(msg)}>dismiss</button>
    </div>
  );
}
