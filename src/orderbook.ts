import { Order, Side, Trade, BookSnapshot, BookLevel } from "./types.js";

let _oid = 0;
let _tid = 0;
const nextOrderId = () => `o${++_oid}`;
const nextTradeId = () => `t${++_tid}`;

/**
 * A single binary market's order book, expressed entirely in YES prices.
 *
 * Matching is price-time priority (the standard CLOB rule): best price first,
 * ties broken by earliest timestamp. Resting limit orders that don't fully fill
 * stay on the book. LTP (last traded price) is updated on every fill.
 */
export class OrderBook {
  readonly marketId: string;
  private bids: Order[] = []; // sorted: best (highest) first
  private asks: Order[] = []; // sorted: best (lowest) first
  ltp: number | null = null;
  trades: Trade[] = [];

  constructor(marketId: string) {
    this.marketId = marketId;
  }

  private resort() {
    // price-time priority: better price first, then older order first
    this.bids.sort((a, b) => b.price! - a.price! || a.ts - b.ts);
    this.asks.sort((a, b) => a.price! - b.price! || a.ts - b.ts);
  }

  bestBid(): number | null {
    return this.bids.length ? this.bids[0].price! : null;
  }
  bestAsk(): number | null {
    return this.asks.length ? this.asks[0].price! : null;
  }

  /** Mid of the visible book; falls back to LTP, then 0.5. */
  mid(): number {
    const b = this.bestBid();
    const a = this.bestAsk();
    if (b !== null && a !== null) return (a + b) / 2;
    return this.ltp ?? 0.5;
  }

  cancelMakerOrders() {
    this.bids = this.bids.filter((o) => o.source !== "MAKER");
    this.asks = this.asks.filter((o) => o.source !== "MAKER");
  }

  cancel(orderId: string) {
    this.bids = this.bids.filter((o) => o.id !== orderId);
    this.asks = this.asks.filter((o) => o.id !== orderId);
  }

  /**
   * Submit an order. Crosses against the resting book first (taking liquidity),
   * then rests any remainder if it is a LIMIT order. Returns the generated
   * trades. The caller (risk/inventory layer) consumes the trades.
   */
  submit(params: {
    side: Side;
    price?: number;
    qty: number;
    type: "LIMIT" | "MARKET";
    source: "MAKER" | "TAKER";
  }): { order: Order; trades: Trade[] } {
    const order: Order = {
      id: nextOrderId(),
      marketId: this.marketId,
      side: params.side,
      price: params.price,
      qty: params.qty,
      type: params.type,
      source: params.source,
      ts: Date.now() + Math.random(), // sub-ms tiebreak for deterministic ordering
    };

    const trades: Trade[] = [];
    const restingSide = order.side === "BUY" ? this.asks : this.bids;

    const crosses = (resting: Order): boolean => {
      if (order.type === "MARKET") return true;
      return order.side === "BUY"
        ? order.price! >= resting.price!
        : order.price! <= resting.price!;
    };

    while (order.qty > 0 && restingSide.length && crosses(restingSide[0])) {
      const maker = restingSide[0];
      const fillQty = Math.min(order.qty, maker.qty);
      const fillPrice = maker.price!; // maker sets the price
      const trade: Trade = {
        id: nextTradeId(),
        marketId: this.marketId,
        price: fillPrice,
        qty: fillQty,
        takerSide: order.side,
        makerOrderId: maker.id,
        takerOrderId: order.id,
        ts: Date.now(),
      };
      trades.push(trade);
      this.trades.push(trade);
      this.ltp = fillPrice;

      order.qty -= fillQty;
      maker.qty -= fillQty;
      if (maker.qty <= 1e-9) restingSide.shift();
    }

    // Rest the remainder if it's a limit order with leftover size.
    if (order.type === "LIMIT" && order.qty > 1e-9) {
      (order.side === "BUY" ? this.bids : this.asks).push(order);
      this.resort();
    }

    return { order, trades };
  }

  ordersMatching(ids: Set<string>): Order[] {
    return [...this.bids, ...this.asks].filter((o) => ids.has(o.id));
  }

  snapshot(depth = 8): BookSnapshot {
    const agg = (orders: Order[]): BookLevel[] => {
      const m = new Map<number, number>();
      for (const o of orders) m.set(o.price!, (m.get(o.price!) ?? 0) + o.qty);
      return [...m.entries()].map(([price, qty]) => ({ price, qty }));
    };
    const bids = agg(this.bids).sort((a, b) => b.price - a.price).slice(0, depth);
    const asks = agg(this.asks).sort((a, b) => a.price - b.price).slice(0, depth);
    return { bids, asks, ltp: this.ltp };
  }
}
