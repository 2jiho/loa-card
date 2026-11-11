import { test } from 'node:test';
import assert from 'node:assert/strict';
import { packPixels, unpackPixels } from '../src/features/card-scanner/reproduction/exact-recording-codec';

/** Independent bytewise reference for the serialized block format. */
function reference(current: Uint8Array, previous?: Uint8Array, xor = false) {
  const same = previous?.length === current.length;
  const blocks: number[] = [];
  for (let start = 0; start < current.length; start += 16_384) {
    const end = Math.min(current.length, start + 16_384);
    if (!same || current.subarray(start, end).some((value, index) => value !== previous![start + index])) {
      blocks.push(start);
    }
  }
  const size = 4 + blocks.reduce((total, start) => total + 8 + Math.min(16_384, current.length - start), 0);
  const result = new Uint8Array(size);
  const view = new DataView(result.buffer);
  view.setUint32(0, blocks.length, true);
  let offset = 4;
  for (const start of blocks) {
    const length = Math.min(16_384, current.length - start);
    view.setUint32(offset, start, true);
    view.setUint32(offset + 4, length, true);
    for (let i = 0; i < length; i++) {
      result[offset + 8 + i] = xor && same ? current[start + i] ^ previous![start + i] : current[start + i];
    }
    offset += 8 + length;
  }
  return result;
}

test('word packing preserves the bytewise format across block boundaries, alignment and XOR modes', () => {
  let seed = 0x641821;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed; };
  for (const size of [0, 1, 2, 3, 4, 5, 16_383, 16_384, 16_385, 32_767, 32_768, 32_769, 65_539]) {
    for (let round = 0; round < 8; round++) {
      const offset = round % 4;
      const current = new Uint8Array(size + offset + 4).subarray(offset, size + offset);
      const previous = new Uint8Array(size + 3).subarray(round % 3, size + round % 3);
      for (let i = 0; i < size; i++) {
        current[i] = random() >>> 24;
        previous[i] = round % 3 ? current[i] : random() >>> 24;
      }
      if (round % 3 === 1 && size) previous[random() % size] ^= 1;
      for (const prior of [undefined, previous, previous.subarray(0, Math.floor(size / 2))]) {
        for (const xor of [false, true]) {
          const result = packPixels(current, prior, xor);
          assert.deepEqual(result, reference(current, prior, xor));
          const restored = prior?.length === size ? Uint8Array.from(prior) : new Uint8Array(size);
          unpackPixels(result, restored, xor && prior?.length === size);
          assert.deepEqual(restored, current);
        }
      }
    }
  }
});
