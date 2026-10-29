import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAcquisitionCapture, parseRecognitionCapture } from '../src/features/card-scanner/capture-provenance';
import type { AcquisitionCapture, RecognitionCapture } from '../src/features/card-scanner/capture-provenance';
import { RunStateTrace, parseRunStateTrace, replayRunStateTrace } from '../dev/run-state-trace';

function acquisition() {
  return { version: 1 as const, sessionId: 'session', observationId: 'observation', processingFrame: 9,
    acquisitionFrameId: 7, canonicalSourceFrameId: 3 as number | null, captureTime: 1.25,
    phase: 'input' as AcquisitionCapture['phase'], slot: 39, pixelKey: 'rgba:abc',
    sourceWidth: 1920, sourceHeight: 1080, cropState: 'materialized' as AcquisitionCapture['cropState'],
    cropWidth: 120, cropHeight: 180,
    nominalBox: { x: 10, y: 20, width: 120, height: 180 },
    contentBox: { x: 12, y: 22, width: 116, height: 176 },
    previewBox: { x: 8, y: 18, width: 124, height: 184 },
    capture: { stable: true, stabilitySource: 'settled-fields' as AcquisitionCapture['capture']['stabilitySource'],
      complete: true as boolean | null, intact: true as boolean | null, labelVisible: false as boolean | null,
      borderAlignment: 0.9 as number | null, borderSides: [1, 0.8, 1, 0.8] as number[] | null },
    quality: { usable: true, reason: '', sharpness: 12.5 } };
}

function recognition() {
  return { version: 1 as const, invocationId: 1,
    source: { sessionId: 'session', observationId: 'observation', frameId: 7, captureOrder: 8,
      captureTime: 1.25, phase: 'input' as const, slot: 39 },
    acquisition: { sessionId: 'session', observationId: 'observation' } as RecognitionCapture['acquisition'],
    processingFrame: 9, stage: 'full' as RecognitionCapture['stage'], stable: true,
    borderAlignment: 0.8, structural: true, fullRead: true, portraitRefinement: false, grayNameFallback: false,
    cropWidth: 120, cropHeight: 180, identityPath: 'ocr-reader' as RecognitionCapture['identityPath'] };
}

function deeplyFrozen(value: unknown): void {
  if (!value || typeof value !== 'object') return;
  assert.equal(Object.isFrozen(value), true);
  for (const child of Object.values(value)) deeplyFrozen(child);
}

test('field revision survives recording as selection metadata without changing exact pixel identity',()=>{
  const input={...acquisition(),fieldRevision:'worker/fields/2'};
  const parsed=parseAcquisitionCapture(input);
  assert.equal(parsed.fieldRevision,input.fieldRevision);
  assert.equal(parsed.pixelKey,input.pixelKey);
  assert.equal(Object.hasOwn(parseAcquisitionCapture(acquisition()),'fieldRevision'),false);
  for(const value of ['',null,0,'x'.repeat(161),'worker\nfields'])
    assert.throws(()=>parseAcquisitionCapture({...input,fieldRevision:value}));
});

test('capture receipts detach and deeply freeze every nested diagnostic object', () => {
  const input = acquisition(), parsed = parseAcquisitionCapture(input);
  assert.deepEqual(parsed, input); assert.notEqual(parsed, input);
  input.nominalBox.x = 999; input.contentBox.width = 1; input.previewBox.y = 999;
  input.capture.borderSides![0] = 0; input.capture.stable = false; input.quality.reason = 'changed';
  assert.equal(parsed.nominalBox.x, 10); assert.equal(parsed.contentBox.width, 116);
  assert.equal(parsed.previewBox.y, 18); assert.equal(parsed.capture.borderSides![0], 1);
  assert.equal(parsed.capture.stable, true); assert.equal(parsed.quality.reason, ''); deeplyFrozen(parsed);
  assert.throws(() => Object.assign(parsed.capture, { complete: false }), TypeError);

  const readerInput = recognition(), receipt = parseRecognitionCapture(readerInput);
  readerInput.source.captureTime = 100; readerInput.source.observationId = 'mutated';
  assert.equal(receipt.source.captureTime, 1.25); assert.equal(receipt.source.observationId, 'observation');
  assert.notEqual(receipt.acquisition, readerInput.acquisition); deeplyFrozen(receipt);
});

