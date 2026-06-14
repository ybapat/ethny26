/**
 * bootstrap.ts — stand up the whole "world" on the validator so the system can be tested.
 *
 * Steps (all via the JSON Ledger API v2, M2M-authed):
 *   1. allocate parties: venue, oracle, regulator, traderLong, traderShort, outsider
 *   2. create oracle feeds (as oracle): MockOraclePrice, RWAOracleFeed, PoRAttestation
 *   3. create Market (as venue)
 *   4. place a long + short Order (as the traders) via Market.PlaceOrder
 *   5. write all ids to bootstrap-out.json (the keeper/engine read these)
 *
 * Field names + types match daml/daml/PerpDex/{Core,Oracle}.daml.
 * Run:  node --env-file-if-exists=.env src/bootstrap.ts   (npm run bootstrap)
 *
 * Idempotency: parties use timestamped hints (fresh each run). Re-running creates
 * a fresh world; copy the printed party ids into .env for the keeper/engine.
 */
import { writeFileSync } from "node:fs";
import { m2mProviderFromEnv } from "./ledger/auth.ts";

const base = (process.env.LEDGER_BASE_URL ?? "").replace(/\/+$/, "");
// The command-submission `userId` MUST be the authenticated OIDC user (set in main
// from /v2/authenticated-user), NOT a party name — a mismatch is a 403.
let userId = "";
const PKG = process.env.PKG ?? "#perp-dex"; // package-NAME reference needs the leading '#'
const MOD_CORE = `${PKG}:PerpDex.Core`;
const MOD_ORACLE = `${PKG}:PerpDex.Oracle`;
const ORACLE_ASSET = process.env.ORACLE_ASSET_ID ?? "ETH/USD";
const COLL_ASSET = process.env.COLLATERAL_ASSET_ID ?? "T-BILL-USD";

const provider = m2mProviderFromEnv();
if (!base || !provider) {
  console.error("Need LEDGER_BASE_URL + OIDC creds in env");
  process.exit(2);
}

const nowIso = () => new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
const plusHoursIso = (h: number) =>
  new Date(Date.now() + h * 3600_000).toISOString().replace(/\.\d{3}Z$/, "Z");
const cid = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

