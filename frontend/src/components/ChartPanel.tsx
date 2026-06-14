/** ChartPanel.tsx — the single primary chart with a clean market header.
 * Overlays the viewing trader's entry & liquidation lines. */
import { useMemo } from "react";
import { useStore } from "../store/store.tsx";
import { MARKETS } from "../domain/config.ts";
import { PriceChart, type OverlayLine } from "./PriceChart.tsx";
import { usePriceFlash, useClock } from "../lib/hooks.ts";
import { fmtCountdown, fmtPct, fmtUsd } from "../lib/format.ts";

export function ChartPanel() {
  const { snap, market, visiblePositions, role } = useStore();
  const cfg = MARKETS.find((m) => m.market === market)!;
  const price = snap.prices[market]?.price ?? 0;
  const candles = snap.candles[market] ?? [];
  const flash = usePriceFlash(price);
  const clock = useClock(); // ticks every second so the countdown is smooth between polls
  const funding = snap.fundingByMarket[market];
  const countdown = funding ? funding.nextAt - clock : 0;

  const dayOpen = candles[0]?.open ?? price;
  const change = price && dayOpen ? (price - dayOpen) / dayOpen : 0;
  const hi = candles.length ? Math.max(...candles.map((c) => c.high)) : 0;
  const lo = candles.length ? Math.min(...candles.map((c) => c.low)) : 0;
  const marketPairs = snap.pairs.filter((p) => p.market === market);
  const oi = marketPairs.reduce((s, p) => s + p.size * price, 0);

  const overlays = useMemo<OverlayLine[]>(() => {
    const own = visiblePositions.filter((p) => p.market === market);
    const lines: OverlayLine[] = [];
    for (const p of own.slice(0, 2)) {
      lines.push({ price: p.entryPrice, color: "#e8a948", label: `${p.side} entry` });
      lines.push({ price: p.liquidationPrice, color: "#ef5d72", dashed: true, label: "liq. price" });
    }
    return lines;
  }, [visiblePositions, market]);

  return (
    <div className="card fill">
      <div className="chart-strip">
        <div className="cs-main">
          <div className="row gap-sm">
            <span className="h1">{market}</span>
            <span className="chip">Perpetual</span>
          </div>
          <div className="row gap-sm" style={{ alignItems: "baseline", marginTop: 4 }}>
            <span className={`tnum ${flash ? `flash-${flash}` : ""}`} style={{ fontSize: 28, fontWeight: 700 }}>
              {fmtUsd(price)}
            </span>
            <span className={`tnum ${change >= 0 ? "up" : "down"}`} style={{ fontSize: 14, fontWeight: 600 }}>
              {change >= 0 ? "▲" : "▼"} {fmtPct(change)}
            </span>
          </div>
        </div>
        <div className="cs-stats">
          <Stat label="Funding rate" value={fmtPct(funding?.rate ?? 0, 3)} accent={(funding?.rate ?? 0) >= 0 ? "var(--up)" : "var(--down)"} hint="paid every hour" />
          <Stat label="Next funding" value={fmtCountdown(countdown)} />
          <Stat label="24h high" value={fmtUsd(hi)} />
          <Stat label="24h low" value={fmtUsd(lo)} />
          <Stat label="Open interest" value={fmtUsd(oi, 0)} />
          <Stat label="Max leverage" value={`${Math.round(1 / cfg.initialMarginRate)}×`} />
        </div>
      </div>
      {role === "outsider" && (
        <div className="public-note">
          You're viewing as an outsider — the live price is public, but no positions or orders are visible to you.
        </div>
      )}
      <PriceChart candles={candles} overlays={overlays} />
    </div>
  );
}

function Stat({ label, value, accent, hint }: { label: string; value: string; accent?: string; hint?: string }) {
  return (
    <div className="cs-stat">
      <span className="label">{label}{hint && <span className="cs-hint"> · {hint}</span>}</span>
      <span className="tnum" style={{ color: accent ?? "var(--text)", fontSize: 14, fontWeight: 600 }}>{value}</span>
    </div>
  );
}
