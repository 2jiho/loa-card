import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMediaDecodedFrame, createMediaSequenceEnd, createMediaSequenceStart, mediaSourceFor,
  parseMediaDecodedFrame, parseMediaInputLink, parseMediaLineageFact, parseMediaSequenceEnd,
  parseMediaSequenceStart, parseMediaSource, withMediaLineage } from '../src/features/card-scanner/media-lineage';
import type { MediaInputLink, MediaLineageFact, MediaSequenceEnd } from '../src/features/card-scanner/media-lineage';
import { RunStateTrace, parseRunStateTrace, replayRunStateTrace } from '../dev/run-state-trace';

const blob = () => new Blob(['video bytes'], { type: 'video/mp4' });
const signal = () => new AbortController().signal;
const start = () => createMediaSequenceStart(blob(), { role: 'original-file' });
async function* values<T>(items: readonly T[]) { for (const item of items) yield item; }
async function collect<T>(items: AsyncIterable<T>) { const result: T[] = []; for await (const item of items) result.push(item); return result; }
function lastEnd(facts: MediaLineageFact[]): MediaSequenceEnd {
  const end = facts.at(-1); assert.equal(end?.kind, 'end');
  if (end?.kind !== 'end') throw Error('Expected end');
  return end;
}
function frozen(value: unknown): void {
  if (!value || typeof value !== 'object') return;
  assert.equal(Object.isFrozen(value), true);
  for (const child of Object.values(value)) frozen(child);
}
function link(): MediaInputLink {
  return { version: 1, sequenceId: 'sequence', sourceId: 'source', role: 'original-file', ordinal: 2,
    processingFrame: 7, acquisitionFrameId: 9, captureTime: 0.25, phase: 'input' };
}

test('Blob identity is object local, immutable metadata uses intrinsic getters, and URLs have fresh request identity', () => {
  const one = blob(), other = blob(), first = mediaSourceFor(one);
  assert.equal(first.sourceId, mediaSourceFor(one).sourceId);
  assert.notEqual(first.sourceId, mediaSourceFor(other).sourceId);
  assert.equal(first.bytes, one.size); assert.equal(first.mimeType, 'video/mp4');
  assert.equal(first.integrity, 'object-identity-only');
  Object.defineProperty(one, 'size', { get() { throw Error('caller size getter'); } });
  Object.defineProperty(one, 'type', { get() { throw Error('caller type getter'); } });
  assert.deepEqual(mediaSourceFor(one), first);
  assert.equal(mediaSourceFor(new Blob(['x'])).mimeType, '');
  const url = 'https://private.invalid/path?token=secret';
  const request = mediaSourceFor(url), requestAgain = mediaSourceFor(url);
  assert.notEqual(request.sourceId, requestAgain.sourceId);
  assert.equal(request.kind, 'url-request'); assert.equal(request.bytes, null); assert.equal(request.mimeType, null);
  assert.equal(JSON.stringify(request).includes('private'), false); frozen(first); frozen(request);
  assert.throws(() => mediaSourceFor(new Blob()), /byte|integer/);
  assert.throws(() => mediaSourceFor({ size: 5, type: 'video/mp4' } as Blob));
});

test('each iterator has a fresh sequence while a reused Blob keeps only its source identity', async () => {
  const source = blob(), first: MediaLineageFact[] = [], second: MediaLineageFact[] = [];
  await collect(withMediaLineage(values([{ time: 1 }]), source, signal(), { role: 'unknown', onFact: fact => first.push(fact) }));
  await collect(withMediaLineage(values([{ time: 1 }]), source, signal(), { role: 'unknown', onFact: fact => second.push(fact) }));
  assert.equal(first[0].sourceId, second[0].sourceId);
  assert.notEqual(first[0].sequenceId, second[0].sequenceId);
  assert.deepEqual(first.map(fact => fact.kind), ['start', 'frame', 'end']);
});

