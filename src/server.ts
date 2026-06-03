import express from "express";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { Exchange } from "./exchange.js";
import { MARKETS, CAPS, MAKER, MODEL_MARKETS, VENUE_MARKETS } from "./config.js";
import { STAGE_NAME } from "./risk.js";
import { HybridReferenceFeed, RealReferenceFeed } from "./referenceFeed.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json());
app.use(express.static(join(__dirname, "..", "public")));

const feed = new HybridReferenceFeed(MARKETS.map(m => m.marketId), MODEL_MARKETS);
const ex = new Exchange(MARKETS, CAPS, MAKER, feed);

// RealReferenceFeed runs in parallel purely for the comparison panel.
// It polls Kalshi + Polymarket and does NOT affect maker quotes.
// Swap the maker's feed to this once real venue access is confirmed.
const realFeed = new RealReferenceFeed(VENUE_MARKETS, 15_000);
setInterval(() => {
  // Push live external prices BEFORE the tick so the maker's anchor eases toward
  // them and informed agents trade toward them. This is what makes our discovered
  // price converge to the real exchange (Kalshi/Polymarket).
  const hybrid = ex.feed as HybridReferenceFeed;
  for (const s of realFeed.snapshot()) {
    const ext = s.polymarket.mid ?? s.kalshi.mid; // prefer Polymarket, fall back to Kalshi
    ex.agents.setExternalAnchor(s.marketId, ext);
    hybrid.setExternalRef?.(s.marketId, ext);
  }

  ex.tick();

  // Keep realFeed's "our price" in sync for the comparison panel.
  for (const id of ex.books.keys()) {
    realFeed.setOurPrice(id, ex.feed.get(id).referencePrice);
  }
}, 250); // 4 ticks/sec

app.get("/api/state", (_req, res) => {
  const markets = [...ex.books.keys()].map((id) => {
    const book = ex.books.get(id)!;
    const cfg = ex.configs.get(id)!;
    const { ref, inv, stage, binding, quote, size, spreadBase, spreadInv, spreadDis, spreadExtra } = ex.quoteFor(id);
    const yesBid = quote.bid, yesAsk = quote.ask;
    const userPos = ex.userPositionFor(id);
    return {
      ...cfg,
      book: book.snapshot(6),
      ltp: book.ltp,
      referencePrice: +ref.referencePrice.toFixed(4),
      venueA: +ref.venueA.toFixed(4),
      venueB: +ref.venueB.toFixed(4),
      disagreement: +ref.disagreement.toFixed(4),
      reservation: +quote.reservation.toFixed(4),
      spread: +quote.spread.toFixed(4),
      spreadBase: +spreadBase.toFixed(4),
      spreadInv: +spreadInv.toFixed(4),
      spreadDis: +spreadDis.toFixed(4),
      spreadExtra: +spreadExtra.toFixed(4),
      yes: { bid: yesBid, ask: yesAsk },
      no: {
        bid: yesAsk === null ? null : +(1 - yesAsk).toFixed(4),
        ask: yesBid === null ? null : +(1 - yesBid).toFixed(4),
      },
      inventory: +inv.toFixed(1),
      exposure: +ex.risk.exposureMarket(id).toFixed(2),
      quoteSize: size,
      stage,
      stageName: STAGE_NAME[stage],
      binding: { kind: binding.kind, id: binding.id, util: +binding.utilisation.toFixed(2) },
      fundamental: +ex.agents.fundamentalFor(id).toFixed(4),
      discovery: (() => {
        const d = ex.feed.discoveryFor?.(id);
        if (!d) return null;
        return {
          modelPrior:  +d.modelPrior.toFixed(4),
          discovered:  +d.discovered.toFixed(4),
          blended:     +d.blended.toFixed(4),
          weight:      +d.weight.toFixed(3),
          volume:      d.volume,
        };
      })(),
      userPosition: {
        netYesQty:    +userPos.netYesQty.toFixed(2),
        mark:         +userPos.mark.toFixed(4),
        unrealisedPnl:+userPos.unrealisedPnl.toFixed(4),
        realisedPnl:  +userPos.realisedPnl.toFixed(4),
        avgCostOpen:  userPos.avgCostOpen !== null ? +userPos.avgCostOpen.toFixed(4) : null,
      },
    };
  });
  res.json({
    markets,
    risk: ex.risk.snapshot(),
    trades: ex.recentTrades.slice(0, 20),
    agents: { enabled: ex.agents.enabled, ...ex.agents.stats() },
  });
});

