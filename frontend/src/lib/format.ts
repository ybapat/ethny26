/** lib/format.ts — display formatters (tabular, terminal-style). */

export function fmtUsd(n: number, dp = 2): string {
  const sign = n < 0 ? "-" : "";
  return `${sign}$${Math.abs(n).toLocaleString("en-US", {
    minimumFractionDigits: dp,
    maximumFractionDigits: dp,
  })}`;
}

export function fmtNum(n: number, dp = 2): string {
  return n.toLocaleString("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp });
}

export function fmtSignedUsd(n: number, dp = 2): string {
  const sign = n > 0 ? "+" : n < 0 ? "-" : "";
  return `${sign}$${Math.abs(n).toLocaleString("en-US", {
    minimumFractionDigits: dp,
    maximumFractionDigits: dp,
  })}`;
}

export function fmtPct(frac: number, dp = 2): string {
  const sign = frac > 0 ? "+" : "";
  return `${sign}${(frac * 100).toFixed(dp)}%`;
}

export function fmtBps(frac: number): string {
  return `${(frac * 10000).toFixed(1)} bps`;
}

export function fmtQty(n: number, dp = 4): string {
  return n.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: dp });
}

/** Shorten a Canton party id "alice::1220abcd" → "alice::1220". */
export function shortParty(id: string): string {
  const [name, hash] = id.split("::");
  return hash ? `${name}::${hash.slice(0, 6)}` : name;
}

export function fmtAgo(unixSec: number, nowSec: number): string {
  const d = Math.max(0, nowSec - unixSec);
  if (d < 60) return `${d}s ago`;
  if (d < 3600) return `${Math.floor(d / 60)}m ago`;
  if (d < 86400) return `${Math.floor(d / 3600)}h ago`;
  return `${Math.floor(d / 86400)}d ago`;
}

export function fmtClock(unixSec: number): string {
  const d = new Date(unixSec * 1000);
  return d.toLocaleTimeString("en-US", { hour12: false });
}

export function fmtCountdown(secs: number): string {
  const s = Math.max(0, Math.floor(secs));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m.toString().padStart(2, "0")}:${r.toString().padStart(2, "0")}`;
}