test('iterator order distinguishes equal and reverse PTS and retains native references and every ordinary field', async () => {
  let cloned = 0, closed = 0;
  const native = { clone() { cloned++; }, close() { closed++; } }, canvas = { width: 4, height: 3 };
  const inputs = [2, 2, -0.125, 1].map((time, index) => ({ time, percent: index * 25,
    still: false, element: canvas, nativeFrame: native, extra: { index },
    decodeSample: { trackId: 3, duration: index / 10 } }));
  const facts: MediaLineageFact[] = [];
  const outputs = await collect(withMediaLineage(values(inputs), blob(), signal(), {
    role: 're-recorded-video', parentCaptureSessionId: 'caller-label', onFact: fact => facts.push(fact) }));
  assert.deepEqual(outputs.map(output => output.time), [2, 2, -0.125, 1]);
  assert.deepEqual(outputs.map(output => output.lineage?.ordinal), [1, 2, 3, 4]);
  assert.deepEqual(outputs.map(output => output.lineage?.pts), [2, 2, -0.125, 1]);
  for (let index = 0; index < outputs.length; index++) {
    const output = outputs[index], input = inputs[index];
    assert.equal(output.nativeFrame, native); assert.equal(output.element, canvas);
    assert.equal(output.extra, input.extra); assert.equal(output.decodeSample, input.decodeSample);
    assert.equal(output.percent, input.percent); assert.equal(output.still, input.still);
    assert.equal(output.lineage?.duration, index / 10); assert.equal(output.lineage?.trackId, 3);
    assert.equal(Object.hasOwn(input, 'lineage'), false); frozen(output.lineage);
  }
  assert.equal(cloned, 0); assert.equal(closed, 0);
  const begun = facts[0]; assert.equal(begun.kind, 'start');
  if (begun.kind === 'start') assert.equal(begun.parentCaptureSessionId, 'caller-label');
  assert.deepEqual(lastEnd(facts), createMediaSequenceEnd(facts[0] as ReturnType<typeof start>, 4, 'eof'));
});

test('wrapper never advances the source or reads the next pooled frame while its consumer holds a yield', async () => {
  let advances = 0, cleaned = 0;
  const native = { timestamp: 0 };
  async function* source() {
    try { for (let index = 0; index < 3; index++) { advances++; native.timestamp = index; yield { time: index, native }; } }
    finally { cleaned++; }
  }
  const facts: MediaLineageFact[] = [];
  const iterator = withMediaLineage(source(), blob(), signal(), { role: 'original-file', onFact: fact => facts.push(fact) });
  assert.equal(advances, 0); assert.equal(facts.length, 0);
  const first = await iterator.next(); assert.equal(first.value!.native, native); assert.equal(advances, 1);
  await Promise.resolve(); await Promise.resolve();
  assert.equal(advances, 1); assert.equal(first.value!.native.timestamp, 0);
  const second = await iterator.next(); assert.equal(second.value!.native.timestamp, 1); assert.equal(advances, 2);
  await iterator.return(); assert.equal(advances, 2); assert.equal(cleaned, 1);
  assert.equal(lastEnd(facts).reason, 'returned'); assert.equal(lastEnd(facts).complete, false);
});

test('lineage envelope preserves own descriptors and symbols without reading lazy pixel fields', async () => {
  let pixelReads = 0;
  const pixelKey = Symbol('native'), native = { timestamp: 1 }, input = { time: 1, [pixelKey]: native };
  Object.defineProperty(input, 'hidden', { value: native, enumerable: false, writable: false });
  Object.defineProperty(input, 'pixels', { enumerable: true, configurable: true,
    get() { pixelReads++; throw Error('pixel getter must not be read'); } });
  const [output] = await collect(withMediaLineage(values([input]), blob(), signal(), { role: 'unknown' }));
  assert.equal(pixelReads, 0); assert.equal(output[pixelKey], native);
  assert.equal(Object.getOwnPropertyDescriptor(output, 'hidden')?.value, native);
  assert.deepEqual(Object.getOwnPropertyDescriptor(output, 'pixels'), Object.getOwnPropertyDescriptor(input, 'pixels'));
  assert.deepEqual(Object.getOwnPropertyDescriptor(output, 'hidden'), Object.getOwnPropertyDescriptor(input, 'hidden'));
  assert.equal(output.lineage?.ordinal, 1); assert.equal(Object.hasOwn(input, 'lineage'), false);
});

