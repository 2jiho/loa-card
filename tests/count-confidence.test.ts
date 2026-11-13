import { test } from "node:test";
import assert from "node:assert/strict";
import { countReliability, currentCountReliability, CountObservations } from "../src/features/card-scanner/recognition/count-confidence";
import { COUNT_UNEXPLAINED_TRAILING_GLYPH } from "../src/features/card-scanner/recognition/count-pattern";
test("unexplained trailing glyph blocks OCR and even a stable-frame shortcut",()=>{
  const sample={stable:true,borderAlignment:1,awakening:0,extraCopies:1,iconPresent:true,ocrConfirmedValue:1,
    pattern:{value:null,candidate:1,score:.55,gap:.08,reason:COUNT_UNEXPLAINED_TRAILING_GLYPH}};
  assert.equal(countReliability(sample),"unconfirmed");
  assert.equal(currentCountReliability(sample),"unconfirmed");
});
test("a trailing-glyph candidate is strong by the score of its crop size, with gap and agreeing OCR",()=>{
  // 구스토 at 1920x1080: +1 in front of a white coat, the same veto it gets at 2560x1440 (score 0.50).
  const small={stable:true,borderAlignment:1,awakening:0,extraCopies:1,iconPresent:true,ocrConfirmedValue:1,patternOcrAgreed:true,
    pattern:{value:null,candidate:1,score:.288,gap:.119,reason:COUNT_UNEXPLAINED_TRAILING_GLYPH,strongScore:.27}};
  assert.notEqual(countReliability(small),"unconfirmed");
  // Without the crop-size score (a 2560x1440 crop), the same score stays unconfirmed.
  assert.equal(countReliability({...small,pattern:{...small.pattern,strongScore:undefined}}),"unconfirmed");
  // The other conditions are unchanged: runner-up gap, OCR agreement, OCR value.
  assert.equal(countReliability({...small,pattern:{...small.pattern,gap:.059}}),"unconfirmed");
  // The gap scales with the score: 0.06 for a resampled crop (구스토 in a window drawn at 0.98: gap 0.066).
  assert.notEqual(countReliability({...small,pattern:{...small.pattern,gap:.066}}),"unconfirmed");
  assert.equal(countReliability({...small,pattern:{...small.pattern,gap:.066,strongScore:undefined,score:.5}}),"unconfirmed");
  assert.equal(countReliability({...small,patternOcrAgreed:false}),"unconfirmed");
  assert.equal(countReliability({...small,ocrConfirmedValue:11}),"unconfirmed");
  assert.equal(countReliability({...small,pattern:{...small.pattern,score:.26}}),"unconfirmed");
});
test("numeric confirmation reaches final reliability only on an intact card", () => {
  const observation = { stable: false, borderAlignment: .95, awakening: 0, extraCopies: 8,
    iconPresent: true, ocrConfirmedValue: 8,
    pattern: { value: null, candidate: 8, score: .458, gap: .013, reason: "close pattern" } };
  assert.equal(countReliability(observation), "pattern-ocr");
  assert.equal(countReliability({ ...observation, ocrConfirmedValue: undefined }), "unconfirmed");
  assert.equal(countReliability({ ...observation, borderAlignment: .79 }), "unconfirmed");
});
import { consensus } from "../src/features/card-scanner/recognition/consensus";
import type { ScannedCard } from "../src/features/card-scanner/recognition/recognizer";

const clear = { stable: false, borderAlignment: .95, awakening: 0,
  extraCopies: 13, pattern: { value: 13, candidate: 13, score: .441, gap: .059, reason: "장수 전체 패턴 일치" } };

