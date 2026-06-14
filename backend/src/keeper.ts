/**
 * keeper.ts — the live ENGINE/keeper, running continuously against the validator.
 *
 * One self-contained process that ties the whole system together:
 *   - sets up the world once (parties, oracle feeds, Market) + seeds a long/short order
 *   - then loops every POLL_MS:
 *       1. CHAINLINK  → fetch live price → UpdatePrice on-ledger (tracks the rotating CID)
 *       2. MATCHING   → read resting Orders, cross long↔short → form MatchedPair (+ cancel the orders)
 *       3. RISK       → per MatchedPair: ApplyFunding when due, Liquidate when equity < MM
 *
 * Risk decisions use the shared risk math (src/risk/math.ts); the on-ledger choices
 * re-enforce them. Matching forms the pair via a top-level create (actAs long+short+venue)
 * because the deployed MatchOrders can't supply the short's signature.
 *
 * Run:  node --env-file-if-exists=.env src/keeper.ts          (Ctrl-C / 'q' to stop)
 */
import readline from "node:readline";
import { m2mProviderFromEnv } from "./ledger/auth.ts";
import { dataStreamsPriceSourceFromEnv } from "./oracle/fromEnv.ts";
import { FEED_IDS } from "./config.ts";
import { risk } from "./risk/math.ts";

const base = (process.env.LEDGER_BASE_URL ?? "").replace(/\/+$/, "");
const PKG = "#perp-dex";
const CORE = `${PKG}:PerpDex.Core`, ORC = `${PKG}:PerpDex.Oracle`;
const ORACLE_ASSET = process.env.ORACLE_ASSET_ID ?? "ETH/USD";
const COLL_ASSET = process.env.COLLATERAL_ASSET_ID ?? "T-BILL-USD";
const NAV = 520.0, MMR = 0.05, FUNDING_SECS = 30, POLL_MS = Number(process.env.POLL_MS ?? 5000);
const p = m2mProviderFromEnv()!;
const prices = dataStreamsPriceSourceFromEnv({ "ETH-USD": FEED_IDS.ETH_USD });
let userId = "";

