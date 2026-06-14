# STATUS / HANDOFF — Private Perp DEX on Canton (ETHGlobal NYC 2026)

> Living handoff for picking up mid-build. Last updated this session. Read this first.

## What we're building
A **private perpetual-futures DEX on the Canton Network**: leveraged BTC/ETH perps, **private orderbook + pure peer-to-peer** settlement (no pool), margined with a **yield-bearing tokenized RWA** (no haircut, stable-collateral whitelist), priced by **Chainlink Data Streams** (verified in-transaction is the stretch), with **privacy by construction** (only trader + counterparty + venue + Regulator see a position; outsiders are blind).

Design docs: `README.md`, `DEX.md`, `CHAINLINK.md`, `CANTON-RWA.md`, `PLAN.md`. Three tracks: Person 1 = Daml contracts (`daml/`), Person 2 = C++ matching engine (`matching-engine/`), **Person 3 = TS backend (`backend/`) — this is what we (this session) built.**

## ✅ CURRENT STATE: full lifecycle works end-to-end on the LIVE validator
We proved, against the real Seaport 5n-sandbox validator, with real Chainlink prices:
**Chainlink price → on-ledger oracle → orderbook (PlaceOrder) → match → PRIVACY (outsider blind / regulator sees) → funding → price move → liquidation → settlement.**
Run `cd backend && npm run e2e` to see it (or `npm run keeper` for the continuous engine).

Backend: **67 unit tests pass**, typecheck clean, zero runtime deps (Node 24 runs `.ts` directly via `node --test`).

## ⏳ PENDING (the one open action)
We deployed a contract fix as a **new package `perp-dex-v2`** (see "Contract fixes" below) but **it must be rebuilt + redeployed** for the C++ engine's `MatchOrders` path. Exact commands:
```bash
daml install 3.4.11                                   # one-time
cd daml && daml build && cd ../backend                # → daml/.daml/dist/perp-dex-v2-1.0.0.dar
npm run upload-dar -- ../daml/.daml/dist/perp-dex-v2-1.0.0.dar   # deploy via Ledger API
npm run e2e                                            # verify (now uses real MatchOrders)
```
If `upload-dar` returns a permission error → deploy `perp-dex-v2-1.0.0.dar` via the Seaport IDE instead.

---

## Validator access (Seaport 5n sandbox)
- REST: `https://ledger-api.validator.devnet.sandbox.fivenorth.io` ; WS: `wss://…` (Canton **3.5.3**).
- Auth: **M2M OIDC** → JWT (8h, auto-refreshed). Token endpoint `https://auth.sandbox.fivenorth.io/application/o/token/`, client `validator-devnet-m2m`. **Secret is in `backend/.env` (gitignored)** — also in `Seaport Sandbox Validator Access.pdf` (repo root, gitignored). `.env.example` documents all vars.
- The authenticated user is **user id `6`** (primaryParty `5nsandbox-devnet-2::1220a14ca128…`). It CAN allocate parties + grant itself rights + submit commands. DAR-upload rights TBD (use Seaport IDE if denied).

