// Dev tool: report human-label / scan-observation coverage against the catalog.
// Usage:
//   node dev/vision-label-coverage.mjs <cards.json> <run-report.json> [<human-label.json>]
// Output: counts + examples for each coverage bucket.
import { readFileSync } from 'node:fs';

const [cardsPath, runPath, labelPath] = process.argv.slice(2);
if (!cardsPath || !runPath) {
  console.error('usage: node dev/vision-label-coverage.mjs <cards.json> <run-report.json> [<human-label.json>]');
  process.exit(1);
}

const root = JSON.parse(readFileSync(cardsPath, 'utf8'));
const catalog = Array.isArray(root) ? root : root.cards;
const cardById = new Map();
for (const c of catalog) if (c.id) cardById.set(String(c.id), c);

const run = JSON.parse(readFileSync(runPath, 'utf8'));
const observedNames = new Set();
const observedIds = new Set();
for (const card of run.result?.cards ?? []) {
  observedNames.add(card.name);
  if (card.id) observedIds.add(String(card.id));
}

const labeledIds = new Set();
const labeledNames = new Set();
if (labelPath) {
  const label = JSON.parse(readFileSync(labelPath, 'utf8'));
  for (const c of label.cards ?? []) {
    labeledIds.add(String(c.id));
    if (c.fields?.name?.status === 'known') labeledNames.add(c.fields.name.value);
  }
}

let labeled = 0, observedOnly = 0, neither = 0;
const examplesNeither = [];
for (const c of catalog) {
  const id = String(c.id);
  const hasLabel = labeledIds.has(id) || labeledNames.has(c.name);
  const hasObs = observedIds.has(id) || observedNames.has(c.name);
  if (hasLabel) labeled += 1;
  else if (hasObs) observedOnly += 1;
  else { neither += 1; if (examplesNeither.length < 15) examplesNeither.push(c.name); }
}

console.log(JSON.stringify({
  catalogTotal: catalog.length,
  labeled,
  observedOnly,
  neither,
  examplesNeither,
  interpretation: 'Coverage is a tracking aid, not correctness or existence proof. Unobserved cards remain unverified, not absent.'
}, null, 2));
