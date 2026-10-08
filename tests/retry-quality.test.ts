import { test } from "node:test";
import assert from "node:assert/strict";
import { retryEligible } from "../src/features/card-scanner/retry-quality";

test("moving name fragments alone do not occupy the expensive retry queue", () => {
  const fragment = { labelPixels: 50, stable: false, borderAlignment: .3, awakening: null, hasNameBand: false };
  assert.equal(retryEligible(fragment), false);
  assert.equal(retryEligible({ ...fragment, hasNameBand: true }), true);
  assert.equal(retryEligible({ ...fragment, awakening: 0 }), true);
  assert.equal(retryEligible({ ...fragment, stable: true }), true);
});

test("growthless and weak-color cards can retry through complete name or border evidence", () => {
  assert.equal(retryEligible({ labelPixels: 40, stable: false, borderAlignment: .2, awakening: null, hasNameBand: true }), true);
  assert.equal(retryEligible({ labelPixels: 10, stable: false, borderAlignment: .85, awakening: null, hasNameBand: false }), true);
  assert.equal(retryEligible({ labelPixels: 10, stable: true, borderAlignment: .2, awakening: null, hasNameBand: false }), false);
});

test('a covered name cannot retry just because its border and jewels survived', () => {
  const covered = { labelPixels: 200, stable: true, borderAlignment: 1, awakening: 3, hasNameBand: true, blankName: true };
  assert.equal(retryEligible(covered), false);
  assert.equal(retryEligible({ ...covered, needsIdentity: true }), false);
  assert.equal(retryEligible({ ...covered, needsIdentity: false }), true);
  assert.equal(retryEligible({ ...covered, blankName: false }), true);
});
