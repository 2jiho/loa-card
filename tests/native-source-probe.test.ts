import test from 'node:test';
import assert from 'node:assert/strict';
import { assessNativeProfile, createNativeSourceProbe, FIRST_FRAME_DEADLINE_MS, formatProbeReport, MAX_PROBE_REPORT_BYTES, snapshotFrame } from '../dev/native-source-profile';
import type { ProbeFrame, ProbePlatform, ProbeReader, ProbeState, ProbeStream, ProbeTrack } from '../dev/native-source-profile';

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const settled = () => new Promise<void>(resolve => setImmediate(resolve));

function frameFixture(overrides: Partial<ProbeFrame> = {}) {
  let closed = 0, allocations = 0;
  const frame: ProbeFrame = {
    format: 'NV12', codedWidth: 2560, codedHeight: 1440, displayWidth: 2560, displayHeight: 1440,
    visibleRect: { x: 0, y: 0, width: 2560, height: 1440 }, timestamp: 123456, duration: 16667,
    colorSpace: { primaries: 'bt709', transfer: 'bt709', matrix: 'bt709', fullRange: false },
    allocationSize(options) { assert.deepEqual(options, {}); allocations++; return 5_529_600; },
    close() { closed++; }, ...overrides,
  };
  return { frame, get closed() { return closed; }, get allocations() { return allocations; } };
}

function fixture() {
  const capture = deferred<ProbeStream>(), read = deferred<ReadableStreamReadResult<ProbeFrame>>();
  const states: ProbeState[] = [];
  let stopped = 0, cancelled = 0, released = 0, requested = 0, readerCreated = 0, options: unknown;
  const track = Object.assign(new EventTarget(), {
    readyState: 'live',
    getSettings: () => ({ displaySurface: 'window', width: 2560, height: 1440, frameRate: 60, deviceId: 'private-device', label: 'private-title' }),
    stop() { stopped++; },
  }) as ProbeTrack;
  const stream: ProbeStream = { getTracks: () => [track], getVideoTracks: () => [track] };
  const reader: ProbeReader = { read: () => read.promise, cancel: async () => { cancelled++; }, releaseLock: () => { released++; } };
  const platform: ProbePlatform = {
    captureSupported: true, processorSupported: true,
    requestCapture(value) { requested++; options = value; return capture.promise; },
    createReader(value) { assert.equal(value, track); readerCreated++; return reader; },
  };
  const controller = createNativeSourceProbe(platform, state => states.push(state));
  return { capture, read, states, track, stream, reader, platform, controller,
    get stopped() { return stopped; }, get cancelled() { return cancelled; }, get released() { return released; },
    get requested() { return requested; }, get readerCreated() { return readerCreated; }, get options() { return options; } };
}

test('capture is requested only by start, synchronously with the existing window-priority settings', async () => {
  const f = fixture();
  assert.equal(f.requested, 0);
  const completed = f.controller.start();
  assert.equal(f.requested, 1, 'the picker call must remain inside the initiating user gesture');
  assert.deepEqual(f.options, { video: { displaySurface: 'window', frameRate: { ideal: 60, max: 60 } }, audio: false });
  assert.equal(f.states.at(-1)?.status, 'selecting');
  f.controller.stop();
  assert.equal((await completed).status, 'cancelled');
  f.capture.reject(new DOMException('a source title must not enter the report', 'NotAllowedError'));
  await settled();
  assert.equal(f.states.length, 2);
});

