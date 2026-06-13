# CHAINLINK.md — Oracle Layer (Data Streams, Verifier, Proof-of-Reserve, CRE)

> Deep-dive #2 of 3. Overview: [PLAN.md](./PLAN.md). Siblings: [DEX.md](./DEX.md) (consumes `P_i`/`P_m`), [CANTON-RWA.md](./CANTON-RWA.md) (PoR gating, Canton infra).
> Status: implementation-grade — every endpoint, header, websocket frame, report field, and Daml choice. Verified 2026-06-13 against `data-streams-canton` **v1.0.0** (tag, 2026-02-20) and live docs.chain.link. Items not verifiable from live sources are flagged ⚠️ in §11.

This document owns: fetching signed price reports off-ledger, verifying them **inside a Daml transaction**, the report schemas, Proof-of-Reserve, CRE triggers, and Chainlink onboarding. The `PriceOracle` interface (§7) decouples DEX mechanics from the source so mock↔real is a one-implementation swap.

---

## 0. Day-1 path vs stretch

- **MVP (day 1):** `MockOraclePrice` on-ledger contract — an `oracle` party posts `{streamId, price, timestamp}`; all DEX mechanics read the abstract `PriceOracle.getPrice` (§7). Ships without any Chainlink access.
- **Stretch:** swap the implementation to the real Chainlink `Verifier`/`Verify` path (§6). Behind the same interface, so DEX code does not change.

---

## 1. Data Streams REST API

**Base URLs**

| Env | REST | WebSocket |
|---|---|---|
| Testnet | `https://api.testnet-dataengine.chain.link` | `wss://ws.testnet-dataengine.chain.link` |
| Mainnet | `https://api.dataengine.chain.link` | `wss://ws.dataengine.chain.link` |

**Endpoints** (append to REST base)

| Purpose | Method | Path | Query |
|---|---|---|---|
| Latest report | GET | `/api/v1/reports/latest` | `feedID` |
| Report at timestamp | GET | `/api/v1/reports` | `feedID`, `timestamp` |
| Bulk at timestamp | GET | `/api/v1/reports/bulk` | `feedIDs` (csv), `timestamp` |
| Page of reports | GET | `/api/v1/reports/page` | `feedID`, `startTimestamp`, `limit?` |

**Status codes:** 200 OK · 206 Partial (bulk, some feeds missing) · 400 bad args/headers · 401 HMAC/permission fail · 500 server.

**Response (single):**
```json
{ "report": {
  "feedID": "0x000359843a543ee2fe414dc14c7e7920ef10f4372990b79d6361cdc0dd1ba782",
  "validFromTimestamp": 1716211800,
  "observationsTimestamp": 1716211845,
  "fullReport": "0x0006f9b553e393ced3..." } }
```
Bulk returns `{ "reports": [ {…}, … ] }`. **`fullReport`** = hex ABI blob (OCR context + body + signatures); pass **unmodified** as `signedReportBytes` to the Canton `Verify` choice (§6).

---

## 2. HMAC authentication (every REST + WS request)

**Three headers**

| Header | Value |
|---|---|
| `Authorization` | API key (UUID) |
| `X-Authorization-Timestamp` | current time in **milliseconds** |
| `X-Authorization-Signature-SHA256` | hex HMAC-SHA256 (below) |

**String-to-sign** (single spaces, no newlines):
```
METHOD PATH BODY_HASH API_KEY TIMESTAMP
```
- `METHOD` = uppercase verb (`GET`; also `GET` for the WS upgrade)
- `PATH` = path **including** query string, e.g. `/api/v1/reports/latest?feedID=0x0003...`
- `BODY_HASH` = hex SHA-256 of body; for empty body (all GET/WS) = `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`
- `API_KEY` = same UUID as the header
- `TIMESTAMP` = same ms integer as the header

```go
stringToSign := fmt.Sprintf("%s %s %s %s %d", method, path, bodyHashHex, apiKey, ts)
mac := hmac.New(sha256.New, []byte(apiSecret)); mac.Write([]byte(stringToSign))
sig := hex.EncodeToString(mac.Sum(nil))
req.Header.Set("Authorization", apiKey)
req.Header.Set("X-Authorization-Timestamp", strconv.FormatInt(ts,10))
req.Header.Set("X-Authorization-Signature-SHA256", sig)
```
```ts
import { createHmac, createHash } from "crypto";
const ts = Date.now();
const bodyHash = createHash("sha256").update("").digest("hex");
const toSign = `GET ${path} ${bodyHash} ${apiKey} ${ts}`;
const sig = createHmac("sha256", apiSecret).update(toSign).digest("hex");
// headers: Authorization=apiKey, X-Authorization-Timestamp=String(ts), X-Authorization-Signature-SHA256=sig
```
**Rules:** timestamp within **±5 s** of server time (sync clock); signature is **hex, not base64**. SDK env var names: `API_KEY`, `USER_SECRET`.

---

