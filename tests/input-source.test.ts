import { test } from "node:test";
import assert from "node:assert/strict";
import { imageInputs, yieldForCapture } from "../src/features/card-scanner/input-source";

test("image input retains order and exact source elements through the final image", async () => {
  const images = [{ src: "first" }, { src: "last" }] as HTMLImageElement[];
  const frames = [];
  for await (const frame of imageInputs(images, new AbortController().signal)) frames.push(frame);
  assert.deepEqual(frames.map(frame => frame.element), images);
  assert.deepEqual(frames.map(frame => frame.percent), [50, 100]);
  assert.ok(frames.every(frame => frame.still));
});

test("aborting image input prevents the next frame from entering the pipeline", async () => {
  const abort = new AbortController();
  const input = imageInputs([{}, {}] as HTMLImageElement[], abort.signal);
  assert.equal((await input.next()).done, false);
  abort.abort();
  await assert.rejects(input.next(), { name: "AbortError" });
});

test("capture yield supports the timer fallback and rejects cancellation before resuming", async () => {
  await yieldForCapture(new AbortController().signal);
  const control=new AbortController();control.abort();
  await assert.rejects(yieldForCapture(control.signal),{name:'AbortError'});
});

test("native scheduler yield still observes a cancellation during the yield", async () => {
  const prior=Object.getOwnPropertyDescriptor(globalThis,'scheduler'),control=new AbortController();
  let yielded=false;
  Object.defineProperty(globalThis,'scheduler',{configurable:true,value:{async yield(){yielded=true;control.abort();}}});
  try { await assert.rejects(yieldForCapture(control.signal),{name:'AbortError'});assert.equal(yielded,true); }
  finally { if(prior)Object.defineProperty(globalThis,'scheduler',prior);else Reflect.deleteProperty(globalThis,'scheduler'); }
});