test('saved-cell nulls remain unknown independently of usable and stable flags', () => {
  const input = acquisition(); input.canonicalSourceFrameId = null;
  input.capture = { stable: false, stabilitySource: 'saved-observation', complete: null,
    intact: null, labelVisible: null, borderAlignment: null, borderSides: null };
  const parsed = parseAcquisitionCapture(input);
  assert.equal(parsed.quality.usable, true); assert.equal(parsed.capture.stable, false);
  assert.equal(parsed.canonicalSourceFrameId, null);
  assert.deepEqual(parsed.capture, input.capture);
  const reader = parseRecognitionCapture({ ...recognition(), acquisition: null });
  assert.equal(reader.acquisition, null);
});

test('resolved omitted crops preserve cached analysis without claiming materialized dimensions', () => {
  const input = { ...acquisition(), cropState: 'omitted-resolved', cropWidth: null, cropHeight: null };
  const parsed = parseAcquisitionCapture(input);
  assert.equal(parsed.cropState, 'omitted-resolved');
  assert.equal(parsed.cropWidth, null); assert.equal(parsed.cropHeight, null);
  assert.deepEqual(parsed.nominalBox, input.nominalBox);
  assert.deepEqual(parsed.contentBox, input.contentBox);
  assert.deepEqual(parsed.previewBox, input.previewBox);
  assert.deepEqual(parsed.capture, input.capture); assert.deepEqual(parsed.quality, input.quality);
  deeplyFrozen(parsed);
  for (const patch of [ { cropWidth: 300, cropHeight: 150 }, { cropWidth: 120 }, { cropHeight: 180 },
    { cropWidth: 0, cropHeight: 0 }, { cropWidth: undefined }, { cropHeight: undefined } ])
    assert.throws(() => parseAcquisitionCapture({ ...input, ...patch }));
  for (const patch of [ { cropWidth: null }, { cropHeight: null }, { cropWidth: null, cropHeight: null },
    { cropState: 'omitted' }, { cropState: undefined } ])
    assert.throws(() => parseAcquisitionCapture({ ...acquisition(), ...patch }));
});

test('legacy acquisition receipts round trip without inferring crop materialization', () => {
  const { cropState, ...legacy } = acquisition();
  assert.equal(cropState, 'materialized');
  const parsed = parseAcquisitionCapture(legacy);
  assert.equal(Object.hasOwn(parsed, 'cropState'), false);
  assert.equal(parsed.cropWidth, 120); assert.equal(parsed.cropHeight, 180);
  assert.deepEqual(parsed, legacy);
  assert.equal(Object.hasOwn(parseAcquisitionCapture(JSON.parse(JSON.stringify(parsed))), 'cropState'), false);
  assert.throws(() => parseAcquisitionCapture({ ...legacy, cropWidth: null, cropHeight: null }));
  assert.throws(() => parseAcquisitionCapture({ ...legacy, cropWidth: 0 }));
});

test('cut and clipped fractional boxes remain diagnostic geometry within magnitude bounds', () => {
  const parsed = parseAcquisitionCapture({ ...acquisition(),
    nominalBox: { x: -65_536, y: -20.5, width: 0.5, height: 65_536 },
    contentBox: { x: 60_000, y: 65_536, width: 2_000, height: 0.25 },
    previewBox: { x: -200, y: -300, width: 240, height: 360 } });
  assert.equal(parsed.nominalBox.x, -65_536); assert.equal(parsed.contentBox.x, 60_000);
  assert.equal(parsed.contentBox.height, 0.25);
});

test('raster and metadata limits are inclusive and reject overflow rather than truncating', () => {
  assert.equal(parseAcquisitionCapture({ ...acquisition(), sourceWidth: 65_536, sourceHeight: 512,
    cropWidth: 8_192, cropHeight: 4_096 }).sourceWidth, 65_536);
  assert.equal(parseRecognitionCapture({ ...recognition(), cropWidth: 65_536, cropHeight: 512 }).cropHeight, 512);
  for (const patch of [ { sourceWidth: 65_537, sourceHeight: 1 }, { sourceWidth: 8_192, sourceHeight: 4_097 },
    { cropWidth: 8_192, cropHeight: 4_097 }, { sourceHeight: 0 }, { cropWidth: 1.5 },
    { nominalBox: { x: -65_537, y: 0, width: 1, height: 1 } },
    { nominalBox: { x: 0, y: 0, width: 0, height: 1 } },
    { nominalBox: { x: 0, y: 0, width: 1, height: Infinity } },
    { quality: { usable: false, reason: 'x'.repeat(257), sharpness: 1 } } ])
    assert.throws(() => parseAcquisitionCapture({ ...acquisition(), ...patch }));
  assert.throws(() => parseRecognitionCapture({ ...recognition(), cropWidth: 8_192, cropHeight: 4_097 }));
  const maximalText = parseAcquisitionCapture({ ...acquisition(), sessionId: '\ud800'.repeat(160),
    observationId: '\ud800'.repeat(160), pixelKey: '\ud800'.repeat(160),
    quality: { usable: true, reason: '\u0000'.repeat(256), sharpness: 0 } });
  assert.ok(new TextEncoder().encode(JSON.stringify(maximalText)).byteLength <= 8_192);
});