## 3. WebSocket streaming

```
wss://ws.testnet-dataengine.chain.link/api/v1/ws?feedIDs=<id1>,<id2>,...
```
- Same three HMAC headers on the upgrade; sign with `METHOD=GET`, `PATH=/api/v1/ws?feedIDs=...`.
- **HA mode** (Go SDK `WsHA:true`): concurrent connections to multiple servers, dedup, auto-reconnect (`WsMaxReconnect`, default 5). Implement ping/pong keepalive + read deadline.
- **Frame:** `{ "report": { "feedID": "...", "fullReport": "0x..." } }` — note the streamed frame carries **only** `feedID`+`fullReport`; `validFromTimestamp`/`observationsTimestamp` are inside the decoded blob (unlike REST which surfaces them).
- Errors arrive as HTTP status during the handshake (400/401/500).

For our DEX, the backend trigger loop (→ DEX.md §5/§7) can either poll `/reports/latest` on the funding/liquidation timer or hold a WS subscription and cache the latest `fullReport` per feed.

---

## 4. Report schemas (field-by-field)

Schema version = first 2 bytes of the decoded report body **and** of the feedID prefix (`0x0003` = V3).

### V3 — Crypto (BTC/USD, ETH/USD; feedID `0x0003…`)
| Field | Type | Notes |
|---|---|---|
| `feedId` | bytes32 | |
| `validFromTimestamp` | uint32 | Unix s |
| `observationsTimestamp` | uint32 | Unix s |
| `nativeFee` | uint192 | **inert on Canton** (no fee charged) |
| `linkFee` | uint192 | inert on Canton |
| `expiresAt` | uint32 | reject if `now > expiresAt` |
| `price` | int192 | DON median; **8 or 18 dp — confirm per stream** (ETH/USD = 18 dp) |
| `bid` | int192 | impact bid |
| `ask` | int192 | impact ask |

### V11 — 24/5 Equities (collateral marks; stretch)
`feedId, validFrom, observations, nativeFee, linkFee, expiresAt, mid (int192), lastSeenTimestampNs (uint64, **ns**), bid, bidVolume, ask, askVolume, lastTradedPrice, marketStatus (uint32)`.
`marketStatus`: 0 Unknown · 1 Pre · 2 Regular · 3 Post · 4 Overnight · 5 Closed. **Trust `marketStatus`, not timestamps.** ⚠️ **No `parseReportDataV11` ships** — must hand-write following the V3 decoder. MVP keeps equity collateral on the NAV/mock path (→ CANTON-RWA.md §5).

### V9 — SmartData / NAV / PoR (Proof-of-Reserve source)
`feedId, validFrom, observations, nativeFee, linkFee, expiresAt, navPerShare (int192), navDate (uint64, **ms**), aum (int192), ripcord (uint32)`. **`ripcord=1` ⇒ data paused — do not consume.**

### V8 / V10 (reference)
V8 RWA Standard: `…, lastUpdateTimestamp (uint64 ns), midPrice, marketStatus (0/1/2)`. V10 Tokenized Asset: adds `currentMultiplier, newMultiplier, activationDateTime, tokenizedPrice, price`.

---

## 5. Feed IDs

| Feed | Schema | Full ID |
|---|---|---|
| ETH/USD (CEX ref) | V3 | `0x000359843a543ee2fe414dc14c7e7920ef10f4372990b79d6361cdc0dd1ba782` ✅ |
| AVAX/USD | V3 | `0x0003735a076086936550bd316b18e5e27fc4f280ee5b6530ce68f5aad404c796` ✅ |
| BTC/USD (CEX ref) | V3 | prefix `0x0003` ✅ but **full id UNCONFIRMED** ⚠️ — re-verify at `docs.chain.link/data-streams/stream-ids`; product name "BTC/USD-RefPrice-DS-Premium-Global-003". |
| Equities (AAPL/SPY/…) | V11 | not publicly listed; arrive on onboarding. Prefix likely `0x000b` (=11) — **unconfirmed** ⚠️. |

**Action:** for the MVP demo, anchor on the **confirmed ETH/USD id** (or re-verify BTC/USD before building). FeedID prefix is a routing hint; the verifier decodes using the schema version in the `fullReport` body.

---

## 6. On-Canton verification (Daml)

Repo `smartcontractkit/data-streams-canton` @ **v1.0.0**. **Build SDK = 3.4.9**, Java ≥17. *(This is the version that compiles the Chainlink package — note the project-wide pin discussion in CANTON-RWA.md §8: token-standard DARs use 3.4.11; "3.5.3" is unconfirmed.)*

**Vendor these DARs in dependency order** (under `dars/`, as `data-dependencies`):
```
common-1.0.0.dar
domain-1.0.0.dar
verifier-config-1.0.0.dar
verifier-1.0.0.dar
```