test('natural EOF including an empty iterator is complete; early return and consumer throw are not EOF', async () => {
  for (const items of [[], [{ time: 1 }]]) {
    const facts: MediaLineageFact[] = [];
    await collect(withMediaLineage(values(items), blob(), signal(), { role: 'unknown', onFact: fact => facts.push(fact) }));
    assert.equal(lastEnd(facts).complete, true); assert.equal(lastEnd(facts).reason, 'eof');
    assert.equal(lastEnd(facts).frames, items.length);
  }
  for (const mode of ['return', 'throw'] as const) {
    const facts: MediaLineageFact[] = [];
    const iterator = withMediaLineage(values([{ time: 1 }]), blob(), signal(), { role: 'unknown', onFact: fact => facts.push(fact) });
    await iterator.next();
    if (mode === 'return') await iterator.return();
    else await assert.rejects(iterator.throw(new Error('consumer error')), /consumer error/);
    assert.equal(lastEnd(facts).complete, false); assert.equal(lastEnd(facts).frames, 1);
    assert.equal(lastEnd(facts).reason, mode === 'return' ? 'returned' : 'error');
  }
});

test('abort and decoder errors remain explicit, propagate to the consumer, and close the source', async () => {
  for (const mode of ['aborted', 'error'] as const) {
    let cleaned = 0;
    const controller = new AbortController(), facts: MediaLineageFact[] = [];
    async function* source() {
      try { yield { time: 0 }; if (mode === 'error') throw Error('decoder failed'); yield { time: 1 }; }
      finally { cleaned++; }
    }
    const iterator = withMediaLineage(source(), blob(), controller.signal, { role: 'unknown', onFact: fact => facts.push(fact) });
    await iterator.next(); if (mode === 'aborted') controller.abort();
    await assert.rejects(iterator.next(), mode === 'aborted' ? { name: 'AbortError' } : /decoder failed/);
    assert.equal(cleaned, 1); assert.equal(lastEnd(facts).reason, mode);
    assert.equal(lastEnd(facts).complete, false); assert.equal(lastEnd(facts).frames, 1);
  }
  const controller = new AbortController(), facts: MediaLineageFact[] = [];
  controller.abort();
  await assert.rejects(collect(withMediaLineage(values([{ time: 1 }]), blob(), controller.signal,
    { role: 'unknown', onFact: fact => facts.push(fact) })), { name: 'AbortError' });
  assert.equal(lastEnd(facts).reason, 'aborted'); assert.equal(lastEnd(facts).frames, 0);
});

test('aborted in-flight values remain owned by the decoder, with no native clone or close', async () => {
  let resolveNext!: (value: IteratorResult<{ time: number; native: object }>) => void;
  let returned = 0, closed = 0;
  const native = { close() { closed++; } }, controller = new AbortController(), facts: MediaLineageFact[] = [];
  const source = { [Symbol.asyncIterator]() { return {
    next: () => new Promise<IteratorResult<{ time: number; native: object }>>(resolve => { resolveNext = resolve; }),
    return: async () => { returned++; return { done: true as const, value: undefined }; },
  }; } };
  const iterator = withMediaLineage(source, blob(), controller.signal, { role: 'unknown', onFact: fact => facts.push(fact) });
  const pending = iterator.next(); controller.abort(); resolveNext({ done: false, value: { time: 2, native } });
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(returned, 1); assert.equal(closed, 0); assert.equal(lastEnd(facts).frames, 0);
});

