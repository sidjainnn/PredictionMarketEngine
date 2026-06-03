/**
 * EXTERNAL REFERENCE PRICE (requirement #1: "stay aligned with external markets").
 *
 * We do NOT copy external markets exactly. Two venues (think Kalshi + Polymarket)
 * give us:
 *   referencePrice = midpoint of the two venue prices   (our anchor)
 *   disagreement   = |venueA - venueB|                  (feeds the spread)
 *
 * Wider venue disagreement => more uncertainty => wider quotes. In production,
 * implement RealReferenceFeed by polling each venue, converting odds -> implied
 * probability, de-vigging, then exposing the same shape. The engine depends only
 * on this interface, so swapping the simulated feed for live venues is local.
 *
 * PRICING SOURCES — three tiers, same interface:
 *
 *   Tier 1  External exchange  Markets that exist on Kalshi / Polymarket.
 *           Poll their API, de-vig, take the midpoint. Disagreement = |A - B|.
 *
 *   Tier 2  Adjacent market    Markets with no prediction-market listing but a
 *           proxy: Pinnacle/Betfair odds for sports (de-vigged), CME FedWatch
 *           for rate decisions, options-implied prob (Black-Scholes N(d2)) for
 *           financial underliers. Set uncertainty from model confidence.
 *
 *   Tier 3  Model / prior      Truly novel markets (keynote word counts, custom
 *           props). Research team sets an opening probability from historical base
 *           rates or expert opinion. High uncertainty => wide spread => the maker
 *           is protected while price discovery happens through trading.
 *
 * All three tiers plug in through ReferenceFeed. HybridReferenceFeed dispatches
 * each market to the right source; the exchange never changes.
 */

export interface ReferenceQuote {
  referencePrice: number; // midpoint of venues, in [0,1]
  venueA: number;
  venueB: number;
  disagreement: number; // |venueA - venueB| — directly widens the spread
  fresh: boolean;       // false if source is stale/missing
}

export interface DiscoveryState {
  modelPrior: number;  // base price before any trading on this platform
  discovered: number;  // EMA of fill prices — what traders are revealing
  blended: number;     // current reference = (1-weight)*prior + weight*discovered
  weight: number;      // 0-1: how much the discovered price influences the reference
  volume: number;      // total contracts traded (discovery confidence)
}

export interface ReferenceFeed {
  get(marketId: string): ReferenceQuote;
  /** Advance internal state one tick. No-op for static/live feeds. */
  step(): void;
  /** Record a fill so order flow feeds back into the reference price. */
  recordFill?(marketId: string, fillPrice: number, qty: number): void;
  /** Return price discovery state for a market, or null if not supported. */
  discoveryFor?(marketId: string): DiscoveryState | null;
}

// ---------------------------------------------------------------------------
// Tier 1 — Simulated external exchange (replace with live API polling)
// ---------------------------------------------------------------------------

export interface VenueMarket {
  marketId: string;
  kalshiTicker?: string;
  polymarketSlug?: string;
  polymarketConditionId?: string;
}

export interface VenueSnapshot {
  marketId: string;
  kalshi:     { bid: number | null; ask: number | null; mid: number | null; ts: number | null };
  polymarket: { mid: number | null; ts: number | null };
  our:        number | null; // our current reference price (set by the exchange after wiring)
}

/**
 * Production feed: polls Kalshi and Polymarket in the background, caches the
 * last good price, and returns a ReferenceQuote on every .get() call.
 *
 * Kalshi  — GET https://api.elections.kalshi.com/trade-api/v2/markets/{ticker}
 *            Response: { market: { yes_bid, yes_ask } } in cents (0-99 int)
 *            De-vig: mid = (yes_bid + yes_ask) / 200
 *            No auth required for public market reads. (Host moved from the old
 *            api.kalshi.com, which no longer resolves.)
 *
 * Polymarket (gamma API) — GET https://gamma-api.polymarket.com/markets?slug={slug}
 *            Response: array of market objects with bestBid / bestAsk / lastTradePrice
 *            Prices are already 0-1 probabilities.
 *
 * If a venue is unreachable the last cached price is used; if never reached,
 * the feed returns fresh:false and the engine falls back to the model prior.
 */
