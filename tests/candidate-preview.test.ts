import test from 'node:test';
import assert from 'node:assert/strict';
import { createCandidatePreviewEncoder } from '../src/features/card-scanner/candidate-preview';
import { encodeCandidatePreviewImage } from '../src/features/card-scanner/candidate-preview-image';

function canvas() {
  const callbacks: BlobCallback[] = [];
  const formats: unknown[][] = [];
  const value = { width: 140, height: 210, toBlob(callback: BlobCallback, ...format: unknown[]) {
    callbacks.push(callback); formats.push(format);
  } } as unknown as HTMLCanvasElement;
  return { value, callbacks, formats };
}

function fileReader() {
  let aborted = 0;
  const inputs: Blob[] = [];
  const value = {
    result: null as string | ArrayBuffer | null,
    onload: null as FileReader['onload'], onerror: null as FileReader['onerror'], onabort: null as FileReader['onabort'],
    readAsDataURL(blob: Blob) { inputs.push(blob); },
    abort() { aborted++; },
  };
  const fire = (type: 'onload' | 'onerror' | 'onabort') => value[type]?.call(value as FileReader, {} as ProgressEvent<FileReader>);
  return { value, inputs, fire, aborted: () => aborted };
}

const jpeg = () => new Blob(['preview'], { type: 'image/jpeg' });
const encoder = (options: Parameters<typeof createCandidatePreviewEncoder>[0] = {}) => createCandidatePreviewEncoder(options).encode;

test('optional preview encodes asynchronously with the original JPEG quality and retains caller ownership', async () => {
  const source = canvas(), reader = fileReader();
  const previews = createCandidatePreviewEncoder({ createReader: () => reader.value });
  const { encode } = previews;
  assert.equal(previews.waiting, 0);
  const result = encode(source.value);
  assert.equal(previews.waiting, 1);
  assert.deepEqual(source.formats, [['image/jpeg', 0.92]]);
  assert.equal(reader.inputs.length, 0);
  const blob = jpeg(); source.callbacks[0](blob);
  assert.equal(previews.waiting, 1, 'FileReader is still part of the unresolved request');
  assert.deepEqual(reader.inputs, [blob]);
  reader.value.result = 'data:image/jpeg;base64,cHJldmlldw=='; reader.fire('onload');
  assert.equal(previews.waiting, 0);
  assert.equal(await result, reader.value.result);
  assert.equal(source.value.width, 140); assert.equal(source.value.height, 210);
  assert.equal(reader.value.onload, null); assert.equal(reader.value.onerror, null); assert.equal(reader.value.onabort, null);
  assert.equal(reader.aborted(), 0);
});

test('null blobs, encoder exceptions, reader exceptions and read errors omit the optional preview', async () => {
  const source = canvas(), reader = fileReader();
  const encode = encoder({ createReader: () => reader.value });
  let result = encode(source.value); source.callbacks[0](null); assert.equal(await result, '');
  result = encode({ width: 140, height: 210, toBlob() { throw Error('tainted'); } } as unknown as HTMLCanvasElement);
  assert.equal(await result, '');
  result = encode(source.value); source.callbacks[1](jpeg()); reader.fire('onerror'); assert.equal(await result, '');
  const missingReader = encoder({ createReader() { throw Error('unsupported'); } });
  result = missingReader(source.value); source.callbacks[2](jpeg()); assert.equal(await result, '');
  reader.value.readAsDataURL = () => { throw Error('read failed'); };
  result = encode(source.value); source.callbacks[3](jpeg()); assert.equal(await result, '');
});

test('cancelled or empty inputs never start native encoding', async () => {
  const source = canvas(), controller = new AbortController(); controller.abort();
  const previews = createCandidatePreviewEncoder({ signal: controller.signal });
  const { encode } = previews;
  assert.equal(await encode(source.value), '');
  assert.equal(previews.waiting, 0);
  source.value.width = 0; assert.equal(await encoder()(source.value), '');
  assert.equal(source.callbacks.length, 0);
});

