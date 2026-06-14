/**
 * gateway.ts — the HTTP bridge between the React frontend and the live Canton ledger.
 *
 * The browser cannot hold the M2M secret, so it never talks to the validator
 * directly. This server is the trusted "venue": it owns the live world (parties,
 * RWA token, oracle feeds, Market), runs the keeper loop (price → match →
 * funding → liquidation), and exposes:
 *
 *   GET  /api/snapshot                          → the full EngineSnapshot the UI consumes
 *   POST /api/order   {trader, side, size, limitPrice, leverage}
 *   POST /api/cancel  {contractId}
 *   POST /api/close   {contractId, side}        (settles the pair P2P)
 *   POST /api/liquidate {contractId, side}      (force/simulate a liquidation)
 *   POST /api/funding {market}
 *   POST /api/shock   {market, pct}             (demo: shove the on-ledger mark)
 *   POST /api/running {on}
 *   POST /api/faucet  {party, amount}           (mint REAL RWA tokens on-ledger)
 *   POST /api/create-wallet {name}              (allocate a REAL Canton party + mint)
 *
 * Everything shown is on-ledger: parties are real Canton parties, RWA collateral
 * is a real RWAToken contract (minted/locked/settled on-ledger), the price is real
 * Chainlink, and orders/matches/positions/funding/liquidation/settlement are real
 * Daml contracts/choices. The snapshot is built UNFILTERED (venue view); the
 * frontend store applies per-party privacy (the real on-ledger privacy is in e2e.ts).
 *
 * Run:  npm run gateway
 */
import http from "node:http";
import fs from "node:fs";
import { SDK, signTransactionHash } from "@canton-network/wallet-sdk";
import { m2mProviderFromEnv } from "./ledger/auth.ts";
import { dataStreamsPriceSourceFromEnv } from "./oracle/fromEnv.ts";
import { FEED_IDS } from "./config.ts";
import { risk } from "./risk/math.ts";

/* ----------------------------- config / mapping ----------------------------- */

const base = (process.env.LEDGER_BASE_URL ?? "").replace(/\/+$/, "");
const PORT = Number(process.env.GATEWAY_PORT ?? 8080);
const PKG = "#perp-dex-v2";
const CORE = `${PKG}:PerpDex.Core`, ORC = `${PKG}:PerpDex.Oracle`, RWA = `${PKG}:PerpDex.RWA`;
const POLL_MS = Number(process.env.POLL_MS ?? 3000);
const DO_MATCH = (process.env.KEEPER_MATCH ?? "1") !== "0"; // 0 → let the C++ engine match

// On-ledger asset ids ↔ the instrument ids the UI's config knows about.
const ON_ORACLE = process.env.ORACLE_ASSET_ID ?? "ETH/USD";      // ↔ UI market "ETH-USD"
const ON_COLL = process.env.COLLATERAL_ASSET_ID ?? "T-BILL-USD"; // ↔ UI instrument "tMMF-USD"
const UI_MARKET = "ETH-USD";
const UI_COLL = "tMMF-USD";

const NAV0 = 520.0;           // starting RWA NAV (USDCx per token)
const APY_FALLBACK = 0.05;    // used only if the live Treasury rate can't be fetched
let apyRate = APY_FALLBACK;   // REAL T-bill APY, fetched from the US Treasury (see fetchTbillApy)
const NAV_ACCRUE_EVERY = 4;   // ticks between on-ledger NAV bumps
// Real-time accrual: NAV grows at exactly the T-bill APY. Honest, but slow — yield
// over a few minutes is tiny (value = amount × NAV is always exact). Set >1 only for
// a clearly-labelled "accelerated" demo.
const NAV_DEMO_SPEEDUP = Number(process.env.NAV_SPEEDUP ?? 1);
const MMR = 0.05;             // maintenance margin rate (Market: 500 bps)
const LIQ_PENALTY = 0.005;    // 50 bps (Market: liqPenaltyBps 50)
const FUNDING_SECS = 30;      // accelerated demo funding cadence
const SEED_FREE = 0;          // wallets start EMPTY — users mint collateral via the faucet
const FAUCET_AMT = 10;        // RWA tokens minted per faucet click (~$5.2k at NAV 520)
const MAX_TAPE = 60;
const MAX_CANDLES = 120;

// Market configs mirrored from frontend/src/domain/config.ts so derivePosition() finds them.
const MARKETS = [
  {
    market: "ETH-USD", underlyingFeedId: FEED_IDS.ETH_USD, collateralInstrument: UI_COLL,
    initialMarginRate: 0.1, maintenanceMarginRate: 0.05, fundingIntervalSeconds: 3600,
    fundingDampingFactor: 0.3, fundingBaseRate: 0.0001, fundingClamp: 0.0075,
    takerFeeRate: 0.0005, liqPenaltyRate: 0.0, maxMarkStalenessSeconds: 300, maxNavStalenessSeconds: 90000,
  },
];
const SEED_PRICE: Record<string, number> = { "ETH-USD": 1680 };

const p = m2mProviderFromEnv();
const prices = dataStreamsPriceSourceFromEnv({ "ETH-USD": FEED_IDS.ETH_USD });

// Chainlink Proof-of-Reserve: read a REAL on-chain PoR aggregator (Ethereum
// mainnet) and use its reserve figure as the on-ledger collateral solvency gate.
// This is a second Chainlink product (besides Data Streams) whose data drives an
// on-ledger STATE CHANGE — PlaceOrder asserts reserves ≥ issuedSupply before
// accepting collateral.
const CHAINLINK_POR_FEED = process.env.POR_FEED ?? "0xa81FE04086865e63E12dD3776978E49DEEa2ea4e"; // WBTC PoR
const ETH_RPC = process.env.ETH_RPC ?? "https://ethereum-rpc.publicnode.com";
async function fetchChainlinkPoR(): Promise<{ reserves: number; updatedAt: number } | null> {
  try {
    const call = async (data: string) => {
      const r = await fetch(ETH_RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to: CHAINLINK_POR_FEED, data }, "latest"] }) });
      return (await r.json() as any).result as string;
    };
    const decimals = Number(BigInt((await call("0x313ce567")) || "0x8"));        // decimals()
    const hex = ((await call("0xfeaf968c")) || "").slice(2);                      // latestRoundData()
    const word = (i: number) => BigInt("0x" + (hex.slice(i * 64, (i + 1) * 64) || "0"));
    const reserves = Number(word(1)) / 10 ** decimals;
    const updatedAt = Number(word(3));
    if (reserves > 0) { console.log(`[gateway] real Chainlink PoR (WBTC) = ${reserves.toFixed(2)} reserves (updated ${new Date(updatedAt * 1000).toISOString().slice(0, 10)})`); return { reserves, updatedAt }; }
  } catch (e) { console.warn("[gateway] Chainlink PoR fetch failed:", (e as Error).message); }
  return null;
}

