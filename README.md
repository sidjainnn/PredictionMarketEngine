# Prediction Market Maker

A **reference-price-anchored, inventory-aware, adaptive-spread market maker** for
binary (YES/NO) prediction markets, on a real limit order book with resting
orders, hierarchical loss limits, and a four-stage risk ladder.

This repo is a **validated engine + starting commit**. The backend logic is
built and tested; the frontend is a functional stub meant to be expanded.

---

## Run it

```bash
npm install
npm run build && npm start        # http://localhost:3000
# or, for iteration:
npm run dev                       # tsx watch, no build step
```

Headless validation (no server, prints engine state to stdout):

```bash
npm run build
node dist/harness.js 500          # calm market
node dist/harness.js 400 --stress # forces the loss-limit cascade
```

---

## What's built (and tested)

- **Single YES order book per market**, price-time priority matching, resting
  limit orders, market orders, cancellation, LTP on every fill. (`orderbook.ts`)
- **NO is the mirror of YES**, never a second book:
  `BUY NO @ p` == `SELL YES @ (1-p)`. This preserves, by construction:
  - `YES_bid + NO_ask = 1` and `YES_ask + NO_bid = 1` (no arbitrage)
  - same-side sums cross 1 (overround / vig) so the maker is never lifted on
    both sides at a loss. (`exchange.ts::placeUserOrder`)
- **Two-venue reference feed** (think Kalshi + Polymarket). Exposes a midpoint
  `referencePrice` (our anchor) and `disagreement = |A-B|` (feeds the spread).
  Swap `SimulatedReferenceFeed` for `RealReferenceFeed` to go live — the engine
  depends only on the interface. (`referenceFeed.ts`)
- **Quote engine** (`quoteEngine.ts`):
  - `reservation = reference - inventory * inventoryCoefficient` (linear skew)
  - `spread = base + inventoryRisk*|inv| + disagreement*k (+ stage widening)`
  - `bid = reservation - spread/2`, `ask = reservation + spread/2`, then clamp
    to [0.01, 0.99] with a min-gap guard so quotes never collapse or cross.
- **Risk** (`risk.ts`):
  - **Exposure = inventory marked to the reference price**, i.e. worst-case loss
    on the *position* if it resolves the bad way:
    long `q` @ mark `m` risks `q*m` (if NO); short risks `|q|*(1-m)` (if YES).
    Deliberately **not** booked-PnL — premium collected during a one-sided ramp
    must not mask a large inventory. (See the comment in `risk.ts`; this is the
    subtle bit and a likely interview question.)
  - **Four nested scopes**: company > category > event > market, each capped,
    each measured at its own aggregation level.
  - **Governing scope = least headroom** (highest utilisation). "Most specific
    wins" means market is the most direct control, but every level is a live
    ceiling — a market under its own cap can still be throttled by its category
    or company aggregate.
  - **Four-stage ladder** (progressive):
    | util | stage | action |
    |------|-------|--------|
    | <0.50 | 0 NORMAL | full size, base spread, both sides |
    | ≥0.50 | 1 REDUCE_SIZE | cut quote size |
    | ≥0.70 | 2 WIDEN | + widen spread |
    | ≥0.85 | 3 ONE_SIDED | + quote only the inventory-reducing side |
    | ≥1.00 | 4 DISABLE | pull quotes |
- **Demo stress injector**: one-sided taker burst across a category to show the
  cascade live (`POST /api/stress {category, side}` or the header buttons).

## Architecture

```
referenceFeed → quoteEngine → exchange (per-market book) → server (HTTP) → frontend
                                  ↑          ↓
                                 risk (exposure, caps, stage)
```

`exchange.tick()` (4 Hz): step venues → mark inventory → re-quote every market
through the risk ladder → simulate taker flow.

---

## Build brief — what to expand in Claude Code

The frontend (`public/index.html`) is a working stub. Priorities to flesh out:

1. **Order-entry panel**: place YES/NO limit & market orders against a chosen
   market via `POST /api/order` (endpoint already exists), show fills + resting.
2. **MM dashboard polish**: per-market reference vs reservation vs LTP, live
   spread breakdown (base / inventory / disagreement), inventory sparkline.
3. **Risk dashboard polish**: the company→category→event→market tree with the
   binding scope highlighted and the active stage per market.
4. **(Optional) PnL panel**: realised spread capture vs marked inventory.

Backend extension points, all isolated:
- Real venues: implement `RealReferenceFeed.get()`.
- Per-category risk tuning: `config.ts::CAPS` and `MAKER`.
- Stage thresholds/actions: `risk.ts::stageFor` and `exchange.ts::quoteFor`.

---

## Study notes — the four models (know them, don't implement them)

This system is intentionally a **simplified order-book maker**, not any of the
below. Have the "what it is + why not here" answer ready.

- **LMSR** (Hanson). Automated cost-function pricing; guarantees liquidity and
  bounded loss (`b·ln2` for binary). *Why not:* it replaces the order book — no
  resting orders — and the assignment requires a CLOB.
- **CFMM** (Uniswap-style `x·y=k`). Passive pooled liquidity for DeFi. *Why
  not:* no native way to anchor to an external reference price, and it can't
  actively manage inventory — the two things this system must do.
- **Avellaneda-Stoikov.** The rigorous inventory-aware optimal-MM model. *We are
  inspired by it* but use a linear inventory term instead of the full
  `σ²(T-t)` stochastic control, which is overkill on a [0,1] probability scale
  and harder to tune/explain. This is the family our maker belongs to.
- **Black-Scholes.** Relevant only for markets with a tradable underlying
  (e.g. "S&P above 6000"), where a binary contract is a cash-or-nothing digital
  option, `price = e^{-rT} N(d2)`, giving a delta to hedge. Pure event markets
  (election winner) have no underlying, so we anchor to probability instead.

One-liner that ties it together: *LMSR and CFMM are automated-maker mechanisms
that replace an order book; Stoikov is an order-book quoting strategy on top of
one. This is an order-book exchange, so it's in the Stoikov family by design.*