test('aborting a pending blob resolves immediately and ignores its late callback', async () => {
  const source = canvas(), controller = new AbortController(); let readers = 0;
  const previews = createCandidatePreviewEncoder({ signal: controller.signal, maxPending: 1, createReader() { readers++; return fileReader().value; } });
  const { encode } = previews;
  const result = encode(source.value); assert.equal(previews.waiting, 1); controller.abort();
  assert.equal(previews.waiting, 0);
  assert.equal(await result, '');
  assert.equal(await encode(source.value), '', 'native work stays capped until the callback arrives');
  assert.equal(source.callbacks.length, 1);
  source.callbacks[0](jpeg()); assert.equal(readers, 0);
  assert.equal(previews.waiting, 0, 'a late native callback does not decrement waiting again');
  assert.equal(await encode(source.value), '', 'an aborted scanner cannot start a new encode');
  assert.equal(source.callbacks.length, 1);
});

test('cancelling FileReader aborts the read and detached late events cannot affect a newer request', async () => {
  const source = canvas(), reader = fileReader(), controller = new AbortController();
  const encode = encoder({ signal: controller.signal, maxPending: 1, createReader: () => reader.value });
  const result = encode(source.value); source.callbacks[0](jpeg());
  const lateLoad = reader.value.onload;
  controller.abort(); assert.equal(await result, ''); assert.equal(reader.aborted(), 1);
  assert.equal(reader.value.onload, null); assert.equal(reader.value.onerror, null); assert.equal(reader.value.onabort, null);
  const next = encoder({ createReader: () => reader.value })(source.value);
  reader.value.result = 'data:image/jpeg;base64,old'; lateLoad?.call(reader.value as FileReader, {} as ProgressEvent<FileReader>);
  source.callbacks[1](null); assert.equal(await next, '');
});

test('timeouts bound optional work and stalled native callbacks cannot grow an unbounded backlog', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const source = canvas(); let readers = 0;
  const previews = createCandidatePreviewEncoder({ maxPending: 2, timeoutMs: 50, createReader() { readers++; return fileReader().value; } });
  const { encode } = previews;
  const first = encode(source.value), second = encode(source.value);
  assert.equal(previews.waiting, 2);
  t.mock.timers.tick(50);
  assert.equal(previews.waiting, 0, 'timed-out native work cannot hold scan completion open');
  assert.equal(await first, ''); assert.equal(await second, '');
  for (let i = 0; i < 20; i++) assert.equal(await encode(source.value), '');
  assert.equal(previews.waiting, 0, 'rejected work never creates an unresolved caller');
  assert.equal(source.callbacks.length, 2);
  source.callbacks[0](jpeg()); source.callbacks[0](jpeg()); assert.equal(readers, 0);
  assert.equal(previews.waiting, 0);
  const next = encode(source.value); assert.equal(source.callbacks.length, 3);
  assert.equal(previews.waiting, 1);
  assert.equal(await encode(source.value), '', 'a duplicate late callback must not release another slot');
  assert.equal(previews.waiting, 1);
  source.callbacks[2](null); assert.equal(await next, ''); source.callbacks[1](null);
  assert.equal(previews.waiting, 0);
});

test('the same deadline covers FileReader and cancels a stalled read', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const source = canvas(), reader = fileReader();
  const encode = encoder({ timeoutMs: 50, createReader: () => reader.value });
  const result = encode(source.value); t.mock.timers.tick(40); source.callbacks[0](jpeg());
  t.mock.timers.tick(10); assert.equal(await result, ''); assert.equal(reader.aborted(), 1);
});

