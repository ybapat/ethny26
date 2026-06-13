# DEX.md — Perpetual-Futures Trading Engine (Private Orderbook + P2P Settlement)

> Deep-dive #1 of 3. Overview: [PLAN.md](./PLAN.md). Sibling docs: [CHAINLINK.md](./CHAINLINK.md) (price/PoR source), [CANTON-RWA.md](./CANTON-RWA.md) (Canton infra, Token Standard, RWA collateral & yield).
> Status: implementation-grade. Verified 2026-06-13.

This document is the **trading engine + margin layer**. It owns: the orderbook, matching, position lifecycle, mark/index pricing, funding, liquidation, and **peer-to-peer settlement**. It does **not** own how prices are fetched/verified (→ CHAINLINK.md) or how holdings are locked/transferred on-ledger (→ CANTON-RWA.md §3).

### Design at a glance (the model we ship)
- **Private orderbook (dark CLOB), not a pool.** Traders post limit orders. The **venue operator** is the only party that sees the whole book (it must, to match); no trader can see another trader's orders. There is **no AMM / LP pool** acting as counterparty.
- **Pure peer-to-peer.** Every fill binds exactly one long to one short into a `MatchedPair`. PnL is zero-sum between those two parties and settles directly between them via atomic DvP.
- **No haircut.** Collateral is valued at full oracle value: `CollateralValue = collateralQty · P_rwa`. This is safe **because the collateral whitelist is restricted to a stable, yield-bearing NAV asset** (T-bill / money-market style) whose USDCx value essentially only accrues upward. Maintenance margin (below) remains the buffer for *perp* price risk.
- **Maintenance margin stays.** It buffers the thing you're betting on (the perp), and it's what makes P2P actually settle. It is independent of what collateral you post.

---

## 0. Privacy convention (applies to every template here)

