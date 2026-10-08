import { test } from "node:test";
import assert from "node:assert/strict";
import { consensus } from "../src/features/card-scanner/consensus.ts";
import type { ScannedCard } from "../src/features/card-scanner/recognizer.ts";
const observation = (
  awakening: number | null,
  extraCopies: number | null,
): ScannedCard => ({
  id: "1",
  name: "테스트 카드",
  awakening,
  extraCopies,
  confidence: 0.95,
  review: [],
  image: "",
  time: 0,
  observations: 1,
});
test("unknown later readings cannot erase known counts", () => {
  const card = consensus([observation(4, 2), observation(null, null)]);
  assert.equal(card.awakening, 4);
  assert.equal(card.extraCopies, 2);
});
test("a named card survives missing fields and later observations repair each field independently", () => {
  const first = consensus([observation(null, 3)]);
  assert.equal(first.name, "테스트 카드");
  assert.equal(first.awakening, null);
  assert.equal(first.extraCopies, 3);
  assert.ok(first.review.includes("각성 확인"));
  const repaired = consensus([first, observation(2, null)]);
  assert.equal(repaired.name, first.name);
  assert.equal(repaired.awakening, 2);
  assert.equal(repaired.extraCopies, 3);
  assert.ok(!repaired.review.includes("각성 확인"));
});
test("conflicting readings remain reviewable until repeated evidence resolves them", () => {
  const wrong = observation(0, 0),
    correct = observation(4, 2);
  assert.ok(consensus([wrong, correct]).review.includes("각성 관측 충돌"));
  const card = consensus([wrong, correct, correct, correct]);
  assert.equal(card.awakening, 4);
  assert.equal(card.extraCopies, 2);
  assert.equal(card.review.length, 0);
});
test("repeated observations do not add copies together", () => {
  const card = consensus([
    observation(4, 2),
    observation(4, 2),
    observation(4, 2),
  ]);
  assert.equal(card.extraCopies, 2);
  assert.equal(card.observations, 3);
});
test("manual verified values survive later automatic observations", () => {
  const manual = {
    ...observation(4, 3),
    manual: ["awakening", "extraCopies"] as const,
  };
  const card = consensus([
    { ...manual, manual: [...manual.manual] },
    observation(0, 15),
    observation(0, 15),
  ]);
  assert.equal(card.awakening, 4);
  assert.equal(card.extraCopies, 3);
  assert.equal(card.review.length, 0);
});
test("selected values cannot silently produce an impossible awakening/count pair", () => {
  const card = consensus([observation(5, 15)]);
  assert.ok(card.review.includes("각성·장수 조합 확인"));
});
test("latest reliable complete observation keeps awakening and count from the same capture", () => {
  const old = { ...observation(3, 9), captureOrder: 1, countReliable: true };
  const current = { ...observation(0, 15), captureOrder: 2, countReliable: true };
  const result = consensus([old, old, old, current]);
  assert.equal(result.awakening, 0);
  assert.equal(result.extraCopies, 15);
  assert.ok(!result.review.includes("각성·장수 조합 확인"));
  const newer = { ...observation(3, 9), captureOrder: 3, countReliable: true };
  const deferred = consensus([current, newer, old]);
  assert.equal(deferred.awakening, 3);
  assert.equal(deferred.extraCopies, 9);
});
test("invalid or unreliable pairs cannot replace a complete reliable capture", () => {
  const valid = { ...observation(3, 9), captureOrder: 1, countReliable: true };
  const invalid = { ...observation(3, 15), captureOrder: 2, countReliable: true };
  const weak = { ...observation(0, 15), captureOrder: 3, countReliable: false };
  const result = consensus([valid, invalid, weak]);
  assert.equal(result.awakening, 3);
  assert.equal(result.extraCopies, 9);
});
test("a changed count uses the latest reliable reading instead of historical majority", () => {
  const old = observation(0, 15),
    current = observation(0, 12);
  const card = consensus([old, old, old, current]);
  assert.equal(card.extraCopies, 12);
  assert.ok(!card.review.some((reason) => reason.includes("장수 관측 충돌")));
  assert.equal(consensus([current, observation(0, 0)]).extraCopies, 0);
});
test("deferred OCR processing cannot overwrite a later captured count and video time can restart", () => {
  const later = {
    ...observation(0, 12),
    captureOrder: 20,
    time: 0,
    image: "new",
  };
  const earlier = {
    ...observation(0, 15),
    captureOrder: 10,
    time: 200,
    image: "old",
  };
  const card = consensus([later, earlier]);
  assert.equal(card.extraCopies, 12);
  assert.equal(card.image, "new");
  assert.equal(card.time, 0);
  assert.equal(card.captureOrder, 20);
});
test("unreadable, out-of-range and unstable later counters do not replace a reliable count", () => {
  const reliable = { ...observation(0, 12), countReliable: true };
  assert.equal(consensus([reliable, observation(0, null)]).extraCopies, 12);
  assert.equal(consensus([reliable, observation(0, 16)]).extraCopies, 12);
  assert.equal(
    consensus([reliable, { ...observation(0, 1), countReliable: false }])
      .extraCopies,
    12,
  );
  assert.equal(
    consensus([{ ...observation(0, 2), countReliable: false }]).extraCopies,
    2,
  );
});

