import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { difference, sameObservation } from "../src/features/card-scanner/recognizer.ts";

test("compression noise deduplicates without hiding changing counters or jewels", () => {
  const original = new Uint8Array(3240).fill(100), noise = new Uint8Array(3240).fill(101);
  assert.equal(sameObservation(original, noise), true);
  // A small digit change would disappear in a whole-card average. Its own region must survive.
  const changedCount = original.slice(); changedCount.fill(240, 900, 950);
  assert.equal(sameObservation(original, changedCount), false);
  const changedJewel = original.slice(); changedJewel.fill(200, 2020, 2060);
  assert.equal(sameObservation(original, changedJewel), false);
});

test("image comparison distinguishes identical, compression changes and different cards", () => {
  assert.equal(difference([10, 20, 30], [10, 20, 30]), 0);
  assert.ok(difference([10, 20, 30], [11, 21, 31]) < 2);
  assert.ok(difference([10, 20, 30], [100, 150, 200]) > 50);
});
test("reference database has unique ids, valid optional descriptors and latest named cards", async () => {
  const data = JSON.parse(await readFile("public/scanner/cards.json", "utf8"));
  assert.equal(
    new Set(data.cards.map((c: { id: string }) => c.id)).size,
    data.cards.length,
  );
  assert.equal(
    new Set(data.cards.map((c: { name: string }) => c.name)).size,
    data.cards.length,
  );
  for (const card of data.cards) {
    assert.ok(card.name.length);
    if(card.feature !== undefined) assert.equal(Buffer.from(card.feature, "base64").length, 720);
  }
  assert.ok(data.cards.some((c: { name: string }) => c.name === "카단"));
  assert.ok(
    data.cards.some(
      (c: { name: string }) => c.name === "죽음의 계율자, 벨가르딘",
    ),
  );
});