test('first frame snapshots only allowed metadata, then closes the frame and all tracks once', async () => {
  const f = fixture(), input = frameFixture();
  Object.assign(input.frame, { copyTo() { assert.fail('metadata probe must never copy pixels'); }, privateTitle: 'private-title' });
  const completed = f.controller.start();
  f.capture.resolve(f.stream); await settled();
  assert.equal(f.states.at(-1)?.status, 'waiting');
  f.read.resolve({ done: false, value: input.frame });
  const report = await completed; await settled();
  assert.equal(report.status, 'completed');
  assert.equal(report.scope, 'direct-track-only-not-scanner-video-wrapper');
  assert.deepEqual(report.track, { displaySurface: 'window', width: 2560, height: 1440, frameRate: 60 });
  assert.deepEqual(report.frame, {
    format: 'NV12', codedWidth: 2560, codedHeight: 1440, displayWidth: 2560, displayHeight: 1440,
    visibleRect: { x: 0, y: 0, width: 2560, height: 1440 }, timestamp: 123456, duration: 16667,
    colorSpace: { primaries: 'bt709', transfer: 'bt709', matrix: 'bt709', fullRange: false },
    allocationSize: 5_529_600, allocationSizeError: null,
  });
  assert.equal(report.profile?.candidate, true);
  assert.equal(report.profile?.notice, '메타데이터상 후보, 실제 복사/색변환 미검증');
  assert.equal(input.allocations, 1); assert.equal(input.closed, 1);
  assert.equal(f.stopped, 1); assert.equal(f.cancelled, 1); assert.equal(f.released, 1);
  f.controller.stop(); f.controller.dispose();
  f.track.dispatchEvent(new Event('ended'));
  assert.equal(input.closed, 1); assert.equal(f.stopped, 1); assert.equal(f.states.length, 3);
  assert.doesNotMatch(formatProbeReport(report), /private-|deviceId|label|copyTo/);
  assert.ok(new TextEncoder().encode(formatProbeReport(report)).byteLength <= MAX_PROBE_REPORT_BYTES);
});

test('snapshot is detached from mutable native metadata and preserves unknown fields as null', () => {
  const input = frameFixture({ format: null, duration: null, colorSpace: { primaries: null, transfer: null, matrix: null, fullRange: null } });
  const snap = snapshotFrame(input.frame);
  (input.frame.visibleRect as { width: number }).width = 10;
  (input.frame.colorSpace as { matrix: string }).matrix = 'bt2020-ncl';
  assert.equal(snap.visibleRect?.width, 2560);
  assert.deepEqual(snap.colorSpace, { primaries: null, transfer: null, matrix: null, fullRange: null });
  assert.equal(snap.format, null); assert.equal(snap.duration, null);
  assert.equal(assessNativeProfile(snap).candidate, false);
  assert.ok(assessNativeProfile(snap).reasons.includes('format-unknown'));
  assert.ok(assessNativeProfile(snap).reasons.includes('color-metadata-incomplete'));
});

test('other formats, HDR/range changes and unsupported geometry remain visible non-candidates', () => {
  for (const format of ['I420', 'NV12']) assert.equal(assessNativeProfile(snapshotFrame(frameFixture({ format }).frame)).candidate, true);
  for (const overrides of [
    { format: 'P010' }, { format: 'RGBA' },
    { colorSpace: { primaries: 'bt2020', transfer: 'pq', matrix: 'bt2020-ncl', fullRange: false } },
    { colorSpace: { primaries: 'bt709', transfer: 'bt709', matrix: 'bt709', fullRange: true } },
    { codedWidth: 2559 }, { visibleRect: null },
    { visibleRect: { x: 2, y: 0, width: 2558, height: 1440 } }, { displayHeight: 1280 },
  ]) {
    const snap = snapshotFrame(frameFixture(overrides).frame);
    assert.equal(assessNativeProfile(snap).candidate, false, JSON.stringify(overrides));
    if ('format' in overrides) assert.equal(snap.format, overrides.format);
  }
});

