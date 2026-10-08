import { test } from "node:test";
import assert from "node:assert/strict";
import { corroboratedCount } from "../src/features/card-scanner/count-corroboration";
test("independent digit agreement corroborates a low-gap count without guessing from awakening capacity", () => {
  const observation = { awakening: 0, value: 15, iconPresent: true, ocrAgreed: true,
    pattern: { value: 15, candidate: 15, score: .4267, gap: .0221, reason: "장수 전체 패턴 일치" } };
  assert.equal(corroboratedCount(observation), true);
  for (const change of [{ value: 13 }, { awakening: 1 }, { awakening: null }, { iconPresent: false }, { ocrAgreed: false },
    { pattern: { ...observation.pattern, candidate: 13 } }, { pattern: { ...observation.pattern, gap: .017 } }])
    assert.equal(corroboratedCount({ ...observation, ...change }), false);
});
test("validated numeric OCR resolves Haenu's close 8 pattern while preserving contradictions", () => {
  const observation = { awakening: 0, value: 8, iconPresent: true, ocrConfirmedValue: 8,
    pattern: { value: null, candidate: 8, score: .458, gap: .013, reason: "장수 패턴 후보 간 차이 부족" } };
  assert.equal(corroboratedCount(observation), true);
  for (const change of [{ ocrConfirmedValue: undefined }, { ocrConfirmedValue: 9 }, { value: 9 },
    { awakening: null }, { awakening: 4 }, { iconPresent: false },
    { pattern: { ...observation.pattern, value: 9 } }, { pattern: { ...observation.pattern, candidate: 9 } },
    { pattern: { ...observation.pattern, score: .399 } }, { pattern: { ...observation.pattern, gap: NaN } }])
    assert.equal(corroboratedCount({ ...observation, ...change }), false);
});
