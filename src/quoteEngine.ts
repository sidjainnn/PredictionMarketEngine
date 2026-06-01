/**
 * QUOTE ENGINE — Reference-anchored, inventory-aware, adaptive spread.
 *
 * This is a deliberately simplified maker. It is INSPIRED BY Avellaneda-Stoikov's
 * inventory-aware reservation price, but uses a linear inventory term instead of
 * the full stochastic-control machinery, because on a [0,1] probability scale that
 * first-order term is all we need and it's far easier to explain and tune.
 *
 *   reservation_price = reference_price - inventory * inventory_coefficient
 *
 *   spread = base_spread
 *          + inventory_risk_component      (more imbalance  => wider)
 *          + external_disagreement_component(venues disagree => wider)
 *
 *   yes_bid = reservation - spread/2
 *   yes_ask = reservation + spread/2
 *
 * NO is derived as the mirror (see exchange.ts), preserving:
 *   yes_bid + no_ask = 1   and   yes_ask + no_bid = 1   (no arbitrage)
 */

export interface QuoteParams {
  baseSpread: number; // e.g. 0.02  (2 cents)
  inventoryCoefficient: number; // reservation skew per contract of inventory
  inventoryRiskCoefficient: number; // spread widening per contract of |inventory|
  disagreementCoefficient: number; // spread widening per unit venue disagreement
}

export interface QuoteInputs {
  referencePrice: number; // external consensus YES probability
  inventory: number; // signed YES contracts (long > 0)
  disagreement: number; // |venueA - venueB| in price units
  params: QuoteParams;
  /** Risk-stage overrides applied by the exchange. */
  sizeMultiplier: number; // Stage 1: reduce size  (1.0 normal)
  extraSpread: number; // Stage 2: widen spread (additive)
  /** Stage 3: suppress one side. "BID"|"ASK"|null */
  suppress: "BID" | "ASK" | null;
}

export interface Quote {
  referencePrice: number;
  reservation: number;
  spread: number;
  bid: number | null; // null when suppressed (one-sided quoting)
  ask: number | null;
  sizeMultiplier: number;
}

const clamp01 = (x: number) => Math.min(0.99, Math.max(0.01, x));

export function computeQuote(inp: QuoteInputs): Quote {
  const { referencePrice, inventory, disagreement, params } = inp;

  const reservation = referencePrice - inventory * params.inventoryCoefficient;

  const spread =
    params.baseSpread +
    Math.abs(inventory) * params.inventoryRiskCoefficient +
    disagreement * params.disagreementCoefficient +
    inp.extraSpread;

  const half = spread / 2;
  // Compute then clamp; if both sides clamp to the same bound (extreme inventory),
  // force a minimum 1-cent gap so we never quote a zero-width or crossed market.
  let bid = inp.suppress === "BID" ? null : clamp01(reservation - half);
  let ask = inp.suppress === "ASK" ? null : clamp01(reservation + half);
  if (bid !== null && ask !== null && ask - bid < 0.01) {
    const mid = (bid + ask) / 2;
    bid = clamp01(mid - 0.005);
    ask = clamp01(mid + 0.005);
  }

  return {
    referencePrice,
    reservation,
    spread,
    bid,
    ask,
    sizeMultiplier: inp.sizeMultiplier,
  };
}
