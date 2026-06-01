import { MarketConfig } from "./types.js";

/**
 * RISK + HIERARCHICAL LOSS LIMITS.
 *
 * Per market we track maker inventory and cash, then exposure as the WORST of the
 * two resolutions:
 *
 *   loss_if_yes = -(cash + q)     (each long YES pays 1 at YES; short pays -1)
 *   loss_if_no  = -(cash)         (YES expires worthless at NO)
 *   exposure    = max(loss_if_yes, loss_if_no, 0)
 *
 * Four nested scopes, each with its own cap, each measured at its own level:
 *   company  > category > event > market
 *
 * "Most specific wins": the market-level cap is the most direct control, but every
 * level is a live ceiling. The scope that actually governs behaviour is the one
 * with the LEAST headroom (highest utilisation). So a market under its own cap can
 * still be throttled because its category or company aggregate is hot.
 *
 * FOUR-STAGE RISK LADDER (progressive; higher stage = stricter):
 *   Stage 0  util < 0.50   NORMAL       full size, base spread, both sides
 *   Stage 1  util >= 0.50  REDUCE_SIZE  cut quote size
 *   Stage 2  util >= 0.70  WIDEN        + widen spread
 *   Stage 3  util >= 0.85  ONE_SIDED    + quote only the inventory-reducing side
 *   Stage 4  util >= 1.00  DISABLE      pull quotes entirely
 */

export type ScopeKind = "company" | "category" | "event" | "market";

export interface Caps {
  company: number;
  category: Record<string, number>;
  event: Record<string, number>;
  market: Record<string, number>;
  defaults: { category: number; event: number; market: number };
}

export interface ScopeStatus {
  kind: ScopeKind;
  id: string;
  exposure: number;
  cap: number;
  utilisation: number;
  stage: number;
}

interface Pos {
  cfg: MarketConfig;
  q: number; // signed YES inventory
  cash: number; // realised cash from trading
}

export function stageFor(util: number): number {
  if (util >= 1.0) return 4;
  if (util >= 0.85) return 3;
  if (util >= 0.7) return 2;
  if (util >= 0.5) return 1;
  return 0;
}

export const STAGE_NAME = ["NORMAL", "REDUCE_SIZE", "WIDEN", "ONE_SIDED", "DISABLE"];

export class RiskManager {
  private pos = new Map<string, Pos>();
  caps: Caps;

  constructor(markets: MarketConfig[], caps: Caps) {
    this.caps = caps;
    for (const cfg of markets) this.pos.set(cfg.marketId, { cfg, q: 0, cash: 0 });
  }

  applyFill(marketId: string, makerSide: "BUY" | "SELL", price: number, qty: number) {
    const p = this.pos.get(marketId);
    if (!p) return;
    if (makerSide === "BUY") {
      p.q += qty;
      p.cash -= price * qty;
    } else {
      p.q -= qty;
      p.cash += price * qty;
    }
  }

  inventory(marketId: string): number {
    return this.pos.get(marketId)?.q ?? 0;
  }

  /**
   * Exposure = worst-case loss attributable to the POSITION, measured from the
   * current reference price (mark), NOT from booked cash.
   *
   * Why not just max(loss_if_yes, loss_if_no) on cash+inventory? Because during a
   * one-sided ramp the maker collects premium that offsets the liability and HIDES
   * the risk: you can be short thousands of contracts yet show near-zero exposure.
   * Collected premium is not a safety buffer (you give it back if the market moves
   * against you). So we mark the inventory to the reference price and measure how
   * much the position alone can lose if the market resolves the bad way:
   *
   *   long q YES  @ mark m  ->  worst loss if NO  = q * m         (paid m, gets 0)
   *   short q YES @ mark m  ->  worst loss if YES = |q| * (1 - m) (owes 1, holds m)
   *
   * This makes inventory the primary risk driver, which is what a desk caps on.
   */
  private markPrice = new Map<string, number>();
  setMark(marketId: string, ref: number) {
    this.markPrice.set(marketId, ref);
  }

  exposureMarket(marketId: string): number {
    const p = this.pos.get(marketId);
    if (!p) return 0;
    const m = this.markPrice.get(marketId) ?? 0.5;
    if (p.q >= 0) return p.q * m; // long YES loses its mark if NO resolves
    return -p.q * (1 - m); // short YES loses (1 - m) per contract if YES resolves
  }

  private sumWhere(pred: (p: Pos) => boolean): number {
    let s = 0;
    for (const p of this.pos.values()) if (pred(p)) s += this.exposureMarket(p.cfg.marketId);
    return s;
  }

  private capFor(kind: ScopeKind, id: string): number {
    if (kind === "company") return this.caps.company;
    if (kind === "category") return this.caps.category[id] ?? this.caps.defaults.category;
    if (kind === "event") return this.caps.event[id] ?? this.caps.defaults.event;
    return this.caps.market[id] ?? this.caps.defaults.market;
  }

  scopesForMarket(marketId: string): ScopeStatus[] {
    const p = this.pos.get(marketId);
    if (!p) return [];
    const { category, eventId } = p.cfg;
    const build = (kind: ScopeKind, id: string, exposure: number): ScopeStatus => {
      const cap = this.capFor(kind, id);
      const utilisation = cap > 0 ? exposure / cap : 0;
      return { kind, id, exposure, cap, utilisation, stage: stageFor(utilisation) };
    };
    return [
      build("company", "ALL", this.sumWhere(() => true)),
      build("category", category, this.sumWhere((x) => x.cfg.category === category)),
      build("event", eventId, this.sumWhere((x) => x.cfg.eventId === eventId)),
      build("market", marketId, this.exposureMarket(marketId)),
    ];
  }

  /** Governing stage = max across the four scopes; binding = least-headroom scope. */
  governing(marketId: string): { stage: number; binding: ScopeStatus; scopes: ScopeStatus[] } {
    const scopes = this.scopesForMarket(marketId);
    let stage = 0;
    let binding = scopes[0];
    for (const s of scopes) {
      if (s.stage > stage) stage = s.stage;
      if (s.utilisation > binding.utilisation) binding = s;
    }
    return { stage, binding, scopes };
  }

  snapshot() {
    const company = this.scopesForMarket([...this.pos.keys()][0]!)[0];
    const seenC = new Set<string>();
    const seenE = new Set<string>();
    const categories: ScopeStatus[] = [];
    const events: ScopeStatus[] = [];
    const markets: ScopeStatus[] = [];
    for (const p of this.pos.values()) {
      const [, cat, ev, mkt] = this.scopesForMarket(p.cfg.marketId);
      if (!seenC.has(cat.id)) { categories.push(cat); seenC.add(cat.id); }
      if (!seenE.has(ev.id)) { events.push(ev); seenE.add(ev.id); }
      markets.push(mkt);
    }
    return { company, categories, events, markets };
  }
}
