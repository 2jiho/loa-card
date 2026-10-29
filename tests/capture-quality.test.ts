import { test } from "node:test";
import assert from "node:assert/strict";
import { insideCard, inspectCapture, CaptureObservations, sameCapture, sameFieldObservation, settledFields } from "../src/features/card-scanner/capture-quality";

test('field comparison preserves strict budgets at every field boundary',()=>{
 const a=new Uint8Array(3240),b=a.slice();
 for(const [from,to,limit] of [[0,864,2.5],[864,2016,2.5],[2016,2592,2.5],[2592,3240,5]]){
  b.fill(0);let remaining=(to-from)*limit-1;
  for(let i=from;i<to&&remaining;i++){b[i]=Math.min(255,remaining);remaining-=b[i];}
  assert.equal(sameCapture(a,b),true);
  // Add the final unit at the end, so an early exit must not round the budget.
  b[to-1]++;
  assert.equal(sameCapture(a,b),false);
  assert.equal(sameFieldObservation(a,b),from===2592);
 }
});

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

test('a changing representative is indexed in its new bin throughout gradual brightness drift',()=>{
  const store=new CaptureObservations();
  let score=10;const initial=store.offerDetailed(new Uint8Array(3240).fill(111),2,score,true);
  for(let brightness=113;brightness<150;brightness+=2){
    score=score*1.2+1;
    const next=store.offerDetailed(new Uint8Array(3240).fill(brightness),2,score,true);
    assert.equal(next.id,initial.id,`brightness ${brightness}`);
    assert.equal(next.decision,'better');
  }
  assert.equal(store.size,1);
});

test('matching metadata is LRU bounded without reusing observation IDs or dropping new candidates',()=>{
  const store=new CaptureObservations(2),a=new Uint8Array(3240).fill(50),b=new Uint8Array(3240).fill(100),c=new Uint8Array(3240).fill(150);
  const first=store.offerDetailed(a,0,1,true),second=store.offerDetailed(b,0,1,true);
  assert.equal(store.offerDetailed(a,0,1,true).id,first.id);
  store.offerDetailed(c,0,1,true);
  assert.equal(store.size,2);
  assert.equal(store.offerDetailed(a,0,1,true).id,first.id);
  const reobserved=store.offerDetailed(b,0,1,true);
  assert.equal(reobserved.decision,'new');assert.ok(reobserved.id>second.id);
});
