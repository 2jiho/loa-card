import { test } from "node:test";
import assert from "node:assert/strict";
import { recordContinuous } from "../src/features/card-scanner/continuous-capture";

class FakeRecorder extends EventTarget {
  static instance: FakeRecorder;
  static isTypeSupported(type: string) { return type.includes("vp8"); }
  state = "inactive";
  mimeType: string;
  requestedBitrate: number;
  stopCalls = 0;
  constructor(_stream: unknown, options: { mimeType: string; videoBitsPerSecond: number }) {
    super(); this.mimeType = options.mimeType; this.requestedBitrate = options.videoBitsPerSecond; FakeRecorder.instance = this;
  }
  start() { this.state = "recording"; }
  data(text: string) {
    this.dispatchEvent(Object.assign(new Event("dataavailable"), { data: new Blob([text]) }));
  }
  stop() {
    this.state = "inactive"; this.stopCalls++;
    queueMicrotask(() => { this.data("tail"); this.dispatchEvent(new Event("stop")); });
  }
}
const Recorder = FakeRecorder as unknown as typeof MediaRecorder;
test("screen recording requests text detail and a resolution-aware bitrate on the actual encoder", async () => {
  const track = { contentHint: "", getSettings: () => ({ width: 2560, height: 1440, frameRate: 60 }) };
  const before = performance.now();
  const capture = recordContinuous({ getVideoTracks: () => [track] } as unknown as MediaStream, () => {}, Recorder);
  assert.ok(capture.startedAt >= before && capture.startedAt <= performance.now());
  assert.equal(track.contentHint, "text");
  assert.equal(FakeRecorder.instance.requestedBitrate, 33_177_600);
  assert.ok(await capture.finish());
});
test("continuous recording preserves encoded chunks including stop's final chunk", async () => {
  const warnings: string[] = [];
  const capture = recordContinuous({} as MediaStream, message => warnings.push(message), Recorder);
  FakeRecorder.instance.data("first"); FakeRecorder.instance.data("second");
  const result = await capture.finish();
  assert.ok(result); assert.equal(await result.blob.text(), "firstsecondtail");
  assert.equal(result.blob.type, "video/webm;codecs=vp8");
  assert.equal(await capture.finish(), result); assert.equal(FakeRecorder.instance.stopCalls, 1);
  assert.deepEqual(warnings, []);
});
test("a truncated recording is never replayed as if it covered the entire scan", async () => {
  const warnings: string[] = [];
  const capture = recordContinuous({} as MediaStream, message => warnings.push(message), Recorder, 5);
  FakeRecorder.instance.data("123456");
  assert.equal(await capture.finish(), undefined);
  assert.equal(warnings.length, 1); assert.match(warnings[0], /용량/);
});
test("encoder failure is reported without returning a partial recovery video", async () => {
  const warnings: string[] = [];
  const capture = recordContinuous({} as MediaStream, message => warnings.push(message), Recorder);
  FakeRecorder.instance.data("first"); FakeRecorder.instance.dispatchEvent(new Event("error"));
  assert.equal(await capture.finish(), undefined);
  assert.equal(warnings.length, 1); assert.match(warnings[0], /실패/);
});
