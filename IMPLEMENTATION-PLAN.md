# Plan: Split PLAN.md into three deep-dive implementation docs

## Context

The repo (`/Users/mugdha/Desktop/blockchain/ethnyc26/ethny26/`) currently holds a single
`PLAN.md` — a high-level plan for a **private perpetual-futures DEX on the Canton Network**
(ETHGlobal NYC 2026) that uses Chainlink Data Streams for prices, Chainlink Proof-of-Reserve
for collateral backing, and tokenized RWA (equity/ETF) as yield-bearing margin collateral with
USDCx as cash/settlement.

The existing PLAN.md is a good *strategy* doc but is **not buildable** — it gestures at APIs
("fetch signed report", "Allocation workflow") without the exact endpoints, schemas, choice
signatures, and edge-case handling needed to write code with no ambiguity. The user wants it
exploded into **three implementation-grade docs**, each going "into the extreme weeds — every
API call, web socket, etc." so there is "no room for confusion."

Three new files will be created (alongside PLAN.md, which stays as the index/overview):

1. **`DEX.md`** — the trading engine + margin trading (positions, matching, funding, mark,
   liquidation, settlement, collateral valuation/haircut, all financial math).
2. **`CHAINLINK.md`** — Data Streams (REST + WebSocket + HMAC), on-Canton `Verifier`/`Verify`,
   report schemas, Proof-of-Reserve, CRE, access/onboarding.
3. **`CANTON-RWA.md`** — Canton/Daml infra, JSON Ledger API v2, privacy model, Splice Token
   Standard (Holding/Allocation), RWA tokenization + **price-appreciation NAV yield**, PoR
   gating, PQS, tooling/versions, Seaport deploy.

User decisions (locked):
- **Concern-clean split** — margin trading lives in DEX.md; RWA+yield+PoR-gating live in CANTON-RWA.md.
- **Yield model = price-appreciation NAV** (wstETH/OUSG style): collateral token value rises via
  oracle NAV, no token-balance changes while escrowed, `CollateralValue` grows automatically each
  margin check, full yield returned to trader at close. This is the cleanest Daml design.

All three docs are written against **live-verified facts (2026-06-13)** from three research
sweeps. The corrections below MUST be applied — the original PLAN.md has several now-falsified claims.

---

## CRITICAL CORRECTIONS to apply across all three docs

These override the original PLAN.md. Each doc must state the corrected fact and flag the gap.

| Topic | PLAN.md said | Verified reality (2026-06-13) | Where |
|---|---|---|---|
| **SDK version conflict** | "Daml SDK / Canton 3.5.3" everywhere | `data-streams-canton` v1.0.0 **requires Daml SDK 3.4.9** to build; Splice token-standard DARs are built with **3.4.11** and are documented compatible with Canton 3.5.x; Canton inside Splice 0.6.5 is a `3.5.1-snapshot` build. **"3.5.3" is unconfirmed** — no such stable tag found. Resolution: build *our* package on 3.4.11 (matches token standard + Chainlink), run against a Canton 3.5.x participant. State the exact pin at build time from `version_information.html`. | all |
| **npm ledger client** | `@c7/ledger` | Package is **`@c7-digital/ledger`** (v2 JSON Ledger API). Companion `@c7-digital/scribe` reshapes `dpm codegen-js` output. `@daml/ledger` is the deprecated v1 client. Fallback: `openapi-fetch` + generated types. | CANTON-RWA |
| **WebSocket update stream** | `/v2/updates/flats` | `/v2/updates/flats` and `/trees` are **removed in Canton 3.5.0**. Use unified **`/v2/updates`** (HTTP POST or WS), discriminated-union responses. | CANTON-RWA |
| **DAR upload** | (unspecified) | Preferred endpoint is **`POST /v2/dars`** (not `/v2/packages`). | CANTON-RWA |
| **templateId format** | package-hash `#pkgid:...` | package-hash format **removed in Splice 0.6.0+**; use **package-name** `"pkg-name:Module:Template"`. | CANTON-RWA / DEX |
| **V11 equities parser** | "V11 Daml parser unconfirmed" | Confirmed: **no `parseReportDataV11` ships** in `data-streams-canton` examples (only `parseReportDataV3` + `hexToUnsignedDecimal`). Must hand-write a V11 decoder following the V3 pattern → keep equities collateral on mock/NAV path for MVP. | CHAINLINK |
| **PoR on Canton** | "likely SmartData V9 via Verifier" | Confirmed live on Canton, but **no public PoR Daml template/decoder exists**; requires bespoke Chainlink engagement. MVP: `PoRAttestation` contract + `CheckSolvency` choice; stretch = V9 `fullReport` through same `Verify`. | CHAINLINK / CANTON-RWA |
| **CRE → Canton write** | "GA adapter not verified" | Confirmed: **no native CRE→Canton write capability** (EVM-only `onReport()`). Bridge = CRE HTTP trigger → our relay → `go-daml`/JSON API submit. Keep our backend timer as primary. | CHAINLINK / DEX |
| **BTC/USD feed id** | hardcoded `0x00037da0…b439` | Prefix `0x0003` = V3 crypto ✓, but the **full 66-char BTC/USD id is NOT confirmed** from live docs. Only ETH/USD `0x000359843a…ba782` is confirmed. Action: verify the exact id from `docs.chain.link/data-streams/stream-ids` at build, never assume. | CHAINLINK |
| **dpm install** | (unspecified) | `curl https://get.digitalasset.com/install/install.sh \| sh`; `dpm build` (NOT `daml build`); `dpm codegen-js <dar> -o <dir> -s <scope>`. | CANTON-RWA |

