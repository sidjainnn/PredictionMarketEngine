/**
 * SIMULATED TRADER POPULATION — real-world order flow, NOT part of the maker.
 *
 * This module is deliberately separate from the market-making engine. The
 * Exchange owns the maker (quoting, inventory, risk); this owns the COUNTERPARTY
 * flow the maker quotes against. In production this whole file is deleted and
 * replaced by real users. Keeping it isolated makes that swap a one-line change
 * and keeps the answer to "is this part of your market maker?" a clean no.
 *
 * Three classic trader types from market-microstructure theory. Each maps to a
 * concept the maker must handle:
 *
 *   INFORMED   Knows the hidden fundamental value (with noise) and trades toward
 *              it. This is the ADVERSE-SELECTION source: informed flow is WHY the
 *              maker loses money on inventory and WHY a spread must exist
 *              (Glosten-Milgrom). Informed flow is also what DISCOVERS the price:
 *              their trades drag the market toward the true probability.
 *
 *   NOISE      Trades randomly, for liquidity/entertainment reasons. This is the
 *              maker's PROFIT source: they pay the spread without information.
 *
 *   MOMENTUM   Chases recent price moves (trend followers). They amplify one-sided
 *              ramps and are what naturally exercises the risk ladder, instead of
 *              a manual stress button.
 *
 * The simulator also owns the hidden FUNDAMENTAL value per market and drifts it
 * slowly — this represents real-world information arriving over time. Price moves
 * on this platform because informed agents act on that information, NOT because an
 * external reference is hand-walked. That is the requested behaviour: flow-driven
 * price discovery.
 */

import { Side } from "./types.js";

const clamp = (x: number) => Math.min(0.97, Math.max(0.03, x));
const rndQty = (lo = 1, hi = 6) => lo + Math.floor(Math.random() * (hi - lo + 1));

export type AgentKind = "informed" | "noise" | "momentum";

export interface MarketView {
  marketId: string;
  ltp: number | null;
  bestBid: number | null;
  bestAsk: number | null;
  reference: number;
}

export interface AgentOrder {
  marketId: string;
  side: Side;
  qty: number;
  kind: AgentKind; // for tagging / analytics
}

interface Agent {
  id: string;
  kind: AgentKind;
  aggression: number; // 0..1 — scales trade frequency and size
}

export interface AgentStats {
  informed: number;
  noise: number;
  momentum: number;
  total: number;
}

export class AgentSimulator {
  /** Master switch. Off = user-only mode (the maker only sees your orders). */
  enabled = true;

  private agents: Agent[] = [];
  private fundamentals = new Map<string, number>(); // hidden "true" probability
  private drift = new Map<string, number>();        // per-market info-arrival rate
  private ltpHist = new Map<string, number[]>();     // for momentum agents
  private externalAnchor = new Map<string, number>(); // live Kalshi/Polymarket mid
  private readonly HIST = 6;

  constructor(marketIds: string[], seedFundamentals?: Map<string, number>) {
    for (const id of marketIds) {
      // Seed the hidden fundamental NEAR the maker's prior but deliberately
      // offset, so informed agents have something to discover (the gap between
      // the maker's opening prior and the true value).
      const seed = seedFundamentals?.get(id) ?? 0.5;
      const offset = (Math.random() - 0.5) * 0.30; // up to +/-15c away from prior
      this.fundamentals.set(id, clamp(seed + offset));
      this.drift.set(id, 0.003 + Math.random() * 0.006);
      this.ltpHist.set(id, []);
    }

    // Build a population: ~40% informed, ~40% noise, ~20% momentum.
    const N = 20;
    for (let i = 0; i < N; i++) {
      const r = Math.random();
      const kind: AgentKind = r < 0.4 ? "informed" : r < 0.8 ? "noise" : "momentum";
      this.agents.push({ id: `agent-${i}`, kind, aggression: 0.3 + Math.random() * 0.7 });
    }
  }

