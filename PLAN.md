# PLAN.md — Private Perpetual Futures DEX on Canton (ETHGlobal NYC 2026)

> Status: **PLAN ONLY** — no implementation code yet. Versions/interfaces verified against live docs on 2026-06-13; see "Verified facts & corrections" for what changed vs. the original brief.

## 1. Product summary & thesis

A **private perpetual-futures DEX** on the Canton Network. Traders take leveraged long/short positions on a continuous underlying (**BTC/USD** index for the MVP), posting a **tokenized equity/ETF** as margin collateral instead of idle cash. Cash/settlement is a **USDC-backed stablecoin** (modeled as `USDCx` for the MVP). A perp has no expiry; it is anchored to the index by a periodic **funding rate** paid between longs and shorts.

**Value props**
1. **Privacy** — positions, collateral, and PnL are visible only to the two counterparties and the venue, with a **Regulator** party as observer for audit. Other traders are *not stakeholders*, so positions are invisible to them → no liquidation hunting, no copy-trading. Even the liquidation level is never exposed.
2. **Productive collateral** — a tokenized RWA (equity/ETF) earns/holds value while serving as margin, vs. idle cash.
3. **Atomic DvP settlement** — PnL settles delivery-vs-payment in a single all-or-nothing transaction.
4. **Verifiable prices & backing** — Chainlink Data Streams (live natively on Canton) supply the index and collateral marks; Chainlink Proof of Reserve attests the RWA is backed before it is accepted.

**Why Canton.** Canton's per-contract privacy (signatory/observer/controller with sub-transaction privacy) gives us *trader-level confidentiality by construction* — non-stakeholders "do not learn that the transaction happened" (live docs, verbatim). That is the core feature a public-chain perps DEX cannot offer. Canton also gives atomic multi-party transactions and a UTXO holding model via the CIP-0056 token standard.