---

## File 1 — `DEX.md` (trading engine + margin trading)

**Goal:** every formula, every inequality, every choice signature, every edge case for the
perp + margin mechanics, with worked numeric examples. No oracle/Canton-infra detail (cross-ref).

Sections:
1. **Variable glossary** — S, P_e, P_m, P_i, L, N, IM/IMR, MM/MMR, F, T_f, E (equity),
   sideSign (+1 long / −1 short). Decimal precision policy (prices 8dp, qty 6dp, round against trader).
2. **Mark vs index price** — index = oracle aggregate; mark = `Median(P1,P2,P3)` with deviation
   clamp (P1 = funding-extrapolated, P2 = index+MA(basis), P3 = median of bid/ask/last). For MVP
   demo, `P_m ≈ P_i` from the single Chainlink V3 benchmark price; document the production formula too.
3. **Open / matching** — `Notional = S·P_e`, `IM_required = S·P_e·IMR = S·P_e/L`, leverage cap
   `L_max = 1/IMR_min`. P2P matching: MVP controls one long + one short → `MatchedPair`. Initial
   margin check at open against `CollateralValue` (see §6).
4. **Unrealized PnL** — `UPnL = (P_m − P_e)·S·sideSign`; worked both directions.
5. **Funding** — production formula (impact-price premium index → TWAP → IR clamp, Binance/dYdX/HL
   variants) AND the **simplified demo formula** to actually ship:
   `F = clamp(0.3·(P_m−P_i)/P_i + 0.0001, −0.0075, +0.0075)`,
   `FundingPayment = F·S·P_i` (use **index** not mark to avoid circular dependency), direction rule
   (F>0 ⇒ longs pay shorts), interval = 1h for demo. Cumulative `accruedFunding` tracking.
6. **Margin & collateral valuation** — isolated margin (per-position, justified vs cross),
   `CollateralValue = collateralQty · P_rwa · haircut` (haircut 0.70–0.90 by asset class; rationale:
   slippage, oracle lag, redemption spread, correlation). `Equity = CollateralValue + UPnL − accruedFundingOwed`.
7. **Liquidation** — exact condition `Equity < MM` ⇔ `MarginRatio = Equity/(S·P_m) < MMR`; derived
   liquidation price (long & short closed forms), bankruptcy price, liquidation penalty split
   (liquidator fee + insurance fund), bad-debt / ADL waterfall. `IMR = 2·MMR` convention. Daml:
   `Liquidate` choice verifies price → ASSERTs breach (healthy position rejected — show the failing
   `submitMustFail` test) → seizes RWA. Liquidation level is never an observable field.
8. **Close / settle** — `RealizedPnL = (P_x−P_e)·S·sideSign`,
   `NetProfit = RealizedPnL + accruedFunding − fees`; DvP settlement in USDCx via the Allocation
   workflow (cross-ref CANTON-RWA §Allocation): profit → USDCx transfer + unlock RWA; loss → sell
   RWA fraction at oracle price to cover, return remainder. Atomic single Daml transaction.
