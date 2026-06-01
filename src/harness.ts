import { Exchange } from "./exchange.js";
import { MARKETS, CAPS, MAKER } from "./config.js";
import { STAGE_NAME } from "./risk.js";

const ex = new Exchange(MARKETS, CAPS, MAKER);
const N = Number(process.argv[2] ?? 400);
const doStress = process.argv.includes("--stress");

for (let i = 0; i < N; i++) ex.tick();
if (doStress) ex.stress("politics", "BUY", 30, 16);

const row = (id: string) => {
  const b = ex.books.get(id)!;
  const { ref, inv, stage, binding, quote, size } = ex.quoteFor(id);
  const yb = quote.bid, ya = quote.ask;
  const f = (x: number | null) => (x === null ? " -- " : x.toFixed(3));
  const noB = ya === null ? null : 1 - ya;
  const noA = yb === null ? null : 1 - yb;
  const ltp = b.ltp != null ? b.ltp.toFixed(3) : "  -  ";
  return `${id.padEnd(13)} ref=${ref.referencePrice.toFixed(3)} dis=${ref.disagreement.toFixed(3)} ltp=${ltp}  YES ${f(yb)}/${f(ya)}  NO ${f(noB)}/${f(noA)}  sz=${String(size).padStart(2)} inv=${inv.toFixed(0).padStart(4)} exp=${ex.risk.exposureMarket(id).toFixed(0).padStart(4)} S${stage}:${STAGE_NAME[stage]} [bind ${binding.kind}=${binding.utilisation.toFixed(2)}]`;
};

console.log(`after ${N} ticks${doStress ? " + politics BUY stress" : ""}\n`);
for (const id of ex.books.keys()) console.log(row(id));

const r = ex.risk.snapshot();
console.log(`\nCOMPANY  exp=${r.company.exposure.toFixed(0)}/${r.company.cap} util=${r.company.utilisation.toFixed(2)} S${r.company.stage}`);
console.log("CATEGORY " + r.categories.map((c) => `${c.id}:${c.exposure.toFixed(0)}/${c.cap}(${c.utilisation.toFixed(2)}S${c.stage})`).join("  "));
console.log("EVENT    " + r.events.map((e) => `${e.id}:${e.utilisation.toFixed(2)}S${e.stage}`).join("  "));

// Invariants on a live two-sided market
const live = [...ex.books.keys()].find((id) => {
  const q = ex.quoteFor(id).quote; return q.bid !== null && q.ask !== null;
})!;
const q = ex.quoteFor(live).quote;
console.log(`\nINVARIANTS (${live})`);
console.log(` YES_bid + NO_ask = ${(q.bid! + (1 - q.bid!)).toFixed(3)}  (must = 1.000)`);
console.log(` YES_ask + NO_bid = ${(q.ask! + (1 - q.ask!)).toFixed(3)}  (must = 1.000)`);
console.log(` overround: YES_ask+NO_ask = ${(q.ask! + (1 - q.bid!)).toFixed(3)} (>1)  underround: YES_bid+NO_bid = ${(q.bid! + (1 - q.ask!)).toFixed(3)} (<1)`);
