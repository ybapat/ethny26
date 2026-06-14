/** PriceChart.tsx — a clean area/line price chart with a price axis, an adaptive
 * time axis, and a hover crosshair + tooltip. Green when up, red when down. */
import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import type { Candle } from "../domain/types.ts";
import { fmtUsd } from "../lib/format.ts";

export interface OverlayLine {
  price: number;
  color: string;
  label: string;
  dashed?: boolean;
}

interface Props {
  candles: Candle[];
  /** How many trailing points to show. Smaller = more zoomed in. */
  points?: number;
  overlays?: OverlayLine[];
}

const MONO = "'Geist Mono', monospace";
const UI = "'Hanken Grotesk', sans-serif";

const pad2 = (n: number) => n.toString().padStart(2, "0");
function fmtAxis(unixSec: number, spanSec: number): string {
  const d = new Date(unixSec * 1000);
  if (spanSec > 3 * 86400) return `${pad2(d.getMonth() + 1)}/${pad2(d.getDate())}`;
  if (spanSec > 2 * 3600) return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}
function fmtFull(unixSec: number, spanSec: number): string {
  const d = new Date(unixSec * 1000);
  const t = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  if (spanSec > 3 * 86400) return `${pad2(d.getMonth() + 1)}/${pad2(d.getDate())} · ${t}`;
  if (spanSec > 2 * 3600) return t;
  return `${t}:${pad2(d.getSeconds())}`;
}

interface Scale {
  view: Candle[];
  plotW: number;
  plotH: number;
  padT: number;
  lo: number;
  hi: number;
  W: number;
  spanSec: number;
}