test('disposing resolves every pending preview and a new scanner has an independent work cap', async () => {
  const source = canvas(), reader = fileReader();
  const previous = createCandidatePreviewEncoder({ maxPending: 2, createReader: () => reader.value });
  const first = previous.encode(source.value), second = previous.encode(source.value);
  assert.equal(previous.waiting, 2);
  source.callbacks[0](jpeg()); previous.dispose(); previous.dispose();
  assert.equal(previous.waiting, 0);
  assert.equal(await first, ''); assert.equal(await second, ''); assert.equal(reader.aborted(), 1);
  assert.equal(await previous.encode(source.value), '');
  const current = createCandidatePreviewEncoder({ maxPending: 1 });
  const next = current.encode(source.value);
  source.callbacks[1](jpeg()); source.callbacks[2](null);
  assert.equal(await next, ''); current.dispose();
});

test('owned previews start without waiting and release their separate canvas only after encoding settles', async () => {
  const source = canvas(), reader = fileReader();
  const previews = createCandidatePreviewEncoder({ createReader: () => reader.value });
  const task = previews.encodeOwned(source.value);
  assert.equal(previews.waiting, 1); assert.equal(source.value.width, 140);
  // Recognition uses another crop and can finish before the encoder callback.
  const recognition = await Promise.resolve({ id: 'read-before-thumbnail', count: 2 });
  assert.equal(recognition.count, 2); assert.equal(previews.waiting, 1);
  assert.equal(source.value.width, 140); assert.equal(source.value.height, 210);
  source.callbacks[0](jpeg()); assert.equal(source.value.width, 140, 'the data URL read still owns the thumbnail');
  reader.value.result = 'data:image/jpeg;base64,preview'; reader.fire('onload');
  assert.equal(await task, reader.value.result);
  assert.equal(source.value.width, 0); assert.equal(source.value.height, 0);
  await previews.dispose();
});

test('owned preview jobs are shared by retries, bounded on admission, and joined on disposal', async () => {
  const first = canvas(), second = canvas(), reader = fileReader();
  const previews = createCandidatePreviewEncoder({ maxPending: 1, createReader: () => reader.value });
  const original = { task: previews.encodeOwned(first.value) }, retry = { ...original };
  assert.equal(original.task, retry.task); assert.equal(first.callbacks.length, 1);
  assert.equal(await previews.encodeOwned(second.value), '', 'saturated thumbnail work is optional');
  assert.equal(second.callbacks.length, 0); assert.equal(second.value.width, 0);
  first.callbacks[0](jpeg());
  await previews.dispose();
  assert.equal(await original.task, ''); assert.equal(await retry.task, '');
  assert.equal(reader.aborted(), 1); assert.equal(previews.waiting, 0);
  assert.equal(first.value.width, 0); assert.equal(first.value.height, 0);
});

test('timed-out owned previews free caller pixels and ignore their late native callback', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const source = canvas(); let reads = 0;
  const previews = createCandidatePreviewEncoder({ timeoutMs: 50, createReader() { reads++; return fileReader().value; } });
  const task = previews.encodeOwned(source.value);
  t.mock.timers.tick(50); assert.equal(await task, ''); assert.equal(source.value.width, 0);
  source.callbacks[0](jpeg()); assert.equal(reads, 0);
  await previews.dispose(); assert.equal(source.value.height, 0);
});

function workerHarness() {
  const sent: { id: number; bitmap: ImageBitmap; transfer: Transferable[] }[] = [];
  const freezes: { source: HTMLCanvasElement; resolve: (bitmap: ImageBitmap) => void; reject: (error: Error) => void }[] = [];
  let terminated = 0, created = 0;
  const worker = {
    onmessage: null as Worker['onmessage'], onerror: null as Worker['onerror'], onmessageerror: null as Worker['onmessageerror'],
    postMessage(message: { id: number; bitmap: ImageBitmap }, transfer: Transferable[]) { sent.push({ ...message, transfer }); },
    terminate() { terminated++; },
  };
  const options = {
    createWorker: () => { created++; return worker as unknown as Worker; },
    createBitmap: (source: HTMLCanvasElement) => new Promise<ImageBitmap>((resolve, reject) => freezes.push({ source, resolve, reject })),
  };
  const respond = (data: unknown) => worker.onmessage?.call(worker as unknown as Worker, { data } as MessageEvent);
  return { worker, options, freezes, sent, respond, created: () => created, terminated: () => terminated };
}

