import { readFile } from "node:fs/promises";
const path = process.argv[2];
if (!path)
  throw new Error("Usage: node scripts/verify-scan.mjs exported-scan.json");
const actual = JSON.parse(await readFile(path, "utf8"));
const truth = JSON.parse(
  await readFile(
    new URL("../tests/fixtures/first-row.json", import.meta.url),
    "utf8",
  ),
);
const failures = [];
const manual = JSON.parse(await readFile(new URL("../tests/fixtures/manual-cards.json", import.meta.url), "utf8"));
const expectedCards = [...truth.cards, ...manual];
const counters = JSON.parse(await readFile(new URL("../tests/fixtures/manual-counters.json", import.meta.url), "utf8"));
if (actual.expected !== truth.expectedOwnedTypes)
  failures.push(`Header: ${actual.expected} != ${truth.expectedOwnedTypes}`);
for (const expected of expectedCards) {
  const found = actual.cards.find((c) => c.name === expected.name);
  if (!found) {
    failures.push(`Missing ${expected.name}`);
    continue;
  }
  for (const key of ["awakening", "extraCopies"])
    if (found[key] !== expected[key])
      failures.push(
        `${expected.name}: ${key} ${found[key]} != ${expected[key]}`,
      );
}
for (const expected of counters) {
  const found = actual.cards.find(c => c.name === expected.name);
  if (!found) failures.push(`Missing counter sample ${expected.name}`);
  else if (found.extraCopies !== expected.extraCopies) failures.push(`${expected.name}: extraCopies ${found.extraCopies} != ${expected.extraCopies}`);
}
console.log(
  JSON.stringify(
    {
      identifiedTypes: actual.cards.length,
      expectedTypes: truth.expectedOwnedTypes,
      review: actual.cards.filter((c) => c.review.length).length,
      annotatedCards: expectedCards.length,
      additionalCounterSamples: counters.length,
      failures,
    },
    null,
    2,
  ),
);
if (failures.length) process.exitCode = 1;
