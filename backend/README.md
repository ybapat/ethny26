# backend — Oracle feed + Risk/Trigger loop (Person 3 track)

This is **Person 3's** workstream from the [root README §9](../README.md): the **live Chainlink Data Streams** price feed and the off-ledger **risk + trigger loop** that applies funding and liquidates positions. The price path is 100% real Chainlink (no mock). The only stand-in left is the *ledger* (`MockLedger`), which becomes the real Canton client once Person 1's Daml DAR lands.

## Setup

```bash
cd backend
cp .env.example .env          # then paste your Chainlink Data Streams credentials into .env
npm install                   # dev-only: typescript + @types/node (for typecheck/editor)
```

`.env` holds **only** credentials (`DS_API_KEY`, `DS_USER_SECRET`, `DS_ENV`) and is gitignored. All other run config lives in `src/liveChainlink.ts`.

## Run / test

```bash
npm test                # 33 unit + integration tests (no creds, no network needed)
npm run typecheck       # strict tsc check
npm run fetch           # fetch ONE live signed price from Chainlink (needs .env creds)
npm run live:chainlink  # the real product loop: live price → funding/liquidation (needs .env creds)
```

No build step — Node 24 runs the TypeScript directly. Runtime deps: none (Node built-ins only).

## Files

```
src/
  types.ts            ← FROZEN integration contract (interfaces everything codes against)
  config.ts           ← Data Streams endpoints, feed ids, DEFAULT_MARKET params
  oracle/
    hmac.ts           ← Chainlink Data Streams HMAC auth (CHAINLINK.md §2)
    dataStreams.ts    ← REST client: build signed request + fetch latest report (§1)
    reportV3.ts       ← decode a V3 (crypto) signed report blob → price (§4)
    priceSource.ts    ← DataStreamsPriceSource (live Chainlink) — the only price source
    fromEnv.ts        ← build the live client/price source from .env credentials
  risk/
    math.ts           ← pure risk math: PnL, funding, equity, liquidation (DEX.md §4–8)
  ledger/
    mockLedger.ts     ← in-memory LedgerClient — stand-in for Person 1's Canton client
  loop/
    triggerLoop.ts    ← runTriggerCycle / startTriggerLoop (DEX.md §5, §7, §10.1)
  fetchPrice.ts       ← CLI: fetch one live price (proves the Chainlink path)
  liveChainlink.ts    ← the real product loop (live price → mark → fund → liquidate)
test/
  oracle.test.ts      ← HMAC, V3 round-trip + real-payload decode, request builder
  risk.test.ts        ← DEX.md §9 worked examples + formulas/boundaries
  loop.test.ts        ← loop integration (funding / liquidation / staleness) via a test stub
```

## How the loop works (one cycle)

`runTriggerCycle({ ledger, prices, risk, config, now })`:
1. read all active `MatchedPair`s from the ledger;
2. per pair, fetch the **live Chainlink** perp mark + the RWA NAV;
3. **staleness guard** (DEX.md §10.1) — skip if the mark/NAV is too old;
4. **funding** (DEX.md §5.2) — if due, compute `rate`/`payment` and exercise `ApplyFunding`;
5. **liquidation** (DEX.md §7) — if a leg's `equity < maintenanceMargin`, exercise `Liquidate`.

`startTriggerLoop(deps, intervalMs)` runs that on a timer — the keeper (Canton has no built-in keepers).

## Integration: the one swap

Everything is wired through `src/types.ts`, so going fully live is a **one-class swap**:

| Interface | Now | Integration day |
|---|---|---|
| `PriceSource` | `DataStreamsPriceSource` (live Chainlink) ✅ already real | unchanged |
| `RiskApi` | `risk` (`risk/math.ts`) ✅ final | unchanged |
| `LedgerClient` | `MockLedger` | a `@c7-digital/ledger` client submitting the real `ApplyFunding`/`Liquidate`/`SettleClose` choices to Canton |

Freeze with Person 1 (Daml): the `MatchedPair` fields and the `ApplyFunding`/`Liquidate`/`SettleClose` argument shapes (`*Args` in `types.ts`). Then the real `LedgerClient` is mechanical.

## What's real vs. stand-in

- **Price: real Chainlink Data Streams** (REST + HMAC), decoded on the off-ledger side; the same signed `fullReport` is what the on-ledger Daml `Verify` choice checks (Person 1).
- **RWA NAV:** a stable configured value (`navValue` in `liveChainlink.ts`) until the Chainlink V9/SmartData NAV feed is wired (CHAINLINK.md §8). Safe because collateral is a stable, whitelisted asset.
- **Ledger:** `MockLedger` (in-memory) until Person 1's DAR — the documented integration seam.
- **Numbers:** float64 off-ledger (rounded at boundaries); the on-ledger Daml choice re-computes in `Decimal` and enforces.