  stats(): AgentStats {
    const s: AgentStats = { informed: 0, noise: 0, momentum: 0, total: this.agents.length };
    for (const a of this.agents) s[a.kind]++;
    return s;
  }

  fundamentalFor(marketId: string): number {
    return this.fundamentals.get(marketId) ?? 0.5;
  }

  /**
   * Pin a market's true value to the live external exchange price (Kalshi /
   * Polymarket mid). Informed agents then trade toward it, so OUR price discovers
   * its way to within a band of the real exchange — which is exactly "prices
   * should approximate the same market on other exchanges." Markets with no
   * external listing get no anchor and discover their own price freely.
   */
  setExternalAnchor(marketId: string, price: number | null) {
    if (price == null) this.externalAnchor.delete(marketId);
    else this.externalAnchor.set(marketId, clamp(price));
  }

  /**
   * Advance the hidden fundamentals each tick.
   *   - Anchored markets: fundamental tracks the external price (with small lag
   *     and tiny noise), so discovery converges toward the real exchange.
   *   - Unanchored markets: slow random walk — genuine independent discovery.
   */
  private stepFundamentals() {
    for (const [id, f] of this.fundamentals) {
      const ext = this.externalAnchor.get(id);
      if (ext != null) {
        const tracked = f + (ext - f) * 0.10 + (Math.random() - 0.5) * 0.01;
        this.fundamentals.set(id, clamp(tracked));
      } else {
        const d = this.drift.get(id)!;
        this.fundamentals.set(id, clamp(f + (Math.random() - 0.5) * 2 * d));
      }
    }
  }

  /**
   * One simulation step. Given the current view of each market, returns the
   * orders the agent population wants to place this tick.
   */
  step(views: MarketView[]): AgentOrder[] {
    if (!this.enabled) return [];
    this.stepFundamentals();

    const orders: AgentOrder[] = [];
    for (const v of views) {
      // record LTP for momentum agents
      if (v.ltp != null) {
        const h = this.ltpHist.get(v.marketId)!;
        h.push(v.ltp);
        if (h.length > this.HIST) h.shift();
      }
      for (const a of this.agents) {
        const o = this.decide(a, v);
        if (o) orders.push(o);
      }
    }
    return orders;
  }

  private decide(agent: Agent, v: MarketView): AgentOrder | null {
    const k = agent.kind;

    if (k === "informed") {
      // Perceived value = true fundamental + small private noise
      const perceived = clamp(this.fundamentalFor(v.marketId) + (Math.random() - 0.5) * 0.04);
      // Buy when the ask is below what they think it's worth (they have edge),
      // sell when the bid is above. Edge must clear a small threshold.
      if (v.bestAsk != null && perceived > v.bestAsk + 0.005 && Math.random() < agent.aggression * 0.45)
        return { marketId: v.marketId, side: "BUY", qty: rndQty(), kind: k };
      if (v.bestBid != null && perceived < v.bestBid - 0.005 && Math.random() < agent.aggression * 0.45)
        return { marketId: v.marketId, side: "SELL", qty: rndQty(), kind: k };
      return null;
    }

    if (k === "noise") {
      // Trade randomly, infrequently, small size — pays the spread.
      if (Math.random() < agent.aggression * 0.12)
        return { marketId: v.marketId, side: Math.random() < 0.5 ? "BUY" : "SELL", qty: rndQty(1, 3), kind: k };
      return null;
    }

    // momentum — chase the recent LTP trend
    const h = this.ltpHist.get(v.marketId)!;
    if (h.length >= 4) {
      const change = h[h.length - 1] - h[h.length - 4];
      if (change > 0.01 && Math.random() < agent.aggression * 0.3)
        return { marketId: v.marketId, side: "BUY", qty: rndQty(2, 5), kind: k };
      if (change < -0.01 && Math.random() < agent.aggression * 0.3)
        return { marketId: v.marketId, side: "SELL", qty: rndQty(2, 5), kind: k };
    }
    return null;
  }
}
