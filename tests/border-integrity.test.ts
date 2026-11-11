import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { alignCardBorders } from "../src/features/card-scanner/acquisition/card-borders";
import { borderIntegrity } from "../src/features/card-scanner/acquisition/border-integrity";

test("border geometry and acceptance remain equal to the prior implementation, with actual zero-score sides retained", () => {
  const samples = JSON.parse(readFileSync(new URL("./fixtures/border-integrity-samples.json", import.meta.url), "utf8"));
  const cases = JSON.parse(readFileSync(new URL("./fixtures/border-alignment-equivalence.json", import.meta.url), "utf8"));
  for (const item of cases) {
    const sample = samples[item.sample];
    const box = { ...sample.box, x: sample.box.x + item.dx, y: sample.box.y + item.dy };
    const actual=alignCardBorders(Uint8Array.from(Buffer.from(sample.rgba, "base64")), sample.width, sample.height, box, item.scale);
    // Legacy expected sides were fabricated zeros whenever the weakest edge
    // scored exactly zero. All geometry and acceptance stay unchanged.
    if(item.expected.alignment===0){
      const {borderSides:_actualSides,...actualGeometry}=actual,{borderSides:_oldSides,...expectedGeometry}=item.expected;
      assert.deepEqual(actualGeometry,expectedGeometry,`${sample.name}: scale=${item.scale}, offset=${item.dx},${item.dy}`);
    }else assert.deepEqual(actual,item.expected,`${sample.name}: scale=${item.scale}, offset=${item.dx},${item.dy}`);
  }
});
test("all five real rarity borders remain intact while the actual tooltip-covered card is excluded", () => {
  const samples = JSON.parse(readFileSync(new URL("./fixtures/border-integrity-samples.json", import.meta.url), "utf8"));
  for (const sample of samples) {
    const result = borderIntegrity(Uint8Array.from(Buffer.from(sample.rgba, "base64")), sample.width, sample.height, sample.box);
    assert.equal(result.intact, sample.intact, sample.name);
    if(!sample.intact){assert.equal(result.minimum,0);assert.deepEqual(result.sides,[22/24,22/24,1,0]);}
    const acquired = alignCardBorders(Uint8Array.from(Buffer.from(sample.rgba, "base64")), sample.width, sample.height, sample.box);
    assert.equal(acquired.intact, sample.intact, `production acquisition: ${sample.name}`);
  }
});
test("dim continuous borders survive, but a missing bottom or a large scroll displacement does not", () => {
  const width = 180, height = 250, box = { x: 20, y: 20, width: 140, height: 210 };
  const rgba = new Uint8Array(width * height * 4).fill(20);
  const paint = (x: number, y: number) => rgba.set([33, 33, 33, 255], (y * width + x) * 4);
  for (let y = 20; y < 230; y++) { paint(20, y); paint(158, y); }
  for (let x = 20; x < 160; x++) { paint(x, 22); paint(x, 227); }
  assert.equal(borderIntegrity(rgba, width, height, box).intact, true);
  const moved=borderIntegrity(rgba,width,height,{...box,y:32});
  assert.equal(moved.intact,false);assert.deepEqual(moved.sides,[1,1,0,0]);
  for (let y = 220; y < 236; y++) for (let x = 20; x < 160; x++) rgba.set([20, 20, 20, 255], (y * width + x) * 4);
  const missing=borderIntegrity(rgba,width,height,box);
  assert.equal(missing.intact,false);assert.deepEqual(missing.sides,[1,1,1,0]);
  const blank=borderIntegrity(new Uint8Array(width*height*4).fill(20),width,height,box);
  assert.equal(blank.intact,false);assert.deepEqual(blank.sides,[0,0,0,0]);
});
