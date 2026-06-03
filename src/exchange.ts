import { OrderBook } from "./orderbook.js";
import { RiskManager, Caps } from "./risk.js";
import { ReferenceFeed, SimulatedReferenceFeed } from "./referenceFeed.js";
import { computeQuote, QuoteParams } from "./quoteEngine.js";
import { MarketConfig, Side, Trade, Outcome } from "./types.js";
import { AgentSimulator, MarketView } from "./agents.js";

const opp = (s: Side): Side => (s === "BUY" ? "SELL" : "BUY");
const clamp01 = (x: number) => Math.min(0.99, Math.max(0.01, x));

export interface MakerSettings {
  quote: QuoteParams;
  baseQuoteSize: number; // contracts per side at Stage 0
}

interface UserPos {
  netYesQty: number;    // signed YES contracts (positive = long YES)
  cashFlow: number;     // total net cash across ALL trades (open + closed)
  openCashBasis: number; // cost basis of the CURRENT open position only
  // realisedPnl = cashFlow - openCashBasis (derived, not stored)
  // unrealisedPnl = netYesQty * mark + openCashBasis (derived)
}

interface UserOrderMeta {
  marketId: string;
  outcome: Outcome;
  side: Side;
  originalPrice?: number; // what the user typed, in their chosen outcome's terms
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
  feed: ReferenceFeed;
  private settings: MakerSettings;
  private engineOrderIds = new Set<string>();
  private userOrderIds = new Set<string>();
  private userPositions = new Map<string, UserPos>();
  private userOrderMeta = new Map<string, UserOrderMeta>();
  recentTrades: Trade[] = [];

  /** Simulated counterparty flow. Separate from the maker; toggleable. */
  agents: AgentSimulator;

  constructor(markets: MarketConfig[], caps: Caps, settings: MakerSettings, feed?: ReferenceFeed) {
    this.settings = settings;
    this.risk = new RiskManager(markets, caps);
    this.feed = feed ?? new SimulatedReferenceFeed(markets.map((m) => m.marketId));
    for (const m of markets) {
      this.books.set(m.marketId, new OrderBook(m.marketId));
      this.configs.set(m.marketId, m);
      this.userPositions.set(m.marketId, { netYesQty: 0, cashFlow: 0, openCashBasis: 0 });
    }
    // Seed agent fundamentals from each market's opening reference price so the
    // informed traders start with a believable (but offset) notion of fair value.
    const seeds = new Map(markets.map((m) => [m.marketId, this.feed.get(m.marketId).referencePrice]));
    this.agents = new AgentSimulator(markets.map((m) => m.marketId), seeds);
  }

  private processTrades(trades: Trade[]) {
    for (const t of trades) {
      this.recentTrades.unshift(t);

      // Engine risk tracking
      let engineSide: Side | null = null;
      if (this.engineOrderIds.has(t.takerOrderId)) engineSide = t.takerSide;
      else if (this.engineOrderIds.has(t.makerOrderId)) engineSide = opp(t.takerSide);
      if (engineSide) this.risk.applyFill(t.marketId, engineSide, t.price, t.qty);

      // User position tracking (in YES-book terms)
      let userSide: Side | null = null;
      if (this.userOrderIds.has(t.takerOrderId)) userSide = t.takerSide;
      else if (this.userOrderIds.has(t.makerOrderId)) userSide = opp(t.takerSide);
      if (userSide) {
        const pos = this.userPositions.get(t.marketId);
        if (pos) {
          const prev = pos.netYesQty;
          if (userSide === "BUY") {
            pos.cashFlow -= t.price * t.qty;
            if (prev < 0) {
              // Closing short: remove from open basis proportionally, then open any flip
              const close = Math.min(t.qty, -prev);
              const open  = t.qty - close;
              pos.openCashBasis = prev + close === 0
                ? -open * t.price
                : pos.openCashBasis * (prev + close) / prev - open * t.price;
            } else {
              pos.openCashBasis -= t.price * t.qty; // adding to long
            }
            pos.netYesQty += t.qty;
          } else {
            pos.cashFlow += t.price * t.qty;
            if (prev > 0) {
              // Closing long: remove from open basis proportionally, then open any flip
              const close = Math.min(t.qty, prev);
              const open  = t.qty - close;
              pos.openCashBasis = prev - close === 0
                ? open * t.price
                : pos.openCashBasis * (prev - close) / prev + open * t.price;
            } else {
              pos.openCashBasis += t.price * t.qty; // adding to short
            }
            pos.netYesQty -= t.qty;
          }
        }
      }
    }
    if (this.recentTrades.length > 100) this.recentTrades.length = 100;
  }

