import { MarketConfig } from "./types.js";
import { Caps } from "./risk.js";
import { MakerSettings } from "./exchange.js";

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

export const MAKER: MakerSettings = {
  quote: {
    baseSpread: 0.02, // 2 cents
    inventoryCoefficient: 0.0009, // reservation skew per contract
    inventoryRiskCoefficient: 0.0004, // spread widening per |contract|
    disagreementCoefficient: 0.5, // spread widening per unit venue disagreement
  },
  baseQuoteSize: 25,
};
