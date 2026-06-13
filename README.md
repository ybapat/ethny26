# Private Perpetual-Futures DEX on Canton

> A leveraged perps exchange where **your positions are invisible to everyone except you, your counterparty, and a regulator** — built on Canton, priced by Chainlink, and margined with **yield-bearing tokenized real-world assets**.
>
> ETHGlobal NYC 2026. This README is the map; the deep dives are [DEX.md](./DEX.md), [CHAINLINK.md](./CHAINLINK.md), [CANTON-RWA.md](./CANTON-RWA.md). High-level pitch/milestones live in [PLAN.md](./PLAN.md).

---

## TL;DR — what we are building

We are building a **private perpetual-futures exchange on the Canton Network.** 

- **It's a perps DEX.** Traders take leveraged long/short bets on a price (BTC/USD or ETH/USD for the MVP), with funding payments keeping the perp anchored to spot
- **It's private.** Unlike a public-chain DEX, your **orders and positions are visible only to you, your counterparty, and a Regulator** (for audit). No one else can even tell they exist--- no liquidation hunting, no copy-trading, no front-running
- **It uses a private orderbook + pure peer-to-peer settlement.** Liquidity is a limit orderbook only the venue can see (to match). Every fill binds **one long to one short**, settling directly between them. 
- **Your margin earns yield.** Instead of posting idle cash, you post a **tokenized, yield-bearing real-world asset**. It keeps earning yield while it's locked as collateral, and we value it at **full price**. Cash settles in a USDC-backed stablecoin (**USDCx**).
- **Prices are trustless.** Prices come from **Chainlink Data Streams**, and the oracle's signature is **verified inside the Daml transaction** — so marks, funding, and liquidations are anchored to real, signed prices, not a relayer we ask you to trust. **Chainlink Proof-of-Reserve** + the whitelist check that the collateral is actually backed before it's accepted.

**One sentence:** *a confidential, orderbook-based perps DEX on Canton where leveraged positions are private by construction, settle peer-to-peer with atomic delivery-vs-payment, and are margined with yield-bearing tokenized RWAs priced by in-transaction-verified Chainlink feeds.*

The rest of this README explains how each of those pieces works and how the three deep-dive docs fit together.

---

## 1. What are we building? (the one-paragraph version)

Traders take leveraged long/short bets on a price (BTC/USD or ETH/USD for the MVP) by posting limit orders to a **private orderbook** — only the venue can see the book to match it, so no trader sees another's orders. Every fill is **pure peer-to-peer**: one long matched to one short, settling directly between the two (there is **no liquidity pool / AMM**). Instead of parking idle cash as margin, traders post a **tokenized stock/ETF that keeps earning yield while it sits as collateral** — valued at **full oracle price with no haircut**, because the collateral whitelist is restricted to a stable, yield-bearing asset. Cash settlement happens in a USDC-backed stablecoin we call **USDCx**. The whole thing runs on **Canton**, whose privacy model means a random outsider literally cannot see that your position *or your orders* exist — no liquidation hunting, no copy-trading, no front-running. A **Regulator** party can see everything for audit, but can't trade or interfere. Prices come from **Chainlink Data Streams**, verified *inside* the transaction, so marks, funding, and liquidations are anchored to real, signed prices rather than a trusted relayer.

### Why each piece is there

| Want | Why it's hard on a normal chain | How we solve it |
|---|---|---|
| **Privacy** | Public chains broadcast every position | Canton: a contract is only visible to its *stakeholders* (§3) |
| **Trustworthy prices** | Oracles are usually off-chain relays you must trust | Chainlink Data Streams verified *in* the Daml transaction |
| **Capital efficiency** | Margin is idle cash earning nothing | Collateral is a yield-bearing RWA, valued at **full oracle price (no haircut)** → full yield, zero leverage penalty |
| **No central counterparty** | Pools socialize losses & need LP incentives | **Pure P2P**: long matched to short, zero-sum, settles directly — no pool |
| **Fair market structure** | Public orderbooks invite front-running | **Private orderbook**: only the venue sees orders to match; traders don't see each other's |
| **Safe settlement** | "I pay, you don't deliver" risk | Atomic delivery-vs-payment (DvP) — one all-or-nothing transaction |
| **Real backing** | A token might not be backed by real assets | Chainlink Proof-of-Reserve gate + stable-collateral whitelist before collateral is accepted |

