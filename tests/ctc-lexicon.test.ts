import { test } from "node:test";
import assert from "node:assert/strict";
import { createCtcLexicon, joinCtcLines } from "../src/features/card-scanner/ctc-lexicon.ts";
import { decodeCtc } from "../src/features/card-scanner/ctc-decoder.ts";
import { matchCtcCardName } from "../src/features/card-scanner/ctc-name-match.ts";
import { confirmName } from "../src/features/card-scanner/name-confidence.ts";

const characters = ["", "가", "디", "딘", "언", "루", "보"];
const cards = [{ id: "1", name: "가디언 루", rarity: 4 }, { id: "2", name: "가디언 보", rarity: 4 }];
function example() {
  return Float32Array.from([
    [.01,.98,0,0,0,0,.01], [.98,0,0,0,0,.01,.01],
    [.01,0,.47,.51,0,.01,0], [.98,0,0,0,0,.01,.01],
    [.01,0,0,0,.98,0,.01], [.98,0,0,0,0,.01,.01],
    [.01,0,0,0,0,.98,.01],
  ].flat());
}
test("complete-name CTC scoring recovers a second-choice glyph lost by greedy decoding", () => {
  const data = example(), reading = decodeCtc(data, 7, characters);
  assert.equal(reading.text, "가딘언루");
  const candidates = createCtcLexicon(characters, cards)(data, 7, reading.text);
  assert.equal(candidates[0].id, "1");
  assert.ok(candidates[0].relativeLikelihood > .9);
  assert.ok(candidates[0].margin > .9);
  const match = matchCtcCardName({ ...reading, candidates }, cards);
  assert.equal(match?.card.id, "1");
  assert.equal(match?.exact, false);
  assert.ok(match && confirmName({ ...match, ocrConfidence: reading.confidence*100 }, true));
});
test("a dictionary cannot turn blank, truncated, tied or weak readings into names", () => {
  const score = createCtcLexicon(characters, cards);
  assert.deepEqual(score(example(), 7, "가디언"), []);
  assert.deepEqual(score(example(), 7, ""), []);
  const reading = { text: "가딘언루", confidence: .9,
    candidates: [{ id: "1", name: "가디언 루", relativeLikelihood: .99, margin: .99 }] };
  assert.equal(matchCtcCardName({ ...reading, confidence: .4 }, cards), null);
  assert.equal(matchCtcCardName({ ...reading, candidates: [{ ...reading.candidates[0], margin: .2 }] }, cards), null);
  assert.equal(matchCtcCardName({ ...reading, candidates: [{ ...reading.candidates[0], relativeLikelihood: .3 }] }, cards), null);
  assert.equal(matchCtcCardName({ ...reading, text: "없는카드" }, cards), null);
  assert.deepEqual(score(new Float32Array(7*characters.length), 7, "가딘언루"), []);
});
test("CTC scoring requires blanks between repeated letters and accepts decomposed Hangul", () => {
  const chars = ["", "ᄀ", "ᅡ", "나"];
  const score = createCtcLexicon(chars, [{ id: "1", name: "가가" }, { id: "2", name: "가나" }]);
  const data = Float32Array.from([1,2,0,1,2].flatMap(winner => chars.map((_, i) => i===winner ? .97 : .01)));
  assert.equal(score(data, 5, "가마")[0]?.id, "1");
  assert.throws(() => score(data, 6, "가마"));
});
test("wrapped lines retain second-choice letters and never collapse identical letters at the seam", () => {
  const chars = ["", "가", "나", "마"];
  const first = Float32Array.from([.01,.98,.01,0]);
  const second = Float32Array.from([.01,.98,.01,0]);
  assert.equal(decodeCtc(joinCtcLines(first, second, 4), 3, chars).text, "가가");
  const variants = Float32Array.from([.01,.01,.47,.51]);
  const joined = joinCtcLines(first, variants, 4);
  const score = createCtcLexicon(chars, [{ id:"1",name:"가나" }, { id:"2",name:"나나" }]);
  assert.equal(score(joined, 3, "가마")[0]?.name, "가나");
  assert.throws(()=>joinCtcLines(first, new Float32Array(3), 4));
});
test("unsupported letters remain contradictory evidence rather than disappearing into blank", () => {
  const chars = ["", "가", "나", "中", "마"];
  const data = Float32Array.from([1,3,2].flatMap(winner=>chars.map((_,i)=>i===winner ? .99 : .001)));
  const score = createCtcLexicon(chars, [{ id:"1",name:"가나" }]);
  assert.ok(score(data,3,"가마")[0].relativeLikelihood < .1);
});
