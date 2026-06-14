// One-off: prune accumulated user rights to recover from TOO_MANY_USER_RIGHTS.
// Keeps the special "any party"/admin rights + the primaryParty; revokes the rest.
import { m2mProviderFromEnv } from "./ledger/auth.ts";
const base = (process.env.LEDGER_BASE_URL ?? "").replace(/\/+$/, "");
const APPLY = process.argv.includes("--apply");
const p = m2mProviderFromEnv();
if (!p) throw new Error("M2M auth not configured — set OIDC creds in backend/.env");
const h = async () => ({ accept: "application/json", "content-type": "application/json", authorization: `Bearer ${await p.getToken()}` });
const J = async (r: Response) => { const t = await r.text(); try { return { ok: r.ok, status: r.status, j: JSON.parse(t) }; } catch { return { ok: r.ok, status: r.status, j: t }; } };

const me = await J(await fetch(`${base}/v2/authenticated-user`, { headers: await h() }));
const userId = me.j.user.id as string;
const primary = me.j.user.primaryParty as string | undefined;

const list = await J(await fetch(`${base}/v2/users/${userId}/rights`, { headers: await h() }));
const rights = (list.j.rights ?? []) as any[];
const partyOf = (r: any) => Object.values(r.kind ?? {})[0] as any;
const isPartyRight = (r: any) => { const k = Object.keys(r.kind ?? {})[0]; return (k === "CanActAs" || k === "CanReadAs"); };
const keep = (r: any) => !isPartyRight(r) || partyOf(r)?.value?.party === primary;
const toRevoke = rights.filter((r) => !keep(r));
console.log(`userId ${userId} | total ${rights.length} | keep ${rights.length - toRevoke.length} | revoke ${toRevoke.length}`);

if (!APPLY) {
  console.log("sample to revoke:", JSON.stringify(toRevoke.slice(0, 2)).slice(0, 160));
  console.log("\n>>> dry-run only. Re-run with --apply to revoke all", toRevoke.length, "party-specific rights.");
} else {
  const BATCH = 100;
  let done = 0;
  for (let i = 0; i < toRevoke.length; i += BATCH) {
    const chunk = toRevoke.slice(i, i + BATCH);
    const out = await J(await fetch(`${base}/v2/users/${userId}/rights`, { method: "PATCH", headers: await h(), body: JSON.stringify({ userId, rights: chunk }) }));
    if (!out.ok) { console.error("revoke batch failed:", out.status, JSON.stringify(out.j).slice(0, 160)); break; }
    done += (out.j.newlyRevokedRights ?? chunk).length;
    console.log(`revoked ${done}/${toRevoke.length}`);
  }
  const after = await J(await fetch(`${base}/v2/users/${userId}/rights`, { headers: await h() }));
  console.log("DONE. rights now:", (after.j.rights ?? []).length, "(was", rights.length + ")");
}