test("a clear whole-count pattern on four intact sides does not require a repeated full card", () => {
  assert.equal(countReliability(clear), "clear-pattern");
  assert.equal(countReliability({ ...clear, stable: true }), "stable-frame");
});
test("weak, obscured, contradictory, unknown or impossible single-frame counts stay unconfirmed", () => {
  for (const input of [
    { ...clear, borderAlignment: .79 },
    { ...clear, pattern: { ...clear.pattern, score: .29 } },
    { ...clear, pattern: { ...clear.pattern, gap: .034 } },
    { ...clear, pattern: { ...clear.pattern, value: null } },
    { ...clear, pattern: { ...clear.pattern, candidate: 3 } },
    { ...clear, pattern: undefined },
    { ...clear, awakening: null },
    { ...clear, awakening: 3 },
    { ...clear, awakening: -1 },
    { ...clear, extraCopies: null },
    { ...clear, extraCopies: 0 },
  ]) assert.equal(countReliability(input), "unconfirmed");
});

test("moderate contrast can distinguish a closed-set count without lowering the matching floor", () => {
  const moderate = { ...clear, extraCopies: 15,
    pattern: { ...clear.pattern, value: 15, candidate: 15, score: .357, gap: .037 } };
  assert.equal(countReliability(moderate), "distinct-pattern");
  assert.equal(countReliability({ ...moderate, pattern: { ...moderate.pattern, gap: .034 } }), "unconfirmed");
  assert.equal(countReliability({ ...moderate, pattern: { ...moderate.pattern, score: .399, gap: .035 } }), "unconfirmed");
  for (const input of [{ ...moderate, borderAlignment: .79 }, { ...moderate, awakening: 1 },
    { ...moderate, pattern: { ...moderate.pattern, value: null } },
    { ...moderate, pattern: { ...moderate.pattern, score: NaN } }])
    assert.equal(countReliability(input), "unconfirmed");
});

test("counter stability distinguishes supplied observation IDs for the same card and awakening", () => {
  const observations = new CountObservations(), vector = new Uint8Array(3240).fill(100);
  const moderate = { ...clear, pattern: { ...clear.pattern, score: .32, gap: .02 } };
  assert.equal(observations.offer("a", "1", vector, moderate), false);
  assert.equal(observations.offer("a", "1", vector, moderate), false);
  assert.equal(observations.offer("b", "2", vector, moderate), false);
  assert.equal(observations.offer("a", "2", vector, { ...moderate, awakening: 1 }), false);
  assert.equal(observations.offer("a", "2", vector, { ...moderate, extraCopies: 3 }), false);
  assert.equal(observations.offer("a", "2", vector, { ...moderate, borderAlignment: .7 }), false);
  const changed = vector.slice(); changed.fill(200, 864, 2016);
  assert.equal(observations.offer("a", "3", changed, moderate), false);
  const otherFields = vector.slice(); otherFields.fill(200, 0, 864); otherFields.fill(200, 2016);
  const repeatedCount = observations.offer("a", "4", otherFields, moderate);
  assert.equal(repeatedCount, true);
  assert.equal(countReliability({ ...moderate, repeatedCount }), "repeated-pattern");
  assert.equal(countReliability({ ...moderate, repeatedCount, pattern: { ...moderate.pattern, gap: .01 } }), "unconfirmed");
});
test("scanner does not turn processing attempt IDs into independent count evidence", () => {
  const observations = new CountObservations(), vector = new Uint8Array(3240).fill(100);
  const weak = { ...clear, pattern: { ...clear.pattern, score: .32, gap: .02 } };
  observations.offer("a", "processing/1", vector, weak);
  const repeatedCount = observations.offer("a", "processing/2", vector, weak);
  assert.equal(repeatedCount, true, "legacy heuristic cannot authenticate source identity");
  const attemptedPromotion = { ...weak, repeatedCount };
  assert.equal(currentCountReliability(attemptedPromotion), "unconfirmed");
  assert.equal(currentCountReliability(clear), "clear-pattern");
  assert.equal(currentCountReliability({ ...weak, stable: true }), "unconfirmed");
});
test("scanner requires count evidence beyond unverified temporal stability", () => {
  const weak = { ...clear, stable: true, pattern: { ...clear.pattern, score: .32, gap: .02 } };
  assert.equal(currentCountReliability(weak), "unconfirmed");
  assert.equal(currentCountReliability({ ...weak, pattern: undefined }), "unconfirmed");
  assert.equal(currentCountReliability({ ...clear, stable: true }), "clear-pattern");
  assert.equal(currentCountReliability({ ...clear, stable: true, awakening: 0, extraCopies: 0, iconPresent: false }), "empty-counter");
  assert.equal(currentCountReliability({ ...weak, iconPresent:true, pattern: {...weak.pattern, value:null, score:.458, gap:.013}, ocrConfirmedValue:13 }), "pattern-ocr");
  assert.equal(currentCountReliability({ ...weak, awakening:5, extraCopies:0 }), "fixed-zero");
});
test("zero counts retain their explicit max-awakening or growthless evidence", () => {
  assert.equal(countReliability({ ...clear, awakening: 5, extraCopies: 0 }), "fixed-zero");
  assert.equal(countReliability({ ...clear, maxAwakening: 0, extraCopies: 0 }), "fixed-zero");
  assert.equal(countReliability({ ...clear, awakening: 5, extraCopies: null }), "unconfirmed");
});