test('identifiers, finite numeric coordinates, booleans, enums, and required nulls are strict', () => {
  for (const patch of [ { version: '1' }, { processingFrame: 0 }, { acquisitionFrameId: -1 },
    { canonicalSourceFrameId: undefined }, { canonicalSourceFrameId: 0 }, { captureTime: NaN },
    { captureTime: -1 }, { phase: 'later' }, { slot: 40 }, { slot: 1.5 }, { pixelKey: '' },
    { sessionId: 'x'.repeat(161) }, { observationId: 'bad\nidentifier' }, { sessionId: 'bad\u0085id' },
    { cropHeight: '180' }, { capture: { ...acquisition().capture, complete: undefined } },
    { capture: { ...acquisition().capture, stable: 1 } },
    { capture: { ...acquisition().capture, borderAlignment: 1.01 } },
    { capture: { ...acquisition().capture, borderSides: [1, 1, 1] } },
    { capture: { ...acquisition().capture, borderSides: [1, 1, 1, -0.1] } },
    { quality: { usable: 'yes', reason: '', sharpness: 0 } },
    { quality: { usable: false, reason: '', sharpness: -1 } } ])
    assert.throws(() => parseAcquisitionCapture({ ...acquisition(), ...patch }));
  for (const patch of [ { invocationId: 0 }, { invocationId: 1.5 }, { processingFrame: 0 },
    { acquisition: undefined }, { stage: 'retry' }, { stable: 'true' }, { borderAlignment: NaN },
    { structural: false }, { fullRead: 1 }, { portraitRefinement: null }, { grayNameFallback: undefined },
    { identityPath: 'candidate' }, { source: { ...recognition().source, sessionId: 'bad\u0000id' } } ])
    assert.throws(() => parseRecognitionCapture({ ...recognition(), ...patch }));
});

test('metadata parsers reject injected authority, pixels, nonplain objects, and hidden executable properties', () => {
  for (const extra of ['expected', 'cardId', 'candidate', 'image', 'pixels', 'attemptId', 'result']) {
    assert.throws(() => parseAcquisitionCapture({ ...acquisition(), [extra]: 'injected' }));
    assert.throws(() => parseRecognitionCapture({ ...recognition(), [extra]: 'injected' }));
  }
  assert.throws(() => parseAcquisitionCapture({ ...acquisition(), quality: { ...acquisition().quality, expected: true } }));
  assert.throws(() => parseRecognitionCapture({ ...recognition(), source: { ...recognition().source, image: 'data:image/png' } }));
  assert.throws(() => parseAcquisitionCapture(Object.assign(new Date(), acquisition())));
  assert.throws(() => parseAcquisitionCapture({ ...acquisition(), [Symbol('pixels')]: new Uint8Array(1) }));
  const hidden = acquisition(); Object.defineProperty(hidden, 'expected', { value: true });
  assert.throws(() => parseAcquisitionCapture(hidden));
  let called = false;
  const accessor = acquisition(); Object.defineProperty(accessor, 'sessionId', { enumerable: true,
    get() { called = true; return 'session'; } });
  assert.throws(() => parseAcquisitionCapture(accessor)); assert.equal(called, false);
  const sides = acquisition().capture.borderSides!;
  Object.defineProperty(sides, '0', { enumerable: true, get() { called = true; return 1; } });
  assert.throws(() => parseAcquisitionCapture({ ...acquisition(), capture: { ...acquisition().capture, borderSides: sides } }));
  assert.equal(called, false);
  assert.deepEqual(parseAcquisitionCapture(Object.assign(Object.create(null), acquisition())), parseAcquisitionCapture(acquisition()));
});

test('invocation ordinals preserve their own order without constraining source chronology or identity path', () => {
  const late = parseRecognitionCapture({ ...recognition(), invocationId: 1,
    source: { ...recognition().source, captureOrder: 1_000, captureTime: 100 } });
  const earlier = parseRecognitionCapture({ ...recognition(), invocationId: 2,
    source: { ...recognition().source, frameId: 0, captureOrder: 0, captureTime: 0 },
    processingFrame: 1, identityPath: 'retained', stage: 'visual', fullRead: false });
  assert.ok(late.invocationId < earlier.invocationId); assert.ok(late.source.captureOrder > earlier.source.captureOrder);
  assert.equal(earlier.source.frameId, 0); assert.equal(earlier.identityPath, 'retained');
  for (const borderAlignment of [0, 0.799999, 0.8, 1]) {
    const receipt = parseRecognitionCapture({ ...recognition(), borderAlignment, structural: borderAlignment >= 0.8 });
    assert.equal(receipt.structural, borderAlignment >= 0.8);
  }
});

