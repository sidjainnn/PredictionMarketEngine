# Prediction Market Maker

A **reference-anchored, inventory-aware, adaptive-spread market maker** for
binary (YES/NO) prediction markets, on a real limit order book with resting
orders, hierarchical loss limits, a four-stage risk ladder, live price discovery,
and convergence to real external exchanges (Kalshi, Polymarket).

A single-user, Kalshi-style trading screen sits on top of the maker: the maker
provides liquidity, the user trades against it. Markets that exist on real
exchanges anchor to them; markets that don't discover their own price from order
flow.

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

## What's built

### Order book and matching (`orderbook.ts`)
- **Single YES order book per market**, price-time priority matching, resting
  limit orders, market orders, cancellation, LTP on every fill.
- **NO is the mirror of YES**, never a second book: `BUY NO @ p == SELL YES @ (1-p)`.
  This preserves, by construction:
  - `YES_bid + NO_ask = 1` and `YES_ask + NO_bid = 1` (no arbitrage)
  - same-side sums cross 1 (overround / vig) so the maker is never lifted on both
    sides at a loss. (`exchange.ts::placeUserOrder`)

### Pricing: three tiers + discovery + convergence (`referenceFeed.ts`)
- **SimulatedReferenceFeed** — two simulated venues for demo (politics markets).
- **ModelReferenceFeed** — research-team prior + uncertainty for markets with no
  external listing. Uncertainty feeds the spread directly.
- **RealReferenceFeed** — polls **live** Kalshi (`api.elections.kalshi.com`) and
  Polymarket (`gamma-api.polymarket.com`). Free, no API key. Caches last good
  price, handles staleness.
- **HybridReferenceFeed** — routes each market to the right source and runs:
  - **Price discovery**: every fill nudges an EMA of fill prices; the reference is
    a blend of the prior and the discovered price, weighted by traded volume.
  - **External convergence**: for markets listed on Kalshi/Polymarket, the anchor
    eases toward the live external price so our discovered price converges to
    within ~1-4% of the real exchange.

### Quote engine (`quoteEngine.ts`)
- `reservation = reference - inventory * inventoryCoefficient` (linear skew)
- `spread = base + inventoryRisk*|inv| + disagreement*k (+ stage widening)`
- `bid = reservation - spread/2`, `ask = reservation + spread/2`, clamped to
  [0.01, 0.99] with a min-gap guard so quotes never collapse or cross.

### Risk and hierarchical loss limits (`risk.ts`)
- **Exposure = inventory marked to the reference price** — worst-case loss on the
  *position* if it resolves the bad way: long `q` @ mark `m` risks `q*m` (if NO);
  short risks `|q|*(1-m)` (if YES). Deliberately **not** booked-PnL — premium
  collected during a one-sided ramp must not mask a large inventory.
- **Four nested scopes**: company > category > event > market, each capped, each
  measured at its own aggregation level.
- **Governing scope = least headroom** (highest utilisation). Most specific level
  is the most direct control, but every level is a live ceiling — a market under
  its own cap can still be throttled by its category or company aggregate.
- **Four-stage ladder** (progressive):
  | util | stage | action |
  |------|-------|--------|
  | <0.50 | 0 NORMAL | full size, base spread, both sides |
  | ≥0.50 | 1 REDUCE_SIZE | cut quote size |
  | ≥0.70 | 2 WIDEN | + widen spread |
  | ≥0.85 | 3 ONE_SIDED | + quote only the inventory-reducing side |
  | ≥1.00 | 4 DISABLE | pull quotes |

### Simulated trader population (`agents.ts`)
Deliberately separate from the maker — the counterparty flow the maker quotes
against. Delete this file to go to real users.
- **Informed** (~40%): know the hidden fundamental, trade toward it. The
  adverse-selection source and the engine of price discovery.
- **Noise** (~40%): random trades — the maker's profit source.
- **Momentum** (~20%): chase the LTP trend — exercise the risk ladder.
- The fundamental is pinned to the live external price where one exists, so
  informed flow drives our price toward the real exchange. Toggle off for a
  user-only mode (`POST /api/agents {enabled:false}` or the header button).

### Frontend (`public/index.html`)
- **Browse view**: Kalshi-style category nav and market cards with live YES price,
  probability bar, sparkline, price-discovery bar, and flash-on-change.
- **Trade terminal** (click a card): order-book ladder with your resting orders
  marked, trade tape, order entry (YES/NO, BUY/SELL, LIMIT/MARKET), open orders
  with cancel, position panel (realised + unrealised PnL), maker dashboard
  (reference/reservation/LTP, 3-part spread breakdown, inventory sparkline, stage,
  binding scope), and the risk tree.
- **Convergence panel**: our price vs Kalshi vs Polymarket with converged / close
  / diverged badges and a live headline count.

### Demo controls
- **Stress injector**: one-sided taker burst across a category to show the risk
  cascade live (`POST /api/stress {category, side}` or the header buttons).
- **Agents toggle**: switch between agent-driven flow and user-only mode.

---

## API

```
GET  /api/state    full market + risk + user-position + discovery snapshot
POST /api/order    place a user order {marketId, outcome, side, type, price?, qty}
GET  /api/orders   the user's resting orders
POST /api/cancel   {orderId}
GET  /api/venues   live convergence: our price vs Kalshi vs Polymarket
POST /api/stress   {category, side}  force the risk cascade
POST /api/agents   {enabled}  toggle the simulated trader population
```

---

## Architecture

```
Kalshi + Polymarket (live APIs)
        ↓
RealReferenceFeed ──→ external price ──→ HybridReferenceFeed (anchor + discovery)
        │                            └──→ AgentSimulator (fundamental)
        └──→ /api/venues (convergence panel)

HybridReferenceFeed → quoteEngine → exchange (per-market book) → server → frontend
   (reference)                          ↑          ↓
   AgentSimulator → TAKER orders →      risk (exposure, caps, stage)
                                        ↓
                              fills → price discovery (back to feed)
```

`exchange.tick()` (4 Hz): push live external prices → mark inventory → re-quote
every market through the risk ladder → run the agent population.

---

## Study notes — the four models (know them, not implemented)

This system is intentionally a **simplified order-book maker**, not any of the
below. Have the "what it is + why not here" answer ready.

- **LMSR** (Hanson). Automated cost-function pricing; guarantees liquidity and
  bounded loss (`b·ln2` for binary). *Why not:* it replaces the order book — no
  resting orders — and the assignment requires a CLOB.
- **CFMM** (Uniswap-style `x·y=k`). Passive pooled liquidity for DeFi. *Why not:*
  no native way to anchor to an external reference price, and it can't actively
  manage inventory — the two things this system must do.
- **Avellaneda-Stoikov.** The rigorous inventory-aware optimal-MM model. *We are
  inspired by it* but use a linear inventory term instead of the full `σ²(T-t)`
  stochastic control, which is overkill on a [0,1] probability scale and harder to
  tune/explain. This is the family our maker belongs to.
- **Black-Scholes.** Relevant only for markets with a tradable underlying (e.g.
  "S&P above 6000"), where a binary contract is a cash-or-nothing digital option,
  `price = e^{-rT} N(d2)`, giving a delta to hedge. Pure event markets (election
  winner) have no underlying, so we anchor to probability instead.

One-liner that ties it together: *LMSR and CFMM are automated-maker mechanisms
that replace an order book; Stoikov is an order-book quoting strategy on top of
one. This is an order-book exchange, so it's in the Stoikov family by design.*
