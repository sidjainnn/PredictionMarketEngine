import { OrderBook } from "./orderbook.js";
import { RiskManager, Caps } from "./risk.js";
import { SimulatedReferenceFeed } from "./referenceFeed.js";
import { computeQuote, QuoteParams } from "./quoteEngine.js";
import { MarketConfig, Side, Trade, Outcome } from "./types.js";

const opp = (s: Side): Side => (s === "BUY" ? "SELL" : "BUY");
const clamp01 = (x: number) => Math.min(0.99, Math.max(0.01, x));

export interface MakerSettings {
  quote: QuoteParams;
  baseQuoteSize: number; // contracts per side at Stage 0
}

/**
 * Owns every market's book, the shared risk manager, the two-venue reference
 * feed, and the maker logic. One tick = re-quote all markets, then simulated
 * taker flow hits the books. The governing risk stage maps to the four actions.
 */
export class Exchange {
  books = new Map<string, OrderBook>();
  configs = new Map<string, MarketConfig>();
  risk: RiskManager;
  feed: SimulatedReferenceFeed;
  private settings: MakerSettings;
  private engineOrderIds = new Set<string>();
  recentTrades: Trade[] = [];

  constructor(markets: MarketConfig[], caps: Caps, settings: MakerSettings) {
    this.settings = settings;
    this.risk = new RiskManager(markets, caps);
    this.feed = new SimulatedReferenceFeed(markets.map((m) => m.marketId));
    for (const m of markets) {
      this.books.set(m.marketId, new OrderBook(m.marketId));
      this.configs.set(m.marketId, m);
    }
  }

  private processTrades(trades: Trade[]) {
    for (const t of trades) {
      this.recentTrades.unshift(t);
      let engineSide: Side | null = null;
      if (this.engineOrderIds.has(t.takerOrderId)) engineSide = t.takerSide;
      else if (this.engineOrderIds.has(t.makerOrderId)) engineSide = opp(t.takerSide);
      if (engineSide) this.risk.applyFill(t.marketId, engineSide, t.price, t.qty);
    }
    if (this.recentTrades.length > 100) this.recentTrades.length = 100;
  }

  /** Build the current maker quote for a market, applying the 4-stage ladder. */
  quoteFor(marketId: string) {
    const ref = this.feed.get(marketId);
    this.risk.setMark(marketId, ref.referencePrice); // mark inventory before reading risk
    const inv = this.risk.inventory(marketId);
    const { stage, binding, scopes } = this.risk.governing(marketId);

    // Map stage -> actions (progressive).
    let sizeMultiplier = 1;
    let extraSpread = 0;
    let suppress: "BID" | "ASK" | null = null;
    let disabled = false;
    if (stage >= 1) sizeMultiplier = 0.4; // Stage 1: reduce size
    if (stage >= 2) extraSpread = 0.04; //    Stage 2: widen spread
    if (stage >= 3) suppress = inv > 0 ? "BID" : "ASK"; // Stage 3: one-sided (keep the reducing side)
    if (stage >= 4) disabled = true; //       Stage 4: disable

    const quote = computeQuote({
      referencePrice: ref.referencePrice,
      inventory: inv,
      disagreement: ref.disagreement,
      params: this.settings.quote,
      sizeMultiplier,
      extraSpread,
      suppress,
    });
    const size = Math.max(1, Math.round(this.settings.baseQuoteSize * sizeMultiplier));
    return { ref, inv, stage, binding, scopes, quote, size, disabled };
  }

  refreshQuotes() {
    this.engineOrderIds.clear();
    for (const [marketId, book] of this.books) {
      book.cancelMakerOrders();
      const { quote, size, disabled } = this.quoteFor(marketId);
      if (disabled) continue;
      if (quote.bid !== null) {
        const { order, trades } = book.submit({
          side: "BUY", price: quote.bid, qty: size, type: "LIMIT", source: "MAKER",
        });
        this.engineOrderIds.add(order.id);
        this.processTrades(trades);
      }
      if (quote.ask !== null) {
        const { order, trades } = book.submit({
          side: "SELL", price: quote.ask, qty: size, type: "LIMIT", source: "MAKER",
        });
        this.engineOrderIds.add(order.id);
        this.processTrades(trades);
      }
    }
  }

  /** Simulated taker flow, biased toward the external reference (informed flow). */
  simTakerFlow() {
    for (const [marketId, book] of this.books) {
      if (Math.random() > 0.6) continue;
      const ref = this.feed.get(marketId);
      const mid = book.mid();
      const buyBias = mid < ref.referencePrice ? 0.65 : 0.35;
      const side: Side = Math.random() < buyBias ? "BUY" : "SELL";
      const qty = 1 + Math.floor(Math.random() * 6);
      const { trades } = book.submit({ side, qty, type: "MARKET", source: "TAKER" });
      this.processTrades(trades);
    }
  }

  /**
   * User order from the frontend. NO orders mirror into the YES book:
   *   BUY NO @ p  -> SELL YES @ (1-p);   SELL NO @ p -> BUY YES @ (1-p)
   */
  placeUserOrder(args: {
    marketId: string; outcome: Outcome; side: Side;
    price?: number; qty: number; type: "LIMIT" | "MARKET";
  }) {
    const book = this.books.get(args.marketId);
    if (!book) throw new Error("unknown market");
    let side = args.side;
    let price = args.price;
    if (args.outcome === "NO") {
      side = opp(args.side);
      if (price !== undefined) price = clamp01(1 - price);
    }
    const { order, trades } = book.submit({
      side, price, qty: args.qty, type: args.type, source: "TAKER",
    });
    this.processTrades(trades);
    return { orderId: order.id, fills: trades, resting: order.qty };
  }

  /** Demo stress: one-sided taker burst across a category to force the cascade. */
  stress(category: string, side: Side = "BUY", rounds = 30, qtyPer = 14) {
    for (let r = 0; r < rounds; r++) {
      for (const [marketId, book] of this.books) {
        if (this.configs.get(marketId)!.category !== category) continue;
        const { trades } = book.submit({ side, qty: qtyPer, type: "MARKET", source: "TAKER" });
        this.processTrades(trades);
      }
      this.refreshQuotes();
    }
  }

  tick() {
    this.feed.step();
    for (const id of this.books.keys()) this.risk.setMark(id, this.feed.get(id).referencePrice);
    this.refreshQuotes();
    this.simTakerFlow();
  }
}