- **Signatories:** orders → `{trader, venue}`; a `MatchedPair` → `{longTrader, shortTrader, venue}`.
- **Observer:** `{Regulator}` (audit-only, never a controller).
- **No other trader is ever a stakeholder** → orders and positions are invisible to outsiders by construction (Canton sub-transaction privacy, → CANTON-RWA.md §2). The venue sees the full book (it's a signatory on every order) but **traders cannot see each other's orders** — this is a *private/dark* CLOB, a stronger privacy story than a public orderbook.
- Liquidation level is **never** an on-ledger field; it is derived inside the choice, never stored as an observable.

---

## 1. Variable glossary & precision policy

| Symbol | Meaning | Unit |
|---|---|---|
| `S` | position size | units of underlying |
| `P_e` | entry/execution price | USDCx |
| `P_i` | index price (oracle aggregate spot) | USDCx |
| `P_m` | mark price (manipulation-resistant fair value) | USDCx |
| `P_x` | exit/close price | USDCx |
| `L` | leverage | dimensionless |
| `N` | notional `= S·P_m` (or `S·P_e` at open) | USDCx |
| `IMR` | initial-margin rate `= 1/L` | fraction |
| `MMR` | maintenance-margin rate | fraction |
| `IM` / `MM` | initial / maintenance margin `= N·IMR` / `N·MMR` | USDCx |
| `sideSign` | `+1` long, `−1` short | — |
| `F` | funding rate (per interval, signed) | fraction |
| `T_f` | funding interval | seconds (demo: 3600) |
| `P_rwa` | oracle NAV of RWA collateral token | USDCx/token |
| `E` | equity `= CollateralValue + UPnL − accruedFundingOwed` | USDCx |

**Convention:** `IMR = 2·MMR` (e.g. IMR 10% ⇒ MMR 5%, max 10×).

**Precision (Daml `Decimal`):** prices 8 dp, quantities 6 dp; full precision in intermediate math; round only at final settlement, always **against the trader** (floor proceeds, ceil debts); accrue funding as exact fractions.

---

## 2. Mark price vs index price

**Index `P_i`** — oracle aggregate spot (→ CHAINLINK.md: the V3 benchmark price is our `P_i`).

**Mark `P_m`** — smoothed fair value so a 1-second spike can't trigger liquidation. Production: `P_m = Clamp(Median(P1,P2,P3), P_i·(1−Cap), P_i·(1+Cap))` with `P1` funding-extrapolated, `P2 = P_i + MA(basis)`, `P3 = Median(bid,ask,last)`. **MVP:** `P_m := P_i` from the verified Data Stream + staleness guard (→ §10.1).

---

## 3. Orderbook, matching & open

### 3.1 Orders (private)
A trader posts a limit order as an `Order` contract (signatory `{trader, venue}`, observer `{Regulator}`). Before/at order time, the trader's RWA collateral is **escrowed to the venue** via the Allocation workflow (→ CANTON-RWA.md §3); the order references that allocation.

```
Notional_open = S · P_e
IM_required   = S · P_e · IMR = S · P_e / L
L_max         = 1 / IMR_min
Initial-margin check (no haircut):  CollateralValue = collateralQty · P_rwa ≥ IM_required
⇒ collateralQty_min = (S · P_e) / (L · P_rwa)
```

`Order` fields: `trader, side (Long|Short), size, limitPrice, collateralAllocationCid, timeInForce, expiresAt, createdAt`. Choices: `Cancel`(trader), `MatchOrders`(venue).

### 3.2 Matching engine (off-ledger decision, on-ledger binding)
The venue's backend runs a **price-time-priority** matching engine. It can read the full book because the venue is a stakeholder on every `Order` (via PQS / `/v2/state/active-contracts`, → CANTON-RWA.md §1/§7). No trader can read the book.

- A long order with `limitPrice ≥` a resting short's `limitPrice` (or vice-versa) is **crossable**.
- Execution price `P_e` = the resting (maker) order's price (price-time priority); partial fills allowed (split orders).
- On a cross, the venue submits `MatchOrders` (controller = venue), which **atomically**: archives/decrements both `Order`s, locks each side's collateral allocation, and creates a `MatchedPair` at `P_e`.

The *ordering* is operator-driven (a known centralization point, documented), but the *binding* is on-ledger and atomic, so execution can't be faked. For the demo, seed one long and one short order that cross.

### 3.3 No pool
There is no AMM or LP vault. Liquidity is whatever resting orders exist; every position is one long matched to one short. (Cold-start: seed orders for the demo; a real deployment needs market makers posting both sides.)

---

## 4. Unrealized PnL

```
UPnL = (P_m − P_e) · S · sideSign        Long: (P_m−P_e)·S    Short: (P_e−P_m)·S
```
Long 10 @ 100, mark 110 ⇒ `+$100`; mark 90 ⇒ `−$100`.

---

## 5. Funding

Anchors the perp to spot. `F>0` (perp above spot) ⇒ **longs pay shorts**; `F<0` ⇒ shorts pay longs. Because it's P2P, funding is a direct transfer between the two matched traders — no pool intermediates.

**Demo formula (ship this):**
```
F = clamp( 0.3·(P_m − P_i)/P_i + 0.0001,  −0.0075, +0.0075 )    # per 1h interval
FundingPayment = F · S · P_i        # index, not mark → avoids circular dependency
FundingPayment_long  = +F·S·P_i (long pays if F>0) ;  short receives the same
```
(Production premium-index/TWAP/IR-clamp variant documented for honesty; the demo uses the clamped single-snapshot form.) `accruedFunding` (signed, negative = owed) is a field on `MatchedPair`, updated each tick. `MatchedPair.ApplyFunding`(venue): read oracle, compute payment, transfer long↔short, archive+recreate the pair (immutable contracts ⇒ churn each tick; fine at demo cadence).

---

## 6. Margin & collateral valuation (no haircut)

**Isolated margin** (per-position): each `MatchedPair` carries each side's own collateral allocation → bounded loss, clean P2P accounting, auditable liquidation, no cross-position cascade.

```
CollateralValue = collateralQty · P_rwa            # NO haircut
Equity (E)      = CollateralValue + UPnL − accruedFundingOwed
```

**Why no haircut is safe here.** A haircut exists to buffer a *collateral-vs-settlement currency mismatch* — it only matters when collateral is volatile against USDCx. We eliminate that risk at the source by **restricting the collateral whitelist to a stable, yield-bearing NAV token** (T-bill / money-market style) whose USDCx value essentially only accrues upward (→ CANTON-RWA.md §5). With near-zero collateral downside, full valuation (`haircut = 1.0`) is justified, and the value prop stays clean: **full yield on collateral, zero leverage penalty.**

> ⚠️ The moment a *volatile or correlated* asset is whitelisted as collateral (a single-stock token, an equity ETF for an equity perp), this no longer holds — the collateral can be worth less than what's owed at seizure time (§9 Example C). That risk is controlled by the **whitelist**, which we own, not by a haircut.

---

## 7. Liquidation (peer-to-peer, no pool)

### 7.1 Condition (exact)
```
Liquidate ⟺ E < MM ⟺ CollateralValue + UPnL − accruedFundingOwed < S·P_m·MMR ⟺ MarginRatio = E/(S·P_m) < MMR
```

### 7.2 Liquidation & bankruptcy prices (no haircut)
```
P_liq_long  = (CollateralValue − accruedFunding + S·P_e) / (S·(1 − MMR))   ≈ P_e·(1 − IMR + MMR)
P_liq_short = (CollateralValue − accruedFunding + S·P_e) / (S·(1 + MMR))   ≈ P_e·(1 + IMR − MMR)
Bankruptcy_long ≈ P_e·(1 − IMR)      Bankruptcy_short ≈ P_e·(1 + IMR)
```
Ordering (long): `Bankruptcy < Liq < Entry` — the gap is the settlement buffer.

### 7.3 Who pays (P2P, no LP pool)
On liquidation the venue closes the `MatchedPair` at mark; **the breaching side's seized collateral pays the solvent counterparty** directly. Surplus above what's owed is returned to the liquidated trader.
- **Penalty** (optional, small): `LiqPenalty = S·P_m·LiqPenaltyRate` → liquidator/keeper fee.
- **Gap / bad debt:** if the perp gaps so far that seized collateral < amount owed, there is **no pool to absorb it** → the shortfall is borne by the counterparty (they receive collateral-limited payout). This residual is mitigated by: (a) the **maintenance-margin buffer** sized for expected gap risk, and (b) the **stable collateral whitelist** (collateral itself doesn't crater). An optional small **insurance fund** (explicitly *not* an LP/AMM pool) can backstop tail gaps; otherwise it's ADL/counterparty-borne. State the chosen policy in the demo.

### 7.4 Daml — `MatchedPair.Liquidate` (controller = venue)
1. Verify price (mock or Chainlink `Verify`, → CHAINLINK.md §6) + staleness guard.
2. `SettleFunding` first (finalize `accruedFunding`).
3. **ASSERT** `E < MM` — a healthy position **must fail** (ship a `submitMustFail` test).
4. Atomically unlock + seize the breaching side's RWA, pay the counterparty via Allocation (→ CANTON-RWA.md §3), apply any penalty, return surplus.

---

## 8. Close & settle (peer-to-peer DvP)

```
RealizedPnL = (P_x − P_e)·S·sideSign
NetProfit   = RealizedPnL + accruedFunding − openFees − closeFees      (fee = S·price·feeRate)
```
`PerpPosition.RequestClose`(trader) → `MatchedPair.SettleClose`(venue), one atomic Daml transaction, **directly between the two traders** (no pool):
1. `SettleFunding` → finalize `accruedFunding`.
2. Compute each side's `NetProfit` (zero-sum: long's gain = short's loss).
3. The losing side's collateral pays the winning side; both legs (collateral leg + USDCx PnL leg) share one `settlementRef` and execute via **Allocation DvP** (`Allocation_ExecuteTransfer`, → CANTON-RWA.md §3) — all-or-nothing.
4. Each trader's remaining (now yield-richer) collateral is unlocked and returned.

---

## 9. Worked numeric examples (no haircut)

Params: `P_i=$200`, `IMR=10%`, `MMR=5%`, demo `F=+0.02%/hr` (on index), RWA `P_rwa=$520/tok`, RWA yield 4% APY, taker 0.05%.

### (A) Long → fund×3 → close profit
```
Open:  S=50 @200. IM_req=$1,000. qty_min=1000/520=1.923 → deposit 2.0 tok → CollVal=2.0·520=$1,040 ✓
+1h:   mark 201. fund=0.0002·50·200=$2.00 (long pays). UPnL=(201−200)·50=+$50.
       E=1040+50−2=$1,088 ; MM=50·201·0.05=$502.50 → safe.
+3h close @205: RealizedPnL=(205−200)·50=+$250. funding=−$6.00. fees: open 5.00 + close 5.125.
       NetProfit=250−6−5−5.125 = +$233.88. Return 2.0 tok + $233.88 (paid by the short).
```
### (B) Short → mark up → near-liq → close loss (funding offsets)
```
Open:  S=100 @200, 5× (IMR=20%). IM_req=$4,000. qty=4000/520=7.69 → deposit 8.0 tok → CollVal=$4,160.
       P_liq_short=(4160+0+100·200)/(100·1.05)=$230.10.
+24h:  mark 215. UPnL=(200−215)·100=−$1,500. funding(short receives)=24·0.0002·100·200=+$96.00.
       coll(yield 1d)=8·$520.056=$4,160.45. E=4160.45−1500+96=$2,756.45 ; MM=$1,075 → safe.
close @217: RealizedPnL=−$1,700. funding +96. fees 10 + 10.85.
       NetProfit=−$1,624.85. Sell 3.12 tok to pay the long; return 4.88 tok.
```
### (C) ⚠️ Cautionary: why the whitelist must be stable (the no-haircut trade-off)
```
Suppose (AGAINST POLICY) collateral were a VOLATILE equity ETF token, no haircut:
Open:  S=50 @200, deposit 2.0 tok @ $520 → CollVal=$1,040.
Shock: perp gaps to mark 160 (−20%) AND collateral −10% (P_rwa=$468 → CollVal=$936).
       UPnL=(160−200)·50=−$2,000. Owed to counterparty ≈ $2,000.
       Seized collateral $936 < $2,000 owed → BAD DEBT $1,064.
       No pool exists → the COUNTERPARTY eats the $1,064 shortfall.
Lesson: with no haircut and no pool, only a STABLE collateral asset is safe. We enforce this via the
        whitelist (stable T-bill/money-market token only). Volatile collateral would require either a
        haircut or an insurance fund — neither of which we want.
```

---

## 10. Edge cases & robustness

1. **Stale price.** Mark `T_stale = 5 min`, NAV `T_stale = 25 h`; `assert (now − oracle.ts ≤ T_stale)` in every choice. Mark-stale ⇒ halt trading + liquidations; NAV-stale ⇒ freeze new opens.
2. **Gap / bad debt (P2P, no pool).** Counterparty-borne by default; mitigate via MM sizing + stable collateral; optional insurance fund (not a pool) for tail gaps. → §7.3.
3. **Funding at liquidation/close.** Always `SettleFunding` before `Liquidate`/`SettleClose`.
4. **Orderbook integrity.** Matching is operator-ordered but on-ledger-bound (atomic `MatchOrders`); cancel races handled by archiving the consumed `Order`; partial fills split orders. No trader can see or front-run another's order (private book).
5. **Rounding.** Floor proceeds / ceil debts; exact fractional funding.
6. **Collateral whitelist (replaces the haircut).** Only a stable, yield-bearing NAV token is acceptable as margin; the PoR gate (→ CANTON-RWA.md §6) plus the whitelist are the collateral-risk controls. Adding any volatile/correlated asset would reintroduce the §9-C bad-debt risk.
7. **Oracle disagreement.** If two sources differ >2%: conservative `min` for margin checks, `max` for any payout; block new opens on that asset.

---

## 11. Daml template & choice map (engine)

| Template | Signatory | Observer | Choices (controller) |
|---|---|---|---|
| `Market` | venue | Regulator | `PlaceOrder`(trader), `ApplyFunding`(venue) |
| `Order` | trader, venue | Regulator | `Cancel`(trader), `MatchOrders`(venue) |
| `PerpPosition` | trader, venue | Regulator | `Mark`(venue), `RequestClose`(trader) |
| `MatchedPair` | longTrader, shortTrader, venue | Regulator | `ApplyFunding`(venue), `SettleFunding`(venue), `Liquidate`(venue), `SettleClose`(venue) |
| `InsuranceFund` *(optional)* | venue | Regulator | `Absorb`(venue) — tail-gap backstop, **not** an LP pool |
| `FundingState` | venue | Regulator | `Advance`(venue) |

**`Market` config:** `underlying` (feed id), `leverageCap`, `maintenanceMarginBps`, `fundingIntervalSeconds`, `oracleRef`, `collateralWhitelist`, `liqPenaltyBps`. *(No `haircutBps`.)*

Collateral lock + USDCx settlement wrap the Token Standard Allocation — defined in **CANTON-RWA.md §3**. Price verification is **CHAINLINK.md §6–7**.

---

## 12. Confidence / gaps

| Item | Status |
|---|---|
| Perp/funding/liquidation/PnL formulas | ✅ Standard, sourced. |
| No-haircut valuation (`CollateralValue = qty·P_rwa`) | ✅ Safe **iff** collateral whitelist = stable yield asset (enforced). |
| Private orderbook / dark CLOB on Canton | ✅ Orders private to {trader, venue}; venue matches; binding is on-ledger atomic. |
| Pure P2P settlement, no pool | ✅ Zero-sum long↔short via Allocation DvP. |
| Matching ordering centralization | ⚠️ Operator-ordered (documented); execution itself is on-ledger/atomic. |
| Tail gap / bad debt with no pool | ⚠️ Counterparty-borne unless optional insurance fund added; mitigated by MM + stable collateral. |
| Cold-start liquidity (orderbook needs makers) | ⚠️ Seed orders for demo; real deployment needs market makers. |