---

## 2. The vocabulary:
- **Perpetual future ("perp")** — a futures contract with no expiry. It tracks a spot price via a periodic **funding rate** paid between longs and shorts.
- **Long / Short** — bet price goes up / down. We match one long against one short into a **MatchedPair**.
- **Orderbook (private / dark CLOB)** — traders post limit orders; the **venue** runs price-time-priority matching and is the only party that can see the whole book. No trader sees another trader's orders → no front-running. There is **no liquidity pool**.
- **Peer-to-peer (P2P)** — every fill is one long vs one short; PnL is zero-sum between them and settles directly, with no pool acting as counterparty.
- **Leverage / Margin** — you control a big position with a small deposit. **Initial Margin (IM)** is what you post to open; **Maintenance Margin (MM)** is the floor you must stay above or you get **liquidated**. (MM buffers the *perp* price — it's separate from what collateral you post.)
- **Mark price vs Index price** — *index* is the real spot price from the oracle; *mark* is a smoothed fair value used for PnL/liquidation so a 1-second spike can't wreck you. (MVP: mark = index.)
- **Collateral** — the RWA token you deposit, valued at **full oracle price**. We can skip the usual safety discount (haircut) because the collateral whitelist only admits a *stable, yield-bearing* asset whose value barely moves down. So: full yield, no leverage penalty.
- **USDCx** — the cash/settlement stablecoin (USDC-backed model).
- **RWA (Real-World Asset)** — a tokenized stock/ETF/T-bill. Ours earns yield via rising **NAV** (net asset value).
- **Canton terms** — a **party** is an identity (trader/venue/regulator). A **signatory** authorizes & is bound by a contract; an **observer** can see it but isn't bound; a **controller** is allowed to trigger a specific action (**choice**). A contract is invisible to anyone who is none of these.
- **Daml** — the smart-contract language for Canton. **DAR** — a compiled Daml package. **PQS** — a service that mirrors the ledger into Postgres so the backend can read it with SQL.

---

## 3. The big idea: privacy by construction

On Ethereum, every position is on a public ledger. On Canton, a contract is only delivered to its **stakeholders** (signatories + observers). Everyone else doesn't just lack permission — **the data never reaches them**, and they can't even tell the contract exists.

Our convention for every position:

```
signatories = { trader(s), venue }      ← they authorize and see it
observer    = { Regulator }             ← audit-only, sees but can't act
everyone else                           ← not a stakeholder → completely blind
```

So we get **five demo viewpoints**:

```
 long  │ short │ venue │ Regulator │ outsider
  ✅      ✅      ✅        ✅          ❌  ← sees only the public price feed
```

The "money shot" of the demo: switch to the **outsider** view and the position simply isn't there. We prove it with a Daml test where the outsider's query returns empty (see [CANTON-RWA.md §2](./CANTON-RWA.md)).

---

## 4. The three documents and how they split the work

Think of it as three layers of a stack. Each doc is self-contained but cross-links the others with `→`.

```
        ┌─────────────────────────────────────────────────────────┐
        │  DEX.md  — THE ENGINE (the "what happens" rules)         │
        │  positions, leverage, funding, PnL, liquidation,         │
        │  settlement, all the math + worked examples              │
        └───────────────┬───────────────────────┬─────────────────┘
       needs a price ↓ (P_i)        needs to lock/move tokens ↓
        ┌──────────────▼──────────┐   ┌──────────▼──────────────────┐
        │  CHAINLINK.md            │   │  CANTON-RWA.md               │
        │  WHERE PRICES COME FROM  │   │  THE PLUMBING + THE ASSET    │
        │  Data Streams API,       │   │  Canton API, privacy,        │
        │  HMAC, websockets,       │   │  Token Standard (lock/DvP),  │
        │  on-chain Verify, PoR    │   │  RWA tokenization + yield    │
        └──────────────────────────┘   └──────────────────────────────┘
                   │  PoR report source ↔ PoR gating logic  │
                   └────────────────────────────────────────┘
```

- **[DEX.md](./DEX.md)** = the brain. The private orderbook + matching engine, every formula and inequality: how IM/MM are computed, how funding flows long↔short, the exact liquidation condition `Equity < MaintenanceMargin`, peer-to-peer settlement math, and three fully-worked numeric examples (including the cautionary case showing *why* the collateral whitelist must be a stable asset when there's no haircut). It says **what** should happen — it delegates **how prices arrive** to CHAINLINK.md and **how tokens actually move** to CANTON-RWA.md.

- **[CHAINLINK.md](./CHAINLINK.md)** = the eyes. How we get a price we can *trust*: the Data Streams REST/WebSocket API (exact endpoints, the HMAC signing scheme, response shapes), the on-Canton `Verify` choice that checks the oracle's signature *inside the transaction*, the report schemas (V3 crypto, V11 equities, V9 for Proof-of-Reserve), and the `PriceOracle` interface that lets us run a **mock oracle on day 1** and swap in real Chainlink later without touching the engine.

- **[CANTON-RWA.md](./CANTON-RWA.md)** = the hands and the wallet. The Canton JSON Ledger API (how the backend submits commands and reads state), the privacy model in detail, the **Splice Token Standard** (how collateral is *locked* — via the Allocation workflow, because token Holdings have no lock button — and how settlement happens *atomically* as DvP), how the **RWA earns yield** (its NAV oracle price rises, so collateral value grows on its own), the Proof-of-Reserve gate, PQS reads, tooling, and the Seaport one-click deploy.

**Rule of thumb:** *math* → DEX.md, *prices* → CHAINLINK.md, *ledger mechanics + the asset itself* → CANTON-RWA.md.

---

## 5. Architecture at a glance

```
┌──────────────────────────────────────────────┐
│ FRONTEND (React)  — the party-view switcher    │   long│short│venue│Regulator│outsider
│ @c7-digital/ledger + dpm codegen-js types      │
└───────────────┬────────────────────────────────┘
                │ JSON Ledger API (read+write) + PQS SQL (read)
┌───────────────▼────────────────────────────────┐
│ BACKEND (thin, TS/Node)                         │
│ • MATCHING ENGINE: reads the private orderbook   │  ← only the venue can see all orders
│   (venue-only view), crosses long↔short orders   │
│ • submits PlaceOrder/MatchOrders/Fund/Mark/      │
│   Liquidate/Close                                │
│ • reads via PQS (SQL) + /v2/state/active-...     │
│ • TRIGGER LOOP: timer fires funding + liquidation│  ← replaces "keepers"; Canton has none
└───────┬─────────────────────────┬───────────────┘
        │ Ledger API              │ fetch signed price report (HTTPS + HMAC)
        ▼                          ▼
┌───────────────────┐     ┌──────────────────────────┐
│ CANTON PARTICIPANT│     │ ORACLE                    │
│ Daml: perp-dex    │     │ MVP: MockOraclePrice       │
│  Market / Order /  │◄────┤ Stretch: Chainlink Verify  │
│  PerpPosition /    │     │  (verifies signature       │
│  MatchedPair /     │     │   inside the transaction)  │
│  CollateralLock/PoR│     └──────────────────────────┘
│ + Token Standard   │   (no pool / AMM contract — settlement is peer-to-peer)
└───────────────────┘
Local dev: dpm sandbox + PQS.  Demo: upload DAR → Seaport shared "5n sandbox".
```

Three things worth calling out for devs:

1. **The orderbook is private and the matching is operator-driven.** Orders are Daml `Order` contracts whose stakeholders are only `{trader, venue, Regulator}`, so the venue's backend can read the whole book (to match) but no trader can see anyone else's orders. The matching *decision* runs off-ledger; the actual *binding* (`MatchOrders`) is an on-ledger atomic transaction, so a fill can't be faked. There is **no pool** — liquidity is just resting orders.
2. **Canton has no keepers/bots built in.** So funding accrual and liquidation checks are driven by a **timer in our backend** (a "trigger loop"). Chainlink CRE was the intended replacement but has no Canton write adapter yet — see [CHAINLINK.md §9](./CHAINLINK.md).
3. **Daml contracts are immutable.** "Updating" a position = archive the old contract + create a new one. So every funding tick produces a new `MatchedPair` contract. Fine at demo cadence; you'd batch it at scale.

---

## 6. End-to-end: follow one trade through all three docs

This is the whole system in one walkthrough. Each step says which doc owns it.

1. **Venue opens a Market** (BTC/USD, leverage cap, maintenance-margin rate, collateral whitelist). → CANTON-RWA.md (it's a Daml `create` via the JSON API).
2. **A trader places a long order.** They deposit a stable yield-bearing RWA token as collateral and post a limit `Order`.
   - First, **Proof-of-Reserve gate + whitelist check**: is this token on the whitelist and actually backed? `CheckSolvency` asserts `reserves ≥ issuedSupply`. → gate logic in CANTON-RWA.md §6, report source in CHAINLINK.md §8.
   - The collateral is **escrowed** using the Token Standard **Allocation** workflow (Holdings have no "lock" — you allocate them to the venue with deadlines; it's escrow, **not** a pool). → CANTON-RWA.md §3.
   - **Initial-margin check (no haircut)**: `collateralValue = qty · price ≥ IM_required`. → DEX.md §3/§6.
   - The order rests in the **private orderbook** — only the venue (and Regulator) can see it. → DEX.md §3.1.
3. **The matching engine crosses orders.** When this long order crosses a resting short order (long limit ≥ short limit), the venue's backend submits `MatchOrders`, which atomically binds them into a `MatchedPair` at the maker's price. No pool is involved — it's one long vs one short, **peer-to-peer**. → DEX.md §3.2.
4. **Outsider refreshes** → sees nothing (not the orders, not the position). **Regulator refreshes** → sees both orders, both positions + live PnL. → CANTON-RWA.md §2 (privacy).
5. **Price moves.** The backend fetches a fresh signed report from Chainlink Data Streams (HMAC-authed REST/WS) and `Verify`s it on-ledger. → CHAINLINK.md §1–3, §6. The engine recomputes `UPnL = (mark − entry)·size·side`. → DEX.md §4.
6. **Funding tick** (timer): `F = clamp(0.3·(mark−index)/index + 0.0001, ±0.75%)`, `payment = F·size·index`, longs pay shorts if `F>0` — a direct transfer between the two matched traders. The old pair is archived and recreated with updated `accruedFunding`. → DEX.md §5.
7. **Meanwhile the RWA collateral earns yield**: its NAV oracle price keeps rising, so `collateralValue` grows automatically every margin check — no action needed, and at full value since there's no haircut. → CANTON-RWA.md §5.
8. **Two endings:**
   - **Liquidation (Path A):** price moves against the short past maintenance margin. The venue exercises `Liquidate`, which **verifies the price**, **asserts** `Equity < MM` (a healthy position is *rejected* — we ship a test proving it), and **seizes the breaching side's collateral to pay the solvent counterparty directly** (no pool absorbs anything). The liquidation level was never an on-ledger field. → DEX.md §7.
   - **Close & settle (Path B):** the winning side calls `RequestClose`; the venue `SettleClose` realizes PnL **peer-to-peer** — the loser's collateral pays the winner via **atomic DvP** (both legs settle in one transaction or none do), then returns each trader's (now yield-richer) collateral. → DEX.md §8 + CANTON-RWA.md §3.
9. **Outsider still sees nothing.** Demo over.

---

## 7. Repo layout & where to start

```
PLAN.md          ← product pitch, value props, weekend milestones, demo script
README.md        ← you are here (the map + glossary + end-to-end story)
DEX.md           ← financial engine: formulas, liquidation, settlement, examples
CHAINLINK.md     ← prices: Data Streams API, HMAC, Verify, schemas, PoR, CRE
CANTON-RWA.md    ← ledger: JSON API, privacy, Token Standard, RWA yield, PQS, deploy
```

**Reading order for a new dev:** this README → PLAN.md (why) → CANTON-RWA.md §0–3 (the platform + how tokens move) → DEX.md (the math) → CHAINLINK.md (the price source). Then the three "Confidence / gaps" tables at the end of each deep dive tell you exactly what's verified vs. what to double-check before building.

---

## 8. Status, key decisions, and honest gaps

**Locked design decisions**
- **Market structure:** a **private orderbook (dark CLOB)**, not a pool/AMM — traders post limit orders only the venue can see; the venue's matching engine crosses them. → DEX.md §3.
- **Settlement:** **pure peer-to-peer** — one long vs one short, zero-sum, settled directly via Allocation DvP. No LP pool is ever a counterparty. → DEX.md §7–8.
- **Collateral:** **no haircut** — valued at full oracle price, made safe by restricting the **collateral whitelist** to a stable, yield-bearing asset. Maintenance margin (for perp risk) is kept. → DEX.md §6.
- **Margin model:** isolated (per-position), not cross — each position is one Daml contract with its own collateral. Cleaner, bounded loss, easier to audit. → DEX.md §6.
- **Yield model:** price-appreciation NAV (wstETH/OUSG style) — collateral value rises via oracle, no rebasing or distribution plumbing. → CANTON-RWA.md §5.
- **Oracle:** mock-first behind a `PriceOracle` interface; real Chainlink is a drop-in swap. → CHAINLINK.md §0/§7.
- **Triggers:** our backend timer (Canton has no keepers; CRE has no Canton write path yet).

**Trade-offs we accept (because no pool + no haircut)**
- **Tail/gap risk is counterparty-borne**, not socialized by a pool — mitigated by maintenance-margin sizing + the stable-collateral whitelist; an optional small insurance fund (not an LP pool) can backstop extreme gaps. → DEX.md §7.3.
- **Orderbook liquidity needs market makers** — the demo seeds crossing orders; a real deployment needs makers posting both sides (no pool means no passive liquidity). → DEX.md §3.3.

**Things to verify before/while building (carried from the deep-dive gap tables)**
- The **exact BTC/USD Data Streams feed id** is unconfirmed — only ETH/USD is verified. Anchor on ETH/USD or re-check the feed list. → CHAINLINK.md §5.
- **Version pins:** the Chainlink Canton package builds on Daml SDK **3.4.9**, the Splice Token Standard DARs on **3.4.11**; the much-quoted "3.5.3" is **not** a confirmed tag. Read the real number from `version_information.html` at build time. → CANTON-RWA.md §0.
- **No `parseReportDataV11`** ships for equities and **no public Proof-of-Reserve Daml template** exists — both need bespoke work or the mock path for the MVP. → CHAINLINK.md §8, §11.
- The npm client is **`@c7-digital/ledger`** (not `@c7/ledger`); `/v2/updates/flats` is removed in 3.5 (use `/v2/updates`). → CANTON-RWA.md §1, §8.

When in doubt, the deep-dive doc for that layer is the source of truth, and its gap table tells you how confident to be.
