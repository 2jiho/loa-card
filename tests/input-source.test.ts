import { test } from "node:test";
import assert from "node:assert/strict";
import { imageInputs, streamImageInputs, yieldForCapture } from "../src/features/card-scanner/input-source";

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

type FakeImageState = { src: string; released: boolean };
async function fakeImages(run: (created: FakeImageState[]) => Promise<void>,
  decode: (image: FakeImageState, created: readonly FakeImageState[]) => Promise<void> = () => Promise.resolve()) {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'Image');
  const created: { src: string; released: boolean }[] = [];
  class Image {
    src = ''; released = false;
    constructor() { created.push(this); }
    decode() { return decode(this, created); }
    removeAttribute(attribute: string) { assert.equal(attribute, 'src'); this.src = ''; this.released = true; }
  }
  Object.defineProperty(globalThis, 'Image', { configurable: true, value: Image });
  try { await run(created); }
  finally { if (original) Object.defineProperty(globalThis, 'Image', original); else Reflect.deleteProperty(globalThis, 'Image'); }
}

for (const adapter of [
  { name: 'streaming images', inputs: streamImageInputs, still: false },
  { name: 'normal image URL inputs', inputs: imageInputs, still: true },
]) {
test(`${adapter.name} preserve repeats and order with one decoded image at a time`, async () => {
  const sources = Object.freeze(['z.png', 'a.png', 'z.png']), decoding: string[] = [];
  await fakeImages(async created => {
    const iterator = adapter.inputs(sources, new AbortController().signal);
    assert.equal(created.length, 0);
    for (const [index, name] of sources.entries()) {
      const frame = await iterator.next();
      assert.equal(frame.done, false); assert.ok(frame.value);
      assert.equal(frame.value.element, created[index]);
      assert.equal(frame.value.element.src, name);
      assert.ok('time' in frame.value); assert.equal(frame.value.time, 0);
      if (adapter.still) { assert.ok('still' in frame.value); assert.equal(frame.value.still, true); }
      assert.equal(frame.value.percent, (index + 1) / 3 * 100);
      assert.equal(created.length, index + 1);
      assert.ok(created.slice(0, -1).every(image => image.released));
      assert.equal(created.at(-1)!.released, false);
    }
    assert.equal((await iterator.next()).done, true);
    assert.ok(created.every(image => image.released));
    assert.deepEqual(decoding, sources);
  }, async (image, created) => {
    assert.equal(created.at(-1), image);
    assert.equal(created.filter(value => !value.released).length, 1,
      'the previous decoded image must be released before the next decode starts');
    decoding.push(image.src);
  });
});

test(`${adapter.name} release the current image on early return without loading the remainder`, async () => {
  await fakeImages(async created => {
    const iterator = adapter.inputs(['first', 'unused'], new AbortController().signal);
    await iterator.next(); await iterator.return();
    assert.equal(created.length, 1); assert.equal(created[0].released, true);
  });
});

test(`${adapter.name} cancel a pending decode and release it even when native decode never settles`, async () => {
  await fakeImages(async created => {
    const controller = new AbortController();
    const iterator = adapter.inputs(['first', 'unused'], controller.signal);
    const pending = iterator.next(); controller.abort();
    await assert.rejects(pending, { name: 'AbortError' });
    assert.equal(created.length, 1); assert.equal(created[0].released, true);
  }, () => new Promise<void>(() => {}));
});

test(`${adapter.name} stop and release a failed decode rather than skipping a source`, async () => {
  await fakeImages(async created => {
    const iterator = adapter.inputs(['broken', 'unused'], new AbortController().signal);
    await assert.rejects(iterator.next(), /decode failed/);
    assert.equal(created.length, 1); assert.equal(created[0].released, true);
  }, () => Promise.reject(new Error('decode failed')));
});
}

for (const urlsFirst of [true, false]) test(`normal image inputs reject a mixed list with ${urlsFirst ? 'URL' : 'element'} first before decoding`, async () => {
  await fakeImages(async created => {
    const element = { src: 'element' } as HTMLImageElement;
    const mixed = (urlsFirst ? ['url', element] : [element, 'url']) as unknown as Parameters<typeof imageInputs>[0];
    await assert.rejects(imageInputs(mixed, new AbortController().signal).next(), TypeError);
    assert.equal(created.length, 0);
    assert.equal(element.src, 'element');
  });
});