async function authHeader() {
  const token = await provider!.getToken();
  return { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json" };
}

async function api(path: string, body: unknown): Promise<any> {
  const res = await fetch(`${base}${path}`, { method: "POST", headers: await authHeader(), body: JSON.stringify(body) });
  const text = await res.text();
  if (!res.ok) throw new Error(`POST ${path} → HTTP ${res.status}: ${text}`);
  return text ? JSON.parse(text) : {};
}

async function authedUserId(): Promise<string> {
  const res = await fetch(`${base}/v2/authenticated-user`, { headers: await authHeader() });
  const j = await res.json();
  const id = j?.user?.id;
  if (!id) throw new Error(`could not read authenticated user id from ${JSON.stringify(j)}`);
  return id;
}

/** Grant the M2M user actAs+readAs rights for a party (needed to submit as it). */
async function grantRights(userId: string, party: string): Promise<void> {
  await api(`/v2/users/${encodeURIComponent(userId)}/rights`, {
    userId,
    rights: [
      { kind: { CanActAs: { value: { party } } } },
      { kind: { CanReadAs: { value: { party } } } },
    ],
  });
}

/** Allocate a party AND grant the current user actAs/readAs rights for it. */
async function allocate(userId: string, hint: string): Promise<string> {
  const r = await api("/v2/parties", { partyIdHint: hint, identityProviderId: "" });
  const party = r?.partyDetails?.party ?? r?.party;
  if (!party) throw new Error(`allocate ${hint}: no party in ${JSON.stringify(r)}`);
  await grantRights(userId, party);
  console.log(`  party ${hint.padEnd(14)} = ${party}`);
  return party;
}

async function create(templateId: string, createArguments: Record<string, unknown>, actAs: string[]): Promise<void> {
  await api("/v2/commands/submit-and-wait", {
    commands: [{ CreateCommand: { templateId, createArguments } }],
    userId, commandId: cid("create"), actAs, readAs: [],
  });
}

async function exercise(
  templateId: string, contractId: string, choice: string, choiceArgument: Record<string, unknown>, actAs: string[],
): Promise<void> {
  await api("/v2/commands/submit-and-wait", {
    commands: [{ ExerciseCommand: { templateId, contractId, choice, choiceArgument } }],
    userId, commandId: cid("exer"), actAs, readAs: [],
  });
}

async function ledgerEnd(): Promise<number> {
  const res = await fetch(`${base}/v2/state/ledger-end`, { headers: await authHeader() });
  const j = await res.json();
  return Number(j.offset ?? 0);
}

/** Query active contracts for one template id → [{contractId, createArgument}]. */
async function active(templateId: string): Promise<Array<{ contractId: string; arg: any }>> {
  const offset = await ledgerEnd();
  const res = await api("/v2/state/active-contracts", {
    activeAtOffset: offset,
    eventFormat: {
      filtersForAnyParty: {
        cumulative: [{ identifierFilter: { TemplateFilter: { value: { templateId, includeCreatedEventBlob: false } } } }],
      },
      verbose: false,
    },
  });
  const out: Array<{ contractId: string; arg: any }> = [];
  const entries = Array.isArray(res) ? res : res.activeContracts ?? [res];
  for (const e of entries) {
    const c =
      e?.contractEntry?.JsActiveContract?.createdEvent ?? e?.createdEvent ?? e?.created ?? (e?.contractId ? e : undefined);
    if (!c?.contractId) continue;
    if (c.templateId && !String(c.templateId).endsWith(templateId.split(":").slice(1).join(":"))) {
      // keep — template filter already applied server-side; this is a loose guard
    }
    out.push({ contractId: String(c.contractId), arg: c.createArgument ?? c.createArguments });
  }
  return out;
}

async function main() {
  console.log(`validator: ${base}\npackage: ${PKG}\n`);

  console.log("1) allocating parties + granting actAs rights…");
  userId = await authedUserId(); // module-level; used by create()/exercise() too
  console.log(`  (authenticated user id ${userId})`);
  const ts = Date.now().toString(36);
  const venue = await allocate(userId, `venue-${ts}`);
  const oracle = await allocate(userId, `oracle-${ts}`);
  const regulator = await allocate(userId, `regulator-${ts}`);
  const long = await allocate(userId, `long-${ts}`);
  const short = await allocate(userId, `short-${ts}`);
  const outsider = await allocate(userId, `outsider-${ts}`);
  const observers = [venue, regulator, long, short, outsider];

  // IMPORTANT: the JWT must be re-fetched AFTER granting rights, otherwise the
  // cached token predates the new actAs rights and command submission 403s.
  provider!.invalidate();
  console.log("  (refreshed token to pick up new actAs rights)");

  const t = nowIso();

  console.log("\n2) creating oracle feeds (as oracle)…");
  await create(`${MOD_ORACLE}:MockOraclePrice`,
    { operator: oracle, observers, assetId: ORACLE_ASSET, price: "200.0", timestamp: t }, [oracle]);
  await create(`${MOD_ORACLE}:RWAOracleFeed`,
    { operator: oracle, observers, asset: COLL_ASSET, navPerUnit: "520.0", timestamp: t }, [oracle]);
  await create(`${MOD_ORACLE}:PoRAttestation`,
    { operator: oracle, observers, assetId: COLL_ASSET, reserveAmt: "10000000.0", issuedSupply: "9000000.0", lastAttestedAt: t }, [oracle]);

  // Capture the CIDs of OUR freshly-created feeds (operator == our oracle party).
  const oracleCid = (await active(`${MOD_ORACLE}:MockOraclePrice`)).find((c) => c.arg?.operator === oracle)?.contractId;
  const rwaNAVCid = (await active(`${MOD_ORACLE}:RWAOracleFeed`)).find((c) => c.arg?.operator === oracle)?.contractId;
  const porCid = (await active(`${MOD_ORACLE}:PoRAttestation`)).find((c) => c.arg?.operator === oracle)?.contractId;
  console.log(`  ✓ MockOraclePrice ${oracleCid}`);
  console.log(`  ✓ RWAOracleFeed   ${rwaNAVCid}`);
  console.log(`  ✓ PoRAttestation  ${porCid}`);
  if (!oracleCid || !rwaNAVCid || !porCid) throw new Error("could not resolve feed CIDs after create");

  console.log("\n3) creating Market (as venue)…");
  // NOTE: deployed DAR's Market takes contract-ID references (oracleCid/rwaNAVCid/porCid),
  // not operator parties — the deployed schema is newer than git's Core.daml.
  await create(`${MOD_CORE}:Market`, {
    venue, regulator, underlying: ORACLE_ASSET,
    // Daml Int64 is JSON-encoded as a STRING in the v2 API:
    leverageCap: "10.0", maintenanceMarginBps: "500", fundingIntervalSecs: "3600",
    collateralWhitelist: [COLL_ASSET], liqPenaltyBps: "50",
    oracleCid, rwaNAVCid, porCid,
  }, [venue]);
  // Select OUR market (this run's venue) — NOT just the last one on the shared ledger.
  const markets = await active(`${MOD_CORE}:Market`);
  const marketCid = markets.find((m) => m.arg?.venue === venue)?.contractId;
  if (!marketCid) throw new Error("Market not found after create (no market with our venue)");
  console.log(`  ✓ Market ${marketCid}`);

  console.log("\n4) placing long + short orders…");
  const orderArgs = (trader: string, side: string) => ({
    trader, side, size: "50.0", limitPrice: "200.0",
    collateralQty: "2.0", collateralAssetId: COLL_ASSET,
    collateralAllocationCid: "", timeInForce: "GTC", expiresAt: plusHoursIso(24),
  });
  // actAs includes venue so the trader's submission can SEE the venue-owned Market
  // (production traders would use explicit contract disclosure instead).
  await exercise(`${MOD_CORE}:Market`, marketCid, "PlaceOrder", orderArgs(long, "Long"), [long, venue]);
  await exercise(`${MOD_CORE}:Market`, marketCid, "PlaceOrder", orderArgs(short, "Short"), [short, venue]);
  const orders = await active(`${MOD_CORE}:Order`);
  console.log(`  ✓ ${orders.length} Order(s) on the book`);

  const out = {
    base, package: PKG,
    parties: { venue, oracle, regulator, long, short, outsider },
    assetIds: { oracle: ORACLE_ASSET, collateral: COLL_ASSET },
    marketCid,
    orderCids: orders.map((o) => o.contractId),
  };
  writeFileSync(new URL("../bootstrap-out.json", import.meta.url), JSON.stringify(out, null, 2));
  console.log("\n✓ world ready. Wrote bootstrap-out.json");
  console.log("\nPut these in .env for the keeper/engine:");
  console.log(`VENUE_PARTY=${venue}`);
  console.log(`ORACLE_PARTY=${oracle}`);
  console.log(`REGULATOR_PARTY=${regulator}`);
}

main().catch((e) => {
  console.error(`\n✗ bootstrap failed: ${String((e as Error).message)}`);
  process.exit(1);
});
