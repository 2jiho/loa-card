import test from 'node:test';
import assert from 'node:assert/strict';
import { tryStartTrackFrames } from '../src/features/card-scanner/track-frame-source';

function fixture() {
  const track = Object.assign(new EventTarget(), { readyState: 'live' });
  const video = { srcObject: { getVideoTracks: () => [track] } } as unknown as HTMLVideoElement;
  let controller!: ReadableStreamDefaultController<VideoFrame>, canceled = 0, options: unknown;
  let readable!: ReadableStream<VideoFrame>;
  class Processor {
    constructor(value: unknown) { options = value; }
    readable = readable = new ReadableStream<VideoFrame>({ start(c) { controller = c; }, cancel() { canceled++; } });
  }
  let closed = 0;
  const frame = (timestamp: number) => ({ timestamp, close() { closed++; } }) as VideoFrame;
  return { track, video, Processor, frame, enqueue: (f: VideoFrame) => controller.enqueue(f), end: () => controller.close(),
    get closed() { return closed; }, get canceled() { return canceled; }, get options() { return options; },
    get locked() { return readable.locked; } };
}

test('track input owns frames through asynchronous consumption and preserves source intervals', async () => {
  const f = fixture(), stamps: number[] = [];
  let finish!: () => void;
  const done = new Promise<void>(resolve => { finish = resolve; });
  const dispose = tryStartTrackFrames(f.video, new AbortController().signal, async s => {
    assert.equal(s.missedFrames, undefined, 'an unavailable discard counter is not proof of zero drops');
    assert.equal(f.closed, stamps.length);
    await Promise.resolve(); stamps.push(s.capturedAt);
  }, finish, error => { throw error; }, f.Processor);
  f.enqueue(f.frame(10_000_000)); f.enqueue(f.frame(10_033_000)); f.end();
  await done;
  // Adding a performance.now() origin can leave sub-nanosecond roundoff.
  assert.ok(Math.abs(stamps[1] - stamps[0] - 33) < 1e-6);
  assert.equal(f.closed, 2);
  assert.deepEqual(f.options, { track: f.track, maxBufferSize: 4 });
  dispose!();
});

test('consumer failure closes the current frame and cancels further input', async () => {
  const f = fixture(); let report!: (error: unknown) => void;
  const error = new Error('failed'), reported = new Promise(resolve => { report = resolve; });
  tryStartTrackFrames(f.video, new AbortController().signal, () => { throw error; }, () => assert.fail('not an ordinary stop'), report, f.Processor);
  f.enqueue(f.frame(1));
  assert.equal(await reported, error); assert.equal(f.closed, 1); assert.equal(f.canceled, 1);
});

test('abort releases a pending read without stopping the shared recording track', async () => {
  const f = fixture(), control = new AbortController(); let stopped = 0;
  const dispose = tryStartTrackFrames(f.video, control.signal, () => assert.fail('no frame expected'), () => stopped++, error => { throw error; }, f.Processor);
  control.abort(); await Promise.resolve(); await Promise.resolve();
  assert.equal(f.canceled, 1); assert.equal(f.track.readyState, 'live'); assert.equal(stopped, 0); dispose!();
});

test('unsupported or rejected processors allow the existing input path', () => {
  const f = fixture();
  class Unsupported { constructor() { throw new Error('unsupported context'); } readable!: ReadableStream<VideoFrame>; }
  assert.equal(tryStartTrackFrames(f.video, new AbortController().signal, () => {}, () => {}, () => {}, Unsupported), undefined);
  const control = new AbortController(); control.abort();
  assert.equal(tryStartTrackFrames(f.video, control.signal, () => {}, () => {}, () => {}, f.Processor), undefined);
});

test('ending a share drains the last queued frame while acquisition is in flight', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const f=fixture(); let release!:()=>void, finish!:()=>void, stopped=0, seen=0;
  const hold=new Promise<void>(resolve=>{release=resolve;});
  const done=new Promise<void>(resolve=>{finish=resolve;});
  tryStartTrackFrames(f.video,new AbortController().signal,async()=>{if(++seen===1)await hold;},()=>{stopped++;finish();},error=>{throw error;},f.Processor);
  f.enqueue(f.frame(1));f.enqueue(f.frame(2));f.end();
  await Promise.resolve();await Promise.resolve();
  f.track.readyState='ended';t.mock.timers.tick(1000);
  assert.equal(stopped,0);assert.equal(seen,1);
  release();await done;assert.equal(seen,2);assert.equal(f.closed,2);assert.equal(stopped,1);
});

test('abort during acquisition keeps the borrowed frame alive until its consumer finishes', async () => {
  const f = fixture(), control = new AbortController();
  let release!: () => void, entered!: () => void;
  const hold = new Promise<void>(resolve => { release = resolve; });
  const consuming = new Promise<void>(resolve => { entered = resolve; });
  const dispose = tryStartTrackFrames(f.video, control.signal, async () => {
    entered(); await hold;
    assert.equal(f.closed, 0, 'an asynchronous crop must retain its input after cancellation');
  }, () => assert.fail('abort is not normal completion'), error => { throw error; }, f.Processor);
  f.enqueue(f.frame(1)); await consuming;
  control.abort(); dispose!();
  assert.equal(f.closed, 0);
  assert.equal(f.canceled, 1);
  assert.equal(f.track.readyState, 'live', 'the recording still owns the shared track');
  release();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.closed, 1, 'the acquired frame is closed exactly once after consumption');
  assert.equal(f.locked, false);
});

test('ended track with a stalled pending read stops once and releases the reader', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const f = fixture(); let stopped = 0;
  const dispose = tryStartTrackFrames(f.video, new AbortController().signal,
    () => assert.fail('there is no delivered frame'), () => stopped++, error => { throw error; }, f.Processor);
  f.track.readyState = 'ended';
  t.mock.timers.tick(100);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(stopped, 1);
  assert.equal(f.canceled, 1);
  assert.equal(f.locked, false);
  t.mock.timers.tick(1000); dispose!();
  assert.equal(stopped, 1);
  assert.equal(f.canceled, 1);
});
