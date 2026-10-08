import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { matchCardName } from "../src/features/card-scanner/card-dictionary.ts";

test("the complete card dictionary resolves line breaks and small Korean OCR errors without filling missing names", async () => {
  const cards = JSON.parse(
    await readFile("public/scanner/cards.json", "utf8"),
  ).cards;
  assert.equal(
    matchCardName("빛을 맞이하는 샨디\n&진저웨일", cards)?.card.name,
    "빛을 맞이하는 샨디&진저웨일",
  );
  assert.equal(
    matchCardName("마법사 로나운", cards)?.card.name,
    "마법사 로나운",
  );
  assert.equal(
    matchCardName("마법사 로나윤", cards)?.card.name,
    "마법사 로나운",
  );
  assert.equal(matchCardName("나베", cards), null);
  assert.equal(matchCardName("빛을 맞이하는", cards), null);
  assert.equal(matchCardName("카드 보관함", cards), null);
});
test("single-character catalog names require an exact reading and truncated suffixes stay unresolved", async () => {
  const cards = JSON.parse(
    await readFile("public/scanner/cards.json", "utf8"),
  ).cards;
  for (const name of ["긴", "렌", "린"])
    assert.equal(matchCardName(name, cards)?.card.name, name);
  assert.equal(matchCardName("아크의 수호자 오", cards), null);
  assert.equal(matchCardName("갈기파도 항구 네", cards), null);
  assert.equal(matchCardName("산디", cards), null);
});

test("rarity color resolves an OCR tie only within the observed grade", async () => {
  const cards = JSON.parse(
    await readFile("public/scanner/cards.json", "utf8"),
  ).cards;
  assert.equal(matchCardName("산디", cards), null);
  assert.equal(
    matchCardName(
      "산디",
      cards.filter((c: { rarity: number }) => c.rarity === 4),
    )?.card.name,
    "샨디",
  );
});