app.post("/api/agents", (req, res) => {
  // Toggle the simulated trader population. enabled:false = user-only mode.
  const { enabled } = req.body ?? {};
  ex.agents.enabled = !!enabled;
  res.json({ ok: true, enabled: ex.agents.enabled });
});

app.post("/api/order", (req, res) => {
  try { res.json({ ok: true, ...ex.placeUserOrder(req.body) }); }
  catch (e: any) { res.status(400).json({ ok: false, error: e.message }); }
});

app.get("/api/orders", (_req, res) => {
  res.json(ex.userOpenOrders());
});

app.post("/api/cancel", (req, res) => {
  try {
    ex.cancelUserOrder(req.body.orderId);
    res.json({ ok: true });
  } catch (e: any) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

app.get("/api/venues", (_req, res) => {
  // Full snapshot: our price, Kalshi live, Polymarket live, delta
  const snap = realFeed.snapshot();
  const withDelta = snap.map(s => ({
    ...s,
    deltaKalshi:     s.our != null && s.kalshi.mid != null
      ? +(s.our - s.kalshi.mid).toFixed(4) : null,
    deltaPolymarket: s.our != null && s.polymarket.mid != null
      ? +(s.our - s.polymarket.mid).toFixed(4) : null,
  }));
  // Include all markets (not just those with venue config) for a complete table
  const byId = new Map(withDelta.map(s => [s.marketId, s]));
  const all = [...ex.books.keys()].map(id => {
    const base = byId.get(id) ?? {
      marketId: id,
      kalshi: { bid: null, ask: null, mid: null, ts: null },
      polymarket: { mid: null, ts: null },
      our: ex.feed.get(id).referencePrice,
      deltaKalshi: null, deltaPolymarket: null,
    };
    const our = +(ex.feed.get(id).referencePrice).toFixed(4);

    // Convergence: how close has our discovered price come to the real exchange?
    // Paras's bar: "approximate the same market on other exchanges" within 10-20%.
    const ext = base.polymarket.mid ?? base.kalshi.mid; // the external truth we target
    let convergence = null as null | {
      external: number; diffPct: number; status: "CONVERGED" | "CLOSE" | "DIVERGED";
    };
    if (ext != null && ext > 0) {
      const diffPct = Math.abs(our - ext) / ext * 100;
      convergence = {
        external: +ext.toFixed(4),
        diffPct: +diffPct.toFixed(1),
        status: diffPct <= 10 ? "CONVERGED" : diffPct <= 20 ? "CLOSE" : "DIVERGED",
      };
    }
    return { ...base, our, convergence };
  });

  // Headline: how many of the externally-listed markets are within tolerance
  const tracked = all.filter(m => m.convergence != null);
  const summary = {
    tracked: tracked.length,
    converged: tracked.filter(m => m.convergence!.status === "CONVERGED").length,
    close:     tracked.filter(m => m.convergence!.status === "CLOSE").length,
    diverged:  tracked.filter(m => m.convergence!.status === "DIVERGED").length,
  };
  res.json({ markets: all, summary });
});

app.post("/api/stress", (req, res) => {
  const { category, side } = req.body ?? {};
  ex.stress(category ?? "politics", side ?? "BUY");
  res.json({ ok: true });
});

const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;
app.listen(PORT, () => console.log(`market maker on http://localhost:${PORT}`));
