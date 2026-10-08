import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";
const result = JSON.parse(await readFile(process.argv[2], "utf8"));
const truth = JSON.parse(await readFile("tests/fixtures/manual-screenshot-cards.json", "utf8"));
assert.equal(result.expected, 384, "Read the on-screen owned-type total independently");
assert.equal(result.capacity, 450);
assert.equal(result.cards.length, result.expected);
assert.equal(new Set(result.cards.map(card => card.name)).size, result.cards.length);
for (const expected of truth) {
  const actual = result.cards.find(card => card.name === expected.name);
  assert.ok(actual, `${expected.name}: missing`);
  assert.equal(actual.awakening, expected.awakening, `${expected.name}: awakening`);
  assert.equal(actual.extraCopies, expected.extraCopies, `${expected.name}: extra copies`);
}
console.log(`384 unique names and ${truth.length} manually labelled card fields passed. This is not full-field ground truth for all 384 cards.`);