test('diagnostic sink failures report once, suppress further facts, and preserve all delivered frames', async () => {
  const facts: MediaLineageFact[] = [], errors: unknown[] = [], inputs = [0, 1, 2].map(time => ({ time }));
  const outputs = await collect(withMediaLineage(values(inputs), blob(), signal(), { role: 'unknown',
    onFact(fact) { facts.push(fact); if (fact.kind === 'frame') throw Error('sink failed'); },
    onError(error) { errors.push(error); throw Error('error sink failed too'); } }));
  assert.equal(errors.length, 1); assert.match(String(errors[0]), /sink failed/);
  assert.deepEqual(facts.map(fact => fact.kind), ['start', 'frame']);
  assert.deepEqual(outputs.map(output => output.time), [0, 1, 2]);
  assert.deepEqual(outputs.map(output => output.lineage?.ordinal), [1, 2, 3]);
});

test('asynchronous diagnostic rejection is observed without stalling or rejecting frame delivery', async () => {
  const errors: unknown[] = [], facts: MediaLineageFact[] = [];
  const outputs = await collect(withMediaLineage(values([{ time: 0 }, { time: 1 }]), blob(), signal(), { role: 'unknown',
    onFact: async fact => { facts.push(fact); throw Error('async sink'); }, onError: async error => { errors.push(error); throw Error('async reporter'); } }));
  await Promise.resolve(); await Promise.resolve();
  assert.equal(outputs.length, 2); assert.equal(errors.length, 1); assert.equal(facts.length, 1);
});

test('invalid current sample metadata passes through unchanged without inventing lineage or stopping recognition', async () => {
  for (const invalid of [ { time: NaN }, { time: Infinity }, { time: 0, decodeSample: { trackId: -1, duration: 0 } },
    { time: 0, decodeSample: { trackId: 0, duration: -1 } },
    { time: 0, decodeSample: { trackId: 0, duration: 0, pixels: new Uint8Array(1) } } ]) {
    const facts: MediaLineageFact[] = [], errors: unknown[] = [];
    const inputs = [invalid, { time: -2, decodeSample: { trackId: null, duration: null } }];
    const outputs = await collect(withMediaLineage(values(inputs), blob(), signal(), { role: 'unknown',
      onFact: fact => facts.push(fact), onError: error => errors.push(error) }));
    assert.equal(outputs[0], invalid); assert.equal(Object.hasOwn(outputs[0], 'lineage'), false);
    assert.equal(outputs[1].lineage?.ordinal, 2); assert.equal(outputs[1].lineage?.pts, -2);
    assert.equal(errors.length, 1); assert.deepEqual(facts.map(fact => fact.kind), ['start']);
  }
  const input = { time: 0 }, errors: unknown[] = [];
  const outputs = await collect(withMediaLineage(values([input]), new Blob(), signal(), { role: 'unknown', onError: error => errors.push(error) }));
  assert.equal(outputs[0], input); assert.equal(errors.length, 1);
});

test('invalid source or current sample metadata never exposes own or inherited stale lineage', async () => {
  const stale = createMediaDecodedFrame(start(), 8, 1), native = { timestamp: 1 };
  for (const sourceFails of [false, true]) {
    for (const inherited of [false, true]) {
      const frame = Object.create(inherited ? { lineage: stale } : Object.prototype,
        { time: { value: sourceFails ? 1 : NaN, enumerable: true }, native: { value: native, enumerable: true } }) as { time: number; native: object; lineage?: typeof stale };
      if (!inherited) Object.defineProperty(frame, 'lineage', { value: stale, enumerable: true });
      const errors: unknown[] = [];
      const [output] = await collect(withMediaLineage(values([frame]), sourceFails ? new Blob() : blob(), signal(),
        { role: 'unknown', onError: error => errors.push(error) }));
      assert.equal(output.lineage, undefined); assert.notEqual(output, frame); assert.equal(output.native, native);
      assert.equal(frame.lineage, stale); assert.equal(errors.length, 1);
    }
  }
  const valid = { time: 1, lineage: stale }, [output] = await collect(withMediaLineage(values([valid]), blob(), signal(), { role: 'unknown' }));
  assert.notEqual(output.lineage?.sequenceId, stale.sequenceId); assert.equal(output.lineage?.ordinal, 1);
});

