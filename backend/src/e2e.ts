/**
 * e2e.ts — COMPREHENSIVE end-to-end test against the live Seaport validator.
 *
 * Exercises the whole system in one deterministic pass and asserts each stage:
 *   Chainlink (real price)  →  on-ledger oracle (UpdatePrice)
 *   orderbook (PlaceOrder long+short)  →  match (form MatchedPair)
 *   funding (ApplyFunding)  →  price move  →  liquidation (Liquidate + Settlements)
 *   privacy (outsider sees nothing, regulator sees the position)
 *
 * Matched to the DEPLOYED contract: MatchedPair is formed via a top-level create
 * (actAs long+short+venue) because the deployed MatchOrders can't supply short's
 * signature; every other choice runs as the venue.
 *
 * Run:  node --env-file-if-exists=.env src/e2e.ts
 */
import assert from "node:assert/strict";
import { m2mProviderFromEnv } from "./ledger/auth.ts";
import { dataStreamsPriceSourceFromEnv } from "./oracle/fromEnv.ts";
import { FEED_IDS } from "./config.ts";

const base = (process.env.LEDGER_BASE_URL ?? "").replace(/\/+$/, "");
const PKG = "#perp-dex";
const CORE = `${PKG}:PerpDex.Core`;
const ORC = `${PKG}:PerpDex.Oracle`;
const ORACLE_ASSET = process.env.ORACLE_ASSET_ID ?? "ETH/USD";
const COLL_ASSET = process.env.COLLATERAL_ASSET_ID ?? "T-BILL-USD";
const NAV = 520.0;
const p = m2mProviderFromEnv()!;
let userId = "";