**Why Chainlink.** Data Streams are live *natively on Canton* — a Daml choice can verify a signed oracle report **inside the transaction** (exercise `Verify` on Chainlink's `Verifier` contract), so mark-to-market, funding, and liquidation are cryptographically anchored to real prices rather than a trusted relayer. PoR closes the "is the RWA real" gap.

## 2. System architecture

```
                         ┌──────────────────────────────────────────────┐
                         │                 FRONTEND (thin)               │
                         │  React + @c7/ledger + dpm codegen-js types    │
                         │  PARTY-VIEW SWITCHER:                         │
                         │   long │ short │ venue │ Regulator │ outsider │
                         └───────────────┬──────────────────────────────┘
                                         │ JSON Ledger API (read+write)
                                         │ + PQS SQL (read)
                         ┌───────────────▼──────────────────────────────┐
                         │             BACKEND (thin, TS/Node)           │
                         │  • submits commands (Open/Match/Fund/Mark/    │
                         │    Liquidate/Close) via JSON Ledger API       │
                         │  • reads via PQS (SQL) + /v2/state/active-... │
                         │  • TRIGGER loop: funding accrual + liquidation│
                         │    check (replaces keepers; CRE as stretch)   │
                         └───────┬───────────────────────┬───────────────┘
                                 │ Ledger API            │ fetch signed report (HTTPS+HMAC)
                                 │                        ▼
          ┌──────────────────────▼─────────┐   ┌──────────────────────────────┐
          │       CANTON PARTICIPANT        │   │  ORACLE (mock-first)         │
          │   Daml package: perp-dex        │   │  • MVP: mock OraclePrice     │
          │   ┌──────────────────────────┐  │   │    template, oracle party    │
          │   │ Market / PerpPosition /   │  │   │    posts {price, timestamp}  │
          │   │ MatchedPair / FundingTick │  │   │  • STRETCH: Chainlink        │
          │   │ Collateral (Holding) /    │◄─┼───┤    Verifier + VerifierConfig │
          │   │ Allocation (DvP) /        │  │   │    (Verify choice, V3)       │
          │   │ PriceOracle interface     │  │   │  • PoR check on accept       │
          │   └──────────────────────────┘  │   └──────────────────────────────┘
          │   Token Standard DARs (-v1):    │
          │   holding / allocation / etc.   │
          └─────────────────────────────────┘
   Local dev: `daml start` single-participant sandbox + PQS.  Demo: DAR → Seaport shared 5n sandbox (DevNet).
```

**Components**
- **Daml package `perp-dex`** — our custom templates + a `PriceOracle` interface that both the mock and the Chainlink path satisfy. Depends on the token-standard `-v1` DARs (and the Chainlink `verifier`/`verifier-config` DARs for the stretch path), vendored under `dars/` as `data-dependencies`.
- **Backend (thin, TypeScript/Node)** — command submission + reads + the off-ledger **trigger loop** (Canton has no keepers). It fetches a price, submits the funding/mark/liquidation choices on a timer.
- **Frontend (thin, React)** — primary job is **switching party views** to demonstrate privacy. Generated types via `dpm codegen-js`, ledger access via `@c7/ledger` (not the deprecated `@daml/ledger`).
- **Oracle** — mock on-ledger price contract first; real Chainlink `Verifier` as a drop-in behind the same `PriceOracle` interface.
- **Deployment** — develop locally (`daml start`, full PQS, own backend); upload the built DAR to **Seaport's shared `5n sandbox` validator** for the live DevNet demo (removes validator approval / SV sponsorship / VPN / onboarding-secret friction).

## 3. Daml data model

Stakeholder convention for everything trader-facing: **signatories = {trader(s), venue operator}**, **observer = {Regulator}**, and *no other trader is ever a stakeholder* → privacy by construction. Controllers are named per choice.

| Template | Signatory | Observer | Key choices (controller) | Notes |
|---|---|---|---|---|
| **`Market`** | venue | Regulator | `OpenPosition` (trader), `ApplyFunding` (venue) | Config: `underlying` (BTC/USD feed id), `leverageCap`, `maintenanceMarginBps`, `fundingIntervalSeconds`, `oracleRef`. Long-lived. |
| **`PerpPosition`** | trader, venue | Regulator | `Mark` (venue), `RequestClose` (trader) | `side` (Long/Short), `size`, `entryPrice`, `leverage`, `collateralRef`, `lastFundingPrice`. Other traders are **not** stakeholders → invisible. |
| **`MatchedPair`** | longTrader, shortTrader, venue | Regulator | `ApplyFunding` (venue), `Liquidate` (venue), `SettleClose` (venue) | Binds one long to one short (P2P). The unit funding/mark/liquidation/settlement act on. |
| **`CollateralLock`** (wraps Token Standard) | trader, venue | Regulator | (released via Allocation choices) | RWA holding escrowed for a position. **Locking uses the Allocation workflow**, not a Holding choice (Holding has none). |
| **`PriceOracle`** *(interface)* | — | — | `getPrice : (Decimal, Time)` | Satisfied by `MockOraclePrice` (MVP) and by a Chainlink-verified wrapper (stretch). Decouples mechanics from the price source. |
| **`MockOraclePrice`** | oracle | venue, Regulator | `UpdatePrice` (oracle) | MVP fallback: holds `streamId`, `price`, `timestamp`. |
| **`PoRAttestation`** | oracle/venue | Regulator | checked at accept-collateral time | Asserts `reserves >= issuedSupply` for the RWA before margin is accepted. |

**Token Standard usage (CIP-0056 `-v1` interfaces — use, don't hand-roll):**
- **Holding interface** `#splice-api-token-holding-v1:Splice.Api.Token.HoldingV1:Holding` — UTXO model for **both** the RWA collateral token and the `USDCx` cash token. It is **view-only (no choices)**; the view carries owner + an optional `Lock` record.
- **Allocation interface** `splice-api-token-allocation-v1` — drives (a) **locking collateral** against a position via `AllocationFactory_Allocate`, and (b) **atomic DvP settlement** of PnL on close. Settlement spec names an `executor` (the venue) + `allocateBefore`/`settleBefore` deadlines; the venue settles with `Allocation_ExecuteTransfer`; back-outs via `Allocation_Withdraw` / `Allocation_Cancel`.

**Choices we write (custom mechanics):**
- **Open / Match** — `Market.OpenPosition` creates a `PerpPosition` with collateral allocated/locked; venue pairs a long + short into a `MatchedPair` (MVP: we control both sides).
- **Funding** — `MatchedPair.ApplyFunding`: reads the oracle, computes `fundingPayment = fundingRate * notional`, transfers it long↔short, archives + recreates the pair with updated `lastFundingPrice` (immutability ⇒ churn; applied at discrete intervals on demand for the demo).
- **Mark** — `PerpPosition.Mark` / `MatchedPair`: `unrealizedPnL = (indexPrice − entryPrice) * size * side`.
- **Liquidate** — `MatchedPair.Liquidate` (controller = venue): **verify the price** (mock or Chainlink `Verify`), **ASSERT** `collateralValue + unrealizedPnL < maintenanceMargin` (so a healthy trader *cannot* be liquidated), then atomically **unlock + seize** the RWA. Liquidation level is internal — never an observable field.
- **Close / Settle** — `RequestClose` → `SettleClose`: realize PnL and settle DvP in `USDCx` via the **Allocation** workflow (`Allocation_ExecuteTransfer`).

## 4. Chainlink integration plan

**Mechanism (verified, `data-streams-canton` v1.0.0, tag `v1.0.0`, 2026-02-20):**
- Two Daml templates: **`VerifierConfig`** (Chainlink-owned; holds oracle public keys + fault param `f`, threshold `f+1`; **our party is granted observer access**) and **`Verifier`** (we exercise the **`Verify`** choice on it).
- `Verify` signature: `exerciseCmd verifierCid Verify with configCid = <latest VerifierConfig cid>; signedReportBytes = <hex signed report from DS API>; sender = <our party>` → returns hex `reportData`, parsed with **`parseReportDataV3`** (crypto/V3 schema — confirmed for BTC/USD).
- VerifierConfig CID **rotates** on oracle-key rotation — look up the latest CID before each verify; never hardcode.
- DARs to vendor: `verifier-1.0.0.dar`, `verifier-config-1.0.0.dar`, `common-1.0.0.dar`, `domain-1.0.0.dar`.

**Feeds (BTC/USD, verified):** stream id `0x00037da06d56d083fe599397a4769a042d63aa73dc4ef57709d31e9971a5b439`, V3 schema. (ETH/USD `0x000359843a…ba782` is the alternate.) Collateral equity valuation would use a **24/5 equities V11** stream — kept behind the same interface; **risk:** V11 Daml parser unconfirmed in v1.0.0 and hex equity ids arrive only on onboarding → for the MVP, value collateral via the mock path or a crypto proxy and treat real equity streams as a stretch.

**Access:** Data Streams needs an **API key + user secret (HMAC auth)** obtained by **contacting Chainlink** (testnet `api.testnet-dataengine.chain.link`), *plus* an on-ledger **observer grant on `VerifierConfig`**. Both have lead time → request immediately.

**Proof of Reserve:** PoR is a push reference feed; per the "Chainlink live on Canton" announcement, SmartData/PoR are live on Canton, **likely delivered as a signed report (SmartData V9) verified through the same `Verifier`**. Exact PoR-on-Canton template is the least-documented item — **confirm with Chainlink**; MVP uses a `PoRAttestation` contract (mock value) asserting `reserves >= issuedSupply` at accept-collateral time, swappable to the verified path.

**CRE trigger:** Chainlink CRE (Workflow DON, cron/event triggers) is the intended off-ledger replacement for keepers, but a **GA CRE→Canton Ledger-API write adapter was not verified**. MVP uses **our own backend timer** to fire funding/liquidation; a CRE scheduled workflow that calls the same submission endpoint is the stretch.

**Mock fallback (primary path day 1):** `MockOraclePrice` template, an `oracle` party posts `{streamId, price, timestamp}` on-ledger; all mechanics read the abstract `PriceOracle.getPrice`. Swapping mock→real is localized to one interface implementation. Keep the **staleness check** in both paths.

## 5. Deployment plan (DevNet via Seaport)

**Pin these (corrected from the brief):**
- **Daml SDK / Canton: 3.5.3** (newest 3.5.x; 3.5.1 is stale). Build CLI = **`dpm`**.
- **Splice: 0.6.x** (0.6.5 latest published; **DevNet ran 0.6.7** — confirm the live DevNet number at build time). Splice 0.6.1+ bundles Canton 3.5.
- **Token Standard: the `splice-api-token-*-v1` packages at `version 1.0.0`** — there is **no "1.3.1"**. Vendor exact DAR filenames from the splice-node 0.6.x bundle.
- **PQS: 3.5.x** (tracks Canton major.minor; exact point release unconfirmed).

**`daml.yaml` shape:** `sdk-version: 3.5.3`; token-standard + Chainlink DARs under **`data-dependencies`** (no package registry → vendor `.dar`s in `dars/`); `daml-script` for tests in a **separate package**.

**Local dev loop:** `dpm build` → `.daml/dist/perp-dex-1.0.0.dar`; `daml start` (in-memory single-participant sandbox, uploads DAR, runs init script) for the inner loop; allocate long/short/venue/Regulator/outsider parties on the one participant; run PQS + backend against it.

**Seaport demo deploy (shared sandbox — no infra):** create a **Loop DevNet wallet** (`devnet.cantonloop.com`, copy Party ID) → log into Seaport (`app.devnet.seaport.to`) → join the hackathon org (admin invites by Party ID) → **Build Project** → **Deploy** the DAR to the pre-configured shared **`5n sandbox`** validator → instantiate via Contract Factory → the Contracts tab gives a create/exercise/archive **audit trail** for judges. Frontend: `dpm codegen-js .daml/dist/perp-dex-1.0.0.dar -o src/generated` + `npm i @c7/ledger`. *(Optional: wire the Build-on-Canton MCP as a version/doc sanity copilot — `canton_check`/`canton_lookup`; it does not deploy.)*

## 6. Milestone build plan (weekend)

**Fri eve — Setup & scaffold (3–4h)**
- Request Chainlink Data Streams access + VerifierConfig observer grant **now** (lead time). Init repo, `daml.yaml` (SDK 3.5.3), vendor token-standard `-v1` DARs, `daml start` runs. Allocate the 5 demo parties.

**Sat AM — Core templates + mock oracle (4–5h)**
- `Market`, `PerpPosition`, `MatchedPair`, `PriceOracle` interface, `MockOraclePrice`. `OpenPosition` + collateral lock via Allocation. Daml Script: open one long + one short, match into a pair. **Privacy assertion test**: an `outsider` party's ACS does not contain the position.

**Sat PM — Mechanics (4–5h)**
- `ApplyFunding`, `Mark`, `Liquidate` (verify price → assert breach → seize RWA), `RequestClose` + `SettleClose` (Allocation DvP in USDCx). Script-drive a full lifecycle: open → fund once → mark → **liquidate** (path A) and a parallel pair → **close+settle** (path B).

**Sat night — Backend + trigger (3–4h)**
- Thin TS backend: PQS reads, `/v2/state/active-contracts` reads, command submission, and the **funding/liquidation trigger loop** (timer). `PoRAttestation` check on accept-collateral.

**Sun AM — Frontend party-switcher (3–4h)**
- React app with the 5 party views; show that long/short/venue/Regulator see the position+PnL and the **outsider sees only price**. Wire to backend.

**Sun midday — Chainlink stretch + Seaport deploy (2–3h)**
- If access landed: swap `MockOraclePrice` → real `Verifier`/`Verify` (BTC/USD, V3) behind the interface. Deploy DAR to Seaport `5n sandbox`. Buffer for breakage.

**Sun PM — Demo polish & dry-run (2h)**
- Rehearse the party-switch script; pre-seed contracts; record a backup video.

## 7. Demo script (party-perspective switch)

1. **Venue** opens the `Market` (BTC/USD), shows parameters.
2. **Trader-long** and **trader-short** each open a position posting tokenized-equity collateral (PoR check passes); venue matches them into a `MatchedPair`.
3. **Outsider** view: refresh — *sees only the price feed, no positions exist for them.* ← privacy money-shot.
4. **Regulator** view: sees **both** positions, collateral, and live PnL (observer) — audit without participation.
5. Push the BTC price (mock/Chainlink). **Venue** runs **ApplyFunding** once → funding flows long↔short.
6. **Path A — Liquidation:** price moves against the short past maintenance margin → venue exercises **Liquidate**; it **verifies the price, asserts the breach** (show that a healthy position is rejected), and **seizes the RWA**. Note: the liquidation level was never visible to anyone but the counterparties + venue.
7. **Path B — Close & settle:** the favorable side exercises **RequestClose** → venue **SettleClose** realizes PnL via **Allocation DvP** in USDCx — atomic delivery-vs-payment.
8. Back to **Outsider**: still sees nothing but price. Close.

## 8. Open questions, risks, honest gaps

**Verified facts & corrections (vs. the brief)**
- ❌ "Token Standard 1.3.1" — does not exist; it's `splice-api-token-*-v1` @ `1.0.0`.
- ❌ "Daml SDK 3.5.1 / splice 0.6.4" — newer exist (3.5.3 / 0.6.5; DevNet 0.6.7). Build CLI is `dpm`.
- ❌ Holding `lock/unlock`/`split/merge` choices — Holding has **no choices**; locking is via the **Allocation** workflow.
- ✅ Privacy model, regulator-as-observer, sub-transaction privacy — confirmed verbatim in live docs.
- ✅ Chainlink `Verifier`/`VerifierConfig` + `Verify` choice + V3 BTC/USD feed + v1.0.0 release — confirmed.

**Risks & gaps**
1. **Chainlink access lead time** — API key + secret *and* on-ledger VerifierConfig observer grant both require contacting Chainlink. *Mitigation:* mock-first behind `PriceOracle`; request access Friday.
2. **V11 equities parser / PoR-on-Canton path / CRE→Canton write** — three items the docs do **not** fully confirm. *Mitigation:* MVP uses crypto V3 for marks, a mock `PoRAttestation`, and our own backend timer; treat all three as stretch and confirm with Chainlink.
3. **No keepers** — funding/liquidation are externally triggered; for the demo, applied at discrete intervals on demand by the backend.
4. **Immutable contracts / churn** — every funding tick/mark archives + recreates the position; fine at demo cadence, would need batching at scale.
5. **P2P liquidity cold-start** — MVP controls both sides (one long, one short); no order book / matching engine.
6. **Seaport vs. PQS/backend** — Seaport's web IDE abstracts away PQS and a custom backend. *Resolved:* develop locally with full PQS + backend, deploy only the DAR to Seaport for the live demo.
7. **DevNet version drift** — confirm the *live* DevNet Splice/SDK numbers at build time (the official `cn-quickstart` `main` still pins older 3.4.11/0.5.3; use a 3.5-targeted branch or bump pins).

**Key references:** docs.canton.network (`/llms.txt`, token-standard, privacy-model, JSON API, PQS, cross-sync DvP) · github.com/hyperledger-labs/splice/tree/main/token-standard · docs.chain.link/data-streams/canton-integration · github.com/smartcontractkit/data-streams-canton (v1.0.0) · github.com/Jatinp26/Seaport-Guide · github.com/Jatinp26/Build-on-Canton-MCP.