**Templates**
- **`Verifier`** — *we create our own instance.* Fields `owner : Party`, `observers : [Party]`; signatory `owner`.
- **`VerifierConfig`** — *Chainlink-owned*; holds oracle public keys + fault param `f` (threshold `f+1`). Chainlink grants **our party observer access**. ⚠️ Internal field names beyond `f` not public. **The CID rotates** on key rotation (old archived, new created) → always query the active `VerifierConfig`, **never hardcode the CID**.

**`Verify` choice** (exercised on `Verifier`):
```daml
choice Verify : BytesHex          -- returns reportData (hex)
  with
    configCid        : ContractId VerifierConfig   -- the *current* active config
    signedReportBytes : BytesHex                   -- = fullReport, unmodified
    sender           : Party
  controller sender
```
```daml
reportData <- submit ourParty $ exerciseCmd verifierCid Verify with
  configCid = currentConfigCid
  signedReportBytes = fullReportHex
  sender = ourParty
let v3 = parseReportDataV3 reportData            -- examples/daml/ReportDataV3.daml
let price = hexToUnsignedDecimal v3.benchmarkPrice   -- HexToDecimal.daml; handle two's-complement
```
`parseReportDataV3` yields `feedId, benchmarkPrice, bid, ask, validFromTimestamp, observationsTimestamp, expiresAt` (price fields are hex → convert with `hexToUnsignedDecimal`). On Canton, `Verify` charges **no fee** (the `nativeFee`/`linkFee` fields are inert).

**Build/test:** `daml install 3.4.9 && make build && make test && make test-examples`.

---

## 7. `PriceOracle` interface (the swap point)

```daml
interface PriceOracle where
  viewtype PriceOracleView
  getPrice : (Decimal, Time)        -- (price, asOf)
```
- `MockOraclePrice` (MVP) implements it from on-ledger `{streamId, price, timestamp}`.
- The Chainlink wrapper implements it by running `Verify` + `parseReportDataV3` (§6).
- **Staleness guard in both:** `assert (now − asOf ≤ T_stale)` (mark 5 min; → DEX.md §10.1). DEX mechanics only ever call `getPrice`; the source swap touches nothing else.

---

## 8. Proof-of-Reserve

Live on Canton (announced 2026-02-25) but ⚠️ **no public PoR Daml template/decoder exists** — bespoke Chainlink engagement required.
- **Report side:** PoR rides the **V9 SmartData** schema (§4): `navPerShare`, `aum`, `ripcord`. Most likely delivered as a signed `fullReport` verified through the **same `Verify`** choice with a hand-written `parseReportDataV9`. Unconfirmed whether V9 shares our `VerifierConfig`.
- **MVP:** `PoRAttestation` contract with a `CheckSolvency` choice — `reserves ≥ issuedSupply` and `age ≤ 25h`. The **gating logic** (calling this at order placement, `Market.PlaceOrder`) lives in **CANTON-RWA.md §6**; this section only covers the report/verification source.

---

## 9. CRE (Workflow DON)

⚠️ **No native CRE→Canton write capability** — CRE writes target EVM (`onReport()`); Canton is not a documented write target. CRE supports Cron / HTTP / EVM-log triggers.
**Bridge pattern (workaround):** CRE cron/HTTP trigger fetches the signed report → POSTs `fullReport` to **our relay** → relay submits `exerciseCmd Verify` via `smartcontractkit/go-daml` or the JSON Ledger API (→ CANTON-RWA.md §1). This adds a centralized relay. **MVP keeps our own backend timer** as the primary funding/liquidation trigger (→ DEX.md §5/§7).

---

## 10. Access & onboarding (request immediately — lead time unknown)

1. **API key + user secret:** contact `https://chain.link/contact?ref_id=datastreams` (testnet `api.testnet-dataengine.chain.link`). Env vars `API_KEY` / `USER_SECRET`.
2. **VerifierConfig observer grant (Canton-specific):** upload the 4 DARs (§6) → get our **Party ID** (`party::namespace`) → give it to Chainlink → they create `VerifierConfig` with our party as observer and hand us the initial CID. Handle CID rotation thereafter.

---

## 11. Confidence / gaps

| Item | Status |
|---|---|
| REST endpoints, HMAC scheme, WS path/frame | ✅ Confirmed |
| V3/V11/V9/V8/V10 schemas | ✅ Confirmed (field-by-field) |
| `Verifier` fields, `Verify` args/return, 4 DAR names@1.0.0, build SDK 3.4.9 | ✅ Confirmed |
| ETH/USD + AVAX/USD feed ids | ✅ Confirmed |
| BTC/USD full feed id | ⚠️ Unconfirmed — re-verify |
| V11 equities prefix; `parseReportDataV11` | ⚠️ Not shipped — hand-write |
| PoR-on-Canton template / V9 decoder / shared VerifierConfig | ⚠️ Not public — bespoke |
| `VerifierConfig` internal field names; onboarding lead time | ⚠️ Unknown |
| CRE→Canton write adapter | ⚠️ Does not exist — relay bridge |