export function PriceChart({ candles, points = 26, overlays = [] }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const scaleRef = useRef<Scale | null>(null);
  const [hover, setHover] = useState<{ x: number; y: number; price: number; time: number } | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;

    const draw = () => {
      const dpr = globalThis.devicePixelRatio || 1;
      const W = wrap.clientWidth;
      const H = wrap.clientHeight;
      if (W === 0 || H === 0) return;
      canvas.width = W * dpr;
      canvas.height = H * dpr;
      canvas.style.width = `${W}px`;
      canvas.style.height = `${H}px`;
      const ctx = canvas.getContext("2d")!;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, W, H);
      if (candles.length === 0) return;

      const padR = 62;
      const padB = 26;
      const padT = 14;
      const plotW = W - padR;
      const plotH = H - padB - padT;

      const view = candles.slice(-points);
      const pts = view.map((c) => c.close);
      let lo = Math.min(...pts);
      let hi = Math.max(...pts);
      for (const o of overlays) if (o.price > 0) { lo = Math.min(lo, o.price); hi = Math.max(hi, o.price); }
      const padP = (hi - lo || 1) * 0.1;
      lo -= padP;
      hi += padP;
      const spanSec = (view[view.length - 1]?.time ?? 0) - (view[0]?.time ?? 0);
      scaleRef.current = { view, plotW, plotH, padT, lo, hi, W, spanSec };

      const xOf = (i: number) => (i / (pts.length - 1 || 1)) * plotW;
      const yOf = (p: number) => padT + plotH - ((p - lo) / (hi - lo)) * plotH;

      // horizontal gridlines + price axis (right)
      ctx.font = `11px ${MONO}`;
      ctx.textBaseline = "middle";
      const rows = 5;
      for (let i = 0; i <= rows; i++) {
        const p = lo + ((hi - lo) * i) / rows;
        const y = yOf(p);
        ctx.strokeStyle = "rgba(255,255,255,0.045)";
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(plotW, y);
        ctx.stroke();
        ctx.fillStyle = "#6b7079";
        ctx.textAlign = "left";
        ctx.fillText(p.toFixed(p > 1000 ? 0 : 2), plotW + 8, y);
      }

      // vertical gridlines + time axis (bottom)
      ctx.textBaseline = "alphabetic";
      ctx.textAlign = "center";
      const cols = Math.min(6, pts.length - 1 || 1);
      for (let c = 0; c <= cols; c++) {
        const i = Math.round((c / cols) * (pts.length - 1));
        const x = xOf(i);
        ctx.strokeStyle = "rgba(255,255,255,0.035)";
        ctx.beginPath();
        ctx.moveTo(x, padT);
        ctx.lineTo(x, padT + plotH);
        ctx.stroke();
        ctx.fillStyle = "#6b7079";
        const t = view[i]?.time;
        if (t) {
          const tx = Math.max(20, Math.min(plotW - 20, x));
          ctx.fillText(fmtAxis(t, spanSec), tx, H - 9);
        }
      }

      const up = pts[pts.length - 1] >= pts[0];
      const line = up ? "#25cc7d" : "#f04d63";

      // area fill
      const grad = ctx.createLinearGradient(0, padT, 0, padT + plotH);
      grad.addColorStop(0, up ? "rgba(37,204,125,0.16)" : "rgba(240,77,99,0.16)");
      grad.addColorStop(1, up ? "rgba(37,204,125,0)" : "rgba(240,77,99,0)");
      ctx.beginPath();
      ctx.moveTo(xOf(0), yOf(pts[0]));
      pts.forEach((p, i) => ctx.lineTo(xOf(i), yOf(p)));
      ctx.lineTo(xOf(pts.length - 1), padT + plotH);
      ctx.lineTo(xOf(0), padT + plotH);
      ctx.closePath();
      ctx.fillStyle = grad;
      ctx.fill();

      // line
      ctx.beginPath();
      ctx.moveTo(xOf(0), yOf(pts[0]));
      pts.forEach((p, i) => ctx.lineTo(xOf(i), yOf(p)));
      ctx.strokeStyle = line;
      ctx.lineWidth = 2;
      ctx.lineJoin = "round";
      ctx.stroke();

      // last point marker + price tag
      const lastY = yOf(pts[pts.length - 1]);
      const lastX = xOf(pts.length - 1);
      ctx.fillStyle = line;
      ctx.beginPath();
      ctx.arc(lastX, lastY, 3.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 0.22;
      ctx.beginPath();
      ctx.arc(lastX, lastY, 7, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.fillStyle = line;
      roundRect(ctx, plotW + 2, lastY - 11, padR - 4, 22, 6);
      ctx.fill();
      ctx.fillStyle = "#06101f";
      ctx.font = `700 11px ${MONO}`;
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      ctx.fillText(pts[pts.length - 1].toFixed(pts[pts.length - 1] > 1000 ? 1 : 2), plotW + 8, lastY);

      // overlay lines (entry / liq)
      ctx.font = `600 10px ${UI}`;
      for (const o of overlays) {
        if (o.price <= 0) continue;
        const y = yOf(o.price);
        if (y < padT || y > padT + plotH) continue;
        ctx.strokeStyle = o.color;
        ctx.setLineDash(o.dashed ? [6, 5] : []);
        ctx.lineWidth = 1.25;
        ctx.globalAlpha = 0.85;
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(plotW, y);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.globalAlpha = 1;
        const tw = ctx.measureText(o.label).width + 14;
        ctx.fillStyle = o.color;
        roundRect(ctx, 6, y - 9, tw, 18, 5);
        ctx.fill();
        ctx.fillStyle = "#0b0c0e";
        ctx.textAlign = "left";
        ctx.fillText(o.label, 13, y);
      }
    };

    draw();
    const ro = new ResizeObserver(draw);
    ro.observe(wrap);
    return () => ro.disconnect();
  }, [candles, overlays, points]);

  const onMove = (e: ReactMouseEvent) => {
    const s = scaleRef.current;
    const wrap = wrapRef.current;
    if (!s || !wrap || s.view.length === 0) return;
    const rect = wrap.getBoundingClientRect();
    const x = e.clientX - rect.left;
    if (x > s.plotW) { setHover(null); return; } // over the price axis
    const n = s.view.length;
    let idx = Math.round((x / s.plotW) * (n - 1));
    idx = Math.max(0, Math.min(n - 1, idx));
    const c = s.view[idx];
    const px = (idx / (n - 1 || 1)) * s.plotW;
    const py = s.padT + s.plotH - ((c.close - s.lo) / (s.hi - s.lo)) * s.plotH;
    setHover({ x: px, y: py, price: c.close, time: c.time });
  };

  const s = scaleRef.current;
  const tipRight = hover && s ? hover.x > s.plotW * 0.62 : false;

  return (
    <div
      ref={wrapRef}
      style={{ position: "relative", flex: 1, minHeight: 0 }}
      onMouseMove={onMove}
      onMouseLeave={() => setHover(null)}
    >
      <canvas ref={canvasRef} />
      {hover && s && (
        <>
          <div className="cx-line" style={{ left: hover.x, top: s.padT, height: s.plotH }} />
          <div className="cx-dot" style={{ left: hover.x, top: hover.y }} />
          <div className="chart-tip" style={{ left: hover.x, top: s.padT + 4, transform: `translateX(${tipRight ? "calc(-100% - 10px)" : "10px"})` }}>
            <span className="chart-tip-px">{fmtUsd(hover.price)}</span>
            <span className="chart-tip-t">{fmtFull(hover.time, s.spanSec)}</span>
          </div>
        </>
      )}
    </div>
  );
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