test('recognition acquisition aliases must exactly match the immutable source tuple', () => {
  for (const acquisition of [ { sessionId: 'another-session', observationId: 'observation' },
    { sessionId: 'session', observationId: 'another-observation' },
    { sessionId: 'session', observationId: 'observation', frameId: 7 } ])
    assert.throws(() => parseRecognitionCapture({ ...recognition(), acquisition }));
});

test('both capture receipt events survive compressed trace roundtrip without creating reducer authority', async () => {
  const plain = new RunStateTrace(), augmented = new RunStateTrace();
  const arrival = { version: 1, inputId: 1, captureTime: 0, observedAtMs: 0, delivery: 'video-poll' };
  assert.equal(plain.record('input-arrival', arrival, 0), true);
  assert.equal(augmented.record('input-arrival', arrival, 0), true);
  const acquired = acquisition(), recognized = recognition();
  assert.equal(augmented.record('acquisition-capture', acquired, 1), true);
  assert.equal(augmented.record('recognition-capture', recognized, 2), true);
  acquired.quality.reason = 'mutated later'; recognized.source.captureTime = 100;
  const signal = new AbortController().signal, plainBlob = await plain.snapshotBlob(), blob = await augmented.snapshotBlob();
  const parsed = await parseRunStateTrace(blob, signal);
  assert.equal(parsed.complete, true); assert.equal(parsed.dropped, 0);
  assert.deepEqual(parsed.events.map(event => event.type), ['input-arrival', 'acquisition-capture', 'recognition-capture']);
  const acquisitionEvent = parsed.events[1], recognitionEvent = parsed.events[2];
  assert.equal(acquisitionEvent.type, 'acquisition-capture'); assert.equal(recognitionEvent.type, 'recognition-capture');
  if (acquisitionEvent.type !== 'acquisition-capture' || recognitionEvent.type !== 'recognition-capture')
    throw Error('Expected capture receipt events');
  assert.equal(acquisitionEvent.value.quality.reason, ''); assert.equal(recognitionEvent.value.source.captureTime, 1.25);
  deeplyFrozen(acquisitionEvent.value); deeplyFrozen(recognitionEvent.value);
  const before = await replayRunStateTrace(plainBlob, signal), after = await replayRunStateTrace(blob, signal);
  assert.equal(after.events, before.events + 2);
  for (const key of ['grid', 'inventory', 'input', 'observations', 'unknownLifecycle'] as const) {
    assert.deepEqual(after[key], before[key]); assert.equal(after[key].supported, false);
  }
});

test('legacy crop state absence survives compressed trace parsing without gaining authority', async () => {
  const { cropState, ...legacy } = acquisition(), trace = new RunStateTrace();
  assert.equal(cropState, 'materialized');
  assert.equal(trace.record('acquisition-capture', legacy, 0), true);
  const signal = new AbortController().signal, blob = await trace.snapshotBlob();
  const parsed = await parseRunStateTrace(blob, signal), event = parsed.events[0];
  assert.equal(event.type, 'acquisition-capture');
  if (event.type !== 'acquisition-capture') throw Error('Expected acquisition receipt');
  assert.equal(Object.hasOwn(event.value, 'cropState'), false);
  const replay = await replayRunStateTrace(blob, signal);
  for (const key of ['grid', 'inventory', 'input', 'observations', 'unknownLifecycle'] as const)
    assert.equal(replay[key].supported, false);
});

test('malformed capture receipts and explicit recording failure make traces incomplete', async () => {
  for (const [type, value] of [
    ['acquisition-capture', { ...acquisition(), image: 'data:image/png;base64,injected' }],
    ['recognition-capture', { ...recognition(), acquisition: { sessionId: 'other', observationId: 'observation' } }],
    ['capture-recording-error', { reason: 'diagnostic callback failed' }],
  ] as const) {
    const trace = new RunStateTrace(), signal = new AbortController().signal;
    assert.equal(trace.record(type, value, 0), false);
    assert.equal(trace.stats.dropped, 1); assert.equal(trace.stats.complete, false);
    const blob = await trace.snapshotBlob(), parsed = await parseRunStateTrace(blob, signal);
    assert.equal(parsed.complete, false); assert.equal(parsed.dropped, 1); assert.equal(parsed.events.length, 0);
    await assert.rejects(replayRunStateTrace(blob, signal), /불완전/);
  }
});
