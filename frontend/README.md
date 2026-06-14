# Frontend — DARKPOOL (Private Perps on Canton)

The party-view-switching trading UI for the private perpetual-futures DEX. It is
the "privacy money-shot" surface from [PLAN.md](../PLAN.md) §7 plus a full trading
terminal: order placement, dark order book, positions, funding, liquidations,
wallet/collateral, and a regulator audit view.

```
npm install
npm run dev      # http://localhost:5173
npm run build    # type-check + production bundle
```

## What you can do right now (no backend required)

It ships with an **in-browser simulation of the entire venue** so every flow is
live today, before the matching engine / risk loop / Canton ledger are wired up:

- **Switch viewpoints** (top-right): `Alice (long)`, `Bob (short)`, `Venue`,
  `Regulator`, `Outsider`. This is the core demo — the outsider sees only the
  public price feed; every private panel is redacted (`CLASSIFIED`). Deep-link
  with `?view=outsider` / `?view=venue` / `?tab=wallet`, etc.
- **Place orders** (as Alice/Bob): side, leverage, size, limit price, with a live
  initial-margin and estimated-liquidation preview (DEX.md §3.1, §7.2). Orders
  escrow RWA collateral and rest in the dark book; the engine crosses long↔short
  into a `MatchedPair`.
- **Manage positions**: live uPnL, equity, margin ratio, liquidation price,
  accrued funding; `Close` issues a `RequestClose` that settles peer-to-peer.
- **Venue Ops** (venue view): the trigger-loop status, `Apply Funding`, and demo
  **oracle-shock** buttons that push the mark to force a maintenance-margin breach
  → liquidation (verify price → assert `E < MM` → seize collateral).
- **Wallet**: Token-Standard holdings (RWA `tMMF` + `USDCx`), free vs. locked
  (Allocation escrow), RWA yield, and the Proof-of-Reserve / whitelist gate.
- **Audit** (regulator/venue): every position, counterparty, order, and PnL.

## Architecture & the backend seam

```
components/  ── pure React views (privacy-agnostic)
   │ useStore()
store/store.tsx ── view state + Canton-style PRIVACY FILTERING per party
   │ getBackend()
data/api.ts  ── the ONE swap point (mock today → live Canton client later)
   │
data/mockEngine.ts ── in-browser sim: price feed, dark CLOB matching,
   │                   trigger loop (funding/liquidation/settle), wallets
domain/      ── types.ts (copied verbatim from backend/src/types.ts, the
                "frozen integration contract") + risk.ts (ported verbatim from
                backend/src/risk/math.ts) + config.ts (mirrors backend config)
```

**Going live is a single seam.** `domain/types.ts` and `domain/risk.ts` are
line-for-line copies of the backend contract, so the UI already speaks the
backend's language. To connect the real stack, implement `data/api.ts`'s
`getBackend()` with a client that:

- reads `MatchedPair` / `Order` via PQS SQL or `/v2/state/active-contracts`,
- submits `PlaceOrder` / `Cancel` / `MatchOrders` / `ApplyFunding` / `Liquidate` /
  `RequestClose` / `SettleClose` via the JSON Ledger API (`@c7-digital/ledger`),

matching the `MockEngine` method surface (`subscribe`, `placeOrder`, …), and set
`VITE_BACKEND_URL`. **No component changes.** The privacy filtering in
`store/store.tsx` is the UI mirror of Canton stakeholder visibility and stays the
same against real data.

## Design

A confidential phosphor-terminal aesthetic — near-black surfaces, emerald
phosphor data, JetBrains Mono + Bricolage Grotesque, scanline/grain atmosphere.
Green = long/up, red = short/down, amber = regulator/audit. Tokens live in
`styles/theme.css`.