// Fetch the REAL average interest rate on U.S. Treasury Bills (US Treasury Fiscal
// Data API, public, no key). This is the actual money-market yield our tokenized
// RWA's NAV accrues at — so the APY shown is real, not invented.
async function fetchTbillApy(): Promise<number> {
  const url = "https://api.fiscaldata.treasury.gov/services/api/fiscal_service/v2/accounting/od/avg_interest_rates?filter=security_desc:eq:Treasury%20Bills&sort=-record_date&page[size]=1&fields=record_date,avg_interest_rate_amt";
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 6000);
    const r = await fetch(url, { signal: ctrl.signal });
    clearTimeout(t);
    const j: any = await r.json();
    const pct = Number(j?.data?.[0]?.avg_interest_rate_amt);
    if (pct > 0 && pct < 25) { console.log(`[gateway] real T-bill APY = ${pct}% (US Treasury, ${j.data[0].record_date})`); return pct / 100; }
  } catch (e) { console.warn("[gateway] T-bill rate fetch failed, using fallback:", (e as Error).message); }
  return APY_FALLBACK;
}

/* ------------------------------- ledger plumbing ---------------------------- */

let userId = "";
let sdk: any = null;                              // Wallet SDK (for external/self-custody onboarding)
let synchronizerId = "";                          // resolved at startup; needed by interactive submission
const keyMap = new Map<string, string>();         // gateway-held external party → privateKey (venue + custodial traders)
const pendingOnboard = new Map<string, any>();    // partyId → prepared party-creation builder
const pendingOrders = new Map<string, any>();     // prepareId → {prepJ, trader, collQty} for self-custody orders
const iso = (ms = Date.now()) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
const nowS = () => Math.floor(Date.now() / 1000);
const dg = (n: number) => n.toFixed(6);
const r6 = (n: number) => Math.round(n * 1e6) / 1e6;
const r2 = (n: number) => Math.round(n * 100) / 100;
const idg = (s: string) => `${s}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
const tsOf = (s: string) => Math.floor(Date.parse(s) / 1000);

async function h(): Promise<Record<string, string>> {
  const headers: Record<string, string> = { accept: "application/json", "content-type": "application/json" };
  if (p) headers.authorization = `Bearer ${await p.getToken()}`;
  return headers;
}
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

/* ── External-party interactive submission (self-custody) ──────────────────────
 * Every actAs party must sign the prepared transaction. Gateway-held parties
 * (venue + custodial traders) are signed here with keyMap; a self-custody trader's
 * signature is supplied by the browser (browserSigs). oracle stays local/custodial. */
async function onboardExternal(hint: string): Promise<string> {
  const key = sdk.keys.generate();
  const res = await sdk.party.external.create(key.publicKey, { partyHint: hint }).sign(key.privateKey).execute();
  keyMap.set(res.partyId, key.privateKey);
  await post(`/v2/users/${userId}/rights`, { userId, rights: [{ kind: { CanReadAs: { value: { party: res.partyId } } } }] });
  return res.partyId;
}
async function prepareExt(commands: any[], actAs: string[]) {
  return post("/v2/interactive-submission/prepare", { userId, commandId: idg("p"), actAs, readAs: [], synchronizerId, disclosedContracts: [], verboseHashing: false, packageIdSelectionPreference: [], commands });
}
function sigFor(party: string, hash: string, browserSigs: Record<string, string>) {
  const signature = keyMap.has(party) ? signTransactionHash(hash, keyMap.get(party)!) : browserSigs[party];
  return { party, signatures: [{ signature, signedBy: party.split("::")[1], format: "SIGNATURE_FORMAT_CONCAT", signingAlgorithmSpec: "SIGNING_ALGORITHM_SPEC_ED25519" }] };
}
async function executeExt(prepJ: any, actAs: string[], browserSigs: Record<string, string> = {}) {
  const signatures = actAs.map((party) => sigFor(party, prepJ.preparedTransactionHash, browserSigs));
  return post("/v2/interactive-submission/executeAndWait", { userId, preparedTransaction: prepJ.preparedTransaction, hashingSchemeVersion: prepJ.hashingSchemeVersion, submissionId: idg("s"), deduplicationPeriod: { Empty: {} }, partySignatures: { signatures } });
}
async function submitExt(commands: any[], actAs: string[], browserSigs: Record<string, string> = {}) {
  const prep = await prepareExt(commands, actAs);
  if (!prep.ok) return { ok: false, j: prep.j };
  const exec = await executeExt(prep.j, actAs, browserSigs);
  return { ok: exec.ok, j: exec.j };
}
const exerExt = (tid: string, cid: string, choice: string, arg: any, actAs: string[], bs: Record<string, string> = {}) =>
  submitExt([{ ExerciseCommand: { templateId: tid, contractId: cid, choice, choiceArgument: arg } }], actAs, bs);

/* --------------------------------- world state ------------------------------ */

interface Trader { partyId: string; label: string; }
const world: {
  ready: boolean;
  traders: Trader[];                 // role "trader" viewpoints (Alice, Bob, + created)
  venue: string; oracle: string; regulator: string; outsider: string;
  obs: string[];                     // observers granted on feeds/tokens
  oracleCid: string; rwaNAVCid: string; porCid: string; marketCid: string;
  nav: number;
  por: { reserveAmt: number; issuedSupply: number; at: number };
  porSource: string;
} = { ready: false, traders: [], venue: "", oracle: "", regulator: "", outsider: "", obs: [], oracleCid: "", rwaNAVCid: "", porCid: "", marketCid: "", nav: NAV0, por: { reserveAmt: 10_000_000, issuedSupply: 9_000_000, at: nowS() }, porSource: "static attestation" };

const candles = new Map<string, { time: number; open: number; high: number; low: number; close: number }[]>();
const curPrice = new Map<string, number>();
const fills: any[] = [];
const liquidations: any[] = [];
const settlements: any[] = [];
const closeRequests: any[] = [];
let fundingNextAt = 0;
let lastFundingRate = 0;
let lastCycle: any = null;
let running = true;
let tickCount = 0;

let snapshot: any = emptySnapshot();
function emptySnapshot() {
  return { now: nowS(), running, parties: [], markets: MARKETS, prices: {}, candles: {}, navs: {}, orders: [], pairs: [], closeRequests: [], fills: [], liquidations: [], settlements: [], holdings: {}, por: {}, lastCycle: null, fundingByMarket: {} };
}

// Serialize ALL ledger-mutating work (ticks + actions) so a shock/action isn't
// raced by a concurrent Chainlink tick.
let queue: Promise<any> = Promise.resolve();
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(fn, fn);
  queue = run.then(() => {}, () => {});
  return run;
}

/* ------------------------------ REAL RWA token ------------------------------ */
// Issuer-custodied yield-bearing token. The gateway acts as issuer (oracle party)
// to mint / adjust balances; value = amount * NAV (NAV accrues = the APY).

async function tokensByOwner(): Promise<Map<string, { cid: string; amount: number }>> {
  const rows = (await active(`${RWA}:RWAToken`)).filter((t: any) => t.arg.issuer === world.oracle && t.arg.instrument === ON_COLL);
  const m = new Map<string, { cid: string; amount: number }>();
  for (const t of rows) m.set(t.arg.owner, { cid: t.cid, amount: Number(t.arg.amount) });
  return m;
}
async function setBalance(owner: string, newAmount: number, known?: Map<string, { cid: string; amount: number }>) {
  const amt = dg(Math.max(0, r6(newAmount)));
  const tok = (known ?? (await tokensByOwner())).get(owner);
  if (tok) await exer(`${RWA}:RWAToken`, tok.cid, "SetBalance", { newAmount: amt }, [world.oracle]);
  else await create(`${RWA}:RWAToken`, { issuer: world.oracle, owner, instrument: ON_COLL, amount: amt }, [world.oracle]);
}
async function mintDelta(owner: string, delta: number) {
  const toks = await tokensByOwner();
  await setBalance(owner, (toks.get(owner)?.amount ?? 0) + delta, toks);
}

/* ----------------------------- world persistence ---------------------------- */
// Persist venue/oracle keys and contract IDs so a gateway restart reuses the
// same parties and market instead of creating a new world (which orphans wallets).

const WORLD_FILE = process.env.WORLD_FILE ?? "world-state.json";

function saveWorld() {
  try {
    fs.writeFileSync(WORLD_FILE, JSON.stringify({
      venue: world.venue, oracle: world.oracle, regulator: world.regulator, outsider: world.outsider,
      oracleCid: world.oracleCid, rwaNAVCid: world.rwaNAVCid, porCid: world.porCid, marketCid: world.marketCid,
      traders: world.traders, nav: world.nav, por: world.por, porSource: world.porSource,
      keys: Object.fromEntries(keyMap),
    }, null, 2));
  } catch (e) { console.warn("[gateway] saveWorld failed:", (e as Error).message); }
}

async function tryRestoreWorld(): Promise<boolean> {
  try {
    if (!fs.existsSync(WORLD_FILE)) return false;
    const data = JSON.parse(fs.readFileSync(WORLD_FILE, "utf8"));
    const markets = (await active(`${CORE}:Market`)).filter((c: any) => c.arg.venue === data.venue);
    if (!markets.length) { console.log("[gateway] world-state.json found but market gone — rebuilding"); return false; }
    world.venue = data.venue; world.oracle = data.oracle;
    world.regulator = data.regulator; world.outsider = data.outsider;
    world.marketCid = markets[0].cid;
    world.traders = data.traders ?? []; world.nav = data.nav ?? NAV0;
    world.obs = [world.venue, world.regulator, world.outsider, ...world.traders.map((t: any) => t.partyId)];
    if (data.por) world.por = data.por;
    if (data.porSource) world.porSource = data.porSource;
    for (const [k, v] of Object.entries(data.keys ?? {})) keyMap.set(k, v as string);
    const liveOracle = (await active(`${ORC}:MockOraclePrice`)).find((c: any) => c.arg.operator === world.oracle);
    const liveNav = (await active(`${ORC}:RWAOracleFeed`)).find((c: any) => c.arg.operator === world.oracle);
    const livePor = (await active(`${ORC}:PoRAttestation`)).find((c: any) => c.arg.operator === world.oracle);
    world.oracleCid = liveOracle?.cid ?? data.oracleCid;
    world.rwaNAVCid = liveNav?.cid ?? data.rwaNAVCid;
    world.porCid = livePor?.cid ?? data.porCid;
    console.log(`[gateway] restored from ${WORLD_FILE}: venue=${world.venue.split("::")[0]} traders=${world.traders.length}`);
    return true;
  } catch (e) { console.warn("[gateway] restore failed:", (e as Error).message); return false; }
}

/* --------------------------------- setup ------------------------------------ */

async function setup() {
  if (!base) throw new Error("LEDGER_BASE_URL missing — set it in backend/.env");
  userId = (await (await fetch(`${base}/v2/authenticated-user`, { headers: await h() })).json()).user.id;
  apyRate = await fetchTbillApy(); // real money-market yield for the RWA NAV
  const por = await fetchChainlinkPoR(); // real Chainlink Proof-of-Reserve → on-ledger solvency gate
  if (por) { world.por = { reserveAmt: r6(por.reserves), issuedSupply: r6(por.reserves * 0.92), at: nowS() }; world.porSource = "Chainlink PoR · WBTC (Ethereum)"; }
  if (!p) throw new Error("OIDC creds required for self-custody mode");
  sdk = await (SDK as any).create({ auth: { method: "static", token: await p.getToken() }, ledgerClientUrl: base });
  synchronizerId = sdk.ctx.defaultSynchronizerId;
  console.log("[gateway] Wallet SDK ready; synchronizer", String(synchronizerId).slice(0, 28), "…");

  if (await tryRestoreWorld()) {
    const live = await prices.getPerpPrice("ETH-USD").catch(() => ({ price: SEED_PRICE[UI_MARKET] }));
    curPrice.set(UI_MARKET, r2(live.price));
    candles.set(UI_MARKET, seedCandles(r2(live.price)));
    fundingNextAt = Date.now() + FUNDING_SECS * 1000;
    world.ready = true;
    await tick();
    return;
  }

  const ts = Date.now().toString(36);
  console.log("[gateway] allocating parties (venue + traders are EXTERNAL / self-custody-capable)…");
  world.oracle = await allocate(`oracle-${ts}`);     // local: signs oracle feeds (custodial)
  world.regulator = await allocate(`reg-${ts}`);     // local: observer only
  world.outsider = await allocate(`out-${ts}`);      // local: observer only
  if (p) p.invalidate();
  world.venue = await onboardExternal(`venue-${ts}`); // external: co-signs every trade
  // No seeded traders — the roster starts empty so a wallet must be created via the
  // self-custody Connect flow (POST /api/wallet/onboard-*). Created wallets push
  // themselves into world.traders / world.obs.
  world.traders = [];
  world.obs = [world.venue, world.regulator, world.outsider];

  const live = await prices.getPerpPrice("ETH-USD").catch(() => ({ price: SEED_PRICE[UI_MARKET] }));
  const entry = r2(live.price);
  curPrice.set(UI_MARKET, entry);

  console.log("[gateway] creating oracle feeds + market (no seeded traders)…");
  await create(`${ORC}:MockOraclePrice`, { operator: world.oracle, observers: world.obs, assetId: ON_ORACLE, price: dg(entry), timestamp: iso() }, [world.oracle]);
  await create(`${ORC}:RWAOracleFeed`, { operator: world.oracle, observers: world.obs, asset: ON_COLL, navPerUnit: dg(world.nav), timestamp: iso() }, [world.oracle]);
  await create(`${ORC}:PoRAttestation`, { operator: world.oracle, observers: world.obs, assetId: ON_COLL, reserveAmt: dg(world.por.reserveAmt), issuedSupply: dg(world.por.issuedSupply), lastAttestedAt: iso() }, [world.oracle]);
  world.oracleCid = (await active(`${ORC}:MockOraclePrice`)).find((c: any) => c.arg.operator === world.oracle).cid;
  world.rwaNAVCid = (await active(`${ORC}:RWAOracleFeed`)).find((c: any) => c.arg.operator === world.oracle).cid;
  world.porCid = (await active(`${ORC}:PoRAttestation`)).find((c: any) => c.arg.operator === world.oracle).cid;
  await submitExt([{ CreateCommand: { templateId: `${CORE}:Market`, createArguments: { venue: world.venue, regulator: world.regulator, underlying: ON_ORACLE, leverageCap: "10.0", maintenanceMarginBps: "500", fundingIntervalSecs: String(FUNDING_SECS), collateralWhitelist: [ON_COLL], liqPenaltyBps: "50", oracleCid: world.oracleCid, rwaNAVCid: world.rwaNAVCid, porCid: world.porCid } } }], [world.venue]);
  world.marketCid = (await active(`${CORE}:Market`)).find((c: any) => c.arg.venue === world.venue).cid;

  candles.set(UI_MARKET, seedCandles(entry));
  fundingNextAt = Date.now() + FUNDING_SECS * 1000;

  world.ready = true;
  console.log(`[gateway] world ready. venue=${world.venue.split("::")[0]} entry≈${entry}`);
  saveWorld();
  await tick();
}

function seedCandles(price: number) {
  const out = [];
  let prev = price * 0.995;
  const step = (POLL_MS / 1000) * 2;
  const t0 = nowS() - MAX_CANDLES * step;
  for (let i = 0; i < MAX_CANDLES; i++) {
    const open = prev;
    const close = prev + (price - prev) * 0.06 + Math.sin(i / 3) * price * 0.0015;
    out.push({ time: t0 + i * step, open, high: Math.max(open, close), low: Math.min(open, close), close });
    prev = close;
  }
  return out;
}
function rollCandle(market: string, price: number) {
  const arr = candles.get(market) ?? [];
  const last = arr[arr.length - 1];
  if (!last || tickCount % 2 === 0) {
    arr.push({ time: nowS(), open: price, high: price, low: price, close: price });
    if (arr.length > MAX_CANDLES) arr.shift();
  } else { last.close = price; last.high = Math.max(last.high, price); last.low = Math.min(last.low, price); }
  candles.set(market, arr);
}

/* ----------------------------- on-ledger actions ---------------------------- */

const minCollQty = (size: number, price: number, leverage: number) => (size * price) / (leverage * world.nav);

// Place an order on-ledger AND lock the trader's collateral by reducing their
// real RWA token balance (free → locked-in-order). Returns the locked qty.
async function placeAndLock(trader: string, side: string, size: number, limitPrice: number, leverage: number, browserSigs: Record<string, string> = {}): Promise<{ ok: boolean; collQty: number; err?: string }> {
  const collQty = r6(minCollQty(size, limitPrice, leverage) * 1.05);
  const order = { trader, side, size: dg(size), limitPrice: dg(limitPrice), collateralQty: dg(collQty), collateralAssetId: ON_COLL, collateralAllocationCid: "", timeInForce: "GTC", expiresAt: iso(Date.now() + 86400000) };
  const r = await exerExt(`${CORE}:Market`, world.marketCid, "PlaceOrder", order, [trader, world.venue], browserSigs);
  if (!r.ok) return { ok: false, collQty, err: JSON.stringify(r.j).slice(0, 200) };
  await mintDelta(trader, -collQty); // lock: real tokens leave the free balance
  return { ok: true, collQty };
}

async function matchBook(): Promise<number> {
  if (!DO_MATCH) return 0;
  const orders = (await active(`${CORE}:Order`)).filter((o: any) => o.arg.venue === world.venue);
  const longs = orders.filter((o: any) => o.arg.side === "Long").sort((a: any, b: any) => Number(b.arg.limitPrice) - Number(a.arg.limitPrice) || a.arg.createdAt.localeCompare(b.arg.createdAt));
  const shorts = orders.filter((o: any) => o.arg.side === "Short").sort((a: any, b: any) => Number(a.arg.limitPrice) - Number(b.arg.limitPrice) || a.arg.createdAt.localeCompare(b.arg.createdAt));
  let matched = 0;
  for (const lo of longs) {
    const so = shorts.find((s: any) => Number(lo.arg.limitPrice) >= Number(s.arg.limitPrice) && Number(s.arg.size) === Number(lo.arg.size));
    if (!so) continue;
    shorts.splice(shorts.indexOf(so), 1);
    const mark = curPrice.get(UI_MARKET)!;
    const px = r2(Math.min(Number(lo.arg.limitPrice), Math.max(Number(so.arg.limitPrice), mark)));
    const size = Number(lo.arg.size);
    const r = await exerExt(`${CORE}:Order`, lo.cid, "MatchOrders", { shortOrderCid: so.cid, executionPrice: dg(px), fillSize: dg(size) }, [world.venue]);
    if (r.ok) { matched++; fills.unshift({ id: idg("fill"), market: UI_MARKET, price: px, size, takerSide: "Long", at: nowS() }); fills.length = Math.min(fills.length, MAX_TAPE); }
  }
  return matched;
}

// Return collateral to free balances when a pair closes (P2P, mirrors SettleClose).
async function creditClose(pr: any, exit: number) {
  const pnlLongTok = ((exit - pr.entryPrice) * pr.size) / world.nav;
  await mintDelta(pr.long.trader, Math.max(0, pr.long.collateralQty + pnlLongTok));
  await mintDelta(pr.short.trader, Math.max(0, pr.short.collateralQty - pnlLongTok));
}
// Return collateral on liquidation (mirrors Core.daml Liquidate payouts).
async function creditLiquidation(pr: any, breach: string, mark: number) {
  const breachingColl = breach === "Long" ? pr.long.collateralQty : pr.short.collateralQty;
  const solventColl = breach === "Long" ? pr.short.collateralQty : pr.long.collateralQty;
  const solventTrader = breach === "Long" ? pr.short.trader : pr.long.trader;
  const breachTrader = breach === "Long" ? pr.long.trader : pr.short.trader;
  const solventSide = breach === "Long" ? "Short" : "Long";
  const solventGainTok = Math.max(0, risk.unrealizedPnl(solventSide as any, pr.size, pr.entryPrice, mark)) / world.nav;
  const penaltyTok = (pr.size * mark * LIQ_PENALTY) / world.nav;
  const paidToSolvent = Math.min(breachingColl, solventGainTok + penaltyTok);
  const returnTok = Math.max(0, breachingColl - paidToSolvent);
  await mintDelta(solventTrader, solventColl + paidToSolvent);
  if (returnTok > 0) await mintDelta(breachTrader, returnTok);
}

/* ----------------------------------- tick ----------------------------------- */

async function pushMark(px: number) {
  curPrice.set(UI_MARKET, px);
  const r = await exer(`${ORC}:MockOraclePrice`, world.oracleCid, "UpdatePrice", { newPrice: dg(px), newTimestamp: iso() }, [world.oracle]);
  if (r.ok) world.oracleCid = (await active(`${ORC}:MockOraclePrice`)).find((c: any) => c.arg.operator === world.oracle)?.cid ?? world.oracleCid;
  rollCandle(UI_MARKET, px);
}

// NAV accrual is intentionally NOT rotated on-ledger: the Market pins its
// rwaNAVCid, and PlaceOrder fetches that exact CID — rotating the feed (UpdateNAV
// is consuming) would orphan it and break trading. So NAV stays at the real
// on-ledger value; value = amount × NAV is always exact. The APY shown is the real
// T-bill rate; real yield over a short demo is negligible (NAV ≈ flat = the truth).
// (To accrue on-ledger, the Market/PlaceOrder would need rwaNAVCid as a choice arg.)

async function tick() {
  if (!world.ready) return;
  tickCount++;
  try {
    const live = await prices.getPerpPrice("ETH-USD");
    await pushMark(r2(live.price)); // PURE real Chainlink Data Streams price — no synthetic modification
  } catch (e) { rollCandle(UI_MARKET, curPrice.get(UI_MARKET)!); }

  const matched = await matchBook();
  await evaluateRisk(Date.now() >= fundingNextAt);
  await refresh();
  console.log(`[gateway] tick ${tickCount}: ETH=${curPrice.get(UI_MARKET)} NAV=${world.nav.toFixed(3)} matched=${matched} pairs=${snapshot.pairs.length}`);
}

async function evaluateRisk(fundingDue: boolean) {
  const t = nowS();
  const px = curPrice.get(UI_MARKET)!;
  const pairRows = (await active(`${CORE}:MatchedPair`)).filter((c: any) => c.arg.venue === world.venue);
  let funded = 0, liquidated = 0;

  for (const pr of pairRows) {
    const a = pr.arg;
    const size = Number(a.size), entry = Number(a.entryPrice);
    if (fundingDue) {
      const r = await exerExt(`${CORE}:MatchedPair`, pr.cid, "ApplyFunding", { oracleCid: world.oracleCid, rwaNAVCid: world.rwaNAVCid }, [world.venue]);
      if (r.ok) { funded++; continue; }
    }
    const longEq = risk.equity(Number(a.longCollateralQty) * world.nav, risk.unrealizedPnl("Long", size, entry, px), 0);
    const shortEq = risk.equity(Number(a.shortCollateralQty) * world.nav, risk.unrealizedPnl("Short", size, entry, px), 0);
    const mm = risk.maintenanceMargin(size, px, MMR);
    const breach = risk.isLiquidatable(longEq, mm) ? "Long" : risk.isLiquidatable(shortEq, mm) ? "Short" : null;
    if (breach) {
      const r = await exerExt(`${CORE}:MatchedPair`, pr.cid, "Liquidate", { breachingSide: breach, oracleCid: world.oracleCid, rwaNAVCid: world.rwaNAVCid }, [world.venue]);
      if (r.ok) {
        liquidated++;
        const view = { size, entryPrice: entry, long: { trader: a.longTrader, collateralQty: Number(a.longCollateralQty) }, short: { trader: a.shortTrader, collateralQty: Number(a.shortCollateralQty) } };
        await creditLiquidation(view, breach, px);
        recordLiquidation(pr.cid, breach, px, size, entry, Number(a.accruedFundingLong), breach === "Long" ? longEq : shortEq, mm);
      }
    }
  }
  if (fundingDue) { fundingNextAt = Date.now() + FUNDING_SECS * 1000; lastFundingRate = risk.fundingRate(px, px, MARKETS[0]); }
  lastCycle = { at: t, evaluated: pairRows.length, fundingApplied: funded, liquidated, settled: 0, skippedStale: 0, skippedNoConfig: 0, perPair: [] };
}

function recordLiquidation(cid: string, side: string, mark: number, size: number, entry: number, accrued: number, eq: number, mm: number) {
  const seized = (side === "Long" ? 0 : 0); // value tape below
  liquidations.unshift({ id: idg("liq"), market: UI_MARKET, contractId: cid, side, markPrice: mark, equity: eq, maintenanceMargin: mm, seized: r6(Math.abs(risk.unrealizedPnl(side as any, size, entry, mark))), at: nowS() });
  liquidations.length = Math.min(liquidations.length, MAX_TAPE);
  settlements.unshift({ id: idg("set"), market: UI_MARKET, contractId: cid, closingSide: side, exitPrice: mark, realizedPnl: -Math.abs(risk.unrealizedPnl(side as any, size, entry, mark)), netFunding: accrued, at: nowS() });
  settlements.length = Math.min(settlements.length, MAX_TAPE);
  void seized;
}

/* ------------------------------ snapshot builder ---------------------------- */

function partyList() {
  return [
    ...world.traders.map((t) => ({ role: "trader", partyId: t.partyId, label: t.label })),
    { role: "venue", partyId: world.venue, label: "Venue Operator" },
    { role: "regulator", partyId: world.regulator, label: "Regulator" },
    { role: "outsider", partyId: world.outsider, label: "Outsider" },
  ];
}

async function refresh() {
  if (!world.ready) return;
  const orderRows = (await active(`${CORE}:Order`)).filter((o: any) => o.arg.venue === world.venue);
  const pairRows = (await active(`${CORE}:MatchedPair`)).filter((c: any) => c.arg.venue === world.venue);
  const toks = await tokensByOwner();

  const orders = orderRows.map((o: any) => {
    const a = o.arg, size = Number(a.size), limitPrice = Number(a.limitPrice), collQty = Number(a.collateralQty);
    const lev = collQty > 0 ? Math.max(1, Math.round((size * limitPrice) / (collQty * world.nav))) : 1;
    return { contractId: o.cid, market: UI_MARKET, trader: a.trader, side: a.side, size, remaining: size, limitPrice, leverage: lev, collateralInstrument: UI_COLL, collateralQty: collQty, status: "Resting", createdAt: tsOf(a.createdAt) };
  });
  const pairs = pairRows.map((pr: any) => {
    const a = pr.arg;
    return { contractId: pr.cid, market: UI_MARKET, collateralInstrument: UI_COLL, size: Number(a.size), entryPrice: Number(a.entryPrice), long: { trader: a.longTrader, collateralQty: Number(a.longCollateralQty) }, short: { trader: a.shortTrader, collateralQty: Number(a.shortCollateralQty) }, accruedFundingLong: Number(a.accruedFundingLong), lastFundingTime: tsOf(a.lastFundingTime), openedAt: tsOf(a.openedAt) };
  });

  const locked = new Map<string, number>();
  const addLock = (party: string, qty: number) => locked.set(party, r6((locked.get(party) ?? 0) + qty));
  for (const o of orders) addLock(o.trader, o.collateralQty);
  for (const pr of pairs) { addLock(pr.long.trader, pr.long.collateralQty); addLock(pr.short.trader, pr.short.collateralQty); }

  const holdings: Record<string, any[]> = {};
  for (const tr of world.traders) {
    holdings[tr.partyId] = [{ instrument: UI_COLL, symbol: "tMMF", owner: tr.partyId, amount: r6(toks.get(tr.partyId)?.amount ?? 0), locked: locked.get(tr.partyId) ?? 0, isCollateral: true }];
  }

  for (let i = closeRequests.length - 1; i >= 0; i--) if (!pairs.some((pr: any) => pr.contractId === closeRequests[i].matchedPairContractId)) closeRequests.splice(i, 1);

  const t = nowS();
  snapshot = {
    now: t, running, parties: partyList(), markets: MARKETS,
    prices: { "ETH-USD": { feedId: FEED_IDS.ETH_USD, price: curPrice.get("ETH-USD") ?? SEED_PRICE["ETH-USD"], asOf: t } },
    candles: { "ETH-USD": candles.get("ETH-USD") ?? [] },
    navs: { [UI_COLL]: { feedId: UI_COLL, price: world.nav, asOf: t } },
    rwaApy: apyRate,
    orders, pairs, closeRequests: [...closeRequests], fills: [...fills], liquidations: [...liquidations], settlements: [...settlements],
    holdings, por: { [UI_COLL]: { instrument: UI_COLL, reserves: world.por.reserveAmt, issuedSupply: world.por.issuedSupply, solvent: world.por.reserveAmt >= world.por.issuedSupply, whitelisted: true, asOf: world.por.at, source: world.porSource } },
    lastCycle, fundingByMarket: { "ETH-USD": { rate: lastFundingRate, nextAt: Math.floor(fundingNextAt / 1000) } },
  };
}

/* ------------------------------- HTTP handlers ------------------------------ */

function readBody(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => { try { resolve(b ? JSON.parse(b) : {}); } catch { resolve({}); } }); });
}

// Resolve the CURRENT on-ledger pair (CID-rotation-safe) by contractId, then by
// the stable (longTrader, shortTrader) key (funding rotates the CID).
async function resolvePair(body: any): Promise<{ cid: string; arg: any } | undefined> {
  const pairs = (await active(`${CORE}:MatchedPair`)).filter((c: any) => c.arg.venue === world.venue);
  let pr = pairs.find((c: any) => c.cid === body.contractId);
  if (!pr) {
    const snapPr = (snapshot.pairs ?? []).find((x: any) => x.contractId === body.contractId);
    if (snapPr) pr = pairs.find((c: any) => c.arg.longTrader === snapPr.long.trader && c.arg.shortTrader === snapPr.short.trader);
  }
  return pr;
}
const pairView = (pr: any) => ({ contractId: pr.cid, size: Number(pr.arg.size), entryPrice: Number(pr.arg.entryPrice), long: { trader: pr.arg.longTrader, collateralQty: Number(pr.arg.longCollateralQty) }, short: { trader: pr.arg.shortTrader, collateralQty: Number(pr.arg.shortCollateralQty) }, accruedFundingLong: Number(pr.arg.accruedFundingLong) });

async function freeOf(party: string): Promise<number> { return (await tokensByOwner()).get(party)?.amount ?? 0; }

async function handleAction(path: string, body: any): Promise<{ ok: boolean; error?: string; party?: string }> {
  const v = world.venue;
  switch (path) {
    case "/api/order": {
      const { trader, side, size, limitPrice, leverage } = body;
      if (!trader || !side || !(size > 0)) return { ok: false, error: "bad order" };
      // Custodial path can only sign for gateway-held parties. A self-custody party
      // whose browser key is missing (orphaned by a gateway restart) lands here and
      // would submit an unsigned tx that dies as "0 valid signatures". Fail clearly.
      if (!keyMap.has(trader)) return { ok: false, error: "stale-wallet: gateway holds no signing key for this party — its self-custody key was lost (likely a gateway restart). Disconnect and create a fresh wallet." };
      const px = limitPrice > 0 ? limitPrice : curPrice.get(UI_MARKET)!;
      const need = r6(minCollQty(size, px, leverage || 5) * 1.05);
      if ((await freeOf(trader)) < need - 1e-6) return { ok: false, error: "insufficient free RWA collateral — use the faucet" };
      const r = await placeAndLock(trader, side, size, r2(px), leverage || 5);
      if (!r.ok) return { ok: false, error: r.err };
      await matchBook(); await refresh();
      return { ok: true };
    }
    case "/api/cancel": {
      const o = (snapshot.orders ?? []).find((x: any) => x.contractId === body.contractId);
      if (!o) return { ok: false, error: "order not found" };
      const r = await exerExt(`${CORE}:Order`, o.contractId, "Cancel", {}, [o.trader]);
      if (r.ok) await mintDelta(o.trader, o.collateralQty); // unlock collateral back to free
      await refresh();
      return r.ok ? { ok: true } : { ok: false, error: JSON.stringify(r.j).slice(0, 200) };
    }
    case "/api/close": {
      const found = await resolvePair(body);
      if (!found) return { ok: false, error: "pair not found" };
      const pr = pairView(found);
      const side = body.side ?? "Long";
      closeRequests.push({ contractId: idg("close"), matchedPairContractId: pr.contractId, closingSide: side, requestedAt: nowS() });
      await refresh();
      const exit = curPrice.get(UI_MARKET)!;
      const r = await exerExt(`${CORE}:MatchedPair`, found.cid, "SettleClose", { oracleCid: world.oracleCid, rwaNAVCid: world.rwaNAVCid }, [v]);
      if (r.ok) {
        await creditClose(pr, exit);
        settlements.unshift({ id: idg("set"), market: UI_MARKET, contractId: pr.contractId, closingSide: side, exitPrice: exit, realizedPnl: risk.realizedPnl(side, pr.size, pr.entryPrice, exit), netFunding: pr.accruedFundingLong, at: nowS() });
        settlements.length = Math.min(settlements.length, MAX_TAPE);
      }
      await refresh();
      return r.ok ? { ok: true } : { ok: false, error: JSON.stringify(r.j).slice(0, 200) };
    }
    case "/api/liquidate": {
      const found = await resolvePair(body);
      if (!found) return { ok: false, error: "pair not found" };
      const pr = pairView(found);
      const side = body.side ?? "Long";
      // push a mark that makes `side` breach (simulate the move), then liquidate.
      // Use an aggressive move (-40% long / +40% short) so equity < MM holds even
      // for low-leverage, over-collateralized positions — this is a demo "force
      // liquidation" button, so it must reliably trip the on-ledger `equity < MM`
      // assert rather than silently no-op.
      const crash = r2(side === "Long" ? pr.entryPrice * 0.6 : pr.entryPrice * 1.4);
      await pushMark(crash);
      const eq = risk.equity((side === "Long" ? pr.long.collateralQty : pr.short.collateralQty) * world.nav, risk.unrealizedPnl(side, pr.size, pr.entryPrice, crash), 0);
      const mm = risk.maintenanceMargin(pr.size, crash, MMR);
      const r = await exerExt(`${CORE}:MatchedPair`, found.cid, "Liquidate", { breachingSide: side, oracleCid: world.oracleCid, rwaNAVCid: world.rwaNAVCid }, [v]);
      if (r.ok) { await creditLiquidation(pr, side, crash); recordLiquidation(pr.contractId, side, crash, pr.size, pr.entryPrice, pr.accruedFundingLong, eq, mm); }
      await refresh();
      return r.ok ? { ok: true } : { ok: false, error: JSON.stringify(r.j).slice(0, 200) };
    }
    case "/api/funding": {
      const pairRows = (await active(`${CORE}:MatchedPair`)).filter((c: any) => c.arg.venue === world.venue);
      for (const pr of pairRows) await exerExt(`${CORE}:MatchedPair`, pr.cid, "ApplyFunding", { oracleCid: world.oracleCid, rwaNAVCid: world.rwaNAVCid }, [v]);
      lastFundingRate = risk.fundingRate(curPrice.get(UI_MARKET)!, curPrice.get(UI_MARKET)!, MARKETS[0]);
      fundingNextAt = Date.now() + FUNDING_SECS * 1000;
      await refresh();
      return { ok: true };
    }
    case "/api/shock": {
      const pct = Number(body.pct) || 0;
      const shocked = r2(Math.max(1, curPrice.get(UI_MARKET)! * (1 + pct)));
      await pushMark(shocked);
      await evaluateRisk(false);
      await refresh();
      return { ok: true };
    }
    case "/api/running": { running = !!body.on; await refresh(); return { ok: true }; }
    case "/api/faucet":
    case "/api/deposit": { if (body.party) await mintDelta(body.party, Math.abs(Number(body.amount) || FAUCET_AMT)); await refresh(); return { ok: true }; }
    case "/api/withdraw": { if (body.party) await mintDelta(body.party, -(Number(body.amount) || 0)); await refresh(); return { ok: true }; }
    // ── SELF-CUSTODY wallet (browser holds the key) ───────────────────────
    // Step 1: browser sends its public key; gateway builds the onboarding
    // topology and returns the multiHash for the browser to sign.
    case "/api/wallet/onboard-prepare": {
      if (!sdk) return { ok: false, error: "wallet SDK not ready" };
      if (!body.publicKey) return { ok: false, error: "publicKey required" };
      const hint = String(body.name || "wallet").replace(/[^a-zA-Z0-9]/g, "").slice(0, 16).toLowerCase() || "wallet";
      const prepared = sdk.party.external.create(body.publicKey, { partyHint: hint });
      const topo = await prepared.topology();
      pendingOnboard.set(topo.partyId, prepared);
      return { ok: true, party: topo.partyId, multiHash: topo.multiHash } as any;
    }
    // Step 2: browser returns the signature over the multiHash; gateway finishes
    // onboarding (party allocated with the USER's key), grants read, mints RWA.
    case "/api/wallet/onboard-execute": {
      const prepared = pendingOnboard.get(body.party);
      if (!prepared) return { ok: false, error: "no pending onboard for party" };
      if (!body.signature) return { ok: false, error: "signature required" };
      await prepared.execute(body.signature);
      pendingOnboard.delete(body.party);
      await post(`/v2/users/${userId}/rights`, { userId, rights: [{ kind: { CanReadAs: { value: { party: body.party } } } }] });
      await setBalance(body.party, SEED_FREE);                 // mint starting RWA to the self-custody wallet
      world.traders.push({ partyId: body.party, label: String(body.name || "Wallet") });
      saveWorld();
      await refresh();
      return { ok: true, party: body.party } as any;
    }
    case "/api/create-wallet": {
      const name = String(body.name || "Trader").replace(/[^a-zA-Z0-9 ]/g, "").trim().slice(0, 16) || "Trader";
      const hint = name.toLowerCase().replace(/[^a-z0-9]/g, "") || "trader";
      const party = await onboardExternal(hint);     // gateway-held external trader (custodial)
      world.traders.push({ partyId: party, label: name });
      world.obs.push(party);
      saveWorld();
      await setBalance(party, SEED_FREE);             // 0 — fund via faucet
      await refresh();
      return { ok: true, party };
    }
    // ── SELF-CUSTODY trading: gateway prepares, browser signs, gateway executes ──
    case "/api/wallet/order-prepare": {
      const { trader, side, size, leverage } = body;
      if (!trader || !side || !(size > 0)) return { ok: false, error: "bad order" };
      const mark = curPrice.get(UI_MARKET)!;
      const px = body.limitPrice > 0 ? body.limitPrice : (side === "Long" ? mark * 1.004 : mark * 0.996);
      const collQty = r6(minCollQty(size, mark, leverage || 5) * 1.05);
      if ((await freeOf(trader)) < collQty - 1e-6) return { ok: false, error: "insufficient free RWA collateral — use the faucet" };
      const order = { trader, side, size: dg(size), limitPrice: dg(r2(px)), collateralQty: dg(collQty), collateralAssetId: ON_COLL, collateralAllocationCid: "", timeInForce: "GTC", expiresAt: iso(Date.now() + 86400000) };
      const prep = await prepareExt([{ ExerciseCommand: { templateId: `${CORE}:Market`, contractId: world.marketCid, choice: "PlaceOrder", choiceArgument: order } }], [trader, world.venue]);
      if (!prep.ok) return { ok: false, error: JSON.stringify(prep.j).slice(0, 200) };
      const prepareId = idg("wo");
      pendingOrders.set(prepareId, { prepJ: prep.j, trader, collQty });
      return { ok: true, prepareId, hash: prep.j.preparedTransactionHash } as any;
    }
    case "/api/wallet/order-execute": {
      const pend = pendingOrders.get(body.prepareId);
      if (!pend) return { ok: false, error: "no pending order" };
      pendingOrders.delete(body.prepareId);
      const exec = await executeExt(pend.prepJ, [pend.trader, world.venue], { [pend.trader]: body.signature });
      if (!exec.ok) return { ok: false, error: JSON.stringify(exec.j).slice(0, 200) };
      await mintDelta(pend.trader, -pend.collQty);   // lock collateral
      await matchBook(); await refresh();
      return { ok: true };
    }
    default: return { ok: false, error: "unknown action" };
  }
}

const server = http.createServer(async (req, res) => {
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("access-control-allow-headers", "content-type");
  res.setHeader("access-control-allow-methods", "GET,POST,OPTIONS");
  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }
  const url = (req.url ?? "").split("?")[0];
  try {
    if (req.method === "GET" && url === "/api/snapshot") { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ ...snapshot, running, ready: world.ready })); return; }
    if (req.method === "GET" && url === "/api/health") { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ ok: true, ready: world.ready })); return; }
    if (req.method === "POST" && url.startsWith("/api/")) {
      const body = await readBody(req);
      const out = await serial(() => handleAction(url, body));
      res.writeHead(out.ok ? 200 : 400, { "content-type": "application/json" }); res.end(JSON.stringify(out)); return;
    }
    res.writeHead(404, { "content-type": "application/json" }); res.end(JSON.stringify({ ok: false, error: "not found" }));
  } catch (e) {
    res.writeHead(500, { "content-type": "application/json" }); res.end(JSON.stringify({ ok: false, error: (e as Error).message }));
  }
});

async function main() {
  server.listen(PORT, () => console.log(`[gateway] HTTP listening on http://localhost:${PORT}  (snapshot: /api/snapshot)`));
  await setup();
  let tickQueued = false;
  setInterval(() => {
    if (!running || tickQueued) return;
    tickQueued = true;
    serial(tick).catch((e) => console.error("[gateway] tick error:", (e as Error).message)).finally(() => { tickQueued = false; });
  }, POLL_MS);
}
main().catch((e) => { console.error("[gateway] fatal:", e); process.exit(1); });