function bitmap() {
  let closed = 0;
  return { value: { width: 140, height: 210, close() { closed++; } } as ImageBitmap, closed: () => closed };
}

test('worker previews transfer a snapshot without HTML toBlob and release owned pixels after the reply', async () => {
  const source = canvas(), harness = workerHarness(), pixels = bitmap();
  const previews = createCandidatePreviewEncoder(harness.options);
  const task = previews.encodeOwned(source.value);
  assert.equal(previews.waiting, 1); assert.equal(harness.freezes[0].source, source.value);
  assert.equal(source.callbacks.length, 0);
  harness.freezes[0].resolve(pixels.value); await Promise.resolve();
  assert.deepEqual(harness.sent[0], { id: 1, bitmap: pixels.value, transfer: [pixels.value] });
  assert.equal(source.value.width, 140); assert.equal(pixels.closed(), 0, 'the worker owns transferred pixels');
  harness.respond({ id: 1, image: 'data:image/jpeg;base64,d29ya2Vy' });
  assert.equal(await task, 'data:image/jpeg;base64,d29ya2Vy');
  assert.equal(previews.waiting, 0); assert.equal(source.value.width, 0);
  assert.equal(source.callbacks.length, 0, 'normal worker work never enters the main-thread encoder');
  await previews.dispose(); assert.equal(harness.terminated(), 1);
});

test('timed-out bitmap snapshots keep admission bounded and close late pixels without posting them', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const source = canvas(), harness = workerHarness();
  const previews = createCandidatePreviewEncoder({ ...harness.options, maxPending: 1, timeoutMs: 50 });
  const task = previews.encodeOwned(source.value);
  t.mock.timers.tick(50); assert.equal(await task, ''); assert.equal(previews.waiting, 0);
  assert.equal(source.value.width, 0);
  const nextSource = canvas();
  for (let i = 0; i < 20; i++) assert.equal(await previews.encode(nextSource.value), '');
  assert.equal(harness.freezes.length, 1, 'unresolved snapshot still owns its native credit');
  const pixels = bitmap(); harness.freezes[0].resolve(pixels.value); await Promise.resolve();
  assert.equal(pixels.closed(), 1); assert.equal(harness.sent.length, 0);
  const next = previews.encode(nextSource.value);
  assert.equal(harness.freezes.length, 2); assert.equal(previews.waiting, 1);
  await previews.dispose(); assert.equal(await next, '');
  const late = bitmap(); harness.freezes[1].resolve(late.value); await Promise.resolve();
  assert.equal(late.closed(), 1); assert.equal(harness.sent.length, 0);
});

test('worker deadline ends only the request and a late reply restores capacity without native fallback', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const source = canvas(), harness = workerHarness(), pixels = bitmap();
  const previews = createCandidatePreviewEncoder({ ...harness.options, maxPending: 1, timeoutMs: 50 });
  const task = previews.encode(source.value);
  harness.freezes[0].resolve(pixels.value); await Promise.resolve();
  t.mock.timers.tick(50); assert.equal(await task, ''); assert.equal(previews.waiting, 0);
  assert.equal(harness.terminated(), 0); assert.equal(pixels.closed(), 0);
  for (let i = 0; i < 20; i++) assert.equal(await previews.encode(source.value), '');
  assert.equal(harness.freezes.length, 1, 'timed-out native work still occupies its slot');
  assert.equal(source.callbacks.length, 0, 'temporary worker slowness never enables the HTML encoder');
  harness.respond({ id: 1, image: 'stale' });
  assert.equal(await task, '', 'the timed-out result cannot be changed by its late image');
  const next = previews.encode(source.value); assert.equal(harness.freezes.length, 2);
  harness.freezes[1].resolve(bitmap().value); await Promise.resolve();
  harness.respond({ id: 1, image: 'duplicate stale' });
  assert.equal(previews.waiting, 1, 'a duplicate old reply cannot settle another request or free another slot');
  assert.equal(await previews.encode(source.value), '');
  harness.respond({ id: 2, image: 'data:image/jpeg;base64,Y3VycmVudA==' });
  assert.equal(await next, 'data:image/jpeg;base64,Y3VycmVudA==');
  assert.equal(harness.created(), 1); assert.equal(source.callbacks.length, 0);
  await previews.dispose(); assert.equal(harness.terminated(), 1);
});

