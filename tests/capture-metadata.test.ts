import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseGrowthPoints,
  parseCardSort,
  readSortArrow,
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
