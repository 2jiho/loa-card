import { test } from "node:test";
import assert from "node:assert/strict";
import { confirmCounter, parseCounterEvidence } from "../src/features/card-scanner/counter-evidence.ts";
import type { CounterReading } from "../src/features/card-scanner/counter-evidence.ts";
const n = (text: string, confidence: number, variant: string): CounterReading => ({ engine: "neural", text, confidence, variant });
const t = (text: string, confidence: number, variant = "tight"): CounterReading => ({ engine: "tesseract", text, confidence, variant });

test("punctuation normalization preserves a complete digit sequence and never joins digits", () => {
  assert.deepEqual(parseCounterEvidence("+7.", 15), { value: 7, plus: true });
  assert.deepEqual(parseCounterEvidence("+.15", 15), { value: 15, plus: true });
  for (const text of ["+1.5", "+1+5", "+?", "+/", "+]", "+..15", "+0", "+19"])
    assert.equal(parseCounterEvidence(text, 15), null, text);
  assert.equal(parseCounterEvidence("+.15", 9), null);
});
test("actual +7 and +15 punctuation failures need corroborating high-confidence neural readings", () => {
  assert.equal(confirmCounter([n("+7.", 76, "raw"), n("+7.", 92, "tight")], 12), 7);
  assert.equal(confirmCounter([n("+.15", 88, "raw"), n("+.15", 92, "tight")], 15), 15);
  assert.equal(confirmCounter([n("+7.", 92, "raw")], 12), null);
  assert.equal(confirmCounter([n("+7.", 92, "raw"), n("+7.", 92, "raw")], 12), null);
});
test("moderate +9 confidence needs agreement from the other OCR engine", () => {
  const neural = [n("+9", 79, "raw"), n("+9", 85, "tight")];
  assert.equal(confirmCounter(neural, 9), null);
  assert.equal(confirmCounter([...neural, t("+9.", 67)], 9), 9);
  assert.equal(confirmCounter([...neural, t("+2", 99)], 9), null);
});
test("an out-of-range background digit cannot be shortened; masked crop must independently agree", () => {
  const neural = [n("+19", 83, "raw"), n("+1", 100, "tight")];
  assert.equal(confirmCounter(neural, 15), null);
  assert.equal(confirmCounter([...neural, n("+1", 95, "mask")], 15), 1);
  assert.equal(confirmCounter([n("+11", 83, "raw"), n("+1", 100, "tight"), n("+1", 95, "mask")], 15), null);
});
test("OCR substitutions and correlated threshold passes cannot establish a count on their own", () => {
  assert.equal(confirmCounter([t("+12", 99), t("+12", 99, "raw")], 15), null);
  assert.equal(confirmCounter([n("+12", 72, "raw"), t("+2", 99)], 15), null);
  assert.equal(confirmCounter([n("+7", 72, "raw"), t("+7", 65, "threshold-10"), t("+7", 65, "threshold-20")], 15), null);
});
