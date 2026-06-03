import { MarketConfig } from "./types.js";
import { Caps } from "./risk.js";
import { MakerSettings } from "./exchange.js";
import { ModelMarket } from "./referenceFeed.js";

export const MARKETS: MarketConfig[] = [
  // POLITICS / event: us-election
  { marketId: "POL-PRES-DEM", question: "Democrat wins the presidency?", category: "politics", eventId: "us-election" },
  { marketId: "POL-PRES-REP", question: "Republican wins the presidency?", category: "politics", eventId: "us-election" },
  { marketId: "POL-SENATE", question: "Party X holds the Senate?", category: "politics", eventId: "us-election" },
  // SPORTS / event: champions-final
  { marketId: "SPT-HOME-WIN", question: "Home side wins the final?", category: "sports", eventId: "champions-final" },
  { marketId: "SPT-OVER-2_5", question: "Over 2.5 goals in the final?", category: "sports", eventId: "champions-final" },
  // ECONOMY / event: fed-june  (has tradable underlying => Black-Scholes is the relevant talking point)
  { marketId: "ECO-CUT-25BP", question: "Fed cuts 25bp in June?", category: "economy", eventId: "fed-june", hasUnderlying: true },
  { marketId: "ECO-SP-ABOVE", question: "S&P 500 above 6000 Friday close?", category: "economy", eventId: "fed-june", hasUnderlying: true },
  // MENTIONS / event: keynote
  { marketId: "MEN-AI-10X", question: "CEO says 'AI' 10+ times in keynote?", category: "mentions", eventId: "keynote" },
];

// Hierarchical caps. Category sums are intentionally below the sum of their
// markets, so heavy one-sided flow trips the category before every market caps.
export const CAPS: Caps = {
  company: 1500,
  category: { politics: 600, sports: 500, economy: 450, mentions: 200 },
  event: { "us-election": 450, "champions-final": 380, "fed-june": 340, keynote: 150 },
  market: {
    "POL-PRES-DEM": 200, "POL-PRES-REP": 200, "POL-SENATE": 180,
    "SPT-HOME-WIN": 200, "SPT-OVER-2_5": 180,
    "ECO-CUT-25BP": 180, "ECO-SP-ABOVE": 180,
    "MEN-AI-10X": 90,
  },
  defaults: { category: 300, event: 240, market: 120 },
};

/**
 * MODEL PRICES — markets with no external exchange listing.
 *
 * These are the "invented" prices. Each entry has a research-team opening
 * probability and a confidence level (uncertainty). The uncertainty feeds
 * directly into the spread: a wide uncertainty means the maker quotes wide
 * and gives the market room to discover the true price through trading.
 *
 * Source conventions used here:
 *   sports    Pinnacle / Betfair implied prob after stripping the overround:
 *             p_true = (1/decimal_odds) / sum_of_all_implied_probs
 *   economy   CME FedWatch tool for rate decisions; Black-Scholes N(d2) for
 *             financial underliers like the S&P market
 *   mentions  Historical base rate from past similar keynotes / events
 *
 * To update prices live: call exchange.feed.modelFeed.update(marketId, price).
 */
export const MODEL_MARKETS: ModelMarket[] = [
  // Sports — priced from Pinnacle implied probability (de-vigged)
  // Home side is a mild favourite in this fixture
  { marketId: "SPT-HOME-WIN",  price: 0.54, uncertainty: 0.08 },
  // Over 2.5 goals: historically ~55% in comparable European finals
  { marketId: "SPT-OVER-2_5", price: 0.55, uncertainty: 0.10 },

  // Economy — CME FedWatch currently showing ~72% probability of a 25bp cut
  { marketId: "ECO-CUT-25BP",  price: 0.72, uncertainty: 0.06 },
  // S&P above 6000 by Friday: options-implied probability via Black-Scholes N(d2)
  { marketId: "ECO-SP-ABOVE",  price: 0.48, uncertainty: 0.09 },

  // Mentions — novel market, no external reference
  // Historical base rate: CEO said "AI" 10+ times in 3 of the last 5 keynotes
  { marketId: "MEN-AI-10X",    price: 0.62, uncertainty: 0.20 },
];

/**
 * VENUE MARKET MAPPINGS — links our internal market IDs to external exchange
 * identifiers so RealReferenceFeed can poll live prices for comparison.
 *
 * How to find real tickers:
 *   Kalshi    GET https://api.kalshi.com/trade-api/v2/markets?limit=100&series_ticker=KXFEDRATE
 *             or browse https://kalshi.com and inspect network requests
 *   Polymarket GET https://gamma-api.polymarket.com/markets?slug=<keyword>
 *             or browse https://polymarket.com and copy the URL slug
 *
 * Markets not listed here still work — they just show "no external data" in
 * the comparison panel and the maker uses the model price from MODEL_MARKETS.
 */
export interface VenueMarket {
  marketId: string;
  kalshiTicker?: string;         // e.g. "KXFEDRATE-25JUN-B25"
  polymarketSlug?: string;       // e.g. "will-fed-cut-rates-june-2025"
  polymarketConditionId?: string; // hex condition ID for CLOB API
}

export const VENUE_MARKETS: VenueMarket[] = [
  // --- Economy ---
  // Closest live Polymarket proxy to ECO-CUT-25BP
  // (June 2025 FOMC cut has resolved; this is the next meaningful Fed market)
  {
    marketId: "ECO-CUT-25BP",
    polymarketSlug: "fed-emergency-rate-cut-before-2027",
  },

  // --- Sports ---
  // Our "Home side wins the final" mapped to the two top World Cup 2026 favourites.
  // Swap to the exact fixture slug once it is listed closer to the event.
  {
    marketId: "SPT-HOME-WIN",
    polymarketSlug: "will-france-win-the-2026-fifa-world-cup-924",
  },
  {
    marketId: "SPT-OVER-2_5",
    polymarketSlug: "will-spain-win-the-2026-fifa-world-cup-963",
  },

  // --- Politics ---
  // 2028 Democratic nomination — best live proxy for long-run Democrat win probability
  {
    marketId: "POL-PRES-DEM",
    polymarketSlug: "will-gavin-newsom-win-the-2028-democratic-presidential-nomination-568",
  },

  // Kalshi tickers: add here once you have API access.
  // Find tickers at: GET https://api.kalshi.com/trade-api/v2/markets?series_ticker=KXFEDRATE
  // Example: { marketId: "ECO-CUT-25BP", kalshiTicker: "KXFEDRATE-25SEP-B25" }
];

export const MAKER: MakerSettings = {
  quote: {
    baseSpread: 0.02, // 2 cents
    inventoryCoefficient: 0.0009, // reservation skew per contract
    inventoryRiskCoefficient: 0.0004, // spread widening per |contract|
    disagreementCoefficient: 0.5, // spread widening per unit venue disagreement
  },
  baseQuoteSize: 25,
};
