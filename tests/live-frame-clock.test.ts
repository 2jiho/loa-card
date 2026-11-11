import { test } from "node:test";
import assert from "node:assert/strict";
import { startVideoFrames, type LiveFrameObservation } from "../src/features/card-scanner/capture/live-frame-clock";

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
  assert.equal(Object.isFrozen(frames.at(-1)),true,'delivered source coordinates cannot be changed after callback return');
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

test('display preview continues without compositor callbacks and never manufactures capture frames',t=>{
 t.mock.timers.enable({apis:['setInterval']});
 const mock=input(),abort=new AbortController();let previews=0,captures=0;
 startVideoFrames(mock.video,abort.signal,()=>captures++,()=>{},error=>{throw error;},33,()=>previews++);
 t.mock.timers.tick(330);assert.equal(previews,10);assert.equal(captures,0);
 mock.deliver(.33,1);assert.equal(captures,1);assert.equal(previews,11);
 t.mock.timers.tick(33);assert.equal(previews,12);assert.equal(captures,1);
 abort.abort();t.mock.timers.tick(1000);assert.equal(previews,12);
});

test('fast frame arrivals update the viewport before expensive capture and skip repeated frames',()=>{
 const mock=input(),abort=new AbortController(),calls:string[]=[];
 startVideoFrames(mock.video,abort.signal,()=>calls.push('capture'),()=>{},error=>{throw error;},33,()=>calls.push('preview'));
 for(let i=1;i<=120;i++)mock.deliver(i/60,i);
 mock.deliver(2,120);
 assert.deepEqual(calls,Array.from({length:120},()=>['preview','capture']).flat());
 abort.abort();
});

test('optional observer sees every callback including skipped timestamps and counter discontinuities',()=>{
 const mock=input(),abort=new AbortController(),events:LiveFrameObservation[]=[],frames:unknown[]=[];
 startVideoFrames(mock.video,abort.signal,stamp=>frames.push(stamp),()=>assert.fail(),error=>{throw error;},33,undefined,
  {onObservation:event=>events.push(event)});
 mock.deliver(1,10);mock.deliver(1,11);mock.deliver(1.1,14);mock.deliver(1.05,13);
 mock.deliver(Number.NaN,Number.NaN);mock.deliver(1.2,15);abort.abort();
 assert.deepEqual(events[0],{kind:'mode',mode:'callback'});
 const callbacks=events.slice(1).filter(event=>event.kind==='callback');
 assert.equal(callbacks.length,6);assert.equal(frames.length,5,'capture compatibility preserves duplicate-time suppression');
 assert.deepEqual(callbacks.map(event=>[event.sequence,event.mediaRelation,event.presentedRelation,event.missedFrames,event.captureEligible]),[
  [1,'first','first',null,true], [2,'duplicate','advance',0,false], [3,'advance','advance',2,true],
  [4,'regression','regression',null,true], [5,'invalid','invalid',null,true], [6,'unknown','unknown',null,true],
 ]);
 assert.equal(callbacks[4].mediaTime,null);assert.equal(callbacks[4].presentedFrames,null);
 assert.ok(events.every(Object.isFrozen));
});

test('timer fallback explicitly exposes repeated polls and cannot claim compositor continuity',t=>{
 t.mock.timers.enable({apis:['setInterval']});
 const mock=input(),abort=new AbortController(),events:LiveFrameObservation[]=[];let captures=0;
 Object.assign(mock.video,{requestVideoFrameCallback:undefined,cancelVideoFrameCallback:undefined});
 startVideoFrames(mock.video,abort.signal,()=>captures++,()=>assert.fail(),error=>{throw error;},33,undefined,
  {onObservation:event=>events.push(event)});
 t.mock.timers.tick(66);mock.video.currentTime=1;t.mock.timers.tick(33);abort.abort();
 assert.deepEqual(events[0],{kind:'mode',mode:'timer'});
 const polls=events.slice(1).filter(event=>event.kind==='timer');
 assert.deepEqual(polls.map(event=>[event.sequence,event.mediaRelation,event.captureEligible]),[
  [1,'first',true],[2,'duplicate',false],[3,'advance',true],
 ]);
 assert.equal(captures,2);
});

test('observer failures are reported independently and cannot stop capture',()=>{
 const mock=input(),abort=new AbortController(),failures:unknown[]=[],frames:unknown[]=[];
 startVideoFrames(mock.video,abort.signal,stamp=>frames.push(stamp),()=>assert.fail(),()=>assert.fail('capture failed'),33,undefined,
  {onObservation:()=>{throw new Error('observer');},onError:error=>failures.push(error)});
 mock.deliver(1,1);mock.deliver(1,2);mock.deliver(2,3);abort.abort();
 assert.equal(frames.length,2);assert.equal(failures.length,4,'mode and all callbacks report their independent failure');
});
