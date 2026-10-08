import { test } from "node:test";
import assert from "node:assert/strict";
import { estimateRowShift } from "../src/features/card-scanner/grid-motion";
const grid = (offset = 0) => Array.from({ length: 40 }, (_, i) => new Uint8Array(12).fill((i + offset * 10) * 5));

test("vertical overlap matches same columns, not horizontal rearrangement", () => {
  assert.equal(estimateRowShift(grid(), grid(1)), 1);
  assert.equal(estimateRowShift(grid(1), grid()), -1);
  const swapped = grid().map((_, i) => grid()[Math.floor(i / 10) * 10 + ((i + 1) % 10)]);
  assert.equal(estimateRowShift(grid(), swapped), null);
});
test("uniform loading tiles cannot establish a row offset", () => {
  const flat = Array.from({ length: 40 }, () => new Uint8Array(12));
  assert.equal(estimateRowShift(flat, flat), null);
});
