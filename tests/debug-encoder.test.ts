import { test } from "node:test";
import assert from "node:assert/strict";
import { createDebugEncoder } from "../src/features/card-scanner/debug-encoder";

class FakeWorker {
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  requests: { id: number; pixels: Uint8ClampedArray; time: number; elapsed: number }[] = [];
  terminated = false;
  flushing = false;
  postMessage(message: unknown, transfer: Transferable[]) {
    if ((message as { finish?: boolean }).finish) { this.flushing = true; return; }
    const request = structuredClone(message, { transfer }) as FakeWorker["requests"][number];
    this.requests.push(request);
  }
  terminate() { this.terminated = true; }
  stored(index: number) { this.onmessage?.({ data: { id: this.requests[index].id, stored: true } } as MessageEvent); }
  done() { this.onmessage?.({ data: { done: true } } as MessageEvent); }
  respond(index: number, error?: string) {
    const request = this.requests[index];
    this.onmessage?.({ data: { id: request.id, error, frame: error ? undefined :
      { image: "data:image/png;base64,AAAA", time: request.time, elapsed: request.elapsed } } } as MessageEvent);
  }
}
const source = new Uint8ClampedArray([1, 2, 3, 255]);
const canvas = { width: 1, height: 1, getContext: () => ({ getImageData: () => ({ data: source.slice() }) }) } as unknown as HTMLCanvasElement;

test("PNG compression does not block submission; transferred pixels are frozen and output stays ordered", async () => {
  const worker = new FakeWorker(), times: number[] = [];
  const encoder = createDebugEncoder(frame => times.push(frame.time), assert.fail, worker);
  encoder.submit(canvas, 2, 10); encoder.submit(canvas, 3, 20);
  assert.equal(worker.requests.length, 2);
  assert.deepEqual(times, []);
  assert.deepEqual([...worker.requests[0].pixels], [...source]);
  worker.stored(0); worker.stored(1);
  assert.deepEqual(times, []);
  let done = false;
  const finishing = encoder.finish().then(() => { done = true; });
  const sameFinish = encoder.finish();
  assert.equal(encoder.finish(), sameFinish);
  await Promise.resolve(); assert.equal(done, false);
  assert.equal(worker.flushing, true);
  worker.respond(0); worker.respond(1); worker.done();
  await finishing;
  await encoder.finish();
  assert.deepEqual(times, [2, 3]);
  assert.equal(worker.terminated, true);
});
test("bounded compression backlog stops debug recording while flushing accepted frames", async () => {
  const worker = new FakeWorker(), reports: string[] = [], times: number[] = [];
  const encoder = createDebugEncoder(frame => times.push(frame.time), text => reports.push(text), worker, 4);
  encoder.submit(canvas, 1, 1); encoder.submit(canvas, 2, 2);
  assert.equal(encoder.active, false);
  assert.equal(worker.requests.length, 1);
  assert.equal(reports.length, 1);
  worker.stored(0);
  const finishing = encoder.finish();
  worker.respond(0); worker.done();
  await finishing;
  assert.deepEqual(times, [1]);
});
test("worker errors release pending frames and allow scan cleanup to finish", async () => {
  const worker = new FakeWorker(), reports: string[] = [];
  const encoder = createDebugEncoder(assert.fail, text => reports.push(text), worker);
  encoder.submit(canvas, 1, 1);
  const finishing = encoder.finish();
  worker.respond(0, "unsupported");
  await finishing;
  assert.equal(reports.length, 1);
  assert.equal(worker.terminated, true);
});
test("temporary disk acknowledgements release the raw memory budget without early PNG encoding", async () => {
  const worker = new FakeWorker(), times: number[] = [];
  const encoder = createDebugEncoder(frame => times.push(frame.time), assert.fail, worker, 4);
  encoder.submit(canvas, 1, 1); worker.stored(0);
  encoder.submit(canvas, 2, 2); worker.stored(1);
  assert.equal(encoder.active, true);
  assert.deepEqual(times, []);
  const finishing = encoder.finish();
  worker.respond(0); worker.respond(1); worker.done();
  await finishing;
  assert.deepEqual(times, [1, 2]);
});
test("incomplete compression output is reported instead of claiming a complete recording", async () => {
  const worker = new FakeWorker(), reports: string[] = [];
  const encoder = createDebugEncoder(assert.fail, text => reports.push(text), worker);
  encoder.submit(canvas, 1, 1); worker.stored(0);
  const finishing = encoder.finish(); worker.done();
  await finishing;
  assert.ok(reports[0].includes("누락"));
});
