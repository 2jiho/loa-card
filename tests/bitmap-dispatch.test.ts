import { test } from "node:test";
import assert from "node:assert/strict";
import { createBitmapDispatch } from "../src/features/card-scanner/bitmap-dispatch.ts";

const metadata = (id: number) => ({ id, width: 140, height: 210, time: id, elapsed: id * 1000 });
test("bitmap snapshots begin before waiting and transfer in capture order even when copies resolve out of order", async () => {
  const copies: ((bitmap: ImageBitmap) => void)[] = [], sent: number[] = [];
  const canvas = {} as HTMLCanvasElement;
  const dispatch = createBitmapDispatch(() => new Promise(resolve => copies.push(resolve)),
    (_bitmap, stamp) => sent.push(stamp.id), error => { throw error; });
  dispatch.submit(canvas, metadata(1)); dispatch.submit(canvas, metadata(2));
  assert.equal(copies.length, 2);
  copies[1]({ close() {} } as ImageBitmap);
  await Promise.resolve(); assert.deepEqual(sent, []);
  copies[0]({ close() {} } as ImageBitmap);
  await dispatch.finish(); assert.deepEqual(sent, [1, 2]);
});
test("canceling unblocks completion and closes bitmaps that finish copying later", async () => {
  let copied!: (bitmap: ImageBitmap) => void, closed = 0, sent = 0;
  const dispatch = createBitmapDispatch(() => new Promise(resolve => { copied = resolve; }),
    () => { sent++; }, error => { throw error; });
  dispatch.submit({} as HTMLCanvasElement, metadata(1));
  dispatch.cancel(); await dispatch.finish();
  copied({ close() { closed++; } } as ImageBitmap);
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  assert.equal(closed, 1); assert.equal(sent, 0);
});
test("failed transfers release bitmap ownership and failed copies are reported", async () => {
  let closed = 0;
  const errors: unknown[] = [];
  const dispatch = createBitmapDispatch(async () => ({ close() { closed++; } } as ImageBitmap),
    () => { throw new Error("transfer"); }, error => errors.push(error));
  dispatch.submit({} as HTMLCanvasElement, metadata(1)); await dispatch.finish();
  assert.equal(closed, 1); assert.equal(errors.length, 1);
  const failed = createBitmapDispatch(async () => { throw new Error("copy"); }, () => {}, error => errors.push(error));
  failed.submit({} as HTMLCanvasElement, metadata(1)); await failed.finish();
  assert.equal(errors.length, 2);
});