9. **Three fully-worked numeric examples** — (A) long open→fund×3→close profit; (B) short
   open→mark up→near-liq→close loss with funding offset; (C) long with RWA collateral price crash →
   liquidation (the correlation-risk worst case). All with real numbers, including NAV yield drift.
10. **Edge cases & robustness** — stale price (T_stale = 5min mark / 25h NAV → halt vs escalate
    haircut), negative equity/bad debt waterfall, funding-at-liquidation ordering (SettleFunding
    before Liquidate), OI imbalance backstop, rounding policy, RWA-vs-underlying correlation cap,
    oracle disagreement (use conservative min/max).
11. **Daml template/choice map for the engine** — `Market`, `PerpPosition`, `MatchedPair`,
    `InsuranceFund`, `FundingState`; signatory/observer/controller per the privacy convention
    (signatories = traders+venue, observer = Regulator, no other trader is ever a stakeholder);
    each custom choice's exact arg list + controller. Cross-ref CANTON-RWA for Holding/Allocation.

## File 2 — `CHAINLINK.md` (oracle layer)

**Goal:** every API call, header, websocket frame, report field, and Daml choice for prices + PoR.

Sections:
1. **Data Streams REST** — base URLs (`https://api.testnet-dataengine.chain.link`, mainnet
   `api.dataengine.chain.link`); endpoints `/api/v1/reports/latest?feedID=`, `/api/v1/reports?feedID=&timestamp=`,
   `/api/v1/reports/bulk?feedIDs=&timestamp=`, `/api/v1/reports/page`; response JSON (`report`:
   `feedID`, `validFromTimestamp`, `observationsTimestamp`, `fullReport`); status codes (200/206/400/401/500).
2. **HMAC auth** — three headers (`Authorization` = API key UUID, `X-Authorization-Timestamp` = ms,
   `X-Authorization-Signature-SHA256` = hex HMAC-SHA256); exact string-to-sign
   `METHOD PATH BODY_HASH API_KEY TIMESTAMP` (empty-body SHA-256 constant given); Go + TS snippet;
   ±5s clock-skew rule; hex not base64.
3. **WebSocket** — `wss://ws.testnet-dataengine.chain.link/api/v1/ws?feedIDs=…`; same HMAC headers on
   upgrade; HA mode (`WsHA`, dedup, reconnect); streamed frame carries only `feedID`+`fullReport`
   (timestamps must be decoded from the blob); ping/pong keepalive.
4. **Report schemas field-by-field** — **V3 crypto** (feedId, validFrom/observations ts, nativeFee,
   linkFee, expiresAt, price, bid, ask — 8 *or* 18 decimals, confirm per stream; ETH/USD = 18dp);
   **V11 24/5 equities** (mid, lastSeenTimestampNs, bid/ask + volumes, lastTradedPrice, marketStatus
   0–5) — note **no Daml decoder ships**; **V9 SmartData/PoR** (navPerShare, navDate ms, aum, ripcord);
   schema version = first 2 bytes of decoded report (and of feedID: `0x0003`=V3).
5. **Feed IDs** — ETH/USD confirmed id; BTC/USD **must be re-verified** (only prefix known); equities
   V11 prefix unconfirmed (likely `0x000b`, do not assume).
6. **On-Canton verification (Daml)** — repo `smartcontractkit/data-streams-canton` @ `v1.0.0`
   (2026-02-20), **build SDK 3.4.9**, Java ≥17. Vendor DARs in dependency order: `common-1.0.0.dar`,
   `domain-1.0.0.dar`, `verifier-config-1.0.0.dar`, `verifier-1.0.0.dar`. `Verifier` template
   (`owner`, `observers`) — we create our own. `Verify` choice: args `configCid : ContractId
   VerifierConfig`, `signedReportBytes : BytesHex` (= `fullReport` unmodified), `sender : Party`;
   returns `BytesHex` reportData → `parseReportDataV3` (+ `hexToUnsignedDecimal`, two's-complement
   handling). **VerifierConfig CID rotates** on key rotation — always query the active one, never
   hardcode. Fee fields are inert on Canton (no payment).
