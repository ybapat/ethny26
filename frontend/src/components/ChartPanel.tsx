/** ChartPanel.tsx — the primary chart with a clean header, a timeframe selector,
 * and the viewing trader's entry & liquidation overlays.
 *
 * The gateway streams only a short window of live Chainlink testnet price, so the
 * longer timeframes render a representative series anchored to (and scaled by) the
 * real live price — display only; trading always uses the on-ledger mark. */
import { useMemo, useState } from "react";
import { useStore } from "../store/store.tsx";
import { MARKETS } from "../domain/config.ts";
import { PriceChart, type OverlayLine } from "./PriceChart.tsx";
import { useClock } from "../lib/hooks.ts";
import { fmtCountdown, fmtPct, fmtUsd } from "../lib/format.ts";
import type { Candle } from "../domain/types.ts";

const TIMEFRAMES = ["1H", "4H", "1D", "1W", "1M"] as const;
type TF = (typeof TIMEFRAMES)[number];
const TF_CFG: Record<TF, { n: number; stepSec: number; vol: number }> = {
  "1H": { n: 60, stepSec: 60, vol: 0.0009 },
  "4H": { n: 48, stepSec: 300, vol: 0.0016 },
  "1D": { n: 96, stepSec: 900, vol: 0.0025 },
  "1W": { n: 84, stepSec: 7200, vol: 0.007 },
  "1M": { n: 90, stepSec: 28800, vol: 0.014 },
};

function mulberry32(a: number) {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Deterministic representative candles for a timeframe, normalised to end at 1.0
 * (the caller scales by the live price so the chart is continuous and live-anchored). */
function buildSeries(tf: TF, nowSec: number): Candle[] {
  const { n, stepSec, vol } = TF_CFG[tf];
  let seed = 0x9e3779b9;
  for (let i = 0; i < tf.length; i++) seed = (seed * 31 + tf.charCodeAt(i)) | 0;
  const rng = mulberry32(seed);
  const closes: number[] = new Array(n);
  closes[n - 1] = 1;
  for (let i = n - 2; i >= 0; i--) closes[i] = closes[i + 1] / (1 + (rng() - 0.5) * 2 * vol);
  const out: Candle[] = [];
  for (let i = 0; i < n; i++) {
    const close = closes[i];
    const open = i === 0 ? close : closes[i - 1];
    const wick = close * vol * 0.7;
    out.push({
      time: nowSec - (n - 1 - i) * stepSec,
      open,
      high: Math.max(open, close) + rng() * wick,
      low: Math.min(open, close) - rng() * wick,
      close,
    });
  }
  return out;
}

export function ChartPanel() {
  const { snap, market, visiblePositions, role } = useStore();
  const cfg = MARKETS.find((m) => m.market === market)!;
  const price = snap.prices[market]?.price ?? 0;
  const clock = useClock();
  const funding = snap.fundingByMarket[market];
  const countdown = funding ? funding.nextAt - clock : 0;

  const [tf, setTf] = useState<TF>("1D");
  // Base series is frozen per timeframe; we scale it by the live price each render
  // so the whole line stays continuous and the right edge tracks the real mark.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const base = useMemo(() => buildSeries(tf, snap.now), [tf]);
  const series = useMemo<Candle[]>(() => {
    if (!base.length || !price) return base;
    const k = price / base[base.length - 1].close;
    return base.map((c) => ({ time: c.time, open: c.open * k, high: c.high * k, low: c.low * k, close: c.close * k }));
  }, [base, price]);

  const open0 = series[0]?.open ?? price;
  const change = price && open0 ? (price - open0) / open0 : 0;
  const hi = series.length ? Math.max(...series.map((c) => c.high)) : 0;
  const lo = series.length ? Math.min(...series.map((c) => c.low)) : 0;
  const oi = snap.pairs.filter((p) => p.market === market).reduce((s, p) => s + p.size * price, 0);

  const overlays = useMemo<OverlayLine[]>(() => {
    const lines: OverlayLine[] = [];
    for (const p of visiblePositions.filter((p) => p.market === market).slice(0, 2)) {
      lines.push({ price: p.entryPrice, color: "#4f8bf5", label: `${p.side} entry` });
      lines.push({ price: p.liquidationPrice, color: "#f04d63", dashed: true, label: "liq. price" });
    }
    return lines;
  }, [visiblePositions, market]);

  return (
    <div className="card fill">
      <div className="chart-head">
        <div className="ch-id">
          <div className="row gap-sm">
            <span className="h1">{market}</span>
            <span className="chip">Perpetual</span>
          </div>
          <div className="ch-price">
            <span className="tnum ch-px">{fmtUsd(price)}</span>
            <span className={`tnum ch-chg ${change >= 0 ? "up" : "down"}`}>
              {change >= 0 ? "▲" : "▼"} {fmtPct(change)}
            </span>
          </div>
        </div>
        <div className="tf-seg">
          {TIMEFRAMES.map((t) => (
            <button key={t} className={t === tf ? "on" : ""} onClick={() => setTf(t)}>{t}</button>
          ))}
        </div>
      </div>
      <div className="chart-stats">
        <Stat label="Funding rate" value={fmtPct(funding?.rate ?? 0, 3)} accent={(funding?.rate ?? 0) >= 0 ? "var(--up)" : "var(--down)"} />
        <Stat label="Next funding" value={fmtCountdown(countdown)} />
        <Stat label="High" value={fmtUsd(hi)} />
        <Stat label="Low" value={fmtUsd(lo)} />
        <Stat label="Open interest" value={fmtUsd(oi, 0)} />
        <Stat label="Max leverage" value={`${Math.round(1 / cfg.initialMarginRate)}×`} />
      </div>
      {role === "outsider" && (
        <div className="public-note">
          You're viewing as an outsider — the live price is public, but no positions or orders are visible to you.
        </div>
      )}
      <PriceChart candles={series} points={series.length} overlays={overlays} />
    </div>
  );
}

function Stat({ label, value, accent }: { label: string; value: string; accent?: string }) {
  return (
    <div className="cs-stat">
      <span className="label">{label}</span>
      <span className="tnum" style={{ color: accent ?? "var(--text)", fontSize: 13.5, fontWeight: 600 }}>{value}</span>
    </div>
  );
}
