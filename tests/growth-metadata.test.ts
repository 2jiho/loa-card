import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("only individually sourced non-growing cards bypass jewel recognition", async () => {
  const cards = JSON.parse(await readFile("public/scanner/cards.json", "utf8")).cards;
  const special = cards.filter((c: { maxAwakening?: number }) => c.maxAwakening === 0);
  assert.equal(special.length, 23);
  for (const card of special) {
    {
      assert.equal(card.growthSource, "local-client:SeasonCard(SecondaryKey=0)");
      assert.equal(card.growthClientEvidence.grade, card.rarity + 1);
      assert.equal(card.growthClientEvidence.maxWakeUp, 0);
      assert.ok(card.growthClientEvidence.primaryKeys.length > 0);
      assert.equal(card.nameSource, "local-client:SeasonCard/GameMsg");
      assert.deepEqual(card.growthClientEvidence.primaryKeys, [card.clientId]);
    }
  }
  assert.deepEqual(special.filter((c: {id: string}) => c.id.startsWith("catalog:")).map((c: {name: string}) => c.name).sort(), ["자크라와 사르타", "전설의 네 장로", "환영달"].sort());
  assert.equal(cards.find((c: { name: string }) => c.name === "죽음의 계율자, 벨가르딘").maxAwakening, undefined);
  for (const name of ["리비아의 게롤트", "벤거버그의 예니퍼", "시릴라", "트리스 메리골드", "단델라이온", "축제를 즐기는 니나브", "축제를 즐기는 에르제베트", "축제를 즐기는 사샤"])
    assert.equal(cards.find((c: { name: string }) => c.name === name).maxAwakening, 0, name);
  // Duplicate legacy DB rows disagree on these limits: never force a guess.
  for (const name of ["아브렐슈드", "세리아", "슈헤리트"])
    assert.equal(cards.find((c: { name: string }) => c.name === name).maxAwakening, undefined, name);
  for (const id of ['9201404','9201204','9201804','9200704','9100105','9100205','9400101']) {
    const card=cards.find((c:{id:string})=>c.id===id);
    assert.equal(card.maxAwakening,0);
    assert.deepEqual(card.growthClientEvidence.primaryKeys,[Number(id)]);
    assert.ok(card.aliases.includes(`${card.name} 카드`));
  }
});