7. **`PriceOracle` interface abstraction** — one Daml interface satisfied by `MockOraclePrice` (MVP,
   day-1 path) and the Chainlink-verified wrapper; staleness check on both paths; swap is one impl.
8. **Proof of Reserve** — no public Canton template; MVP `PoRAttestation` + `CheckSolvency`
   (`reserves >= issuedSupply` AND age ≤ 25h); stretch = V9 `fullReport` via same `Verify`. (Gating
   logic itself lives in CANTON-RWA; this section covers the oracle/report side.)
9. **CRE** — no native Canton write; bridge pattern (CRE HTTP/cron trigger → our relay →
   `go-daml`/JSON API submit). Primary remains our backend timer.
10. **Access & onboarding** — `chain.link/contact?ref_id=datastreams` for API key + user secret
    (`API_KEY`/`USER_SECRET`), unknown lead time → request immediately; separately give Canton Party
    ID (`party::namespace`) to get the `VerifierConfig` observer grant.
11. **Confidence table** — confirmed vs unconfirmed (BTC id, V11 decoder, PoR template, VerifierConfig
    internal fields, lead times) carried verbatim so the team knows what to validate.

## File 3 — `CANTON-RWA.md` (infra + token standard + RWA + yield + PoR gating)

**Goal:** every JSON Ledger API endpoint/shape, privacy semantics, Token-Standard interface
signature, RWA/yield design, PoR gate, PQS query, tooling, and Seaport deploy step.

Sections:
1. **JSON Ledger API v2** — base `http://localhost:7575/v2/`; `POST /v2/commands/submit-and-wait`
   (Create/Exercise command JSON shapes, `actAs`/`readAs` as **body fields** not JWT claims),
   `POST /v2/state/active-contracts` (+ `GET /v2/state/ledger-end` for `activeAtOffset`),
   `POST /v2/parties`, `POST /v2/dars`, `/v2/updates` (HTTP + WS, discriminated union). JWT auth
   (none local; Keycloak bearer for secured/DevNet). OpenAPI/AsyncAPI doc endpoints.
2. **Privacy model** — signatory/observer/controller/stakeholder/informee definitions; projection
   algorithm; the verbatim guarantee that non-stakeholders "do not learn that the transaction
   happened"; ACS exclusion enforced at participant level; divulgence caveat; explicit-disclosure
   opt-in. `daml-script` privacy assertion test (outsider `query`/`queryContractId` returns empty/None).
3. **Splice Token Standard (CIP-0056, `-v1` @ 1.0.0)** — vendor `splice-api-token-holding-v1`,
   `-allocation-v1`, `-metadata-v1` (built w/ SDK 3.4.11) under `dars/vendored/`. **Holding** interface
   `Splice.Api.Token.HoldingV1` — `HoldingView{owner, instrumentId{admin,id}, amount, lock?, meta}`,
   **NO choices** (lock is a read-only view field). **Allocation** interface
   `Splice.Api.Token.AllocationV1` — `SettlementInfo{executor, settlementRef, requestedAt,
   allocateBefore, settleBefore, meta}`, `TransferLeg{sender, receiver, amount, instrumentId, meta}`,
   `AllocationSpecification`, `AllocationView{allocation, holdingCids, meta}`; choices
   `Allocation_ExecuteTransfer` (controller executor), `Allocation_Withdraw` (sender),
   `Allocation_Cancel` (sender+receiver+executor); `AllocationFactory_Allocate` (registry-supplied
   `factoryId` + `disclosedContracts` + `choiceContextData`). **Locking collateral = the Allocation
   pattern** (since Holding has no lock choice): allocate RWA holding to venue with deadlines; back
   out via Withdraw; settle via ExecuteTransfer. **Atomic DvP** = multiple legs sharing one
   `settlementRef`, all `Allocation_ExecuteTransfer` in one `submit-and-wait` batch (all-or-nothing).
4. **RWA tokenization** — fund-wrapper claim model (Securitize/Ondo/Backed/BUIDL landscape); on-Canton
   representation as a Token-Standard Holding with a permissioned `instrumentId.admin`.
