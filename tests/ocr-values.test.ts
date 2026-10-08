import assert from "node:assert/strict";
import { test } from "node:test";
import {
  parseExtraCopies,
  parseInventoryTotal,
} from "../src/features/card-scanner/ocr-values.ts";
test("inventory OCR accepts the complete owned/capacity pair only", () => {
  assert.deepEqual(parseInventoryTotal(" (384 / 450)\n"), {
    owned: 384,
    capacity: 450,
  });
  for (const text of [
    "384",
    "384 /",
    "384 / 45",
    "384 450",
    "0/450",
    "384/9999",
  ])
    assert.equal(parseInventoryTotal(text), null, text);
});
test("copy OCR rejects incomplete digits and values outside awakening capacity", () => {
  for (const count of [1, 7, 10, 15])
    assert.equal(parseExtraCopies(`+${count}\n`), count);
  for (const text of ["+", "+?", "7", "+0", "+16", "+1+2"])
    assert.equal(parseExtraCopies(text), null, text);
  assert.equal(parseExtraCopies("+6", 5), null);
  assert.equal(parseExtraCopies("+5", 5), 5);
});