  private recordDiscovery(trades: Trade[]) {
    if (!this.feed.recordFill) return;
    for (const t of trades) this.feed.recordFill(t.marketId, t.price, t.qty);
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
    if (stage >= 2) extraSpread = 0.04;   // Stage 2: widen spread
    if (stage >= 3) suppress = inv > 0 ? "BID" : "ASK"; // Stage 3: one-sided
    if (stage >= 4) disabled = true;      // Stage 4: disable

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

    // Spread component breakdown for the UI
    const spreadBase = this.settings.quote.baseSpread;
    const spreadInv = Math.abs(inv) * this.settings.quote.inventoryRiskCoefficient;
    const spreadDis = ref.disagreement * this.settings.quote.disagreementCoefficient;

    return { ref, inv, stage, binding, scopes, quote, size, disabled, spreadBase, spreadInv, spreadDis, spreadExtra: extraSpread };
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
        this.recordDiscovery(trades);
      }
      if (quote.ask !== null) {
        const { order, trades } = book.submit({
          side: "SELL", price: quote.ask, qty: size, type: "LIMIT", source: "MAKER",
        });
        this.engineOrderIds.add(order.id);
        this.processTrades(trades);
        this.recordDiscovery(trades);
      }
    }
  }

  /**
   * Run the simulated trader population for one tick. Builds a view of each
   * market, asks the agent simulator what orders it wants, and submits them as
   * TAKER flow. This REPLACES the old random taker noise: price now moves because
   * informed/noise/momentum agents act on the hidden fundamental, not because the
   * reference is hand-walked. Toggle off (agents.enabled = false) for user-only.
   */
  runAgents() {
    if (!this.agents.enabled) return;
    const views: MarketView[] = [];
    for (const [marketId, book] of this.books) {
      views.push({
        marketId,
        ltp: book.ltp,
        bestBid: book.bestBid(),
        bestAsk: book.bestAsk(),
        reference: this.feed.get(marketId).referencePrice,
      });
    }
    for (const o of this.agents.step(views)) {
      const book = this.books.get(o.marketId);
      if (!book) continue;
      const { trades } = book.submit({ side: o.side, qty: o.qty, type: "MARKET", source: "TAKER" });
      this.processTrades(trades);
      this.recordDiscovery(trades);
    }
  }

  /**
   * User order from the frontend. NO orders mirror into the YES book:
   *   BUY NO @ p  -> SELL YES @ (1-p);   SELL NO @ p -> BUY YES @ (1-p)
   *
   * User order ID is added to userOrderIds BEFORE processTrades so that fills
   * from immediate execution are correctly attributed to the user's position.
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
    // Tag before processTrades so immediate fills are attributed to user
    this.userOrderIds.add(order.id);
    this.userOrderMeta.set(order.id, {
      marketId: args.marketId,
      outcome: args.outcome,
      side: args.side,
      originalPrice: args.price,
    });
    this.processTrades(trades);
    this.recordDiscovery(trades);
    return { orderId: order.id, fills: trades, resting: order.qty };
  }

  /** Returns all of the user's still-resting limit orders across all markets. */
  userOpenOrders() {
    const result: Array<{
      orderId: string; marketId: string; outcome: Outcome; side: Side;
      originalPrice?: number; yesbookPrice: number; qty: number;
    }> = [];
    for (const [marketId, book] of this.books) {
      for (const order of book.ordersMatching(this.userOrderIds)) {
        if (order.qty <= 1e-9) continue;
        const meta = this.userOrderMeta.get(order.id);
        if (!meta) continue;
        result.push({
          orderId: order.id,
          marketId,
          outcome: meta.outcome,
          side: meta.side,
          originalPrice: meta.originalPrice,
          yesbookPrice: order.price!,
          qty: Math.round(order.qty),
        });
      }
    }
    return result;
  }

  cancelUserOrder(orderId: string) {
    const meta = this.userOrderMeta.get(orderId);
    if (!meta) throw new Error("order not found");
    const book = this.books.get(meta.marketId);
    if (!book) throw new Error("market not found");
    book.cancel(orderId);
    this.userOrderIds.delete(orderId);
  }

  /**
   * User's mark-to-reference position for one market.
   *
   * unrealisedPnl = netYesQty * mark + openCashBasis
   *   Long  10 YES @ 0.40, mark 0.45: 10*0.45 + (-4.0) = +0.50
   *   Short 10 YES @ 0.55, mark 0.45: -10*0.45 + (+5.5) = +1.00
   *
   * realisedPnl = cashFlow - openCashBasis
   *   After selling 5 of 10 longs @ 0.50 (bought @ 0.40): +0.50 locked in.
   */
  userPositionFor(marketId: string) {
    const pos = this.userPositions.get(marketId) ?? { netYesQty: 0, cashFlow: 0, openCashBasis: 0 };
    const mark = this.feed.get(marketId).referencePrice;
    const unrealisedPnl = pos.netYesQty * mark + pos.openCashBasis;
    const realisedPnl   = pos.cashFlow - pos.openCashBasis;
    // avgCostOpen in YES-book terms; caller can invert for NO display
    const avgCostOpen = Math.abs(pos.netYesQty) > 1e-9 ? -pos.openCashBasis / pos.netYesQty : null;
    return { netYesQty: pos.netYesQty, mark, unrealisedPnl, realisedPnl, avgCostOpen };
  }

  /** Demo stress: one-sided taker burst across a category to force the cascade. */
  stress(category: string, side: Side = "BUY", rounds = 30, qtyPer = 14) {
    for (let r = 0; r < rounds; r++) {
      for (const [marketId, book] of this.books) {
        if (this.configs.get(marketId)!.category !== category) continue;
        const { trades } = book.submit({ side, qty: qtyPer, type: "MARKET", source: "TAKER" });
        this.processTrades(trades);
        this.recordDiscovery(trades);
      }
      this.refreshQuotes();
    }
  }

  tick() {
    this.feed.step();
    for (const id of this.books.keys()) this.risk.setMark(id, this.feed.get(id).referencePrice);
    this.refreshQuotes();
    this.runAgents();
  }
}