const iso = (ms = Date.now()) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
const nowS = () => Math.floor(Date.now() / 1000);
const dg = (n: number) => n.toFixed(6);
const idg = (s: string) => `${s}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
async function h() { return { authorization: `Bearer ${await p.getToken()}`, accept: "application/json", "content-type": "application/json" }; }
async function J(x: any) { const r = await x; const t = await r.text(); let j: any; try { j = JSON.parse(t); } catch { j = t; } return { ok: r.ok, status: r.status, j }; }
async function post(path: string, body: any) { return J(fetch(`${base}${path}`, { method: "POST", headers: await h(), body: JSON.stringify(body) })); }
async function end() { return Number((await (await fetch(`${base}/v2/state/ledger-end`, { headers: await h() })).json()).offset ?? 0); }
async function active(tid: string) {
  const r = await post("/v2/state/active-contracts", { activeAtOffset: await end(), eventFormat: { filtersForAnyParty: { cumulative: [{ identifierFilter: { TemplateFilter: { value: { templateId: tid, includeCreatedEventBlob: false } } } }] }, verbose: false } });
  const arr = Array.isArray(r.j) ? r.j : r.j.activeContracts ?? [];
  return arr.map((e: any) => { const c = e?.contractEntry?.JsActiveContract?.createdEvent ?? e?.createdEvent ?? e; return { cid: c?.contractId as string, arg: c?.createArgument ?? c?.createArguments }; }).filter((x: any) => x.cid);
}
async function allocate(hint: string) {
  const r = await post("/v2/parties", { partyIdHint: hint, identityProviderId: "" });
  const party = r.j.partyDetails.party as string;
  await post(`/v2/users/${userId}/rights`, { userId, rights: [{ kind: { CanActAs: { value: { party } } } }, { kind: { CanReadAs: { value: { party } } } }] });
  return party;
}
async function create(tid: string, args: any, actAs: string[]) { return post("/v2/commands/submit-and-wait", { commands: [{ CreateCommand: { templateId: tid, createArguments: args } }], userId, commandId: idg("c"), actAs, readAs: [] }); }
async function exer(tid: string, cid: string, choice: string, arg: any, actAs: string[]) { return post("/v2/commands/submit-and-wait", { commands: [{ ExerciseCommand: { templateId: tid, contractId: cid, choice, choiceArgument: arg } }], userId, commandId: idg("e"), actAs, readAs: [] }); }

interface World { venue: string; oracle: string; regulator: string; marketCid: string; rwaNAVCid: string; oracleCid: string; }

async function setup(): Promise<World> {
  userId = (await (await fetch(`${base}/v2/authenticated-user`, { headers: await h() })).json()).user.id;
  const ts = Date.now().toString(36);
  console.log("setup: allocating parties…");
  const venue = await allocate(`venue-${ts}`), oracle = await allocate(`oracle-${ts}`), regulator = await allocate(`reg-${ts}`);
  const long = await allocate(`long-${ts}`), short = await allocate(`short-${ts}`);
  p.invalidate();
  const obs = [venue, regulator, long, short];
  const live = await prices.getPerpPrice("ETH-USD");
  const entry = Math.round(live.price * 100) / 100;
  await create(`${ORC}:MockOraclePrice`, { operator: oracle, observers: obs, assetId: ORACLE_ASSET, price: dg(entry), timestamp: iso() }, [oracle]);
  await create(`${ORC}:RWAOracleFeed`, { operator: oracle, observers: obs, asset: COLL_ASSET, navPerUnit: dg(NAV), timestamp: iso() }, [oracle]);
  await create(`${ORC}:PoRAttestation`, { operator: oracle, observers: obs, assetId: COLL_ASSET, reserveAmt: "10000000.0", issuedSupply: "9000000.0", lastAttestedAt: iso() }, [oracle]);
  const oracleCid = (await active(`${ORC}:MockOraclePrice`)).find((c: any) => c.arg.operator === oracle).cid;
  const rwaNAVCid = (await active(`${ORC}:RWAOracleFeed`)).find((c: any) => c.arg.operator === oracle).cid;
  const porCid = (await active(`${ORC}:PoRAttestation`)).find((c: any) => c.arg.operator === oracle).cid;
  await create(`${CORE}:Market`, { venue, regulator, underlying: ORACLE_ASSET, leverageCap: "10.0", maintenanceMarginBps: "500", fundingIntervalSecs: String(FUNDING_SECS), collateralWhitelist: [COLL_ASSET], liqPenaltyBps: "50", oracleCid, rwaNAVCid, porCid }, [venue]);
  const marketCid = (await active(`${CORE}:Market`)).find((c: any) => c.arg.venue === venue).cid;
  // seed one crossing long + short
  const collQty = Math.ceil(((1 * entry * 0.10) / NAV) * 10000) / 10000;
  const order = (trader: string, side: string) => ({ trader, side, size: dg(1), limitPrice: dg(entry), collateralQty: dg(collQty), collateralAssetId: COLL_ASSET, collateralAllocationCid: "", timeInForce: "GTC", expiresAt: iso(Date.now() + 86400000) });
  await exer(`${CORE}:Market`, marketCid, "PlaceOrder", order(long, "Long"), [long, venue]);
  await exer(`${CORE}:Market`, marketCid, "PlaceOrder", order(short, "Short"), [short, venue]);
  console.log(`setup done. venue=${venue.split("::")[0]} entry≈${entry}, 2 orders seeded.\n`);
  return { venue, oracle, regulator, marketCid, rwaNAVCid, oracleCid };
}

async function tick(w: World) {
  const t = nowS();
  // 1. CHAINLINK → on-ledger
  const live = await prices.getPerpPrice("ETH-USD");
  const px = Math.round(live.price * 100) / 100;
  await exer(`${ORC}:MockOraclePrice`, w.oracleCid, "UpdatePrice", { newPrice: dg(px), newTimestamp: iso() }, [w.oracle]);
  w.oracleCid = (await active(`${ORC}:MockOraclePrice`)).find((c: any) => c.arg.assetId === ORACLE_ASSET && c.arg.operator === w.oracle)?.cid ?? w.oracleCid;

  // 2. MATCH resting orders for our venue (price-time priority; cross long.limit >= short.limit)
  const orders = (await active(`${CORE}:Order`)).filter((o: any) => o.arg.venue === w.venue);
  const longs = orders.filter((o: any) => o.arg.side === "Long").sort((a: any, b: any) => a.arg.createdAt.localeCompare(b.arg.createdAt));
  const shorts = orders.filter((o: any) => o.arg.side === "Short").sort((a: any, b: any) => a.arg.createdAt.localeCompare(b.arg.createdAt));
  let matched = 0;
  for (const lo of longs) {
    const so = shorts.find((s: any) => Number(lo.arg.limitPrice) >= Number(s.arg.limitPrice) && Number(s.arg.size) === Number(lo.arg.size));
    if (!so) continue;
    shorts.splice(shorts.indexOf(so), 1);
    const exec = dg(Number(so.arg.limitPrice));
    const r = await create(`${CORE}:MatchedPair`, { longTrader: lo.arg.trader, shortTrader: so.arg.trader, venue: w.venue, regulator: w.regulator, size: dg(Number(lo.arg.size)), entryPrice: exec, longCollateralQty: dg(Number(lo.arg.collateralQty)), shortCollateralQty: dg(Number(so.arg.collateralQty)), collateralAssetId: COLL_ASSET, accruedFundingLong: "0.0", openedAt: iso(), lastFundingTime: iso(), maintenanceMarginBps: "500", fundingIntervalSecs: String(FUNDING_SECS), liqPenaltyBps: "50" }, [lo.arg.trader, so.arg.trader, w.venue]);
    if (r.ok) { matched++; await exer(`${CORE}:Order`, lo.cid, "Cancel", {}, [lo.arg.trader]); await exer(`${CORE}:Order`, so.cid, "Cancel", {}, [so.arg.trader]); }
  }

  // 3. RISK per MatchedPair (funding when due, liquidate when equity < MM)
  const pairs = (await active(`${CORE}:MatchedPair`)).filter((c: any) => c.arg.venue === w.venue);
  let funded = 0, liquidated = 0;
  for (const pr of pairs) {
    const a = pr.arg;
    const size = Number(a.size), entry = Number(a.entryPrice), lastF = Math.floor(Date.parse(a.lastFundingTime) / 1000);
    if (t - lastF >= FUNDING_SECS) { const r = await exer(`${CORE}:MatchedPair`, pr.cid, "ApplyFunding", { oracleCid: w.oracleCid, rwaNAVCid: w.rwaNAVCid }, [w.venue]); if (r.ok) { funded++; continue; } }
    const longEq = risk.equity(Number(a.longCollateralQty) * NAV, risk.unrealizedPnl("Long", size, entry, px), 0);
    const shortEq = risk.equity(Number(a.shortCollateralQty) * NAV, risk.unrealizedPnl("Short", size, entry, px), 0);
    const mm = risk.maintenanceMargin(size, px, MMR);
    const breach = risk.isLiquidatable(longEq, mm) ? "Long" : risk.isLiquidatable(shortEq, mm) ? "Short" : null;
    if (breach) { const r = await exer(`${CORE}:MatchedPair`, pr.cid, "Liquidate", { breachingSide: breach, oracleCid: w.oracleCid, rwaNAVCid: w.rwaNAVCid }, [w.venue]); if (r.ok) liquidated++; }
  }
  console.log(`[${t}] ETH=${px}  orders=${orders.length} matched=${matched}  pairs=${pairs.length} funded=${funded} liquidated=${liquidated}`);
}

async function main() {
  const w = await setup();
  let running = false;
  const timer = setInterval(async () => { if (running) return; running = true; try { await tick(w); } catch (e) { console.error("tick error:", (e as Error).message); } finally { running = false; } }, POLL_MS);
  await tick(w);
  const rl = readline.createInterface({ input: process.stdin });
  rl.on("line", (l) => { if (l.trim() === "q") { clearInterval(timer); rl.close(); process.exit(0); } });
}
main().catch((e) => { console.error(e); process.exit(1); });
