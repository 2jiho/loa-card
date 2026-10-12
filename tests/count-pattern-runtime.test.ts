import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { matchCountPattern, prepareContrastPattern } from "../src/features/card-scanner/count-pattern.ts";
import { countReliability } from "../src/features/card-scanner/count-confidence.ts";
import { readFullAwakening } from "../src/features/card-scanner/visual-fields.ts";
import type { Raster, RasterContext } from "../src/features/card-scanner/acquisition-raster.ts";

const atlas = JSON.parse(await readFile("public/scanner/counter-patterns.json", "utf8"));
const patterns = atlas.patterns.map(prepareContrastPattern);
const samples = JSON.parse(await readFile("tests/fixtures/counter-samples.json", "utf8"));
function pixels(sample: { rgba: string }, offset = 0) {
  const image = new Uint8Array(140 * 210 * 4), strip = Buffer.from(sample.rgba, "base64");
  for (let y = 0; y < 25; y++) image.set(strip.subarray(y * 86 * 4, (y + 1) * 86 * 4), ((141 + offset + y) * 140 + 54) * 4);
  return image;
}

test('full-awakening shortcut rejects visible labelled counters but accepts an icon without digits',()=>{
  let data=new Uint8Array(140*210*4);
  const context={drawImage(){},getImageData(){return {data};}} as unknown as RasterContext;
  const fields={awakening:5,hasIcon:true,offsetY:0,labelPixels:100,blankName:false,hasNameBand:true};
  for(const sample of samples){
    data=pixels(sample);
    const value=readFullAwakening({} as Raster,context,fields,patterns);
    assert.equal(value?.awakening,null,sample.name);
    assert.equal(value?.extraCopies,sample.value,sample.name);
  }
  data=new Uint8Array(140*210*4);
  for(let y=144;y<164;y++)for(let x=60;x<82;x++)data.set([40,190,200,255],(y*140+x)*4);
  assert.deepEqual(readFullAwakening({} as Raster,context,fields,patterns),{awakening:5,extraCopies:0});
});

test("runtime font atlas reads manually labelled counters with compensated vertical movement", () => {
  for (const sample of samples) for (const offset of [-2, 0, 3]) {
    const result = matchCountPattern(pixels(sample, offset), patterns, offset);
    assert.equal(result.value, sample.value, `${sample.name}, offset ${offset}`);
  }
});

test("closed-set confidence never confirms a wrong labelled count under contrast and brightness changes", () => {
  let confirmed = 0;
  for (const sample of samples) for (const factor of [.65, .8, 1]) for (const brightness of [-18, 0, 18]) {
    const image = pixels(sample);
    for (let i = 0; i < image.length; i += 4) {
      if (!image[i + 3]) continue;
      for (let c = 0; c < 3; c++) image[i + c] = Math.max(0, Math.min(255, (image[i + c] - 128) * factor + 128 + brightness));
    }
    const pattern = matchCountPattern(image, patterns);
    const reliability = countReliability({ stable: false, borderAlignment: .95,
      awakening: 0, extraCopies: pattern.value, pattern });
    if (reliability !== "unconfirmed") {
      confirmed++;
      assert.equal(pattern.value, sample.value, `${sample.name}: contrast ${factor}, brightness ${brightness}`);
    }
  }
  assert.ok(confirmed > 0, "the policy must retain usable readings as well as rejecting uncertain ones");
});

test("awakening limits reject the winning count without substituting a lower candidate", () => {
  for (const sample of samples) {
    const result = matchCountPattern(pixels(sample), patterns, 0, sample.value - 1);
    assert.equal(result.value, null, sample.name);
    assert.equal(result.candidate, sample.value, sample.name);
    assert.equal(result.reason, "각성별 장수 상한 초과");
  }
});

test("missing icon, solid occlusion and incomplete atlases return unknown rather than zero", () => {
  const image = pixels(samples.find((s: {name: string}) => s.name === "여울"));
  assert.equal(matchCountPattern(image, patterns.slice(0, 8)).value, null);
  for (let y = 141; y < 172; y++) image.fill(0, (y * 140 + 56) * 4, (y * 140 + 89) * 4);
  assert.equal(matchCountPattern(image, patterns).value, null);
  const covered = pixels(samples[0]);
  for (let y = 142; y < 167; y++) covered.fill(160, (y * 140 + 89) * 4, (y * 140 + 139) * 4);
  assert.equal(matchCountPattern(covered, patterns).value, null);
  assert.equal(matchCountPattern(new Uint8Array(0), patterns).value, null);
});

test("visible digits without the plus prefix do not produce a positive count", () => {
  const pattern = patterns.find((p: {value: number}) => p.value === 10);
  const image = new Uint8Array(140 * 210 * 4);
  for (let y = 144; y < 164; y++) for (let x = 60; x < 82; x++)
    image.set([40, 190, 200, 255], (y * 140 + x) * 4);
  for (const p of pattern.foreground) {
    if (pattern.plus.includes(p)) continue;
    const y = Math.floor(p / 50) + 144, x = p % 50 + 90;
    image.set([255, 255, 255, 255], (y * 140 + x) * 4);
  }
  assert.equal(matchCountPattern(image, patterns).value, null);
});