test("a supplied absent-icon decision accepts zero without a second frame", () => {
  // This checks the confidence contract, not whether an image is unobstructed.
  const empty = { stable: false, borderAlignment: .95, awakening: 0,
    extraCopies: 0, iconPresent: false };
  for (let awakening = 0; awakening < 5; awakening++)
    assert.equal(countReliability({ ...empty, awakening }), "empty-counter");
  for (const input of [{ ...empty, iconPresent: true },
    { ...empty, iconPresent: undefined }, { ...empty, borderAlignment: .79 },
    { ...empty, awakening: null }, { ...empty, awakening: -1 },
    { ...empty, awakening: .5 }, { ...empty, extraCopies: null }])
    assert.equal(countReliability(input), "unconfirmed");
});

test("a newly verified empty overlay replaces an older positive count and clears its review", () => {
  const old: ScannedCard = { id: "1", name: "sample", awakening: 0, extraCopies: 3,
    confidence: 1, review: [], image: "old", time: 0, observations: 1,
    captureOrder: 1, countReliable: true };
  const current = { ...old, extraCopies: 0, captureOrder: 2,
    countReliable: countReliability({ stable: false, borderAlignment: .95,
      awakening: 0, extraCopies: 0, iconPresent: false }) !== "unconfirmed" };
  const result = consensus([old, current]);
  assert.equal(result.extraCopies, 0);
  assert.equal(result.countReliable, true);
  assert.ok(!result.review.some(reason => reason.includes("장수")));
});
test("clear-pattern evidence updates an older stable count but weak newer captures cannot erase it", () => {
  const old: ScannedCard = { id: "1", name: "sample", awakening: 0, extraCopies: 15,
    confidence: 1, review: [], image: "old", time: 0, observations: 1, captureOrder: 1, countReliable: true };
  const current = { ...old, extraCopies: clear.extraCopies, captureOrder: 2, image: "clear",
    countReliable: countReliability(clear) !== "unconfirmed" };
  const weak = { ...old, extraCopies: 1, captureOrder: 3, countReliable: false };
  const result = consensus([old, current, weak]);
  assert.equal(result.extraCopies, 13);
  assert.equal(result.countReliable, true);
  assert.ok(!result.review.some(reason => reason.includes("장수")));
});

test("independent numeric OCR corroborates a dim-border pattern but disagreement stays reviewable", () => {
  const current = { stable: false, borderAlignment: 0, awakening: 0, extraCopies: 15,
    iconPresent: true, patternOcrAgreed: true,
    pattern: { value: 15, candidate: 15, score: .4267, gap: .0221, reason: "장수 전체 패턴 일치" } };
  assert.equal(countReliability(current), "pattern-ocr");
  assert.equal(countReliability({ ...current, patternOcrAgreed: false }), "unconfirmed");
  assert.equal(countReliability({ ...current, extraCopies: 13 }), "unconfirmed");
  assert.equal(countReliability({ ...current, awakening: null }), "unconfirmed");
});
