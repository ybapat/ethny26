/**
 * smoke.ts — connectivity + capability probe against the Seaport 5n-sandbox validator.
 *
 * Read-only-ish: it (1) exchanges the M2M token, (2) reads ledger-end + version,
 * (3) lists parties, (4) ATTEMPTS to allocate one throwaway party to learn whether
 * the M2M user may allocate + act-as parties (decides the bootstrap strategy).
 *
 * Run:  node --env-file-if-exists=.env src/smoke.ts   (or: npm run smoke)
 */
import { m2mProviderFromEnv } from "./ledger/auth.ts";

const base = (process.env.LEDGER_BASE_URL ?? "").replace(/\/+$/, "");

async function main() {
  if (!base) {
    console.error("LEDGER_BASE_URL not set");
    process.exit(2);
  }
  const provider = m2mProviderFromEnv();
  if (!provider) {
    console.error("No OIDC creds (OIDC_CLIENT_ID/OIDC_CLIENT_SECRET) in env");
    process.exit(2);
  }

  console.log(`validator: ${base}`);

  // 1) token
  let token: string;
  try {
    token = await provider.getToken();
    console.log(`✓ M2M token obtained (len=${token.length})`);
  } catch (e) {
    console.error(`✗ token exchange failed: ${String((e as Error).message)}`);
    process.exit(1);
    return;
  }
  const auth = { authorization: `Bearer ${token}`, accept: "application/json" };

  // helper
  const show = async (label: string, res: Response) => {
    const body = await res.text();
    const trimmed = body.length > 400 ? body.slice(0, 400) + "…" : body;
    console.log(`${res.ok ? "✓" : "✗"} ${label}: HTTP ${res.status} ${trimmed}`);
    return { ok: res.ok, status: res.status, body };
  };

  // 2) version + ledger-end (auth sanity)
  await show("GET /v2/version", await fetch(`${base}/v2/version`, { headers: auth }));
  await show("GET /v2/state/ledger-end", await fetch(`${base}/v2/state/ledger-end`, { headers: auth }));

  // 3) list parties
  await show("GET /v2/parties", await fetch(`${base}/v2/parties`, { headers: auth }));

  // 4) try to allocate a throwaway party (capability probe)
  const hint = `smoke${Date.now().toString(36)}`;
  const alloc = await fetch(`${base}/v2/parties`, {
    method: "POST",
    headers: { ...auth, "content-type": "application/json" },
    body: JSON.stringify({ partyIdHint: hint, identityProviderId: "" }),
  });
  const r = await show(`POST /v2/parties (allocate "${hint}")`, alloc);

  console.log("\n──────── verdict ────────");
  if (r.ok) {
    console.log("✓ M2M user CAN allocate parties → bootstrap can create venue/oracle/traders itself.");
  } else if (r.status === 403 || r.status === 401) {
    console.log("✗ party allocation denied → either allocate parties in the Loop/Seaport wallet UI,");
    console.log("  or run everything as the single VENUE_PARTY for a functional (non-privacy) test.");
  } else {
    console.log(`? unexpected status ${r.status} — inspect the body above.`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