test('source return cleanup failure is an error terminator and never hides a previous decoder error', async () => {
  const cleanup = Error('cleanup failed');
  for (const decoderFails of [false, true]) {
    let advances = 0;
    const decoder = Error('decoder failed'), facts: MediaLineageFact[] = [];
    const source = { [Symbol.asyncIterator]() { return {
      async next() { if (advances++) throw decoder; return { done: false as const, value: { time: 0 } }; },
      async return(): Promise<IteratorResult<{ time: number }>> { throw cleanup; },
    }; } };
    const iterator = withMediaLineage(source, blob(), signal(), { role: 'unknown', onFact: fact => facts.push(fact) });
    await iterator.next();
    await assert.rejects(decoderFails ? iterator.next() : iterator.return(), error => error === (decoderFails ? decoder : cleanup));
    assert.equal(lastEnd(facts).reason, 'error'); assert.equal(lastEnd(facts).complete, false);
    assert.equal(lastEnd(facts).frames, 1);
  }
});

test('fact parsers detach and deeply freeze bounded metadata with explicit nulls and signed PTS', () => {
  const begun = { ...start(), parentCaptureSessionId: 'capture-label' };
  const parsed = parseMediaSequenceStart(begun);
  assert.deepEqual(parsed, begun); assert.notEqual(parsed, begun); assert.notEqual(parsed.source, begun.source); frozen(parsed);
  assert.equal(parseMediaSequenceStart({ ...begun, parentCaptureSessionId: null }).parentCaptureSessionId, null);
  const frame = createMediaDecodedFrame(parsed, 1, -0.5), end = createMediaSequenceEnd(parsed, 0, 'eof');
  assert.equal(frame.pts, -0.5); assert.equal(frame.duration, null); assert.equal(frame.trackId, null);
  for (const fact of [parsed, frame, end]) {
    assert.deepEqual(parseMediaLineageFact(JSON.parse(JSON.stringify(fact))), fact); frozen(fact);
    assert.ok(new TextEncoder().encode(JSON.stringify(fact)).byteLength <= 8_192);
  }
  const maximum = parseMediaSequenceStart({ ...begun, sequenceId: '\ud800'.repeat(160), sourceId: '\ud800'.repeat(160),
    source: { ...begun.source, sourceId: '\ud800'.repeat(160), mimeType: '\ud800'.repeat(128) }, parentCaptureSessionId: '\ud800'.repeat(160) });
  assert.ok(new TextEncoder().encode(JSON.stringify(maximum)).byteLength <= 8_192);
});

test('strict source, frame and termination bounds reject coercion, missing nulls and invalid completeness', () => {
  const begun = start(), frame = createMediaDecodedFrame(begun, 1, 0), end = createMediaSequenceEnd(begun, 1, 'eof');
  for (const patch of [ { sourceId: '' }, { sourceId: 'x'.repeat(161) }, { sourceId: 'bad\nname' },
    { kind: 'file' }, { bytes: 0 }, { bytes: 1.5 }, { bytes: Number.MAX_SAFE_INTEGER + 1 },
    { mimeType: 'x'.repeat(129) }, { mimeType: 'bad\u0085type' }, { integrity: 'sha256' } ])
    assert.throws(() => parseMediaSource({ ...begun.source, ...patch }));
  assert.throws(() => parseMediaSource({ ...begun.source, bytes: null }));
  assert.throws(() => parseMediaSource({ ...mediaSourceFor('url'), bytes: 4 }));
  assert.throws(() => parseMediaSource({ ...mediaSourceFor('url'), mimeType: 'video/mp4' }));
  for (const patch of [ { version: '1' }, { role: 'recording' }, { ordinal: 0 }, { ordinal: 1.5 },
    { ordinal: Number.MAX_SAFE_INTEGER + 1 }, { pts: NaN }, { pts: Infinity }, { pts: '1' }, { duration: -0.1 },
    { duration: undefined }, { duration: Infinity }, { trackId: -1 }, { trackId: 0.5 }, { trackId: undefined } ])
    assert.throws(() => parseMediaDecodedFrame({ ...frame, ...patch }));
  for (const patch of [ { frames: -1 }, { frames: 0.5 }, { complete: false }, { complete: 1 },
    { reason: 'returned' }, { reason: 'stopped' } ]) assert.throws(() => parseMediaSequenceEnd({ ...end, ...patch }));
  for (const patch of [ { sourceId: 'mismatch' }, { parentCaptureSessionId: undefined },
    { parentCaptureSessionId: '' }, { parentCaptureSessionId: 'x'.repeat(161) } ])
    assert.throws(() => parseMediaSequenceStart({ ...begun, ...patch }));
});