## 🔑 HARD-WON GOTCHAS (these cost hours — don't relearn them)
1. **Package ref needs `#`**: templateIds are `#perp-dex-v2:PerpDex.Core:MatchedPair` (the `#` = package-name reference). Without it → `TEMPLATES_OR_INTERFACES_NOT_FOUND`.
2. **Daml JSON encoding**: `Int64` → **string** (`"500"`), `Decimal` → **string** (`"200.0"`), `Time` → **ISO-8601** (`"2026-…Z"`), `Side`/enums → bare string (`"Long"`). Sending an Int as a number → `Expected ujson.Str`.
3. **Command `userId` must be the authenticated OIDC user (`"6"`)**, NOT a party name. Wrong userId → 403 security error. (Get it from `GET /v2/authenticated-user` → `.user.id`.)
4. **Refresh the token AFTER granting rights**: a JWT obtained before a `CanActAs` grant doesn't see the new right → 403. We call `provider.invalidate()` after allocating+granting.
5. **Party allocation + rights**: `POST /v2/parties {partyIdHint}` then `POST /v2/users/6/rights {rights:[{kind:{CanActAs:{value:{party}}}}, …]}`. Allocated parties are local; user 6 can act as them once granted.
6. **Select YOUR contracts** from `active-contracts`: the shared ledger has everyone's contracts. Filter by your fresh party (e.g. Market by `arg.venue === venue`, feeds by `arg.operator === oracle`). Don't take "the last one."
7. **`active-contracts`**: first `GET /v2/state/ledger-end` → `offset`, then `POST /v2/state/active-contracts {activeAtOffset, eventFormat:{filtersForAnyParty|filtersByParty:{[party]:…}, cumulative:[{identifierFilter:{TemplateFilter:{value:{templateId,includeCreatedEventBlob:false}}}}]}}`. Use `filtersByParty` to test privacy (query as a specific party).
8. **`UpdatePrice` rotates the oracle CID** (consuming → recreate). Track the new CID after each post (re-query by operator+assetId). Same for `ApplyFunding` (pair CID rotates).
9. **Same-version redeploy is a no-op on Canton**: changing code but keeping `version: 1.0.0` won't replace the deployed package. Bump version. **Changing signatories/observers is upgrade-incompatible → must use a NEW package name** (that's why `perp-dex-v2`).

## Contract design + the fixes we made (in `daml/daml/PerpDex/`)
- Templates: `Market` (config + `oracleCid/rwaNAVCid/porCid` refs; choice `PlaceOrder`), `Order` (`Cancel`, `ConsumeForMatch`, `MatchOrders`), `PerpPosition` (`RequestClose`), `MatchedPair` (`ApplyFunding`, `Liquidate`, `SettleClose`), `Settlement`. Oracle: `MockOraclePrice` (`UpdatePrice`), `RWAOracleFeed` (`UpdateNAV`), `PoRAttestation` (`CheckSolvency`, `UpdateAttestation`).
- **Choice arg shapes (PROVEN against the validator):**
  - `Market.PlaceOrder {trader, side, size, limitPrice, collateralQty, collateralAssetId, collateralAllocationCid:"", timeInForce, expiresAt}` — actAs `[trader, venue]` (venue needed for visibility of the venue-owned Market).
  - `Order.MatchOrders {shortOrderCid, executionPrice, fillSize}` (exercised on the LONG order) — actAs `[venue]`.
  - `MatchedPair.ApplyFunding {oracleCid, rwaNAVCid}` — actAs `[venue]`. (Funding is computed on-ledger; collateral qtys adjust; pair CID rotates.)
  - `MatchedPair.Liquidate {breachingSide, oracleCid, rwaNAVCid}` — actAs `[venue]`. Asserts `equity < MM`; emits `Settlement` (+ surplus).
  - `MatchedPair.SettleClose {oracleCid, rwaNAVCid}` — actAs `[venue]`.
  - `MockOraclePrice.UpdatePrice {newPrice, newTimestamp}` — actAs `[oracle]`.