export class RealReferenceFeed implements ReferenceFeed {
  private cache = new Map<string, {
    kalshiBid:  number | null; kalshiAsk: number | null;
    polymarket: number | null;
    kalshiTs:   number; polymarketTs: number;
  }>();
  private venueMarkets: VenueMarket[];
  private ourPrices = new Map<string, number>(); // set by exchange for comparison panel

  constructor(venueMarkets: VenueMarket[], pollIntervalMs = 15_000) {
    this.venueMarkets = venueMarkets;
    for (const vm of venueMarkets) {
      this.cache.set(vm.marketId, {
        kalshiBid: null, kalshiAsk: null, polymarket: null, kalshiTs: 0, polymarketTs: 0,
      });
    }
    this.poll();
    setInterval(() => this.poll(), pollIntervalMs);
  }

  step() {} // live feed — polling runs on its own timer

  private async poll() {
    await Promise.allSettled(this.venueMarkets.map(vm => this.pollOne(vm)));
  }

  private async pollOne(vm: VenueMarket) {
    const entry = this.cache.get(vm.marketId)!;

    // -- Kalshi --
    if (vm.kalshiTicker) {
      try {
        const res = await fetch(
          `https://api.elections.kalshi.com/trade-api/v2/markets/${vm.kalshiTicker}`,
          { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(5000) },
        );
        if (res.ok) {
          const d = await res.json() as { market?: { yes_bid?: number; yes_ask?: number } };
          const m = d.market;
          if (m?.yes_bid != null && m?.yes_ask != null) {
            entry.kalshiBid = m.yes_bid / 100;
            entry.kalshiAsk = m.yes_ask / 100;
            entry.kalshiTs  = Date.now();
          }
        }
      } catch { /* network error — keep stale cache */ }
    }

    // -- Polymarket (gamma API) --
    // Response: array of market objects; prices are decimal probabilities 0-1.
    if (vm.polymarketSlug) {
      try {
        const slug = encodeURIComponent(vm.polymarketSlug);
        const url  = `https://gamma-api.polymarket.com/markets?slug=${slug}&limit=1`;
        const res  = await fetch(url, { signal: AbortSignal.timeout(8000) });
        if (res.ok) {
          const d = await res.json() as Array<Record<string, string>>;
          const mkt = d[0];
          if (mkt) {
            const bid  = mkt.bestBid  ? parseFloat(mkt.bestBid)  : null;
            const ask  = mkt.bestAsk  ? parseFloat(mkt.bestAsk)  : null;
            const last = mkt.lastTradePrice ? parseFloat(mkt.lastTradePrice) : null;
            const mid  = bid != null && ask != null ? (bid + ask) / 2 : last;
            if (mid != null && mid > 0 && mid < 1) {
              entry.polymarket   = mid;
              entry.polymarketTs = Date.now();
            }
          }
        }
      } catch { /* network error — keep stale cache */ }
    }
  }

  /** Called by the exchange so the comparison panel can show our price too. */
  setOurPrice(marketId: string, price: number) {
    this.ourPrices.set(marketId, price);
  }

  get(marketId: string): ReferenceQuote {
    const entry = this.cache.get(marketId);
    const stale = 60_000; // treat as stale after 60 s
    const now   = Date.now();

    const kalshiMid = (entry?.kalshiBid != null && entry.kalshiAsk != null)
      ? (entry.kalshiBid + entry.kalshiAsk) / 2 : null;
    const freshK = entry != null && (now - entry.kalshiTs) < stale && kalshiMid != null;

    const pmMid  = entry?.polymarket ?? null;
    const freshP = entry != null && (now - entry.polymarketTs) < stale && pmMid != null;

    if (freshK && freshP) {
      const ref = (kalshiMid! + pmMid!) / 2;
      return { referencePrice: ref, venueA: kalshiMid!, venueB: pmMid!,
               disagreement: Math.abs(kalshiMid! - pmMid!), fresh: true };
    }
    if (freshK) return { referencePrice: kalshiMid!, venueA: kalshiMid!, venueB: kalshiMid!,
                         disagreement: 0, fresh: true };
    if (freshP) return { referencePrice: pmMid!,    venueA: pmMid!,    venueB: pmMid!,
                         disagreement: 0, fresh: true };

    // No live data yet — return fresh:false so caller can fall back to model
    return { referencePrice: 0.5, venueA: 0.5, venueB: 0.5, disagreement: 0.15, fresh: false };
  }

