import { test } from "node:test";
import assert from "node:assert/strict";
import { estimateRowShift } from "../src/features/card-scanner/grid-motion";
const grid = (offset = 0) => Array.from({ length: 40 }, (_, i) => new Uint8Array(12).fill((i + offset * 10) * 5));

test("vertical overlap matches same columns, not horizontal rearrangement", () => {
  assert.equal(estimateRowShift(grid(), grid(1)), 1);
  assert.equal(estimateRowShift(grid(1), grid()), -1);
  const swapped = grid().map((_, i) => grid()[Math.floor(i / 10) * 10 + ((i + 1) % 10)]);
  assert.equal(estimateRowShift(grid(), swapped), null);
});
test("uniform loading tiles cannot establish a row offset", () => {
  const flat = Array.from({ length: 40 }, () => new Uint8Array(12));
  assert.equal(estimateRowShift(flat, flat), null);
});

test('three-row jumps use the remaining ten columns in either direction',()=>{
 const patterned=(offset:number)=>Array.from({length:40},(_,i)=>Uint8Array.from({length:48},(_,k)=>((i+offset*10+1)*73+k*31)%251));
 assert.equal(estimateRowShift(patterned(0),patterned(3)),3);
 assert.equal(estimateRowShift(patterned(3),patterned(0)),-3);
 const blocked=patterned(3);for(let i=0;i<4;i++)blocked[i].fill(0);
 assert.equal(estimateRowShift(patterned(0),blocked),null);
});