- **Fix 1 (deployed earlier):** `PlaceOrder` was *consuming* the Market (one order killed it). Made it `nonconsuming`.
- **Fix 2 (this session, in `perp-dex-v2`, needs redeploy):** `MatchOrders` couldn't create `MatchedPair`/`PerpPosition` because they were `signatory longTrader, shortTrader, venue` and the choice (run on the long order) only has `{long, venue}` authority — `DAML_AUTHORIZATION_ERROR`. **Fix: made `MatchedPair` and `PerpPosition` `signatory venue`, with traders+regulator as `observer`** (privacy preserved via observers). Now `MatchOrders` (venue authority) creates both legs. This changed signatories → renamed package to `perp-dex-v2`.
- **Workaround we used before Fix 2** (still in git history / earlier e2e): form the `MatchedPair` via a **top-level `CreateCommand` with `actAs:[long,short,venue]`** (top-level create is authorized by the submitter's parties). Now superseded by real `MatchOrders` once `perp-dex-v2` is deployed. The keeper/e2e currently call `MatchOrders`.

## Backend (`backend/src/`) — what each file is
- `types.ts` — frozen interfaces (LedgerClient, PriceSource, RiskApi, MatchedPair, *Args, etc.).
- `risk/math.ts` — pure perp math (PnL, funding, equity, liquidation; DEX.md §4–8). **Final, tested.**
- `oracle/` — `hmac.ts` (Chainlink Data Streams HMAC), `dataStreams.ts` (REST), `reportV3.ts` (V3 decode, validated vs a live report), `wsPriceSource.ts` (WS stream), `priceSource.ts` (`DataStreamsPriceSource`), `fromEnv.ts` (build from env). **Chainlink fetch is REAL and proven.**
- `ledger/auth.ts` — **M2M OIDC token provider** (exchange + 8h refresh) + `buildWsSubprotocols` for Canton WS.
- `ledger/cantonLedger.ts` — `CantonLedger` (LedgerClient over the JSON API; token-aware). Used by `liveChainlink.ts`.
- `ledger/mockLedger.ts` — in-memory ledger for the unit tests.
- `loop/triggerLoop.ts` — abstract risk/trigger loop (multi-market, funding/liquidation/close) — used by unit tests + `liveChainlink.ts`.
- **`smoke.ts`** — validator connectivity + party-allocation probe (`npm run smoke`).
- **`bootstrap.ts`** — allocate parties (+grant), create oracle feeds + Market, place orders (`npm run bootstrap`).
- **`e2e.ts`** — THE comprehensive live test: Chainlink→orderbook→MatchOrders→privacy→funding→liquidation→settlement (`npm run e2e`).
- **`keeper.ts`** — THE live engine: posts Chainlink price, matches resting orders (MatchOrders), funds/liquidates each tick (`npm run keeper`; `KEEPER_MATCH=0` to defer matching to the C++ engine).
- **`uploadDar.ts`** — deploy a DAR from the terminal via `POST /v2/dars` (`npm run upload-dar -- <dar>`).
- `fetchPrice.ts` — one-shot live Chainlink price (`npm run fetch`). `liveChainlink.ts` — older keeper variant using CantonLedger + Chainlink WS.

## Demo numbers (for `npm run e2e`)
size 1 ETH @ live price (~$1680), collateral ≈10x in T-BILL-USD @ NAV 520, MMR 5%/IMR 10%, funding ~$0.0001×size×price/interval. Liquidation triggered by posting price ×0.90.

## NEXT STEPS (priority order)
1. **Redeploy `perp-dex-v2`** (commands at top) and confirm `npm run e2e` passes with the real `MatchOrders`.
2. **Wire Person 2's C++ engine** to the validator: `ORDER_TEMPLATE_ID=#perp-dex-v2:PerpDex.Core:Order`, `MATCH_ORDERS_CHOICE=MatchOrders`, M2M JWT (Bearer for REST; WS subprotocols `jwt.token.<tok>`+`daml.ws.auth`). Then run `KEEPER_MATCH=0 npm run keeper` so the engine matches and the keeper only does risk.
3. **Chainlink prize (stretch):** on-ledger `Verify` of the signed `fullReport` (we already thread `signedReport` through; needs Chainlink's `Verifier`/`VerifierConfig` on this network + observer grant — see CHAINLINK.md §6).
4. **Demo polish:** privacy money-shot (already asserted in e2e), record the run.

## Git / conventions
- Repo `github.com/ybapat/ethny26`, branch `main`. **Commit messages must NOT include a Claude co-author line** (team preference; there's a memory note about it).
- `.env`, `node_modules`, `*.dar`, `bootstrap-out.json`, the validator PDF are gitignored.
- History note: `main` was rewritten once (diverged hashes); if local diverges, `git stash -u && git reset --hard origin/main && git stash pop` then commit on top.