const iso = (ms = Date.now()) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
const idg = (s: string) => `${s}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
const d = (n: number) => n.toFixed(6);
async function h() { return { authorization: `Bearer ${await p.getToken()}`, accept: "application/json", "content-type": "application/json" }; }
async function J(x: any) { const r = await x; const t = await r.text(); let j: any; try { j = JSON.parse(t); } catch { j = t; } return { ok: r.ok, status: r.status, j }; }
async function post(path: string, body: any) { return J(fetch(`${base}${path}`, { method: "POST", headers: await h(), body: JSON.stringify(body) })); }
async function end() { return Number((await (await fetch(`${base}/v2/state/ledger-end`, { headers: await h() })).json()).offset ?? 0); }
function evFmt(tid: string, party?: string) {
  const f = { cumulative: [{ identifierFilter: { TemplateFilter: { value: { templateId: tid, includeCreatedEventBlob: false } } } }] };
  return party ? { filtersByParty: { [party]: f }, verbose: false } : { filtersForAnyParty: f, verbose: false };
}
async function activeAs(party: string | undefined, tid: string) {
  const r = await post("/v2/state/active-contracts", { activeAtOffset: await end(), eventFormat: evFmt(tid, party) });
  const arr = Array.isArray(r.j) ? r.j : r.j.activeContracts ?? [];
  return arr
    .map((e: any) => { const c = e?.contractEntry?.JsActiveContract?.createdEvent ?? e?.createdEvent ?? e; return { cid: c?.contractId as string, arg: c?.createArgument ?? c?.createArguments }; })
    .filter((x: any) => x.cid);
}
const active = (tid: string) => activeAs(undefined, tid);
async function allocate(hint: string) {
  const r = await post("/v2/parties", { partyIdHint: hint, identityProviderId: "" });
  const party = r.j.partyDetails.party as string;
  await post(`/v2/users/${userId}/rights`, { userId, rights: [{ kind: { CanActAs: { value: { party } } } }, { kind: { CanReadAs: { value: { party } } } }] });
  return party;
}
async function create(tid: string, args: any, actAs: string[]) { return post("/v2/commands/submit-and-wait", { commands: [{ CreateCommand: { templateId: tid, createArguments: args } }], userId, commandId: idg("c"), actAs, readAs: [] }); }
async function exer(tid: string, cid: string, choice: string, arg: any, actAs: string[]) { return post("/v2/commands/submit-and-wait", { commands: [{ ExerciseCommand: { templateId: tid, contractId: cid, choice, choiceArgument: arg } }], userId, commandId: idg("e"), actAs, readAs: [] }); }
const ok = (label: string, r: any) => { console.log(`${r.ok ? "✓" : "✗"} ${label}: ${r.status}${r.ok ? "" : " " + JSON.stringify(r.j).slice(0, 220)}`); assert.ok(r.ok, label); };

async function main() {
  userId = (await (await fetch(`${base}/v2/authenticated-user`, { headers: await h() })).json()).user.id;

  console.log("── 1. CHAINLINK: fetch live price ──");
  const prices = dataStreamsPriceSourceFromEnv({ "ETH-USD": FEED_IDS.ETH_USD });
  const live = await prices.getPerpPrice("ETH-USD");
  const entry = Math.round(live.price * 100) / 100;
  console.log(`✓ live ETH/USD from Chainlink Data Streams: ${entry} (signedReport ${live.signedReport ? live.signedReport.length + " hex chars" : "none"})`);

  console.log("\n── 2. parties ──");
  const ts = Date.now().toString(36);
  const venue = await allocate(`v${ts}`), oracle = await allocate(`o${ts}`), regulator = await allocate(`r${ts}`),
        long = await allocate(`l${ts}`), short = await allocate(`s${ts}`), outsider = await allocate(`x${ts}`);
  p.invalidate();
  const obs = [venue, regulator, long, short];

  console.log("\n── 3. oracle feeds (post the REAL Chainlink price on-ledger) ──");
  ok("MockOraclePrice@" + entry, await create(`${ORC}:MockOraclePrice`, { operator: oracle, observers: obs, assetId: ORACLE_ASSET, price: d(entry), timestamp: iso() }, [oracle]));
  ok("RWAOracleFeed", await create(`${ORC}:RWAOracleFeed`, { operator: oracle, observers: obs, asset: COLL_ASSET, navPerUnit: d(NAV), timestamp: iso() }, [oracle]));
  ok("PoRAttestation", await create(`${ORC}:PoRAttestation`, { operator: oracle, observers: obs, assetId: COLL_ASSET, reserveAmt: "10000000.0", issuedSupply: "9000000.0", lastAttestedAt: iso() }, [oracle]));
  let oracleCid = (await active(`${ORC}:MockOraclePrice`)).find((c: any) => c.arg.operator === oracle).cid;
  const rwaNAVCid = (await active(`${ORC}:RWAOracleFeed`)).find((c: any) => c.arg.operator === oracle).cid;
  const porCid = (await active(`${ORC}:PoRAttestation`)).find((c: any) => c.arg.operator === oracle).cid;

  console.log("\n── 4. market + ORDERBOOK ──");
  ok("Market", await create(`${CORE}:Market`, { venue, regulator, underlying: ORACLE_ASSET, leverageCap: "10.0", maintenanceMarginBps: "500", fundingIntervalSecs: "3600", collateralWhitelist: [COLL_ASSET], liqPenaltyBps: "50", oracleCid, rwaNAVCid, porCid }, [venue]));
  const marketCid = (await active(`${CORE}:Market`)).find((c: any) => c.arg.venue === venue).cid;
  const size = 1;
  const collQty = Math.ceil(((size * entry * 0.10) / NAV) * 10000) / 10000; // ~10x
  const order = (trader: string, side: string) => ({ trader, side, size: d(size), limitPrice: d(entry), collateralQty: d(collQty), collateralAssetId: COLL_ASSET, collateralAllocationCid: "", timeInForce: "GTC", expiresAt: iso(Date.now() + 86400000) });
  ok("PlaceOrder long", await exer(`${CORE}:Market`, marketCid, "PlaceOrder", order(long, "Long"), [long, venue]));
  ok("PlaceOrder short", await exer(`${CORE}:Market`, marketCid, "PlaceOrder", order(short, "Short"), [short, venue]));
  console.log(`   both orders resting (size ${size} @ ${entry}, collateral ${collQty} each ≈10x)`);

  console.log("\n── 5. MATCH (form the position) ──");
  ok("MatchedPair", await create(`${CORE}:MatchedPair`, { longTrader: long, shortTrader: short, venue, regulator, size: d(size), entryPrice: d(entry), longCollateralQty: d(collQty), shortCollateralQty: d(collQty), collateralAssetId: COLL_ASSET, accruedFundingLong: "0.0", openedAt: iso(), lastFundingTime: iso(), maintenanceMarginBps: "500", fundingIntervalSecs: "3600", liqPenaltyBps: "50" }, [long, short, venue]));
  let pair = (await active(`${CORE}:MatchedPair`)).find((c: any) => c.arg.longTrader === long)!;

  console.log("\n── 6. PRIVACY (the money-shot) ──");
  const outsiderSees = (await activeAs(outsider, `${CORE}:MatchedPair`)).some((c: any) => c.cid === pair.cid);
  const regulatorSees = (await activeAs(regulator, `${CORE}:MatchedPair`)).some((c: any) => c.cid === pair.cid);
  console.log(`   outsider sees the position?  ${outsiderSees}   (want false)`);
  console.log(`   regulator sees the position? ${regulatorSees}  (want true)`);
  assert.equal(outsiderSees, false, "outsider must NOT see the MatchedPair");
  assert.equal(regulatorSees, true, "regulator MUST see the MatchedPair");
  console.log("✓ privacy holds: invisible to outsiders, visible to the regulator");

  console.log("\n── 7. FUNDING ──");
  ok("ApplyFunding", await exer(`${CORE}:MatchedPair`, pair.cid, "ApplyFunding", { oracleCid, rwaNAVCid }, [venue]));
  pair = (await active(`${CORE}:MatchedPair`)).find((c: any) => c.arg.longTrader === long)!;
  console.log(`   collateral long/short ${pair.arg.longCollateralQty}/${pair.arg.shortCollateralQty}, accruedFundingLong ${pair.arg.accruedFundingLong}`);

  console.log("\n── 8. price drops 10% → LIQUIDATION + SETTLEMENT ──");
  const crash = Math.round(entry * 0.90 * 100) / 100;
  await exer(`${ORC}:MockOraclePrice`, oracleCid, "UpdatePrice", { newPrice: d(crash), newTimestamp: iso() }, [oracle]);
  oracleCid = (await active(`${ORC}:MockOraclePrice`)).find((c: any) => c.arg.operator === oracle).cid;
  console.log(`   posted new mark ${crash} (long underwater)`);
  ok("Liquidate(Long)", await exer(`${CORE}:MatchedPair`, pair.cid, "Liquidate", { breachingSide: "Long", oracleCid, rwaNAVCid }, [venue]));
  const settlements = (await active(`${CORE}:Settlement`)).filter((c: any) => c.arg.winner === short || c.arg.loser === long || c.arg.winner === long);
  for (const s of settlements) console.log(`   Settlement: ${s.arg.reason.padEnd(18)} winner=${String(s.arg.winner).split("::")[0]} amt=${s.arg.collateralAmt}`);
  assert.ok(settlements.some((s: any) => s.arg.reason === "Liquidation"), "a Liquidation settlement must exist");
  const pairGone = !(await active(`${CORE}:MatchedPair`)).some((c: any) => c.arg.longTrader === long);
  assert.ok(pairGone, "pair archived after liquidation");
  console.log(`   MatchedPair archived after liquidation? ${pairGone}`);

  console.log("\n✅ ALL STAGES PASSED — Chainlink → orderbook → match → privacy → funding → liquidation → settlement, live on the validator.");
}
main().catch((e) => { console.error("\n✗ FAILED:", e?.message ?? e); process.exit(1); });