test('allocation query failure is reported without hiding the other native metadata', async () => {
  const f = fixture(), input = frameFixture({ allocationSize() { throw new DOMException('private-title', 'NotSupportedError'); } });
  const completed = f.controller.start(); f.capture.resolve(f.stream); await settled();
  f.read.resolve({ done: false, value: input.frame });
  const report = await completed;
  assert.equal(report.status, 'completed');
  assert.equal(report.frame?.format, 'NV12'); assert.equal(report.frame?.allocationSize, null);
  assert.equal(report.frame?.allocationSizeError, 'query-failed'); assert.equal(report.profile?.candidate, false);
  assert.doesNotMatch(formatProbeReport(report), /private-title/);
  assert.equal(input.closed, 1); assert.equal(f.stopped, 1);
});

test('stopping a pending picker resolves promptly and stops a late granted stream', async () => {
  const f = fixture(), completed = f.controller.start();
  f.controller.stop(); f.controller.stop();
  assert.equal((await completed).reason, 'stopped');
  f.capture.resolve(f.stream); await settled();
  assert.equal(f.stopped, 1); assert.equal(f.readerCreated, 0); assert.equal(f.states.length, 2);
});

test('abort while waiting closes a late frame once without allocating or republishing it', async () => {
  const f = fixture(), input = frameFixture(), completed = f.controller.start();
  f.capture.resolve(f.stream); await settled();
  f.controller.stop(); assert.equal((await completed).status, 'cancelled');
  f.read.resolve({ done: false, value: input.frame }); await settled();
  assert.equal(input.closed, 1); assert.equal(input.allocations, 0);
  assert.equal(f.cancelled, 1); assert.equal(f.released, 1); assert.equal(f.stopped, 1);
  assert.equal(f.states.at(-1)?.status, 'cancelled'); assert.equal(f.states.length, 3);
});

test('first-frame timeout starts after selection, and releases a later frame safely', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(), input = frameFixture(), completed = f.controller.start();
  t.mock.timers.tick(FIRST_FRAME_DEADLINE_MS * 2); await settled();
  assert.equal(f.states.at(-1)?.status, 'selecting', 'OS picker time is not the first-frame deadline');
  f.capture.resolve(f.stream); await settled();
  t.mock.timers.tick(FIRST_FRAME_DEADLINE_MS - 1); assert.equal(f.stopped, 0);
  t.mock.timers.tick(1);
  assert.equal((await completed).status, 'timeout'); assert.equal(f.stopped, 1); assert.equal(f.cancelled, 1);
  f.read.resolve({ done: false, value: input.frame }); await settled();
  assert.equal(input.closed, 1); assert.equal(input.allocations, 0); assert.equal(f.states.at(-1)?.status, 'timeout');
});

test('ending the track cleans up waiting resources and removes the ended listener', async () => {
  const f = fixture(), completed = f.controller.start();
  f.capture.resolve(f.stream); await settled();
  f.track.dispatchEvent(new Event('ended'));
  assert.equal((await completed).reason, 'track-ended');
  f.track.dispatchEvent(new Event('ended')); f.read.reject(new Error('late read error')); await settled();
  assert.equal(f.stopped, 1); assert.equal(f.cancelled, 1); assert.equal(f.released, 1); assert.equal(f.states.length, 3);
});

test('picker rejection and synchronous request failure retain a bounded nonsensitive failure reason', async () => {
  const f = fixture(), completed = f.controller.start();
  f.capture.reject(new DOMException('private window title', 'NotAllowedError'));
  const report = await completed;
  assert.equal(report.status, 'cancelled'); assert.equal(report.reason, 'capture-cancelled-or-denied');
  assert.doesNotMatch(formatProbeReport(report), /private window/);
  f.platform.requestCapture = () => { throw new Error('private title'); };
  assert.equal((await f.controller.start()).reason, 'capture-request-failed');
});

