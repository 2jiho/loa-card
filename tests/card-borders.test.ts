import { test } from "node:test";
import assert from "node:assert/strict";
import { alignCardBorders } from "../src/features/card-scanner/card-borders.ts";

function sample(scale: number, dx: number, dy: number) {
  const width = 200 * scale, height = 270 * scale;
  const rgba = new Uint8Array(width * height * 4).fill(20);
  const box = { x: 20 * scale, y: 20 * scale, width: 140 * scale, height: 210 * scale };
  const x = box.x + dx, y = box.y + dy;
  const paint = (px: number, py: number) => rgba.set([160, 160, 160, 255], (py * width + px) * 4);
  for (let i = 0; i < box.height; i++) {
    paint(x, y + i); paint(x + box.width - 2 * scale, y + i);
  }
  for (let i = 0; i < box.width; i++) {
    paint(x + i, y + 2 * scale); paint(x + i, y + box.height - 3 * scale);
  }
  return { rgba, width, height, box };
}
test("paired borders correct small translation without stretching field coordinates", () => {
  for (const scale of [1, 2]) {
    const input = sample(scale, -2 * scale, -scale);
    const result = alignCardBorders(input.rgba, input.width, input.height, input.box, scale);
    assert.equal(result.content.x, input.box.x - 2 * scale);
    assert.equal(result.content.y, input.box.y - scale);
    assert.equal(result.content.width, input.box.width);
    assert.equal(result.content.height, input.box.height);
    assert.ok(result.preview.x < result.content.x && result.preview.y < result.content.y);
    assert.ok(result.preview.y + result.preview.height > result.content.y + result.content.height);
  }
});
test("blank or already aligned cards do not drift toward nearby artwork", () => {
  const input = sample(1, 0, 0);
  assert.deepEqual(alignCardBorders(input.rgba, input.width, input.height, input.box).content, input.box);
  input.rgba.fill(20);
  assert.deepEqual(alignCardBorders(input.rgba, input.width, input.height, input.box).content, input.box);
  for (let y = 40; y < 180; y++) input.rgba.set([240, 240, 240, 255], (y * input.width + 18) * 4);
  assert.deepEqual(alignCardBorders(input.rgba, input.width, input.height, input.box).content, input.box);
});
test("preview padding stays inside the input image", () => {
  const rgba = new Uint8Array(40 * 60 * 4);
  const result = alignCardBorders(rgba, 40, 60, { x: 0, y: 0, width: 40, height: 60 });
  assert.deepEqual(result.preview, { x: 0, y: 0, width: 40, height: 60 });
});

test("single-frame alignment requires four opposite border strokes", () => {
  const input = sample(1, 0, 0);
  assert.ok(alignCardBorders(input.rgba, input.width, input.height, input.box).alignment >= .8);
  // A tooltip or scrolling slice can preserve three sides but cover the bottom.
  for (let x = input.box.x; x < input.box.x + input.box.width; x++)
    input.rgba.set([20, 20, 20, 255], ((input.box.y + input.box.height - 3) * input.width + x) * 4);
  assert.ok(alignCardBorders(input.rgba, input.width, input.height, input.box).alignment < .8);
  input.rgba.fill(20);
  assert.equal(alignCardBorders(input.rgba, input.width, input.height, input.box).alignment, 0);
});
