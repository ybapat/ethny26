/** tradeSpike.ts — full self-custody PlaceOrder: BOTH trader and venue are
 * external parties; each signs the prepared tx. venue key held by the gateway
 * (operator), trader key by the user. Proves the real architecture. */
import { SDK, signTransactionHash } from "@canton-network/wallet-sdk";
import { m2mProviderFromEnv } from "./ledger/auth.ts";

const base = (process.env.LEDGER_BASE_URL ?? "").replace(/\/+$/, "");
const prov = m2mProviderFromEnv()!;
const PKG = "#perp-dex-v2", CORE = `${PKG}:PerpDex.Core`, ORC = `${PKG}:PerpDex.Oracle`;
const ON_ORACLE = "ETH/USD", ON_COLL = "T-BILL-USD";
let userId = "", synchronizerId = "";
const iso = () => new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
const idg = (s: string) => `${s}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
async function h() { return { authorization: `Bearer ${await prov.getToken()}`, accept: "application/json", "content-type": "application/json" }; }
async function J(x: any) { const r = await x; const t = await r.text(); let j: any; try { j = JSON.parse(t); } catch { j = t; } return { ok: r.ok, status: r.status, j }; }
async function post(p: string, b: any) { return J(fetch(`${base}${p}`, { method: "POST", headers: await h(), body: JSON.stringify(b) })); }
async function end() { return Number((await (await fetch(`${base}/v2/state/ledger-end`, { headers: await h() })).json()).offset ?? 0); }
async function active(tid: string) {
  const r = await post("/v2/state/active-contracts", { activeAtOffset: await end(), eventFormat: { filtersForAnyParty: { cumulative: [{ identifierFilter: { TemplateFilter: { value: { templateId: tid, includeCreatedEventBlob: false } } } }] }, verbose: false } });
  const a = Array.isArray(r.j) ? r.j : r.j.activeContracts ?? [];
  return a.map((e: any) => { const c = e?.contractEntry?.JsActiveContract?.createdEvent ?? e?.createdEvent ?? e; return { cid: c?.contractId, arg: c?.createArgument }; }).filter((x: any) => x.cid);
}
async function allocate(hint: string) { const r = await post("/v2/parties", { partyIdHint: hint, identityProviderId: "" }); const party = r.j.partyDetails.party; await post(`/v2/users/${userId}/rights`, { userId, rights: [{ kind: { CanActAs: { value: { party } } } }, { kind: { CanReadAs: { value: { party } } } }] }); return party; }
async function create(tid: string, args: any, actAs: string[]) { return post("/v2/commands/submit-and-wait", { commands: [{ CreateCommand: { templateId: tid, createArguments: args } }], userId, commandId: idg("c"), actAs, readAs: [] }); }

// Submit a transaction signed by EXTERNAL parties (interactive submission).
async function submitExternal(commands: any[], actAs: string[], keys: Record<string, string>) {
  const prep = await post("/v2/interactive-submission/prepare", { userId, commandId: idg("p"), actAs, readAs: [], synchronizerId, disclosedContracts: [], verboseHashing: false, packageIdSelectionPreference: [], commands });
  if (!prep.ok) throw new Error("prepare: " + JSON.stringify(prep.j).slice(0, 300));
  const { preparedTransaction, preparedTransactionHash, hashingSchemeVersion } = prep.j;
  const signatures = actAs.map((party) => ({ party, signatures: [{ signature: signTransactionHash(preparedTransactionHash, keys[party]), signedBy: party.split("::")[1], format: "SIGNATURE_FORMAT_CONCAT", signingAlgorithmSpec: "SIGNING_ALGORITHM_SPEC_ED25519" }] }));
  const exec = await post("/v2/interactive-submission/executeAndWait", { userId, preparedTransaction, hashingSchemeVersion, submissionId: idg("s"), deduplicationPeriod: { Empty: {} }, partySignatures: { signatures } });
  if (!exec.ok) throw new Error("execute: " + JSON.stringify(exec.j).slice(0, 400));
  return exec.j;
}

async function main() {
  userId = (await (await fetch(`${base}/v2/authenticated-user`, { headers: await h() })).json()).user.id;
  const sdk: any = await (SDK as any).create({ auth: { method: "static", token: await prov.getToken() }, ledgerClientUrl: base });
  synchronizerId = sdk.ctx.defaultSynchronizerId;
  const ts = Date.now().toString(36);
  const oracle = await allocate(`oracle-${ts}`); const regulator = await allocate(`reg-${ts}`); prov.invalidate();
  console.log("onboarding EXTERNAL venue + EXTERNAL trader…");
  const vKey = sdk.keys.generate();
  const venue = (await sdk.party.external.create(vKey.publicKey, { partyHint: `venue${ts}` }).sign(vKey.privateKey).execute()).partyId;
  const tKey = sdk.keys.generate();
  const trader = (await sdk.party.external.create(tKey.publicKey, { partyHint: `trader${ts}` }).sign(tKey.privateKey).execute()).partyId;
  const keys: Record<string, string> = { [venue]: vKey.privateKey, [trader]: tKey.privateKey };
  console.log("  venue =", venue.split("::")[0], "| trader =", trader.split("::")[0]);
  const obs = [venue, regulator, trader];
  await create(`${ORC}:MockOraclePrice`, { operator: oracle, observers: obs, assetId: ON_ORACLE, price: "1680.0", timestamp: iso() }, [oracle]);
  await create(`${ORC}:RWAOracleFeed`, { operator: oracle, observers: obs, asset: ON_COLL, navPerUnit: "520.0", timestamp: iso() }, [oracle]);
  await create(`${ORC}:PoRAttestation`, { operator: oracle, observers: obs, assetId: ON_COLL, reserveAmt: "10000000.0", issuedSupply: "9000000.0", lastAttestedAt: iso() }, [oracle]);
  const oracleCid = (await active(`${ORC}:MockOraclePrice`)).find((c: any) => c.arg.operator === oracle).cid;
  const rwaNAVCid = (await active(`${ORC}:RWAOracleFeed`)).find((c: any) => c.arg.operator === oracle).cid;
  const porCid = (await active(`${ORC}:PoRAttestation`)).find((c: any) => c.arg.operator === oracle).cid;
  console.log("creating Market (venue signs externally)…");
  await submitExternal([{ CreateCommand: { templateId: `${CORE}:Market`, createArguments: { venue, regulator, underlying: ON_ORACLE, leverageCap: "10.0", maintenanceMarginBps: "500", fundingIntervalSecs: "30", collateralWhitelist: [ON_COLL], liqPenaltyBps: "50", oracleCid, rwaNAVCid, porCid } } }], [venue], keys);
  const marketCid = (await active(`${CORE}:Market`)).find((c: any) => c.arg.venue === venue).cid;
  console.log("placing order (trader + venue BOTH sign externally)…");
  await submitExternal([{ ExerciseCommand: { templateId: `${CORE}:Market`, contractId: marketCid, choice: "PlaceOrder", choiceArgument: { trader, side: "Long", size: "1.0", limitPrice: "1680.0", collateralQty: "0.4", collateralAssetId: ON_COLL, collateralAllocationCid: "", timeInForce: "GTC", expiresAt: iso() } } }], [trader, venue], keys);
  const order = (await active(`${CORE}:Order`)).find((o: any) => o.arg.trader === trader);
  console.log(order ? `\n✅ FULL SELF-CUSTODY TRADE WORKS — Order created by externally-signed PlaceOrder (trader+venue), size ${order.arg.size} @ ${order.arg.limitPrice}` : "\n✗ no Order found");
}
main().catch((e) => { console.error("✗ failed:", e?.message ?? e); if (e?.stack) console.error(e.stack.split("\n").slice(0, 5).join("\n")); process.exit(1); });
