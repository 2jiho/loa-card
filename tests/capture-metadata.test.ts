import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseGrowthPoints,
  parseCardSort,
  readSortArrow,
  reconcileCardSort,
} from "../src/features/card-scanner/capture-metadata";
test("growth points preserve zero, separators and the displayed capacity without guessing glyphs", () => {
  assert.deepEqual(parseGrowthPoints("165,450 / 999,999,999"), {
    current: 165450,
    maximum: 999999999,
  });
  assert.deepEqual(parseGrowthPoints("0 / 999,999,999"), {
    current: 0,
    maximum: 999999999,
  });
  for (const text of ["16545O/999999999", "165450", "12/10", "-1/999999999"])
    assert.equal(parseGrowthPoints(text), null);
});

test('transient missing sort direction retains the last known order without a reset',()=>{
 const asc={kind:'name',direction:'asc'} as const;
 assert.deepEqual(reconcileCardSort(asc,null),{sort:asc,changed:false});
 assert.deepEqual(reconcileCardSort(asc,{kind:'name',direction:'unknown'}),{sort:asc,changed:false});
 assert.deepEqual(reconcileCardSort({kind:'name',direction:'unknown'},asc),{sort:asc,changed:false});
 assert.deepEqual(reconcileCardSort(null,asc),{sort:asc,changed:false});
});

test('real sort changes reset positions and never borrow the previous key direction',()=>{
 const asc={kind:'name',direction:'asc'} as const;
 const lost=reconcileCardSort(asc,{kind:'name',direction:'unknown'}).sort;
 const desc={kind:'name',direction:'desc'} as const;
 assert.deepEqual(reconcileCardSort(lost,desc),{sort:desc,changed:true});
 const other={kind:'rarity',direction:'unknown'} as const;
 assert.deepEqual(reconcileCardSort(asc,other),{sort:other,changed:true});
});
test("sort labels record primary keys without inventing missing direction or default tie rules", () => {
  assert.deepEqual(parseCardSort("이름 역순"), {
    kind: "name",
    direction: "desc",
  });
  assert.deepEqual(parseCardSort("각성 단계 순"), {
    kind: "awakening",
    direction: "unknown",
  });
  assert.equal(parseCardSort("보 유 순")?.kind, "owned");
  assert.equal(parseCardSort("미확인 정렬"), null);
  assert.equal(
    readSortArrow(new Uint8ClampedArray(30 * 30 * 4), 30, 30),
    "unknown",
  );
});
