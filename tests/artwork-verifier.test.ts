import { test } from "node:test";
import assert from "node:assert/strict";
import { createArtworkVerifier, confirmArtwork } from "../src/features/card-scanner/artwork-verifier.ts";
import { confirmName } from "../src/features/card-scanner/name-confidence.ts";

function fixture(kind: number) {
  const bytes = new Uint8Array(720), rgba = new Uint8ClampedArray(24 * 32 * 4);
  for (let i = 0; i < 100; i++) {
    const value = kind === 0 ? (i * 37) % 256 : (i * 11 + 51) % 256;
    for (let c = 0; c < 3; c++) {
      bytes[120 + 3 * i + c] = value;
      rgba[((8 + Math.floor(i / 20)) * 24 + 2 + i % 20) * 4 + c] = value;
    }
  }
  return { feature: Buffer.from(bytes).toString("base64"), rgba };
}
const a = fixture(0), b = fixture(1);
const cards = [
  { id: "a", name: "영원의 아크 카양겔", rarity: 4, feature: a.feature },
  { id: "b", name: "빛을 맞이하는 실리안", rarity: 4, feature: b.feature },
];

test("noisier text needs near-identical artwork and an independent unique text winner", () => {
  const evidence = { mode: "name-correction" as const, textSimilarity: .76,
    textGap: .28, correlation: .981, margin: .148, visiblePrefix: "흑한의 헬기의만" };
  assert.equal(confirmArtwork(evidence, .81), true);
  for (const change of [{textGap: .14}, {textGap: undefined}, {correlation: .96}, {margin: .11}, {textSimilarity: .74}])
    assert.equal(confirmArtwork({...evidence, ...change}, .81), false);
  assert.equal(confirmArtwork(evidence, .74), false);
});

test("truncated OCR is confirmed only when independent artwork agrees", () => {
  const match = createArtworkVerifier(cards)(a.rgba, "영원의 아크 카양", .95);
  assert.equal(match?.card.id, "a");
  assert.equal(match?.exact, false);
  assert.ok(match && match.score < 1);
  assert.ok(match && confirmName({ ...match, ocrConfidence: 95 }, false));
  assert.equal(createArtworkVerifier(cards)(b.rgba, "영원의 아크 카양", .95), null);
});

test("bounded portrait registration tolerates a one-pixel shift without completing unrelated or ambiguous names", () => {
  const shifted = new Uint8ClampedArray(a.rgba.length);
  for (let y = 0; y < 31; y++) for (let x = 0; x < 23; x++)
    shifted.set(a.rgba.subarray((y * 24 + x) * 4, (y * 24 + x) * 4 + 4), ((y + 1) * 24 + x + 1) * 4);
  assert.equal(createArtworkVerifier(cards)(shifted, "영원의 아크 카양", .95)?.card.id, "a");
  assert.equal(createArtworkVerifier(cards)(shifted, "다른 카드", .95), null);
  assert.equal(createArtworkVerifier([cards[0], { ...cards[1], feature: a.feature }])(shifted, "영원의 아크 카양", .95), null);
});
test("weak, ambiguous and absent text cannot be completed from artwork", () => {
  const verify = createArtworkVerifier(cards);
  for (const text of ["", "영원", "다른 카드", cards[0].name])
    assert.equal(verify(a.rgba, text, .95), null);
  assert.equal(verify(a.rgba, "영원의 아크 카양", .84), null);
  assert.equal(verify(a.rgba, "영원의 아그 카양", .95)?.card.id, "a");
  assert.equal(verify(a.rgba, "영원의 아그 카양", .74), null);
  const tied = createArtworkVerifier([...cards, { ...cards[0], id: "c", name: "영원의 아크 카양의 그림자" }]);
  assert.equal(tied(a.rgba, "영원의 아크 카양", .95), null);
  assert.equal(createArtworkVerifier([cards[0], { ...cards[1], feature: a.feature }])(a.rgba, "영원의 아크 카양", .95), null);
});
test("artwork ignores name, jewel and counter pixels and is brightness invariant", () => {
  const modified = new Uint8ClampedArray(a.rgba.length).fill(255);
  for (let i = 0; i < 100; i++) {
    const p = ((8 + Math.floor(i / 20)) * 24 + 2 + i % 20) * 4;
    for (let c = 0; c < 3; c++) modified[p + c] = a.rgba[p + c] * .6 + 30;
  }
  assert.equal(createArtworkVerifier(cards)(modified, "영원의 아크 카양", .95)?.card.id, "a");
  assert.equal(createArtworkVerifier(cards)(new Uint8Array(a.rgba.length), "영원의 아크 카양", .95), null);
});
