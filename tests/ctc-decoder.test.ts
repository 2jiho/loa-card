import { test } from "node:test";
import assert from "node:assert/strict";
import { decodeCtc } from "../src/features/card-scanner/ctc-decoder.ts";
function probabilities(indices: number[], classes: number) {
  return Float32Array.from(
    indices.flatMap((index) =>
      Array.from({ length: classes }, (_, c) => (c === index ? 0.95 : 0.01)),
    ),
  );
}
test("CTC preserves repeated digits separated by blank and composes Korean jamo", () => {
  const chars = ["", "+", "1", "ᄀ", "ᅡ"];
  assert.equal(
    decodeCtc(probabilities([1, 1, 0, 2, 2, 0, 2], 5), 7, chars).text,
    "+11",
  );
  assert.equal(decodeCtc(probabilities([3, 0, 4], 5), 3, chars).text, "가");
  assert.equal(decodeCtc(probabilities([0, 0], 5), 2, chars).confidence, 0);
});
test("CTC rejects a model output with a mismatched vocabulary", () => {
  assert.throws(() => decodeCtc(new Float32Array(3), 2, ["", "1"]));
});