test('reader setup, read and native metadata failures all stop capture without retaining a frame', async () => {
  {
    const f = fixture(); f.platform.createReader = () => { throw new Error('setup'); };
    const completed = f.controller.start(); f.capture.resolve(f.stream);
    assert.equal((await completed).reason, 'frame-reader-setup-failed'); assert.equal(f.stopped, 1);
  }
  {
    const f = fixture(), completed = f.controller.start(); f.capture.resolve(f.stream); await settled();
    f.read.reject(new Error('read'));
    assert.equal((await completed).reason, 'frame-read-failed'); await settled();
    assert.equal(f.stopped, 1); assert.equal(f.cancelled, 1); assert.equal(f.released, 1);
  }
  {
    const f = fixture(), input = frameFixture();
    Object.defineProperty(input.frame, 'format', { get() { throw new Error('closed'); } });
    const completed = f.controller.start(); f.capture.resolve(f.stream); await settled();
    f.read.resolve({ done: false, value: input.frame });
    assert.equal((await completed).reason, 'frame-metadata-failed'); assert.equal(input.closed, 1); assert.equal(f.stopped, 1);
  }
});

test('cleanup tolerates cancellation/close failures and still stops every distinct captured track', async () => {
  const f = fixture(); let extraStops = 0, closeAttempts = 0;
  const extra = Object.assign(new EventTarget(), { readyState: 'live', getSettings: () => ({}), stop() { extraStops++; throw new Error('stop'); } });
  f.stream.getTracks = () => [extra, f.track, f.track];
  f.reader.cancel = () => Promise.reject(new Error('cancel'));
  const input = frameFixture({ close() { closeAttempts++; throw new Error('close'); } });
  const completed = f.controller.start(); f.capture.resolve(f.stream); await settled();
  f.read.resolve({ done: false, value: input.frame });
  assert.equal((await completed).reason, 'frame-metadata-failed'); await settled();
  assert.equal(closeAttempts, 1); assert.equal(extraStops, 1); assert.equal(f.stopped, 1); assert.equal(f.released, 1);
  f.controller.dispose(); assert.equal(closeAttempts, 1); assert.equal(f.stopped, 1);
});

test('missing or ended video tracks and a reader that ends without a frame fail explicitly', async () => {
  for (const kind of ['missing', 'ended', 'empty'] as const) {
    const f = fixture();
    if (kind === 'ended') Object.assign(f.track, { readyState: 'ended' });
    const completed = f.controller.start();
    f.capture.resolve(kind === 'missing' ? { ...f.stream, getVideoTracks: () => [] } : f.stream);
    if (kind === 'empty') { await settled(); f.read.resolve({ done: true, value: undefined }); }
    assert.equal((await completed).reason, { missing: 'no-video-track', ended: 'track-ended', empty: 'reader-ended-without-frame' }[kind]);
    assert.equal(f.stopped, 1);
  }
});

test('unsupported contexts and disposal never open a picker, and page cleanup releases late results', async () => {
  for (const feature of ['captureSupported', 'processorSupported'] as const) {
    const f = fixture(); f.platform[feature] = false;
    const report = await f.controller.start();
    assert.equal(report.status, 'unsupported'); assert.equal(f.requested, 0); assert.equal(report.frame, null);
  }
  const f = fixture(), completed = f.controller.start();
  f.controller.dispose(); f.capture.resolve(f.stream); await settled();
  assert.equal((await completed).reason, 'disposed'); assert.equal(f.stopped, 1);
  assert.equal((await f.controller.start()).reason, 'disposed'); assert.equal(f.requested, 1);
});

test('replacing a pending run cannot let the old stream overwrite the new result', async () => {
  const f = fixture(), next = deferred<ProbeStream>();
  const old = f.controller.start(); f.platform.requestCapture = () => next.promise;
  const current = f.controller.start();
  assert.equal((await old).reason, 'replaced');
  const oldTrack = Object.assign(new EventTarget(), { readyState: 'live', getSettings: () => ({}), stop() { oldStops++; } });
  let oldStops = 0;
  f.capture.resolve({ getVideoTracks: () => [oldTrack], getTracks: () => [oldTrack] }); await settled();
  assert.equal(oldStops, 1); assert.equal(f.states.at(-1)?.status, 'selecting');
  next.resolve(f.stream); await settled();
  f.read.resolve({ done: false, value: frameFixture().frame });
  assert.equal((await current).status, 'completed'); assert.equal(f.states.at(-1)?.status, 'completed');
});

