/**
 * Core domain types.
 *
 * Key modelling decision: a binary prediction contract is a digital option whose
 * price IS the implied probability of YES, bounded in [0,1], with NO = 1 - YES by
 * no-arbitrage. We therefore keep a SINGLE order book per market expressed in
 * YES-price terms. A NO order is just a mirrored YES order:
 *
 *    BUY  NO  @ p   <=>   SELL YES @ (1 - p)
 *    SELL NO  @ p   <=>   BUY  YES @ (1 - p)
 *
 * This collapses two books into one and makes the spread structural: because
 * yes_ask + no_ask = 1 + spread, the maker never "hits both sides" at a loss.
 */

export type Side = "BUY" | "SELL";
export type Outcome = "YES" | "NO";
export type OrderType = "LIMIT" | "MARKET";

/** Who placed the order. MAKER orders are our own resting quotes. */
export type Source = "MAKER" | "TAKER";

export interface Order {
  id: string;
  marketId: string;
  /** Always normalised to the YES book. */
  side: Side;
  /** YES-denominated limit price in [0,1]. Undefined for MARKET orders. */
  price?: number;
  /** Remaining quantity (contracts). */
  qty: number;
  type: OrderType;
  source: Source;
  ts: number;
}

export interface Trade {
  id: string;
  marketId: string;
  price: number; // YES price
  qty: number;
  /** The side the aggressor took. */
  takerSide: Side;
  makerOrderId: string;
  takerOrderId: string;
  ts: number;
}

/** A price level in the book, aggregated. */
export interface BookLevel {
  price: number;
  qty: number;
}

export interface BookSnapshot {
  bids: BookLevel[]; // descending price
  asks: BookLevel[]; // ascending price
  ltp: number | null;
}

/** Loss-limit scopes, from broadest to narrowest. */
export type ScopeKind = "company" | "category" | "event" | "market";

export interface MarketConfig {
  marketId: string;
  question: string;
  category: string; // e.g. "politics", "sports", "economy", "mentions"
  eventId: string; // groups markets, e.g. one election or one match
  /** Whether this market has a tradable underlying (=> Black-Scholes applies). */
  hasUnderlying?: boolean;
}
