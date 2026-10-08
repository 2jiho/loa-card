import { test } from "node:test";
import assert from "node:assert/strict";
import { startVideoFrames } from "../src/features/card-scanner/live-frame-clock";

function input() {
  let next = 0;
  const pending = new Map<number, VideoFrameRequestCallback>();
  const canceled: number[] = [], track = { readyState: "live" };
  const video = { readyState: 2, currentTime: 0, srcObject: { getVideoTracks: () => [track] },
    requestVideoFrameCallback: (callback: VideoFrameRequestCallback) => { pending.set(++next, callback); return next; },
    cancelVideoFrameCallback: (id: number) => { canceled.push(id); pending.delete(id); } } as unknown as HTMLVideoElement;
  const deliver = (mediaTime: number, presentedFrames: number) => {
    const [id, callback] = [...pending.entries()][0]; pending.delete(id);
    callback(0, { mediaTime, presentedFrames } as VideoFrameCallbackMetadata);
  };
  return { video, track, pending, canceled, deliver };
}
test("live capture follows delivered frames and reports actual compositor gaps without duplicate crops", () => {
  const mock = input(), abort = new AbortController(), frames: unknown[] = [];
  const stop = startVideoFrames(mock.video, abort.signal, stamp => frames.push(stamp), () => assert.fail(), error => { throw error; });
  for (let i = 1; i <= 60; i++) mock.deliver(i / 60, i);
  mock.deliver(1, 60); mock.deliver(1.05, 63);
  assert.equal(frames.length, 61);
  assert.deepEqual(frames.at(-1), { mediaTime: 1.05, presentedFrames: 63, missedFrames: 2 });
  abort.abort(); assert.equal(mock.pending.size, 0); assert.equal(mock.canceled.length, 1); stop();
});
test("ended shares and failed processing stop exactly once and cancel pending callbacks", () => {
  const mock = input(); let ended = 0;
  const stop = startVideoFrames(mock.video, new AbortController().signal, () => assert.fail(), () => ended++, error => { throw error; });
  mock.track.readyState = "ended"; mock.deliver(1, 1); stop(); assert.equal(ended, 1);
  const failing = input(), failures: unknown[] = [];
  startVideoFrames(failing.video, new AbortController().signal, () => { throw new Error("failed"); }, () => assert.fail(), error => failures.push(error));
  failing.deliver(1, 1); assert.equal(failures.length, 1); assert.equal(failing.pending.size, 0);
});
test("watchdog detects an ended share with no callbacks, and timer fallback skips unchanged frames", t => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const mock = input(); let ended = 0;
  startVideoFrames(mock.video, new AbortController().signal, () => assert.fail(), () => ended++, error => { throw error; });
  mock.track.readyState = "ended"; t.mock.timers.tick(33);
  assert.equal(ended, 1); assert.equal(mock.pending.size, 0);
  t.mock.timers.tick(1000); assert.equal(ended, 1);
  const fallback = input(), abort = new AbortController(); let captures = 0;
  Object.assign(fallback.video, { requestVideoFrameCallback: undefined, cancelVideoFrameCallback: undefined });
  startVideoFrames(fallback.video, abort.signal, () => captures++, () => assert.fail(), error => { throw error; });
  t.mock.timers.tick(33); assert.equal(captures, 1);
  t.mock.timers.tick(99); assert.equal(captures, 1);
  fallback.video.currentTime = 1 / 30; t.mock.timers.tick(33); assert.equal(captures, 2);
  abort.abort(); fallback.video.currentTime = 2 / 30; t.mock.timers.tick(33); assert.equal(captures, 2);
});