test('strict whitelists reject model, pixel, archive and control injections without calling getters', () => {
  const begun = start(), frame = createMediaDecodedFrame(begun, 1, 0), end = createMediaSequenceEnd(begun, 1, 'returned');
  for (const input of [begun, frame, end]) {
    for (const key of ['expected', 'cardId', 'candidate', 'pixels', 'image', 'archive', 'command', 'url', 'toJSON'])
      assert.throws(() => parseMediaLineageFact({ ...input, [key]: key === 'toJSON' ? () => { throw Error('executed'); } : true }));
    assert.throws(() => parseMediaLineageFact({ ...input, [Symbol('pixels')]: new Uint8Array(1) }));
    assert.throws(() => parseMediaLineageFact(Object.assign(new Date(), input)));
    const hidden = { ...input }; Object.defineProperty(hidden, 'command', { value: 'stop' });
    assert.throws(() => parseMediaLineageFact(hidden));
    let called = false;
    const getter = { ...input }; Object.defineProperty(getter, 'sequenceId', { enumerable: true, get() { called = true; return 'id'; } });
    assert.throws(() => parseMediaLineageFact(getter)); assert.equal(called, false);
    const discriminator = { ...input }; Object.defineProperty(discriminator, 'kind', { enumerable: true, get() { called = true; return input.kind; } });
    assert.throws(() => parseMediaLineageFact(discriminator)); assert.equal(called, false);
    assert.deepEqual(parseMediaLineageFact(Object.assign(Object.create(null), input)), input);
  }
  assert.throws(() => parseMediaSequenceStart({ ...begun, source: { ...begun.source, filename: 'private.mp4' } }));
  assert.throws(() => createMediaDecodedFrame(begun, 1, 0, { trackId: 1, duration: 0, pixels: [] } as never));
});

test('input links preserve independent processing/acquisition ordinals without PTS or clock joins', () => {
  const input = { ...link() }, parsed = parseMediaInputLink(input);
  assert.deepEqual(parsed, input); assert.notEqual(parsed, input); frozen(parsed);
  input.captureTime = 3; assert.equal(parsed.captureTime, 0.25);
  const reversed = parseMediaInputLink({ ...link(), ordinal: 100, processingFrame: 1, acquisitionFrameId: 2, captureTime: 0, phase: 'recovery' });
  assert.equal(reversed.ordinal, 100); assert.equal(reversed.processingFrame, 1);
  for (const patch of [ { version: 2 }, { sourceId: '' }, { sequenceId: 'x'.repeat(161) }, { role: 'other' },
    { ordinal: 0 }, { processingFrame: 0 }, { acquisitionFrameId: 1.5 }, { captureTime: -1 }, { captureTime: NaN },
    { captureTime: Infinity }, { phase: 'later' }, { pts: 0 }, { pixels: [] }, { command: 'stop' }, { expected: true } ])
    assert.throws(() => parseMediaInputLink({ ...link(), ...patch }));
  for (const key of Object.keys(link())) { const omitted = { ...link() } as Record<string, unknown>; delete omitted[key]; assert.throws(() => parseMediaInputLink(omitted)); }
  let called = false;
  const getter = { ...link() }; Object.defineProperty(getter, 'captureTime', { enumerable: true, get() { called = true; return 0; } });
  assert.throws(() => parseMediaInputLink(getter)); assert.equal(called, false);
  const hidden = { ...link() }; Object.defineProperty(hidden, 'pixels', { value: [] });
  assert.throws(() => parseMediaInputLink(hidden));
  assert.throws(() => parseMediaInputLink({ ...link(), [Symbol('pixels')]: [] }));
});