  /** Full venue snapshot for the comparison API endpoint. */
  snapshot(): VenueSnapshot[] {
    return [...this.cache.entries()].map(([marketId, e]) => ({
      marketId,
      kalshi: {
        bid: e.kalshiBid,
        ask: e.kalshiAsk,
        mid: e.kalshiBid != null && e.kalshiAsk != null ? (e.kalshiBid + e.kalshiAsk) / 2 : null,
        ts:  e.kalshiTs || null,
      },
      polymarket: { mid: e.polymarket, ts: e.polymarketTs || null },
      our: this.ourPrices.get(marketId) ?? null,
    }));
  }
}

/** Simulated two-venue consensus. Each venue random-walks around a shared truth. */
export class SimulatedReferenceFeed implements ReferenceFeed {
  private state = new Map<
    string,
    { truth: number; a: number; b: number; step: number }
  >();

  constructor(marketIds: string[], initialPrices?: Map<string, number>) {
    for (const id of marketIds) {
      const truth = initialPrices?.get(id) ?? (0.3 + Math.random() * 0.4);
      this.state.set(id, {
        truth,
        a: truth,
        b: truth,
        step: 0.006 + Math.random() * 0.01,
      });
    }
  }

  /**
   * Reference drift is intentionally FROZEN. Price movement on this platform now
   * comes from the simulated trader population (see agents.ts) acting on the
   * hidden fundamental, NOT from hand-walking an external reference. The venues
   * stay put as a stable anchor; agents + price discovery move the visible price.
   *
   * To restore live external drift, re-enable the random walk below (or swap in
   * RealReferenceFeed, which polls genuine Kalshi/Polymarket prices).
   */
  step() {
    // no-op: agents drive price, not reference drift
  }

  get(marketId: string): ReferenceQuote {
    const s = this.state.get(marketId);
    if (!s)
      return { referencePrice: 0.5, venueA: 0.5, venueB: 0.5, disagreement: 0, fresh: false };
    return {
      referencePrice: (s.a + s.b) / 2,
      venueA: s.a,
      venueB: s.b,
      disagreement: Math.abs(s.a - s.b),
      fresh: true,
    };
  }
}

// ---------------------------------------------------------------------------
// Tier 2 & 3 — Model / prior-based pricing for markets with no external venue
// ---------------------------------------------------------------------------

export interface ModelMarket {
  marketId: string;
  /**
   * Opening probability from your model. Sources by category:
   *   politics  — polling aggregation, historical base rates for incumbents/seats
   *   sports    — Pinnacle / Betfair implied prob after de-vigging the overround
   *   economy   — CME FedWatch for rate decisions; Black-Scholes N(d2) for S&P
   *   mentions  — historical frequency from past similar events
   */
  price: number;
  /**
   * How confident the model is. Maps directly to disagreement, which widens
   * the spread proportionally. Higher uncertainty = wider quotes = more edge
   * to cover model error while price discovery happens through trading.
   *
   * Typical values:
   *   0.04  tight (futures-implied, very liquid proxy)
   *   0.10  moderate (good polling, recent base rate)
   *   0.20  wide (sparse data, novel event type)
   *   0.30  very wide (first-ever market, research-team guess)
   */
  uncertainty?: number;
}

/**
 * Static model feed. Holds the research team's opening prices; does not drift.
 * In production, update prices on each poll of the underlying model source.
 */
