# CANTON-RWA.md — Canton/Daml Infra, Token Standard, RWA Collateral & Yield

> Deep-dive #3 of 3. Overview: [PLAN.md](./PLAN.md). Siblings: [DEX.md](./DEX.md) (engine that consumes collateral), [CHAINLINK.md](./CHAINLINK.md) (price/PoR report source).
> Status: implementation-grade — every JSON Ledger API endpoint/shape, privacy semantic, Token-Standard interface signature, RWA/yield design, PoR gate, PQS query, tooling command, and Seaport step. Verified 2026-06-13. Unconfirmed items flagged ⚠️ in §10.

This document owns: the Canton participant + JSON Ledger API, the privacy model, the Splice Token Standard (Holding/Allocation — how collateral is locked and how DvP settles), RWA tokenization, the **price-appreciation NAV yield** design, PoR gating at open, PQS reads, tooling/versions, and Seaport deploy.

---

## 0. Version pins (READ FIRST — corrects PLAN.md)

| Component | Pin | Note |
|---|---|---|
| Our Daml package build | **SDK 3.4.11** | Matches Splice token-standard DARs; compatible with Canton 3.5.x participant. Chainlink package itself builds on 3.4.9 (→ CHAINLINK.md §6). |
| Canton participant | **3.5.x** | Inside Splice 0.6.5 = a `3.5.1-snapshot` build. ⚠️ **"3.5.3" is unconfirmed** — read the exact number from `version_information.html` at build time. |
| Splice | **0.6.5** (min for Protocol 35) | DevNet upgrade to Protocol 35 = complete. Confirm live DevNet number at build. |
| Token Standard | `splice-api-token-*-v1` @ **1.0.0** | There is no "1.3.1". |
| PQS (scribe) | **3.5.x** | Tracks Canton major.minor. |
| Build CLI | **`dpm`** | `daml build` is removed in 3.5. |
| Ledger client | **`@c7-digital/ledger`** | Not `@c7/ledger`; `@daml/ledger` is the deprecated v1 client. |

---

## 1. JSON Ledger API v2

Base (local sandbox): `http://localhost:7575/v2/`. OpenAPI at `GET /docs/openapi`, AsyncAPI (WS) at `GET /docs/asyncapi`.

| Purpose | Method | Path |
|---|---|---|
| Submit command (sync) | POST | `/v2/commands/submit-and-wait` |
| …returning the txn | POST | `/v2/commands/submit-and-wait-for-transaction` |
| Async submit | POST | `/v2/commands/async/submit` |
| Active contract set | POST | `/v2/state/active-contracts` |
| Ledger end (offset) | GET | `/v2/state/ledger-end` |
| Updates (HTTP + **WS**) | POST | `/v2/updates` *(`/updates/flats` & `/trees` removed in 3.5 — do not use)* |
| Allocate party | POST | `/v2/parties` |
| Upload DAR | POST | `/v2/dars` *(preferred; `/v2/packages` deprecated)* |
| List packages | GET | `/v2/packages` |
| Version | GET | `/v2/version` |

**Submit (create) shape:**
```json
{ "commands": [ { "CreateCommand": {
      "templateId": "perp-dex:PerpDex.Market:Market",
      "createArguments": { "venue": "Venue::122…", "underlying": "ETH/USD", "maintenanceMarginBps": 500 } } } ],
  "userId": "venue", "commandId": "open-mkt-1",
  "actAs": ["Venue::122…"], "readAs": [], "submissionId": "s-1" }
```
→ `{ "updateId": "...", "completionOffset": 12345 }`.

**Exercise shape:** `{ "ExerciseCommand": { "contractId":"00ab…", "templateId":"…", "choice":"Allocation_ExecuteTransfer", "choiceArgument": { "extraArgs": {} } } }`.

**Active contracts:** first `GET /v2/state/ledger-end` for `activeAtOffset`, then `POST /v2/state/active-contracts` with `{ "activeAtOffset": N, "eventFormat": { "filtersForAnyParty": { "cumulative":[{ "identifierFilter": { "WildcardFilter": { "value": { "includeCreatedEventBlob": false } } } }] }, "verbose": false } }`.

**`templateId` format:** package-**name** `"pkg-name:Module:Template"` (package-hash `#…` format removed in Splice 0.6.0+).

**WS `/v2/updates`:** subscribe `{ "beginExclusive": N, "updateFormat": { "includeTransactions": { "eventFormat": {…} } } }`; responses are a discriminated union `Transaction | Reassignment | TopologyTransaction | OffsetCheckpoint`.