test("a count seen only during motion stays reviewable until a reliable capture", () => {
  const moving = { ...observation(0, 2), countReliable: false };
  assert.ok(consensus([moving]).review.includes("장수 안정 관측 필요"));
  assert.ok(
    !consensus([
      moving,
      { ...observation(0, 12), countReliable: true },
    ]).review.some((r) => r.includes("장수")),
  );
});

test("manual name verification clears OCR name review after rescanning", () => {
  const manual = {
    ...observation(0, 2),
    name: "확인한 이름",
    manual: ["name"] as "name"[],
  };
  const automatic = { ...observation(0, 2), review: ["이름 확인"] };
  const card = consensus([manual, automatic]);
  assert.equal(card.name, "확인한 이름");
  assert.ok(!card.review.some((r) => r.includes("이름")));
});

test("count diagnostics follow the representative capture rather than an older name reading", () => {
  const old = { ...observation(3, null), captureOrder: 1 };
  const diagnostic = { maximum: 9, reason: "보조 OCR 불일치", readings: [
    { engine: "PP-OCRv6", text: "+9", confidence: 80, value: 9 },
  ] };
  const current = { ...observation(3, null), captureOrder: 2, countDiagnostics: diagnostic };
  assert.deepEqual(consensus([old, current]).countDiagnostics, diagnostic);
});

test("count evidence and preview prefer the reliable capture over an equally valued moving crop", () => {
  const reliable = { ...observation(0, 12), captureOrder: 1, countReliable: true,
    image: "reliable", countDiagnostics: { maximum: 15, reason: "strong", readings: [] } };
  const moving = { ...observation(0, 12), captureOrder: 2, countReliable: false,
    image: "moving", countDiagnostics: { maximum: 15, reason: "weak", readings: [] } };
  const result = consensus([reliable, moving]);
  assert.equal(result.image, "reliable");
  assert.equal(result.countDiagnostics?.reason, "strong");
});

test("a guessed identity cannot overwrite the fields of a confirmed card", () => {
  const confirmed = { ...observation(2, 10), captureOrder: 1, countReliable: true, image: "confirmed" };
  const guessed = { ...observation(0, 15), captureOrder: 2, countReliable: true,
    image: "another-card", review: ["이름 확인"] };
  const result = consensus([confirmed, guessed]);
  assert.equal(result.awakening, 2);
  assert.equal(result.extraCopies, 10);
  assert.equal(result.image, "confirmed");
  assert.equal(result.review.length, 0);
  const repaired = consensus([guessed, confirmed]);
  assert.equal(repaired.extraCopies, 10);
});

test("manual fields remain authoritative even when their name is under review", () => {
  const confirmed = { ...observation(0, 15), countReliable: true };
  const manual = { ...observation(3, 8), review: ["이름 확인"],
    manual: ["awakening", "extraCopies"] as ("awakening" | "extraCopies")[] };
  const result = consensus([confirmed, manual]);
  assert.equal(result.awakening, 3);
  assert.equal(result.extraCopies, 8);
  assert.equal(result.countReliable, true);
});
