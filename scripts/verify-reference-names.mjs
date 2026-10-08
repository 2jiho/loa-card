import { readFile } from "node:fs/promises";

const [referencePath, ...scanPaths] = process.argv.slice(2);
if (!referencePath || !scanPaths.length)
  throw new Error("Usage: node scripts/verify-reference-names.mjs reference.json scan.json [scan.json ...]");
const reference = JSON.parse(await readFile(referencePath, "utf8"));
const names = new Set(reference.cards.map(card => card.name));
if (!Number.isInteger(reference.expected) || names.size !== reference.expected ||
    names.size !== reference.cards.length)
  throw new Error("Reference must contain the complete, unique name list and independently read total.");
for (const path of scanPaths) {
  const scan = JSON.parse(await readFile(path, "utf8"));
  const actual = new Set(scan.cards.map(card => card.name));
  const missing = [...names].filter(name => !actual.has(name));
  const extra = [...actual].filter(name => !names.has(name));
  const duplicates = scan.cards.length - actual.size;
  const headerMatches = scan.expected === reference.expected;
  const reviews = scan.cards.filter(card => card.review?.length).map(card => ({ name: card.name, review: card.review }));
  console.log(JSON.stringify({ path, recognized: actual.size, expected: names.size,
    headerMatches, missing, extra, duplicates, reviews,
    scope: "Reference-name agreement only; not independent full-field ground truth." }, null, 2));
  if (!headerMatches || missing.length || extra.length || duplicates) process.exitCode = 1;
}