**Auth:** local sandbox = none. Secured/DevNet = `Authorization: Bearer <JWT>` (Keycloak OIDC; RS256/ES256/JWKS). **`actAs`/`readAs` are command-body fields, not JWT claims** (changed from v1).

---

## 2. Privacy model

- **Signatory** authorizes + is bound, full visibility. **Observer** sees full payload (even post-archive), not bound. **Controller** may exercise a choice (need not be a stakeholder). **Stakeholder** = signatory ∪ observer. **Informee** = party that sees a given action (stakeholder of created contract / actor / named choice-observer / key maintainer).
- **Sub-transaction privacy (projection):** each party sees only the sub-transaction of actions on contracts where it is an informee; other actions are dropped. The formal guarantee: parties who are not stakeholders **"do not learn that the transaction happened."**
- **ACS exclusion** is enforced at the participant node: an outsider's `/v2/state/active-contracts` simply does **not contain** a position they're not a stakeholder of — they cannot even tell it exists. This is the privacy money-shot (→ PLAN.md demo).
- **Caveat — divulgence:** if a choice `fetch`es a non-stakeholder's contract, that content is divulged through the transaction tree permanently. Avoid divulging position internals to non-stakeholders. **Explicit disclosure** is the opt-in way to share a contract off-ledger; never accidental.

**Privacy assertion test (`daml-script`) — ship this:**
```daml
test_outsider_blind = do
  [long, short, venue, reg, outsider] <- mapA allocateParty ["L","S","V","R","O"]
  -- venue+traders open a MatchedPair (signatories L,S,V; observer R)
  pair <- ...
  outsiders <- query @MatchedPair outsider
  assert (null outsiders)                       -- outsider's ACS is empty
  byId <- queryContractId @MatchedPair outsider pair
  assert (byId == None)                         -- cannot fetch by CID either
  -- Regulator (observer) DOES see it:
  regSees <- query @MatchedPair reg
  assert (not (null regSees))
```

---

## 3. Splice Token Standard (CIP-0056, `-v1` @ 1.0.0)

**Vendor** (under `dars/vendored/`, as `data-dependencies`; built w/ SDK 3.4.11):
`splice-api-token-holding-v1-1.0.0.dar`, `splice-api-token-allocation-v1-1.0.0.dar`, `splice-api-token-metadata-v1-1.0.0.dar`.

### Holding — `Splice.Api.Token.HoldingV1`  (UTXO; **NO choices**)
```daml
data HoldingView = HoldingView with
  owner : Party
  instrumentId : InstrumentId        -- {admin : Party, id : Text}
  amount : Decimal
  lock : Optional Lock               -- read-only view of any lock; no lock CHOICE exists
  meta : Metadata
data Lock = Lock with holders:[Party]; expiresAt:Optional Time; expiresAfter:Optional RelTime; context:Optional Text
```
Used for **both** the RWA collateral token and `USDCx`. Locking is **not** a Holding choice — it is done via the Allocation pattern (below).

### Allocation — `Splice.Api.Token.AllocationV1`
```daml
data SettlementInfo = SettlementInfo with
  executor : Party                   -- the venue (settles)
  settlementRef : Reference          -- links all legs of one settlement
  requestedAt : Time
  allocateBefore : Time              -- sender must allocate by this
  settleBefore : Time                -- settlement must execute by this
  meta : Metadata
data TransferLeg = TransferLeg with sender:Party; receiver:Party; amount:Decimal; instrumentId:InstrumentId; meta:Metadata
data AllocationSpecification = AllocationSpecification with settlement:SettlementInfo; transferLegId:Text; transferLeg:TransferLeg
data AllocationView = AllocationView with allocation:AllocationSpecification; holdingCids:[ContractId Holding]; meta:Metadata

interface Allocation where
  viewtype AllocationView
  choice Allocation_ExecuteTransfer : Allocation_ExecuteTransferResult with extraArgs:ExtraArgs   -- controller executor
  choice Allocation_Withdraw        : Allocation_WithdrawResult        with extraArgs:ExtraArgs   -- controller sender
  choice Allocation_Cancel          : Allocation_CancelResult          with extraArgs:ExtraArgs   -- sender+receiver+executor
```
`AllocationFactory_Allocate` (registry-supplied `factoryId : ContractId AllocationFactory` + `disclosedContracts` + `choiceContextData`) creates the `Allocation`, consuming the input `Holding`s into `holdingCids`. ⚠️ Exact extra args beyond `AllocationSpecification` are registry-specific.

