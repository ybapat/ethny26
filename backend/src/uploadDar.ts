/**
 * uploadDar.ts — deploy a DAR to the validator from the terminal via the JSON Ledger API.
 *
 * Run:  node --env-file-if-exists=.env src/uploadDar.ts ../daml/.daml/dist/perp-dex-v2-1.0.0.dar
 *   (or)  npm run upload-dar -- ../daml/.daml/dist/perp-dex-v2-1.0.0.dar
 *
 * Uses the M2M token. Tries POST /v2/dars (preferred), falls back to /v2/packages.
 */
import { readFileSync } from "node:fs";
import { m2mProviderFromEnv } from "./ledger/auth.ts";

const base = (process.env.LEDGER_BASE_URL ?? "").replace(/\/+$/, "");
const darPath = process.argv[2];
const p = m2mProviderFromEnv();

async function main() {
  if (!base || !p) { console.error("Need LEDGER_BASE_URL + OIDC creds in .env"); process.exit(2); }
  if (!darPath) { console.error("usage: node src/uploadDar.ts <path-to-.dar>"); process.exit(2); }

  const bytes = new Uint8Array(readFileSync(darPath));
  console.log(`uploading ${darPath} (${bytes.length} bytes) → ${base}`);
  const token = await p!.getToken();

  for (const path of ["/v2/dars", "/v2/packages"]) {
    const res = await fetch(`${base}${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/octet-stream" },
      body: bytes,
    });
    const t = await res.text();
    console.log(`POST ${path} → HTTP ${res.status} ${t.slice(0, 400)}`);
    if (res.ok) { console.log("\n✓ DAR uploaded + vetted. #perp-dex-v2 is now live."); return; }
    if (res.status !== 404) break; // only fall through on 404 (endpoint not found)
  }
  console.error("\n✗ upload failed. If it's a permission error, deploy this DAR via the Seaport IDE instead.");
  process.exit(1);
}
main().catch((e) => { console.error(e); process.exit(1); });
