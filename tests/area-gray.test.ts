import { test } from "node:test";
import assert from "node:assert/strict";
import { areaGray } from "../src/features/card-scanner/area-gray";
import { createHash } from 'node:crypto';

test('overlap reuse preserves pre-optimization Float32 outputs at native and fractional scales', () => {
  const cases: [number, number, string][] = [
    [24,32,'062e301128abd415c8747dc80565ea8b981853b08c79779dad0c2ec37e03a8f9'],
    [139,209,'b9fb3574a8dd1b7845f29dc20cc387e13e19d30de272f630984292ce7e15e800'],
    [140,210,'0274af2dc47fa2174339daa6dda025d4e4603aca6256f5e958d75953bcc3495d'],
    [175,263,'7434612d118cf2c0cfd3db8ce8f4d4e698a4412718fe4c78cd44873664351de5'],
    [280,420,'77b8b1161edf4d5d869860066fb0f2be69ec64cfd7fca8fab15a0838a65388e4'],
  ];
  for(const [width,height,expected] of cases) {
    const pixels=Uint8Array.from({length:width*height*4},(_,i)=>(i*73+Math.floor(i/17)*31)%256);
    const result=areaGray(pixels,width,height);
    assert.equal(createHash('sha256').update(new Uint8Array(result.buffer)).digest('hex'),expected);
  }
});
test("fractional portrait bins integrate pixels rather than sampling a single location", () => {
  const pixels = Uint8Array.from([0, 0, 0, 255, 60, 60, 60, 255, 120, 120, 120, 255]);
  assert.deepEqual(Array.from(areaGray(pixels, 3, 1, 2, 1)), [20, 100]);
});
test("area integration preserves constant colors and the global gray mean", () => {
  const pixels = Uint8Array.from({ length: 140 * 210 * 4 }, (_, i) => i % 4 === 3 ? 255 : Math.floor(i / 4) % 256);
  const output = areaGray(pixels, 140, 210);
  const inputMean = Array.from({ length: 140 * 210 }, (_, i) => pixels[4 * i]).reduce((a, b) => a + b, 0) / (140 * 210);
  assert.ok(Math.abs(output.reduce((a, b) => a + b, 0) / output.length - inputMean) < .00001);
  assert.throws(() => areaGray(new Uint8Array(4), 1, 1));
});
