import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { normalizeName, matchCardName } from "../src/features/card-scanner/card-dictionary.ts";
import { confirmName } from "../src/features/card-scanner/name-confidence.ts";
import { normalizeNumericOcr } from "../src/features/card-scanner/ocr-normalization.ts";
import { parseExtraCopies, parseInventoryTotal } from "../src/features/card-scanner/ocr-values.ts";
import { parseCounterEvidence } from "../src/features/card-scanner/counter-evidence.ts";
import { parseGrowthPoints } from "../src/features/card-scanner/capture-metadata.ts";

test("name normalization composes jamo, removes invisible spacing and preserves catalog digits", () => {
  assert.equal(normalizeName("니아\u200b"), "니아");
  assert.equal(normalizeName(" 고비우스２４세\uFEFF"), "고비우스24세");
  assert.equal(normalizeName("니마"), "니마");
});
test("four observed corrected names are accepted only with stable, clear dictionary evidence", () => {
  const cards = JSON.parse(readFileSync("public/scanner/cards.json", "utf8")).cards;
  for (const [text, name, confidence] of [["니마", "니아", 96], ["란자람", "라자람", 87], ["산디", "샨디", 91], ["유주", "유즈", 66]] as const) {
    const catalog = text === "산디" ? cards.filter((c: {rarity: number}) => c.rarity === 4) : cards;
    const match = matchCardName(text, catalog);
    assert.equal(match?.card.name, name);
    assert.ok(match);
    assert.equal(confirmName({ ...match, ocrConfidence: confidence }, true), true);
    assert.equal(confirmName({ ...match, ocrConfidence: confidence }, false), false);
  }
  assert.equal(matchCardName("산디", cards), null);
  assert.equal(matchCardName("빛을 맞이하는", cards), null);
});
test("confidence policy retains weak readings and close alternatives for review", () => {
  const evidence = { exact: false, score: .84, gap: .3, ocrConfidence: 65 };
  assert.equal(confirmName({ ...evidence, ocrConfidence: 59 }, true), false);
  assert.equal(confirmName({ ...evidence, gap: .19 }, true), false);
  assert.equal(confirmName({ ...evidence, score: .82 }, true), false);
  assert.equal(confirmName({ ...evidence, score: .95, ocrConfidence: 55 }, false), true);
});
test("complete whole-name corrections distinguish observed Shandi and Frank without temporal repetition", () => {
  const cards = JSON.parse(readFileSync("public/scanner/cards.json", "utf8")).cards;
  for (const [rawText, name, ocrConfidence] of [["산디", "샨디", 69], ["프램크", "프랭크", 98]] as const) {
    const catalog = name === "샨디" ? cards.filter((c: {rarity: number}) => c.rarity === 4) : cards;
    const match = matchCardName(rawText, catalog);
    assert.equal(match?.card.name, name);
    assert.ok(match);
    const evidence = { ...match, rawText, ocrConfidence, complete: true };
    assert.equal(confirmName(evidence, false), true);
    for (const change of [{ complete: false }, { ocrConfidence: 64.9 }, { gap: .399 }, { score: .829 },
      { rawText: rawText.slice(0, -1) }, { rawText: "산ㄷ" }])
      assert.equal(confirmName({ ...evidence, ...change }, false), false);
  }
  assert.equal(confirmName({ exact: false, score: .833, gap: .167, ocrConfidence: 81,
    complete: true, rawText: "카란", card: { name: "카단" } }, false), false);
});
test("numeric normalization handles Unicode presentation without changing digits or joining groups", () => {
  assert.equal(normalizeNumericOcr(" ＋１５\u200b "), "+15");
  assert.equal(parseExtraCopies("＋１５"), 15);
  assert.deepEqual(parseInventoryTotal("（３８４／４５０）"), { owned: 384, capacity: 450 });
  assert.deepEqual(parseGrowthPoints("１６５，４５０／９９９，９９９，９９９"), { current: 165450, maximum: 999999999 });
  assert.deepEqual(parseCounterEvidence("（＋７）", 15), { value: 7, plus: true });
  assert.deepEqual(parseCounterEvidence("＋１）", 15), { value: 1, plus: true });
  for (const text of ["+1.5", "+1+5", "+O", "+I", "+19", "+1/5"])
    assert.equal(parseCounterEvidence(text, 15), null, text);
});