5. **Yield = price-appreciation NAV (chosen)** — token balance constant; `RWAOracleFeed.navPerUnit`
   rises (`P_rwa(t) ≈ P_rwa(0)·(1+y)^(t/365)`); `CollateralValue(t) = qty · navPerUnit(t) · haircut`
   grows automatically each margin check; no rebase listener, no distribution routing; full yield
   returned at close with the unlocked Holding. Daml `RWAOracleFeed` template + `UpdateNAV` choice;
   daily heartbeat + intraday interpolation; worked yield-drift numbers. Explicitly contrast
   rejected rebasing/distribution models and why they're harder in Daml.
6. **Proof-of-Reserve gating** — at `OpenPosition`: `exercise porFeed CheckSolvency` asserting
   `reserveAmt ≥ issuedSupply` AND `now − lastAttestedAt ≤ 25h` AND NAV freshness ≤ 60min; on fail,
   reject open / set collateral factor 0. Cross-ref CHAINLINK §8 for the report source.
7. **PQS** — scribe.jar pipeline (`--source-ledger-port=6865`, postgres target,
   `--pipeline-filter-contracts`); SQL surface (`active()`, `creates()`, `archives()`, `exercises()`,
   `lookup_contract()`, `summary_active()`), JSONB payload columns, example query for open positions;
   backend connects to Postgres directly.
8. **Tooling/versions** — `dpm` install + commands (`build`, `codegen-js`, `sandbox`, `script`,
   `pqs`); `daml.yaml` shape with `data-dependencies` vendoring; multi-package layout (contracts +
   tests); `@c7-digital/ledger` (+ `@c7-digital/scribe`) vs deprecated `@daml/ledger`;
   `openapi-fetch` fallback with a worked Exercise command.
9. **Seaport deploy** — 9 steps: Loop DevNet wallet (`devnet.cantonloop.com`, copy Party ID) → admin
   invites by Party ID → `app.devnet.seaport.to` → Teams → confirm `5n sandbox` validator → New Blank
   Project → Build Project → Deploy DAR to `5n sandbox` → Contract Factory create/exercise → Contracts
   audit tab for judges. What it abstracts (no node/VPN/PQS). DevNet version-drift note.
10. **Confidence table** — `3.5.3` unconfirmed (use snapshot pin), `@c7-digital/ledger` API surface
    not fully verified, `AllocationFactory_Allocate` extra args registry-specific, cn-quickstart pins.

---

## Cross-cutting conventions (all three docs)

- **Top of each doc:** one-line status + "verified 2026-06-13" + a pointer back to PLAN.md as overview,
  and forward/back cross-references between the three docs (DEX↔CHAINLINK for price, DEX↔CANTON-RWA for
  Allocation/collateral, CHAINLINK↔CANTON-RWA for PoR).
- **Honesty:** every doc ends with a confidence/gaps table separating *confirmed-from-live-source* vs
  *unconfirmed/assumed*, so nothing reads as more certain than it is.
- **Code blocks:** Daml signatures, JSON request/response bodies, curl/HMAC snippets, SQL — concrete and
  copy-pasteable, not pseudo.
- **Privacy convention restated where relevant:** signatories = {trader(s), venue}, observer =
  {Regulator}, no other trader is ever a stakeholder.

## Files created
- `ethny26/DEX.md` (new)
- `ethny26/CHAINLINK.md` (new)
- `ethny26/CANTON-RWA.md` (new)
- `ethny26/PLAN.md` — light edit: add a "Document map" pointer to the three new files and apply the
  version/package corrections inline so the overview is no longer contradicted by the deep dives.

## Verification

These are documentation deliverables, so verification is correctness/consistency-oriented:
1. **Internal consistency:** grep the three docs + PLAN.md for version strings (`3.5.3`, `3.4.11`,
   `3.4.9`, `0.6.5`), package names (`@c7-digital/ledger`, `splice-api-token-*-v1`), and feed ids —
   confirm no doc contradicts another and all corrections from the table above are applied uniformly.
2. **No-confusion check:** each major flow (open, fund, mark, liquidate, close/settle, verify-price,
   PoR-gate) has, end-to-end, the exact endpoint/choice/args needed to implement it with no "TODO/figure
   out later" gaps — except items explicitly listed in a confidence/gaps table.
3. **Cross-reference integrity:** every "see X.md §Y" pointer resolves to a real section.
4. **Spot-re-verify the two riskiest facts** before building: the exact BTC/USD feed id (or switch the
   MVP to the confirmed ETH/USD id) and the live DevNet Splice/Canton version pin from
   `version_information.html`.
