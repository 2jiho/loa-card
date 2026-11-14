import {test} from 'node:test';
import assert from 'node:assert/strict';
import {closeWindowShare, openWindowShare, requestWindowShare, stopShareStream} from '../src/app/share-commands';
import {createShareAttemptGuard} from '../src/features/card-scanner/capture/share-stream-owner';

function restoreNavigator(hadOwn: boolean, previous: Navigator | undefined) {
  if (hadOwn) Object.defineProperty(globalThis, 'navigator', {configurable: true, value: previous});
  else delete (globalThis as {navigator?: Navigator}).navigator;
}

async function withNavigator<T>(mediaDevices: Record<string, unknown>, run: () => Promise<T>): Promise<T> {
  const hadOwn = Object.hasOwn(globalThis, 'navigator');
  const previous = globalThis.navigator;
  Object.defineProperty(globalThis, 'navigator', {configurable: true, value: {mediaDevices}});
  try { return await run(); }
  finally { restoreNavigator(hadOwn, previous); }
}

function fakeStream(settings: Record<string, unknown>) {
  const videoTrack = {
    getSettings: () => settings,
    readyState: 'live',
    addEventListener: () => {},
    stop: () => {},
  };
  return {
    stream: {
      getVideoTracks: () => [videoTrack],
      getTracks: () => [videoTrack],
    } as unknown as MediaStream,
    videoTrack,
  };
}

function shareFixture(options: {settings?: Record<string, unknown>; play?: () => Promise<void>; engineReady?: boolean} = {}) {
  let stopped = 0;
  const videoTrack = {
    getSettings: () => options.settings ?? {cursor: 'never'},
    readyState: 'live',
    addEventListener: () => {},
    stop: () => { stopped++; },
  };
  const stream = {
    getVideoTracks: () => [videoTrack],
    getTracks: () => [videoTrack],
  } as unknown as MediaStream;
  const video = {current: {srcObject: null, play: options.play ?? (async () => {})} as unknown as HTMLVideoElement};
  return {
    stream,
    video,
    refs: {
      stream: {current: null as MediaStream | null},
      controller: {current: null as AbortController | null},
      engineReady: {current: options.engineReady ?? false},
      video,
    },
    stopped: () => stopped,
  };
}

test('requestWindowShare asks for a window cursor-free share and reports exclusion', async () => {
  let requested: unknown;
  const {stream} = fakeStream({cursor: 'never'});
  await withNavigator({
    getSupportedConstraints: () => ({cursor: true}),
    getDisplayMedia: async (constraints: unknown) => { requested = constraints; return stream; },
  }, async () => {
    const result = await requestWindowShare();
    assert.equal(result.stream, stream);
    assert.equal(result.cursorMode, 'excluded');
    assert.equal(result.supportsCursor, true);
    assert.deepEqual(requested, {video: {displaySurface: 'window', frameRate: {ideal: 60, max: 60}, cursor: 'never'}, audio: false});
  });
});

test('requestWindowShare reports included and unsupported cursor modes', async () => {
  await withNavigator({
    getSupportedConstraints: () => ({cursor: true}),
    getDisplayMedia: async () => fakeStream({cursor: 'always'}).stream,
  }, async () => {
    assert.equal((await requestWindowShare()).cursorMode, 'included');
  });
  await withNavigator({
    getSupportedConstraints: () => ({}),
    getDisplayMedia: async () => fakeStream({}).stream,
  }, async () => {
    assert.equal((await requestWindowShare()).cursorMode, 'unsupported');
  });
});

test('requestWindowShare rejects a stream without a video track and stops the rest', async () => {
  let stopped = 0;
  const audio = {stop: () => { stopped++; }};
  const stream = {getVideoTracks: () => [], getTracks: () => [audio]} as unknown as MediaStream;
  await withNavigator({
    getSupportedConstraints: () => ({cursor: true}),
    getDisplayMedia: async () => stream,
  }, async () => {
    await assert.rejects(requestWindowShare(), /비디오 트랙/u);
    assert.equal(stopped, 1);
  });
});

test('openWindowShare hands a live played stream to the scanner and clears picking', async () => {
  const fixture = shareFixture();
  const calls = {picking: [] as boolean[], sharing: [] as boolean[], cursor: [] as string[], ready: [] as boolean[], errors: [] as string[], started: 0};
  await withNavigator({
    getSupportedConstraints: () => ({cursor: true}),
    getDisplayMedia: async () => fixture.stream,
  }, async () => {
    await openWindowShare({
      guard: createShareAttemptGuard(), ...fixture.refs, preparationUncertain: () => false,
      setSharePicking: value => { calls.picking.push(value); },
      setSharing: value => { calls.sharing.push(value); },
      setCursorMode: value => { calls.cursor.push(value); },
      setReady: value => { calls.ready.push(value); },
      setActionError: value => { calls.errors.push(value); },
      onStart: () => { calls.started++; },
    });
  });
  assert.equal(fixture.refs.stream.current, fixture.stream);
  assert.equal(fixture.video.current?.srcObject, fixture.stream);
  assert.deepEqual(calls.cursor, ['excluded']);
  assert.deepEqual(calls.sharing, [true]);
  assert.deepEqual(calls.ready, [true]);
  assert.equal(calls.started, 1);
  assert.deepEqual(calls.picking, [true, false, false]);
  assert.deepEqual(calls.errors, []);
});

test('openWindowShare stops the stream and reports a play failure without starting', async () => {
  const fixture = shareFixture({play: async () => { throw Error('play blocked'); }});
  const calls = {sharing: [] as boolean[], errors: [] as string[], started: 0};
  await withNavigator({
    getSupportedConstraints: () => ({cursor: true}),
    getDisplayMedia: async () => fixture.stream,
  }, async () => {
    await openWindowShare({
      guard: createShareAttemptGuard(), ...fixture.refs, preparationUncertain: () => false,
      setSharePicking: () => {}, setSharing: value => { calls.sharing.push(value); },
      setCursorMode: () => {}, setReady: () => {}, setActionError: value => { calls.errors.push(value); },
      onStart: () => { calls.started++; },
    });
  });
  assert.equal(fixture.refs.stream.current, null);
  assert.equal(fixture.stopped(), 1);
  // A browser's own (English) message is not shown as is: the person gets what to do.
  assert.deepEqual(calls.errors, ['화면 공유를 시작하지 못했어요. 다른 창이나 화면을 골라 다시 시도해 주세요.']);
  assert.deepEqual(calls.sharing, [true, false]);
  assert.equal(calls.started, 0);
});

test('closeWindowShare aborts an unprepared scan and stops the stream', () => {
  const fixture = shareFixture();
  const controller = new AbortController();
  fixture.refs.controller.current = controller;
  fixture.refs.stream.current = fixture.stream;
  let sharing = true;
  closeWindowShare({
    guard: createShareAttemptGuard(), controller: fixture.refs.controller,
    engineReady: fixture.refs.engineReady, stream: fixture.refs.stream,
    setSharing: value => { sharing = value; },
  });
  assert.equal(controller.signal.aborted, true);
  assert.equal(fixture.stopped(), 1);
  assert.equal(sharing, false);
});

test('stopShareStream stops every track even when one stop throws', () => {
  let stopped = 0;
  const tracks = [
    {stop: () => { stopped++; throw Error('already ended'); }},
    {stop: () => { stopped++; }},
  ];
  stopShareStream({getTracks: () => tracks} as unknown as MediaStream);
  assert.equal(stopped, 2);
  assert.doesNotThrow(() => stopShareStream(null));
});