export class ModelReferenceFeed implements ReferenceFeed {
  private prices: Map<string, { price: number; uncertainty: number }>;

  constructor(markets: ModelMarket[]) {
    this.prices = new Map(markets.map(m => [
      m.marketId,
      { price: m.price, uncertainty: m.uncertainty ?? 0.15 },
    ]));
  }

  step() {} // model prices are updated externally, not by ticking

  get(marketId: string): ReferenceQuote {
    const cfg = this.prices.get(marketId);
    const price = cfg?.price ?? 0.50;
    const unc   = cfg?.uncertainty ?? 0.25; // unknown market = very wide
    // Represent model uncertainty as two analysts with the same midpoint but
    // separated by the uncertainty level. disagreement feeds the spread directly.
    const venueA = Math.min(0.98, Math.max(0.02, price + unc / 2));
    const venueB = Math.min(0.98, Math.max(0.02, price - unc / 2));
    return { referencePrice: price, venueA, venueB, disagreement: unc, fresh: cfg != null };
  }

  /** Update a market's model price in-flight (e.g. after new polling data). */
  update(marketId: string, price: number, uncertainty?: number) {
    const existing = this.prices.get(marketId);
    this.prices.set(marketId, {
      price,
      uncertainty: uncertainty ?? existing?.uncertainty ?? 0.15,
    });
  }
}

// ---------------------------------------------------------------------------
// HybridReferenceFeed — routes each market to the right source
// ---------------------------------------------------------------------------

/**
 * Production-ready dispatcher. External markets (those on Kalshi / Polymarket)
 * go through the simulated (or real) two-venue feed; novel markets go through
 * the model feed. The exchange only sees ReferenceFeed and never changes.
 *
 * Swap path to go live:
 *   1. Replace SimulatedReferenceFeed with RealReferenceFeed (poll Kalshi + PM).
 *   2. Keep ModelReferenceFeed for any market not listed on external venues.
 *   3. Optionally: call modelFeed.update() periodically as model data refreshes.
 */
interface DiscEntry {
  prior: number;      // base price captured at first fill
  discovered: number; // EMA of fill prices
  weight: number;     // blending weight [0, maxWeight]
  volume: number;     // contracts traded
}

/**
 * PRICE DISCOVERY — how order flow feeds back into the reference price.
 *
 * Every fill (user or simulated taker) is treated as a signal. An informed
 * trader buying YES at 0.70 when the model says 0.54 is evidence the true
 * probability is higher. The EMA of fill prices becomes a "discovered" price
 * that gradually replaces the model prior as volume accumulates.
 *
 *   blended = (1 - weight) × base_reference + weight × discovered
 *
 * Weight grows with volume, capped per market type:
 *   Model markets (no external anchor): up to 0.70 — order flow CAN override
 *   Sim markets (external anchor):      up to 0.15 — external reference governs
 *
 * This is how a prediction market should work: the initial price is the best
 * available guess, and trading reveals information until the price converges
 * on the true probability. Each market starts at its prior and discovers its
 * own price through the collective knowledge of its traders.
 */
export class HybridReferenceFeed implements ReferenceFeed {
  private simFeed: SimulatedReferenceFeed;
  readonly modelFeed: ModelReferenceFeed;
  private modelIds: Set<string>;
  private disc = new Map<string, DiscEntry>();
  private externalRef = new Map<string, number>(); // live Kalshi/Polymarket mid
  private easedBase   = new Map<string, number>(); // base eased toward external

  constructor(allMarketIds: string[], modelMarkets: ModelMarket[]) {
    const modelIdList = modelMarkets.map(m => m.marketId);
    const simIds = allMarketIds.filter(id => !modelIdList.includes(id));
    const initialPrices = new Map(modelMarkets.map(m => [m.marketId, m.price]));
    this.simFeed   = new SimulatedReferenceFeed(simIds, initialPrices);
    this.modelFeed = new ModelReferenceFeed(modelMarkets);
    this.modelIds  = new Set(modelIdList);
    for (const id of allMarketIds) {
      this.disc.set(id, { prior: 0, discovered: 0, weight: 0, volume: 0 });
    }
  }

