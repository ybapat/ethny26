/** OrderForm.tsx — the friendly buy/sell box. Long (green) / Short (red), a
 * leverage slider with presets, size + limit price, and a plain-language summary
 * with margin, liquidation price and fees. Trades as the current party. */
import { useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "../store/store.tsx";
import { INSTRUMENTS, MARKETS } from "../domain/config.ts";
import { liquidationPrice, minCollateralQty, notional } from "../domain/risk.ts";
import { fmtQty, fmtUsd } from "../lib/format.ts";
import type { Side } from "../domain/types.ts";

export function OrderForm() {
  const { snap, market, role, party, placeOrder, visibleOrders, visiblePositions } = useStore();
  const cfg = MARKETS.find((m) => m.market === market)!;
  const mark = snap.prices[market]?.price ?? 0;
  const nav = snap.navs[cfg.collateralInstrument]?.price ?? 1;
  const meta = INSTRUMENTS[cfg.collateralInstrument];
  const maxLev = Math.round(1 / cfg.initialMarginRate);
  const asset = market.split("-")[0];

  const [side, setSide] = useState<Side>("Long");
  const [leverage, setLeverage] = useState(Math.min(5, maxLev));
  const [size, setSize] = useState("2");
  const [limit, setLimit] = useState("");
  const [toast, setToast] = useState<{ ok: boolean; msg: string } | null>(null);
  const [placing, setPlacing] = useState(false);
  const before = useRef<{ o: number; p: number; err?: string }>({ o: 0, p: 0 });

  // Clear the spinner once the order actually lands on-ledger — it either rests
  // (a new resting order), matches into a position, or surfaces an error.
  useEffect(() => {
    if (!placing) return;
    if (visibleOrders.length > before.current.o || visiblePositions.length > before.current.p || snap.error !== before.current.err) {
      setPlacing(false);
    }
  }, [visibleOrders.length, visiblePositions.length, snap.error, placing]);

  const canTrade = role === "trader";
  const sizeN = parseFloat(size) || 0;
  const isMarket = limit.trim() === "";
  const limitN = isMarket ? mark : parseFloat(limit) || mark;

  const wallet = snap.holdings[party.partyId] ?? [];
  const collFree = wallet.find((h) => h.instrument === cfg.collateralInstrument)?.amount ?? 0;

  const presets = maxLev >= 20 ? [2, 5, 10, 20] : [2, 5, 10];

  const preview = useMemo(() => {
    if (sizeN <= 0 || limitN <= 0) return null;
    const escrowQty = minCollateralQty(sizeN, limitN, leverage, nav) * 1.05;
    const im = (sizeN * limitN) / leverage;
    const cv = escrowQty * nav;
    const liq = liquidationPrice(side, sizeN, limitN, cv, 0, cfg.maintenanceMarginRate);
    const fee = sizeN * limitN * cfg.takerFeeRate;
    return { value: notional(sizeN, limitN), im, reqQty: escrowQty, liq, fee, enough: collFree >= escrowQty };
  }, [sizeN, limitN, leverage, side, nav, cfg.maintenanceMarginRate, cfg.takerFeeRate, collFree]);

  const submit = () => {
    if (placing) return;
    // A "market" order (blank price) is sent as a marketable limit so it crosses
    // resting opposite orders; a typed price is used as a real limit (may rest).
    const submitPrice = isMarket ? (side === "Long" ? mark * 1.004 : mark * 0.996) : limitN;
    before.current = { o: visibleOrders.length, p: visiblePositions.length, err: snap.error };
    setPlacing(true);
    const r = placeOrder({ market, trader: party.partyId, side, size: sizeN, limitPrice: submitPrice, leverage });
    setToast(r.ok ? { ok: true, msg: isMarket ? "Market order sent — matching now…" : "Limit order resting privately in the book." } : { ok: false, msg: r.error ?? "Order rejected" });
    setTimeout(() => setToast(null), 3400);
    if (!r.ok) setPlacing(false);
    else setTimeout(() => setPlacing(false), 25000); // safety fallback
  };

  return (
    <div className="card fill ticket">
      <div className="ticket-tabs">
        <button className={`tt-tab long ${side === "Long" ? "on" : ""}`} onClick={() => setSide("Long")}>
          Buy / Long
        </button>
        <button className={`tt-tab short ${side === "Short" ? "on" : ""}`} onClick={() => setSide("Short")}>
          Sell / Short
        </button>
      </div>

      <div className="ticket-scroll">
        <div className="field">
          <div className="row between">
            <span className="label">Leverage</span>
            <span className="tnum" style={{ color: "var(--green)", fontWeight: 700 }}>{leverage}×</span>
          </div>
          <input type="range" min={1} max={maxLev} step={1} value={leverage} onChange={(e) => setLeverage(parseInt(e.target.value))} className="lev-range" />
          <div className="presets">
            {presets.map((p) => (
              <button key={p} className={`preset ${leverage === p ? "on" : ""}`} onClick={() => setLeverage(p)}>{p}×</button>
            ))}
          </div>
        </div>

        <div className="field">
          <div className="row between">
            <span className="label">Amount</span>
            <span className="muted" style={{ fontSize: 12 }}>≈ {preview ? fmtUsd(preview.value) : "—"}</span>
          </div>
          <div className="input-affix">
            <input className="input" value={size} onChange={(e) => setSize(e.target.value)} inputMode="decimal" />
            <span className="affix">{asset}</span>
          </div>
        </div>

        <div className="field">
          <span className="label">Limit price</span>
          <div className="input-affix">
            <input className="input" value={limit} placeholder={`${mark.toFixed(2)} (market)`} onChange={(e) => setLimit(e.target.value)} inputMode="decimal" />
            <span className="affix">USD</span>
          </div>
        </div>

        <div className="summary-box">
          <Row label="Order value" value={preview ? fmtUsd(preview.value) : "—"} />
          <Row label="Margin required" value={preview ? fmtUsd(preview.im) : "—"} />
          <Row label="Collateral locked" value={preview ? `${fmtQty(preview.reqQty)} ${meta.symbol}` : "—"} warn={preview ? !preview.enough : false} />
          <Row label="Liquidation price" value={preview ? fmtUsd(preview.liq) : "—"} accent="var(--down)" />
          <Row label="Est. fee" value={preview ? fmtUsd(preview.fee) : "—"} muted />
        </div>
      </div>

      <div className="ticket-footer">
        {toast && <div className={`toast ${toast.ok ? "ok" : "bad"}`}>{toast.msg}</div>}
        {canTrade ? (
          <>
            <div className="row between balance-row">
              <span className="muted" style={{ fontSize: 12.5 }}>Available collateral</span>
              <span className="tnum" style={{ fontSize: 12.5 }}>{fmtQty(collFree)} {meta.symbol}</span>
            </div>
            <button
              className={side === "Long" ? "btn btn-long" : "btn btn-short"}
              style={{ height: 46, fontSize: 15 }}
              disabled={!preview || !preview.enough || sizeN <= 0 || placing}
              onClick={submit}
            >
              {placing ? <><span className="spinner" /> Placing order…</> : side === "Long" ? `Buy / Long ${asset}` : `Sell / Short ${asset}`}
            </button>
          </>
        ) : (
          <div className="hint">
            You're connected as <strong>{party.label}</strong>, which can't trade. Disconnect (top-right) and connect as a <strong>trader</strong> wallet to place a trade.
          </div>
        )}
      </div>
    </div>
  );
}

function Row({ label, value, accent, warn, muted }: { label: string; value: string; accent?: string; warn?: boolean; muted?: boolean }) {
  return (
    <div className="row between sum-row">
      <span className="label" style={{ fontWeight: 500 }}>{label}</span>
      <span className="tnum" style={{ color: warn ? "var(--down)" : muted ? "var(--text-mid)" : accent ?? "var(--text)", fontSize: 13, fontWeight: 600 }}>
        {value}
      </span>
    </div>
  );
}