test('unavailable track settings remain explicit, and even malformed long metadata fits the JSON bound', async () => {
  const f = fixture(); f.track.getSettings = () => { throw new Error('private-device'); };
  const long = '\u0000🙂'.repeat(300);
  const input = frameFixture({ format: long, codedWidth: NaN, colorSpace: { primaries: long, transfer: long, matrix: long, fullRange: null } });
  const completed = f.controller.start(); f.capture.resolve(f.stream); await settled(); f.read.resolve({ done: false, value: input.frame });
  const report = await completed;
  assert.equal(report.track, null); assert.equal(report.trackSettingsError, 'query-failed');
  assert.equal(report.frame?.codedWidth, null); assert.equal(report.profile?.candidate, false);
  const json = formatProbeReport(report);
  assert.ok(new TextEncoder().encode(json).byteLength <= MAX_PROBE_REPORT_BYTES);
  assert.doesNotMatch(json, /private-device|\\u0000/);
});

test('pagehide stops a pending picker, and BFCache restore keeps the page usable for another capture', async () => {
  const first = fixture(), second = fixture(), windowTarget = new EventTarget();
  const nodes = Object.fromEntries(['run', 'stop', 'save', 'status', 'result'].map(id => [id, Object.assign(new EventTarget(), { disabled: false, textContent: '' })]));
  let requests = 0, readers = 0;
  class Processor {
    constructor(options: { track: ProbeTrack; maxBufferSize: number }) {
      assert.equal(options.track, second.track); assert.equal(options.maxBufferSize, 1); readers++;
    }
    readable = { getReader: () => second.reader };
  }
  const replacements = {
    document: { querySelector: (selector: string) => nodes[selector.slice(1)] },
    window: windowTarget,
    navigator: { mediaDevices: { getDisplayMedia: () => (++requests === 1 ? first.capture.promise : second.capture.promise) } },
    MediaStreamTrackProcessor: Processor,
  };
  const originals = new Map(Object.keys(replacements).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  try {
    for (const [key, value] of Object.entries(replacements)) Object.defineProperty(globalThis, key, { configurable: true, value });
    await import('../dev/native-source-probe');
    assert.equal(requests, 0);
    nodes.run.dispatchEvent(new Event('click'));
    assert.equal(requests, 1); assert.equal(nodes.run.disabled, true);
    windowTarget.dispatchEvent(new Event('pagehide'));
    assert.equal(nodes.run.disabled, false); assert.equal(nodes.stop.disabled, true);
    first.capture.resolve(first.stream); await settled();
    assert.equal(first.stopped, 1); assert.equal(readers, 0, 'the late grant after leaving must be stopped without a read');
    windowTarget.dispatchEvent(Object.assign(new Event('pageshow'), { persisted: true }));
    nodes.run.dispatchEvent(new Event('click'));
    assert.equal(requests, 2, 'restored buttons must retain their listener and a reusable controller');
    second.capture.resolve(second.stream); await settled();
    assert.equal(readers, 1); assert.equal(nodes.stop.disabled, false);
    const input = frameFixture(); second.read.resolve({ done: false, value: input.frame }); await settled();
    assert.equal(input.closed, 1); assert.equal(second.stopped, 1);
    assert.equal(nodes.run.disabled, false); assert.equal(nodes.save.disabled, false);
    assert.equal(JSON.parse(nodes.result.textContent).status, 'completed');
    windowTarget.dispatchEvent(new Event('pagehide'));
    assert.equal(second.stopped, 1, 'repeated pagehide must not stop a finished track twice');
  } finally {
    windowTarget.dispatchEvent(new Event('pagehide'));
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