test('disposing a timed-out worker releases its posted jobs and the next scanner has independent capacity', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const source = canvas(), harness = workerHarness();
  const previews = createCandidatePreviewEncoder({ ...harness.options, maxPending: 1, timeoutMs: 50 });
  const task = previews.encode(source.value);
  harness.freezes[0].resolve(bitmap().value); await Promise.resolve();
  const lateReply = harness.worker.onmessage;
  t.mock.timers.tick(50); assert.equal(await task, ''); await previews.dispose();
  assert.equal(harness.terminated(), 1); assert.equal(previews.waiting, 0);
  const freshHarness = workerHarness(), next = createCandidatePreviewEncoder({ ...freshHarness.options, maxPending: 1 });
  const nextTask = next.encode(source.value); assert.equal(next.waiting, 1);
  lateReply?.call(harness.worker as unknown as Worker, { data: { id: 1, image: 'old scan' } } as MessageEvent);
  assert.equal(next.waiting, 1);
  freshHarness.freezes[0].resolve(bitmap().value); await Promise.resolve();
  freshHarness.respond({ id: 1, image: 'data:image/jpeg;base64,bmV3' });
  assert.equal(await nextTask, 'data:image/jpeg;base64,bmV3'); await next.dispose();
});

test('worker errors cancel posted jobs but keep outstanding snapshot credits until pixels return', async () => {
  const source = canvas(), harness = workerHarness();
  const previews = createCandidatePreviewEncoder({ ...harness.options, maxPending: 2 });
  const first = previews.encode(source.value), second = previews.encode(source.value);
  harness.freezes[0].resolve(bitmap().value); await Promise.resolve();
  harness.respond({ id: 1, error: 'convertToBlob unavailable' });
  assert.equal(await first, ''); assert.equal(await second, ''); assert.equal(previews.waiting, 0);
  const fallback = previews.encode(source.value);
  assert.equal(source.callbacks.length, 1);
  assert.equal(await previews.encode(source.value), '', 'the late snapshot and native fallback use both credits');
  const late = bitmap(); harness.freezes[1].resolve(late.value); await Promise.resolve();
  assert.equal(late.closed(), 1); assert.equal(harness.sent.length, 1);
  const extra = previews.encode(source.value); assert.equal(source.callbacks.length, 2);
  source.callbacks[0](null); source.callbacks[1](null);
  assert.equal(await fallback, ''); assert.equal(await extra, ''); await previews.dispose();
});

test('actual worker runtime and message errors still terminate it and allow bounded HTML fallback', async () => {
  for (const event of ['onerror', 'onmessageerror'] as const) {
    const source = canvas(), harness = workerHarness();
    const previews = createCandidatePreviewEncoder({ ...harness.options, maxPending: 1 });
    const task = previews.encode(source.value);
    harness.freezes[0].resolve(bitmap().value); await Promise.resolve();
    if (event === 'onerror') harness.worker.onerror?.call(harness.worker as unknown as Worker, {} as ErrorEvent);
    else harness.worker.onmessageerror?.call(harness.worker as unknown as Worker, {} as MessageEvent);
    assert.equal(await task, ''); assert.equal(harness.terminated(), 1);
    const fallback = previews.encode(source.value);
    assert.equal(source.callbacks.length, 1); assert.equal(await previews.encode(source.value), '');
    source.callbacks[0](null); assert.equal(await fallback, ''); await previews.dispose();
  }
});

