/** IdentityStrip.tsx — a thin band under the topbar telling you who you are and
 * exactly what your party can see. Makes the privacy model legible at a glance. */
import { useStore } from "../store/store.tsx";
import { shortParty } from "../lib/format.ts";
import type { PartyRole } from "../domain/types.ts";

const VISIBILITY: Record<PartyRole, { color: string; sees: string }> = {
  trader: { color: "var(--blue)", sees: "Your own orders, your position, your RWA collateral & PnL. Nothing about other traders." },
  venue: { color: "var(--green)", sees: "The full dark order book + every matched pair (signatory on all). Runs matching & the trigger loop." },
  regulator: { color: "var(--amber)", sees: "Observer on everything — all positions, counterparties & PnL for audit. Cannot trade." },
  outsider: { color: "var(--down)", sees: "Only the public price feed. Not a stakeholder on any order or position — they're invisible to you." },
};

export function IdentityStrip() {
  const { party, role, isMock } = useStore();
  const v = VISIBILITY[role];
  return (
    <div className="identity">
      <span className="role-pill" style={{ background: "color-mix(in srgb, " + v.color + " 14%, transparent)", color: v.color }}>
        <span className="pdot" style={{ width: 7, height: 7, borderRadius: "50%", background: v.color }} />
        {party.label}
      </span>
      <span className="muted tnum" style={{ fontSize: 10.5 }}>{shortParty(party.partyId)}</span>
      <span style={{ color: v.color, opacity: 0.5 }}>│</span>
      <span className="muted" style={{ fontSize: 11.5 }}>{v.sees}</span>
      <span className="grow" />
      <span className="chip" title={isMock ? "Running against the in-browser simulation" : "Connected to a live backend"}>
        <span className="dot live" style={{ background: isMock ? "var(--amber)" : "var(--green)" }} />
        {isMock ? "SIMULATED LEDGER" : "LIVE · CANTON"}
      </span>
    </div>
  );
}
