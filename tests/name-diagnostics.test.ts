import { test } from "node:test";
import assert from "node:assert/strict";
import { nameAttempt } from "../src/features/card-scanner/name-diagnostics.ts";
const cards = [{ id: "1", name: "혹한의 헬가이아", rarity: 3 }, { id: "2", name: "헬가이아", rarity: 3 }];
test("failed name diagnostics preserve OCR text and distinguish weak readings from missing suffixes", () => {
  const reading = nameAttempt("흑한의 헬기이만", 67, "paddle", "원본", cards, false);
  assert.equal(reading.candidates[0].name, cards[0].name);
  assert.equal(reading.text, "흑한의 헬기이만");
  assert.match(reading.reason, /조건 미달/);
  assert.match(nameAttempt("혹한의 헬가", 90, "paddle", "원본", cards, false).reason, /접미사/);
  assert.match(nameAttempt("", 0, "paddle", "원본", cards, false).reason, /판독 없음/);
  assert.match(nameAttempt("혹한의 헬가이아", 20, "paddle", "원본", cards, false).reason, /신뢰도/);
});