test('worker startup, snapshot and transfer failures never hang optional previews', async () => {
  const source = canvas();
  const unavailable = createCandidatePreviewEncoder({ createWorker() { throw Error('CSP'); } });
  let task = unavailable.encode(source.value); source.callbacks[0](null); assert.equal(await task, '');
  await unavailable.dispose();
  const harness = workerHarness();
  const previews = createCandidatePreviewEncoder(harness.options);
  task = previews.encode(source.value); harness.freezes[0].reject(Error('bitmap rejected')); await Promise.resolve();
  source.callbacks[1](null); assert.equal(await task, '');
  harness.worker.postMessage = () => { throw Error('transfer rejected'); };
  task = previews.encode(source.value); const pixels = bitmap();
  harness.freezes[1].resolve(pixels.value); await Promise.resolve();
  assert.equal(await task, ''); assert.equal(pixels.closed(), 1); assert.equal(harness.terminated(), 1);
  await previews.dispose();
});

test('abort and disposal join owned preview work while closing untransferred late bitmaps', async () => {
  const source = canvas(), harness = workerHarness(), controller = new AbortController();
  const previews = createCandidatePreviewEncoder({ ...harness.options, signal: controller.signal });
  const first = previews.encodeOwned(source.value), second = previews.encodeOwned(canvas().value);
  harness.freezes[0].resolve(bitmap().value); await Promise.resolve();
  controller.abort(); await previews.dispose();
  assert.equal(await first, ''); assert.equal(await second, ''); assert.equal(source.value.width, 0);
  assert.equal(previews.waiting, 0); assert.equal(harness.terminated(), 1);
  const late = bitmap(); harness.freezes[1].resolve(late.value); await Promise.resolve();
  assert.equal(late.closed(), 1); assert.equal(harness.sent.length, 1);
  assert.equal(await previews.encode(canvas().value), '');
});

test('worker JPEG helper uses the original quality, chunked base64 and releases bitmap/canvas', async () => {
  const pixels = bitmap(), bytes = Uint8Array.from({ length: 70_000 }, (_, index) => index % 256);
  let format: ImageEncodeOptions | undefined, draw: unknown[] | undefined;
  const offscreen = { width: 140, height: 210,
    getContext: () => ({ drawImage(...args: unknown[]) { draw = args; } }),
    async convertToBlob(options: ImageEncodeOptions) { format = options; assert.equal(pixels.closed(), 1); return new Blob([bytes], { type: 'image/jpeg' }); },
  } as unknown as OffscreenCanvas;
  const image = await encodeCandidatePreviewImage(pixels.value, () => offscreen);
  assert.deepEqual(format, { type: 'image/jpeg', quality: 0.92 });
  assert.deepEqual(draw, [pixels.value, 0, 0]);
  assert.equal(image, `data:image/jpeg;base64,${Buffer.from(bytes).toString('base64')}`);
  assert.equal(pixels.closed(), 1); assert.equal(offscreen.width, 0); assert.equal(offscreen.height, 0);
});

test('worker JPEG helper releases pixels and canvas on constructor, drawing or encoding failure', async () => {
  const constructorPixels = bitmap();
  await assert.rejects(encodeCandidatePreviewImage(constructorPixels.value, () => { throw Error('canvas'); }));
  assert.equal(constructorPixels.closed(), 1);
  for (const stage of ['draw', 'encode']) {
    const pixels = bitmap();
    const offscreen = { width: 140, height: 210,
      getContext: () => ({ drawImage() { if (stage === 'draw') throw Error(stage); } }),
      async convertToBlob() { throw Error(stage); },
    } as unknown as OffscreenCanvas;
    await assert.rejects(encodeCandidatePreviewImage(pixels.value, () => offscreen));
    assert.equal(pixels.closed(), 1); assert.equal(offscreen.width, 0); assert.equal(offscreen.height, 0);
  }
});