test('media facts and actual input-use links survive compressed trace roundtrip without changing reducer state', async () => {
  const plain = new RunStateTrace(), augmented = new RunStateTrace();
  const arrival = { version: 1, inputId: 1, captureTime: 0, observedAtMs: 0, delivery: 'video-poll' };
  assert.equal(plain.record('input-arrival', arrival, 0), true);
  assert.equal(augmented.record('input-arrival', arrival, 0), true);
  const begun = createMediaSequenceStart(blob(), { role: 're-recorded-video', parentCaptureSessionId: 'label-only' });
  const first = createMediaDecodedFrame(begun, 1, 1.25, { trackId: 0, duration: 0.04 });
  const second = createMediaDecodedFrame(begun, 2, -0.5);
  const inputLink = parseMediaInputLink({ ...link(), sequenceId: first.sequenceId, sourceId: first.sourceId,
    role: first.role, ordinal: first.ordinal });
  for (const fact of [begun, first, second, createMediaSequenceEnd(begun, 2, 'eof')])
    assert.equal(augmented.record('media-lineage', fact, 1), true);
  assert.equal(augmented.record('media-input-link', inputLink, 2), true);
  const plainBlob = await plain.snapshotBlob(), augmentedBlob = await augmented.snapshotBlob();
  const parsed = await parseRunStateTrace(augmentedBlob, signal());
  assert.equal(parsed.complete, true); assert.equal(parsed.dropped, 0);
  assert.deepEqual(parsed.events.map(event => event.type), ['input-arrival', 'media-lineage',
    'media-lineage', 'media-lineage', 'media-lineage', 'media-input-link']);
  const parsedFacts = parsed.events.filter(event => event.type === 'media-lineage');
  assert.deepEqual(parsedFacts.map(event => event.value.kind), ['start', 'frame', 'frame', 'end']);
  for (const event of parsed.events) frozen(event.value);
  const before = await replayRunStateTrace(plainBlob, signal()), after = await replayRunStateTrace(augmentedBlob, signal());
  assert.equal(after.events, before.events + 5);
  for (const key of ['grid', 'inventory', 'input', 'observations', 'unknownLifecycle'] as const)
    assert.deepEqual(after[key], before[key]);
});

test('invalid media metadata and explicit diagnostic error marker make traces incomplete', async () => {
  const begun = start();
  for (const [type, value] of [
    ['media-lineage', { ...createMediaDecodedFrame(begun, 1, 0), expected: true }],
    ['media-lineage', { ...createMediaSequenceEnd(begun, 1, 'returned'), complete: true }],
    ['media-input-link', { ...link(), pixels: new Uint8Array(1) }],
    ['media-recording-error', { reason: 'diagnostic callback failed' }],
  ] as const) {
    const trace = new RunStateTrace();
    assert.equal(trace.record(type, value, 0), false);
    assert.equal(trace.stats.complete, false); assert.equal(trace.stats.dropped, 1);
    const snapshot = await trace.snapshotBlob(), parsed = await parseRunStateTrace(snapshot, signal());
    assert.equal(parsed.complete, false); assert.equal(parsed.dropped, 1); assert.equal(parsed.events.length, 0);
    await assert.rejects(replayRunStateTrace(snapshot, signal()), /불완전/);
  }
});
