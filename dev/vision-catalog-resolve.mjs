// Dev tool: resolve ambiguous vision OCR hypotheses against the game card catalog.
// Usage:
//   node dev/vision-catalog-resolve.mjs <cards.json> <hypotheses.json>
// Output: per-cell ranked catalog candidates (top 5) with a normalized similarity score.
// This is candidate compression only; it never certifies a reading as ground truth.
import { readFileSync } from 'node:fs';

const [cardsPath, hypothesesPath] = process.argv.slice(2);
if (!cardsPath || !hypothesesPath) {
  console.error('usage: node dev/vision-catalog-resolve.mjs <cards.json> <hypotheses.json>');
  process.exit(1);
}

const catalogRoot = JSON.parse(readFileSync(cardsPath, 'utf8'));
const catalog = Array.isArray(catalogRoot) ? catalogRoot : catalogRoot.cards;
const hypotheses = JSON.parse(readFileSync(hypothesesPath, 'utf8'));

const names = [];
for (const card of catalog) {
  if (card && typeof card.name === 'string' && card.name.trim()) names.push(card.name.trim());
  if (Array.isArray(card?.aliases)) for (const a of card.aliases) if (typeof a === 'string' && a.trim()) names.push(a.trim());
}
const uniqueNames = [...new Set(names)];

function normalize(s) {
  return s.normalize('NFC').replace(/\s+/g, '').toLowerCase();
}

function bigrams(s) {
  const out = new Set();
  for (let i = 0; i < s.length - 1; i++) out.add(s.slice(i, i + 2));
  return out;
}

function similarity(a, b) {
  const A = bigrams(a), B = bigrams(b);
  if (!A.size && !B.size) return a === b ? 1 : 0;
  let inter = 0;
  for (const g of A) if (B.has(g)) inter += 1;
  return (2 * inter) / (A.size + B.size);
}

const results = hypotheses.cells.map(cell => {
  const obs = cell.observations.map(normalize);
  const scored = [];
  for (const name of uniqueNames) {
    const n = normalize(name);
    let best = 0;
    for (const o of obs) {
      const s = similarity(o, n);
      // exact match on normalized form is maximal
      if (o === n) { best = 1; break; }
      if (s > best) best = s;
    }
    if (best > 0) scored.push({ name, score: Number(best.toFixed(3)) });
  }
  scored.sort((a, b) => b.score - a.score);
  return { col: cell.col, observations: cell.observations, candidates: scored.slice(0, 5) };
});

console.log(JSON.stringify({ caseId: hypotheses.caseId, video: hypotheses.video, row: hypotheses.row, cells: results }, null, 2));