### Locking collateral = the Allocation pattern (since Holding has no lock)
1. Trader `AllocationFactory_Allocate`: `executor=venue`, `sender=trader`, `receiver=venue` (escrow agent, **not** an LP/AMM pool), `amount=collateral`, deadlines `allocateBefore`/`settleBefore`. Input RWA `Holding`s are archived into the `Allocation` (= escrow). The trader's `Order` (→ DEX.md §3) references this allocation; the collateral is *escrowed*, never pooled.
2. Back out before `allocateBefore`: `Allocation_Withdraw` (sender).
3. **Settle (close/liquidate):** `Allocation_ExecuteTransfer` (executor=venue) → atomically moves holdings to receiver; returns change to sender.
4. `Allocation_Cancel` needs all three parties.

### Atomic DvP (peer-to-peer close/settle, → DEX.md §8)
Settlement is **directly between the two matched traders** (zero-sum long↔short), with the venue as executor — no pool is ever a counterparty. Both legs (the loser's collateral leg + the USDCx PnL leg) share one `settlementRef`; the venue exercises all `Allocation_ExecuteTransfer` in **one** `submit-and-wait` batch → Canton guarantees all-or-nothing.

---

## 4. RWA tokenization

Tokenized equities/ETFs/T-bills today (Securitize, Ondo/OUSG, Backed bTokens, BlackRock BUIDL, Franklin BENJI) are **fund-wrapper claims** — the token is a claim on a regulated fund unit, not the raw share, with transfer restricted to permissioned parties. On Canton we model the RWA as a Token-Standard **Holding** whose `instrumentId.admin` is the (permissioned) issuer/registry party. `USDCx` is modeled the same way.

---

## 5. Yield = price-appreciation NAV (chosen design)

Token **balance is constant** while escrowed; the **oracle NAV rises**:
```
P_rwa(t) ≈ P_rwa(0) · (1 + y)^(t/365)            # y = annual yield
CollateralValue(t) = collateralQty · P_rwa(t)    # full oracle value, NO haircut; grows automatically
```
Because the DEX reads `P_rwa` at every margin check (→ DEX.md §6), the trader earns yield on locked collateral with **no rebase listener, no distribution routing, no token-balance change**. Full appreciated value is returned with the unlocked Holding at close.

**This is exactly what makes "no haircut" safe (→ DEX.md §6):** the collateral is a *stable, monotonically-accruing* NAV token (T-bill / money-market style) with near-zero downside vs. USDCx, so valuing it at full oracle price (collateral factor = 1.0) is justified. The whitelist must only admit such assets — a volatile/correlated token would reintroduce the bad-debt risk in DEX.md §9 Example C.

```daml
template RWAOracleFeed with
    asset : Text; navPerUnit : Decimal; timestamp : Time; operator : Party
  where
    signatory operator
    observer  ...                                  -- venue, Regulator
    choice UpdateNAV : ContractId RWAOracleFeed with newNav:Decimal; newTs:Time
      controller operator
      do create this with navPerUnit = newNav; timestamp = newTs
```
Daily NAV heartbeat + intraday interpolation; staleness guard `now − timestamp ≤ 25h` (→ DEX.md §10.1).

**Rejected alternatives:** *rebasing* (BUIDL-style balance growth) needs the escrow recognized as a holder + an external balance-change listener; *distribution* (BENJI-style USDCx dividends) needs a `ClaimYield` choice + custody routing. Both add Daml complexity for no demo benefit. Price-appreciation is the wstETH/OUSG-proven, immutable-contract-friendly choice.

---

## 6. Proof-of-Reserve gating + stable-collateral whitelist (replace the haircut)

Because we charge **no haircut** (§5, → DEX.md §6), the collateral-risk controls are instead **(a) a stable-collateral whitelist** — only a low-volatility, yield-bearing NAV token may be posted as margin — **and (b) the PoR gate** below, which proves that token is actually backed before it's accepted. Together they replace what a haircut would otherwise buffer.

Before accepting RWA as margin, `Market.PlaceOrder` calls (→ CHAINLINK.md §8 for the report source):
```daml
nonconsuming choice CheckSolvency : Bool with operator : Party
  controller operator
  do now <- getTime
     pure (reserveAmt >= issuedSupply && (now `subTime` lastAttestedAt) <= hours 25)
```
`PlaceOrder` asserts `CheckSolvency == True`, that the asset is on the **collateral whitelist**, **and** NAV freshness ≤ 60 min; on failure → reject the order / freeze new orders for that asset. MVP uses the mock `PoRAttestation`; stretch swaps to the V9-verified value.

---

## 7. PQS (Participant Query Store)

`scribe.jar` streams the ledger → Postgres (JSONB); the backend queries **Postgres**, never PQS directly.
```bash
./scribe.jar pipeline --source-ledger-host=localhost --source-ledger-port=6865 \
  --target-postgres-host=localhost --target-postgres-port=5432 --target-postgres-database=ledger_data \
  --target-postgres-username=pqs --target-postgres-password=secret \
  --pipeline-datasource=TransactionStream --pipeline-ledger-start=Genesis --pipeline-filter-contracts="*"
```
SQL functions: `active('pkg:Mod:Tmpl'[, offset])`, `creates()`, `archives()`, `exercises()`, `lookup_contract(cid)`, `summary_active(offset)`. Payload columns: `contract_id, payload(jsonb), template_fqn, signatories[], observers[], created_at_offset, archived_at_offset, …`.
```sql
-- open positions escrowed to the venue
SELECT contract_id, payload->'allocation'->'transferLeg'->>'sender' AS trader,
       payload->'allocation'->'settlement'->>'settleBefore' AS expires
FROM active('splice-api-token-allocation-v1:Splice.Api.Token.AllocationV1:Allocation')
WHERE payload->'allocation'->'settlement'->>'executor' = 'Venue::122…'
  AND archived_at_offset IS NULL;
```

---

## 8. Tooling & versions

```bash
curl https://get.digitalasset.com/install/install.sh | sh    # installs dpm
dpm build                                                     # → .daml/dist/perp-dex-1.0.0.dar
dpm sandbox / dpm script / dpm pqs / dpm canton-console
dpm codegen-js .daml/dist/perp-dex-1.0.0.dar -o frontend/src/generated -s "@perp"
```
**`daml.yaml`:**
```yaml
sdk-version: 3.4.11
name: perp-dex
version: 1.0.0
source: daml
dependencies: [daml-prim, daml-stdlib]
data-dependencies:
  - ./dars/vendored/splice-api-token-holding-v1-1.0.0.dar
  - ./dars/vendored/splice-api-token-allocation-v1-1.0.0.dar
  - ./dars/vendored/splice-api-token-metadata-v1-1.0.0.dar
  # stretch (Chainlink): common/domain/verifier-config/verifier -1.0.0.dar
```
Use a `multi-package.yaml` to keep `daml-script` tests in a separate package (`dpm build --all`).

**Frontend:** `npm i @c7-digital/ledger` (v2 client); reshape codegen with `@c7-digital/scribe`. Fallback = `openapi-fetch` + generated types from the OpenAPI spec:
```ts
import createClient from "openapi-fetch"; import type { paths } from "./generated/ledger-api";
const c = createClient<paths>({ baseUrl: "http://localhost:7575" });
await c.POST("/v2/commands/submit-and-wait", { body: { commands:[…], actAs:["…"], userId:"…", commandId:"…" } });
```

---

## 9. Seaport DevNet deploy (no infra)

1. `https://devnet.cantonloop.com` → create Loop DevNet wallet → copy **Party ID** (`alice::122…`).
2. Give Party ID to org admin → they **Members → Invite**.
3. `https://app.devnet.seaport.to` → auth with Loop wallet → **Teams** → your hackathon team → confirm **`5n sandbox`** validator.
4. **New Blank Project** → edit `.daml` → save → **Build Project** (DAR lands in Builds).
5. **Deploy** → select DAR → validator **`5n sandbox`** → confirm.
6. **Contract Factory** → pick template → fill fields → **Create Contract** → get CID; exercise choices from the ACTIVE CONTRACTS table.
7. **Contracts tab** = full create/exercise/archive audit trail for judges.

Abstracts: node setup, VPN/allowlisting, PQS, DAR scripts. **Dev locally** (full PQS + backend) and deploy only the DAR to Seaport for the live demo.

---

## 10. Confidence / gaps

| Item | Status |
|---|---|
| JSON Ledger API v2 endpoints/shapes; `/v2/updates`; `POST /v2/dars`; actAs/readAs as body fields | ✅ Confirmed |
| Privacy semantics + projection + ACS exclusion | ✅ Confirmed (live docs) |
| Holding (no choices) + Allocation interface/choice signatures | ✅ Confirmed |
| Price-appreciation NAV yield design | ✅ Our choice; cleanest in Daml |
| `dpm` commands, `daml.yaml`, codegen, Seaport steps | ✅ Confirmed |
| Canton "3.5.3" exact tag | ⚠️ Unconfirmed — use snapshot pin from version_information.html |
| `@c7-digital/ledger` exact method surface | ⚠️ Partially (npm page gated); `openapi-fetch` fallback is safe |
| `AllocationFactory_Allocate` extra args; `ExtraArgs` shape | ⚠️ Registry-specific |
| PoR-on-Canton template (report source) | ⚠️ See CHAINLINK.md §8 — bespoke |
