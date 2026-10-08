import { test } from "node:test";
import assert from "node:assert/strict";
import { insideCard, inspectCapture, CaptureObservations, sameFieldObservation, settledFields } from "../src/features/card-scanner/capture-quality";

function faintNameImage() {
  const image = new Uint8Array(140 * 210 * 4).fill(120);
  // Low-saturation but visible strokes: border evidence must preserve these.
  for (let y = 18; y < 29; y++) for (let x = 64; x < 67; x++)
    image.set([132, 132, 132, 255], (y * 140 + x) * 4);
  return image;
}
test("individual cards remain collectable when other grid slots are offscreen", () => {
  const viewport = { x: 0, y: 0, width: 500, height: 400 };
  assert.equal(insideCard({ x: 20, y: 10, width: 140, height: 210 }, viewport), true);
  assert.equal(insideCard({ x: 20, y: 250, width: 140, height: 210 }, viewport), false);
  assert.equal(insideCard({ x: -1, y: 10, width: 140, height: 210 }, viewport), false);
});
test("quality exclusions have explicit reasons and never require OCR or jewels", () => {
  const image = faintNameImage();
  assert.match(inspectCapture(image, 140, 210, false, true).reason, /잘림/);
  assert.equal(inspectCapture(image, 140, 210, true, false).usable, false);
  assert.equal(inspectCapture(image, 140, 210, true, true).usable, true);
  assert.equal(inspectCapture(image.subarray(0, 5), 140, 210, true, true).usable, false);
});
test("strong independent borders preserve weak-color crops without accepting cut or moving cards", () => {
  const image = faintNameImage();
  assert.equal(inspectCapture(image, 140, 210, true, false, true, true).usable, true);
  assert.equal(inspectCapture(image, 140, 210, false, false, true, true).usable, false);
  assert.equal(inspectCapture(image, 140, 210, true, false, false, true).usable, false);
});
test("a better or stable observation can replace a duplicate; columns stay independent", () => {
  const store = new CaptureObservations(), image = new Uint8Array(30).fill(100);
  assert.equal(store.offer(image, 0, 10, false), "new");
  assert.equal(store.offer(image, 0, 10.1, false), "duplicate");
  assert.equal(store.offer(image, 0, 14, false), "better");
  assert.equal(store.offer(image, 0, 12, true), "better");
  assert.equal(store.offer(image, 0, 20, false), "duplicate");
  assert.equal(store.offer(image, 1, 12, true), "new");
  assert.equal(store.offer(new Uint8Array(30).fill(160), 0, 12, true), "new");
});

test("only an individually stable or confidently aligned crop passes movement quality", () => {
  const image = faintNameImage();
  assert.match(inspectCapture(image, 140, 210, true, true, false).reason, /이동 중/);
  assert.equal(inspectCapture(image, 140, 210, true, true, true).usable, true);
});

test("counter changes are not hidden in the unchanged portrait average", () => {
  const store = new CaptureObservations(), before = new Uint8Array(3240).fill(100), after = before.slice();
  after.fill(104, 864, 2016);
  assert.equal(store.offer(before, 0, 10, true), "new");
  assert.equal(store.offer(after, 0, 10, true), "new");
});

test("portrait animation does not prevent stable name, count and jewel readings", () => {
  const before = new Uint8Array(3240).fill(100), after = before.slice();
  after.fill(180, 2592);
  assert.equal(sameFieldObservation(before, after), true);
  for (const [from, to] of [[0, 864], [864, 2016], [2016, 2592]]) {
    const moving = after.slice();
    moving.fill(104, from, to);
    assert.equal(sameFieldObservation(before, moving), false);
  }
  assert.equal(sameFieldObservation(before.subarray(0, 10), after), false);
});

test("settled fields follow vertical scrolling while preserving card identity and column", () => {
  const card = new Uint8Array(3240).fill(100), different = card.slice();
  different.fill(180, 0, 864);
  const previous = Array.from({ length: 40 }, () => different.slice());
  previous[22] = card;
  assert.equal(settledFields(card, 12, previous), true);
  assert.equal(settledFields(card, 32, previous), true);
  assert.equal(settledFields(card, 11, previous), false);
  assert.equal(settledFields(card, 12, []), false);
});
test("duplicate groups remain stable across brightness-bin boundaries", () => {
  const store = new CaptureObservations(), a = new Uint8Array(3240).fill(111), b = new Uint8Array(3240).fill(112);
  const first = store.offerDetailed(a, 3, 10, false), second = store.offerDetailed(b, 3, 12, true);
  assert.equal(second.id, first.id); assert.equal(second.decision, "better");
  assert.equal(store.offerDetailed(b, 4, 12, true).decision, "new");
  const renamed = b.slice(); renamed.fill(150, 0, 864);
  assert.notEqual(store.offerDetailed(renamed, 3, 12, true).id, first.id);
});
