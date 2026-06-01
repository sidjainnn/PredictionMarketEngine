import express from "express";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { Exchange } from "./exchange.js";
import { MARKETS, CAPS, MAKER } from "./config.js";
import { STAGE_NAME } from "./risk.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json());
app.use(express.static(join(__dirname, "..", "public")));

const ex = new Exchange(MARKETS, CAPS, MAKER);
setInterval(() => ex.tick(), 250); // 4 ticks/sec

app.get("/api/state", (_req, res) => {
  const markets = [...ex.books.keys()].map((id) => {
    const book = ex.books.get(id)!;
    const cfg = ex.configs.get(id)!;
    const { ref, inv, stage, binding, quote, size } = ex.quoteFor(id);
    const yesBid = quote.bid, yesAsk = quote.ask;
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
      yes: { bid: yesBid, ask: yesAsk },
      no: { bid: yesAsk === null ? null : +(1 - yesAsk).toFixed(4),
            ask: yesBid === null ? null : +(1 - yesBid).toFixed(4) },
      inventory: +inv.toFixed(1),
      exposure: +ex.risk.exposureMarket(id).toFixed(2),
      quoteSize: size,
      stage,
      stageName: STAGE_NAME[stage],
      binding: { kind: binding.kind, id: binding.id, util: +binding.utilisation.toFixed(2) },
    };
  });
  res.json({ markets, risk: ex.risk.snapshot(), trades: ex.recentTrades.slice(0, 12) });
});

app.post("/api/order", (req, res) => {
  try { res.json({ ok: true, ...ex.placeUserOrder(req.body) }); }
  catch (e: any) { res.status(400).json({ ok: false, error: e.message }); }
});

app.post("/api/stress", (req, res) => {
  const { category, side } = req.body ?? {};
  ex.stress(category ?? "politics", side ?? "BUY");
  res.json({ ok: true });
});

const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;
app.listen(PORT, () => console.log(`market maker on http://localhost:${PORT}`));
