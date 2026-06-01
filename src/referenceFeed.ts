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
 */

export interface ReferenceQuote {
  referencePrice: number; // midpoint of venues, in [0,1]
  venueA: number;
  venueB: number;
  disagreement: number; // |venueA - venueB|
  fresh: boolean; // false if venues are stale/missing
}

export interface ReferenceFeed {
  get(marketId: string): ReferenceQuote;
}

/** Production stub: drop your venue polling here. */
export class RealReferenceFeed implements ReferenceFeed {
  get(_marketId: string): ReferenceQuote {
    // TODO: poll Kalshi + Polymarket -> implied prob -> de-vig -> expose below.
    throw new Error("RealReferenceFeed not wired in this environment");
  }
}

/** Simulated two-venue consensus. Each venue random-walks around a shared truth. */
export class SimulatedReferenceFeed implements ReferenceFeed {
  private state = new Map<
    string,
    { truth: number; a: number; b: number; step: number }
  >();

  constructor(marketIds: string[]) {
    for (const id of marketIds) {
      const truth = 0.3 + Math.random() * 0.4;
      this.state.set(id, {
        truth,
        a: truth,
        b: truth,
        step: 0.006 + Math.random() * 0.01,
      });
    }
  }

  /** Advance both venues one tick; they track a slowly drifting shared truth. */
  step() {
    for (const s of this.state.values()) {
      s.truth = Math.min(0.97, Math.max(0.03, s.truth + (Math.random() - 0.5) * 2 * s.step));
      // each venue noisily tracks truth, occasionally diverging
      s.a = Math.min(0.98, Math.max(0.02, s.truth + (Math.random() - 0.5) * 0.03));
      s.b = Math.min(0.98, Math.max(0.02, s.truth + (Math.random() - 0.5) * 0.03));
    }
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