  /** The raw model/sim prior, before external anchoring or discovery. */
  private rawBase(marketId: string): number {
    return this.modelIds.has(marketId)
      ? this.modelFeed.get(marketId).referencePrice
      : this.simFeed.get(marketId).referencePrice;
  }

  /** Is this market listed on an external exchange (so we should track it)? */
  private isAnchored(marketId: string): boolean {
    return this.externalRef.has(marketId);
  }

  /**
   * Push the live external price (Kalshi/Polymarket mid). When set, the maker's
   * base anchor EASES toward it so our price converges to the real exchange —
   * Paras's "approximate the same market on other exchanges." Pass null to drop
   * the anchor (back to pure model/sim + discovery).
   */
  setExternalRef(marketId: string, price: number | null) {
    if (price == null) this.externalRef.delete(marketId);
    else this.externalRef.set(marketId, Math.min(0.97, Math.max(0.03, price)));
  }

  step() {
    this.simFeed.step();
    // Ease each anchored market's base toward its external price. Slow easing
    // (5%/tick) makes the convergence VISIBLE: the price travels from its opening
    // prior to the external value over a few seconds rather than snapping.
    for (const [id, target] of this.externalRef) {
      const cur = this.easedBase.get(id) ?? this.rawBase(id);
      this.easedBase.set(id, cur + (target - cur) * 0.05);
    }
  }

  /**
   * Record a fill. Each fill nudges the discovered price via EMA.
   *   Anchored markets (on Kalshi/PM):   flow fine-tunes around the external anchor.
   *   Unanchored markets (Baazi-only):   flow IS the price — pure discovery.
   */
  recordFill(marketId: string, fillPrice: number, qty: number) {
    const d = this.disc.get(marketId);
    if (!d) return;

    if (d.volume === 0) {
      d.prior = this.rawBase(marketId);
      d.discovered = d.prior;
    }

    // Unanchored markets learn faster and let flow dominate (no external truth).
    // Anchored markets learn gently — the external anchor already governs.
    const anchored = this.isAnchored(marketId);
    const alpha = anchored ? 0.06 : 0.12;
    const maxW  = anchored ? 0.30 : 0.70;
    d.discovered = Math.min(0.97, Math.max(0.03, (1 - alpha) * d.discovered + alpha * fillPrice));
    d.volume    += qty;
    d.weight     = Math.min(maxW, d.volume / (d.volume + 50));
  }

  get(marketId: string): ReferenceQuote {
    const raw = this.modelIds.has(marketId)
      ? this.modelFeed.get(marketId)
      : this.simFeed.get(marketId);

    // Base = eased external anchor if listed externally, else the raw prior.
    const base = this.isAnchored(marketId)
      ? (this.easedBase.get(marketId) ?? this.rawBase(marketId))
      : raw.referencePrice;

    const d = this.disc.get(marketId);
    if (!d || d.weight < 0.005) {
      return { ...raw, referencePrice: Math.min(0.97, Math.max(0.03, base)) };
    }

    const ref = (1 - d.weight) * base + d.weight * d.discovered;
    const divergence = Math.abs(base - d.discovered) * d.weight;
    return {
      referencePrice: Math.min(0.97, Math.max(0.03, ref)),
      venueA: raw.venueA,
      venueB: raw.venueB,
      disagreement: raw.disagreement + divergence * 0.5,
      fresh: raw.fresh,
    };
  }

  discoveryFor(marketId: string): DiscoveryState | null {
    const d = this.disc.get(marketId);
    if (!d) return null;
    const basePrior = d.volume === 0 ? this.rawBase(marketId) : d.prior;
    return {
      modelPrior: basePrior,
      discovered: d.volume > 0 ? d.discovered : basePrior,
      blended:    this.get(marketId).referencePrice,
      weight:     d.weight,
      volume:     d.volume,
    };
  }
}
