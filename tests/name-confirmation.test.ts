import { test } from "node:test";
import assert from "node:assert/strict";
import { consensus } from "../src/features/card-scanner/consensus.ts";
import { confirmSortedNames } from "../src/features/card-scanner/name-confirmation.ts";
import type { ScannedCard } from "../src/features/card-scanner/recognizer.ts";

function card(name: string, slot: number, exact = false): ScannedCard {
  return { id: name, name, awakening: 0, extraCopies: 2, confidence: .88,
    review: exact ? [] : ["이름 확인"], image: "", time: 0, observations: 1,
    capturePosition: { frame: "session/1", slot, stable: true, sort: { kind: "name", direction: "asc" } },
    nameEvidence: [{ frame: "session/1", stable: true, rawText: name + "오독", engine: "paddle", readingId: name,
      fingerprint: name, ocrConfidence: 80, score: .88, gap: .2, exact }] };
}
test("cache reuse and identical OCR errors do not count as corroboration", () => {
  const a = card("나", 1);
  assert.ok(consensus([a, a, a]).review.includes("이름 확인"));
  const b = structuredClone(a);
  b.nameEvidence![0].readingId = "new";
  b.nameEvidence![0].fingerprint = "different";
  assert.ok(consensus([a, b]).review.includes("이름 확인"));
  b.nameEvidence![0].rawText = "다른 오독";
  assert.ok(consensus([a, b]).review.includes("이름 확인"));
  b.nameEvidence![0].frame = "session/2";
  assert.equal(consensus([a, b]).nameConfirmedBy, "repeat");
  b.nameEvidence![0].stable = false;
  assert.ok(consensus([a, b]).review.includes("이름 확인"));
});
test("weak readings stay reviewable even when independent OCR agrees", () => {
  const a = card("나", 1), b = card("나", 1);
  b.nameEvidence![0] = { ...b.nameEvidence![0], readingId: "b", fingerprint: "b", engine: "tesseract", ocrConfidence: 49 };
  assert.ok(consensus([a, b]).review.includes("이름 확인"));
});
test("name sorting confirms only a unique candidate between trusted adjacent cells", () => {
  const before = card("가", 0, true), middle = card("나", 1), after = card("다", 2, true);
  const observations = [before, middle, after];
  const catalog = observations.map(c => ({ id: c.id, name: c.name, rarity: 0 }));
  assert.equal(confirmSortedNames([middle], observations, catalog)[0].nameConfirmedBy, "sort");
  assert.ok(confirmSortedNames([middle], observations, [...catalog, { id: "누", name: "누", rarity: 0 }])[0].review.includes("이름 확인"));
  after.capturePosition!.frame = "another-session/1";
  assert.ok(confirmSortedNames([middle], observations, catalog)[0].review.includes("이름 확인"));
});
test("descending order works; unknown direction and untrusted neighbors cannot confirm", () => {
  const observations = [card("다", 0, true), card("나", 1), card("가", 2, true)];
  for (const c of observations) c.capturePosition!.sort!.direction = "desc";
  const catalog = observations.map(c => ({ id: c.id, name: c.name, rarity: 0 }));
  assert.equal(confirmSortedNames([observations[1]], observations, catalog)[0].nameConfirmedBy, "sort");
  observations[1].review.push("추가 장수 확인");
  assert.deepEqual(confirmSortedNames([observations[1]], observations, catalog)[0].review, ["추가 장수 확인"]);
  observations[1].capturePosition!.sort!.direction = "unknown";
  assert.ok(confirmSortedNames([observations[1]], observations, catalog)[0].review.includes("이름 확인"));
  observations[1].capturePosition!.sort!.direction = "desc";
  observations[0].nameEvidence![0].exact = false;
  assert.ok(confirmSortedNames([observations[1]], observations, catalog)[0].review.includes("이름 확인"));
});
