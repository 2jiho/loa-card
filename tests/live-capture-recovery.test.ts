import test from 'node:test';
import assert from 'node:assert/strict';
import {createLiveCapturePipeline,type RecoveryCaptureDecision,type LiveCaptureDecision} from '../src/features/card-scanner/capture/live-capture-pipeline';
import {InputDecisionReplay} from '../src/features/card-scanner/reproduction/live-input-decision-replay';

function deferred(){let resolve!:()=>void;const promise=new Promise<void>(done=>{resolve=done;});return {promise,resolve};}
const turn=()=>new Promise<void>(resolve=>setImmediate(resolve));
const stamp=(inputId:number,captureTime:number)=>({inputId,captureTime,observedAtMs:captureTime*1000});
type Frame={id:number;bytes:number;closed:number};
const frame=(id:number,bytes=1):Frame=>({id,bytes,closed:0});

test('recovery batch runs FIFO on the common single consumer with original timestamps and separate events',async()=>{
 const seen:{id:number;time:number}[]=[],normal:LiveCaptureDecision[]=[],recovery:RecoveryCaptureDecision[]=[];
 const pipeline=createLiveCapturePipeline<Frame>({yieldTask:()=>Promise.resolve(),frameBytes:f=>f.bytes,
  consume:(f,time)=>{seen.push({id:f.id,time});},release:f=>{f.closed++;},onError:assert.fail,
  onDecision:e=>{normal.push(e);},onRecoveryDecision:e=>{recovery.push(e);}});
 const a=frame(1),b=frame(2);
 assert.equal(pipeline.offerRecovery([{frame:a,stamp:stamp(4,2.5)},{frame:b,stamp:stamp(5,2.7)}]),true);
 await pipeline.flush();assert.deepEqual(seen,[{id:1,time:2.5},{id:2,time:2.7}]);assert.deepEqual([a.closed,b.closed],[1,1]);
 assert.deepEqual(normal,[]);assert.deepEqual(recovery.map(e=>e.kind),['started','finished','released','started','finished','released']);
});

test('recovery transfer is atomic and rejects busy, out-of-order or over-budget batches without taking ownership',async()=>{
 const held=deferred(),a=frame(1,3),b=frame(2,3),released:number[]=[];
 const pipeline=createLiveCapturePipeline<Frame>({maxRetainedBytes:5,yieldTask:()=>Promise.resolve(),frameBytes:f=>f.bytes,
  consume:()=>held.promise,release:f=>{f.closed++;released.push(f.id);},onError:assert.fail});
 assert.equal(pipeline.offerRecovery([{frame:a,stamp:stamp(1,1)},{frame:b,stamp:stamp(2,2)}]),false);
 assert.equal(pipeline.offerRecovery([{frame:a,stamp:stamp(2,2)},{frame:b,stamp:stamp(1,1)}]),false);
 assert.equal(pipeline.offerRecovery([{frame:a,stamp:stamp(1,1)}]),true);
 await turn();assert.equal(pipeline.offerRecovery([{frame:b,stamp:stamp(2,2)}]),false);
 assert.equal(b.closed,0);held.resolve();await pipeline.flush();assert.deepEqual(released,[1]);
});

test('new live input cannot replace queued recovery and interrupted input is reported',async()=>{
 const held=deferred(),a=frame(1),b=frame(2),c=frame(3),seen:number[]=[],released:number[]=[];let interrupted=0;
 const pipeline=createLiveCapturePipeline<Frame>({yieldTask:()=>Promise.resolve(),consume:async f=>{seen.push(f.id);if(f===a)await held.promise;},
  release:f=>{f.closed++;released.push(f.id);},onError:assert.fail,onRecoveryInterruption:()=>{interrupted++;}});
 assert.equal(pipeline.offerRecovery([{frame:a,stamp:stamp(1,1)},{frame:b,stamp:stamp(2,2)}]),true);
 await turn();pipeline.offer(c,3,stamp(3,3));assert.equal(c.closed,0);
 const d=frame(4);pipeline.offer(d,4,stamp(4,4));assert.equal(d.closed,1);assert.equal(interrupted,1);
 held.resolve();await pipeline.flush();assert.deepEqual(seen,[1,2,3]);assert.deepEqual(released,[4,1,2,3]);
});

test('disposing releases pending recovery once with explicit loss and does not abort the active owner',async()=>{
 const held=deferred(),a=frame(1),b=frame(2),events:RecoveryCaptureDecision[]=[];
 const pipeline=createLiveCapturePipeline<Frame>({yieldTask:()=>Promise.resolve(),consume:()=>held.promise,
  release:f=>{f.closed++;},onError:assert.fail,onRecoveryDecision:e=>{events.push(e);}});
 assert.equal(pipeline.offerRecovery([{frame:a,stamp:stamp(1,1)},{frame:b,stamp:stamp(2,2)}]),true);
 await turn();pipeline.dispose();assert.equal(b.closed,1);assert.equal(a.closed,0);
 held.resolve();await pipeline.flush();assert.equal(a.closed,1);
 assert.deepEqual(events.map(e=>[e.kind,e.inputId]),[['started',1],['lost',2],['released',2],['finished',1],['released',1]]);
});

test('actual FIFO ownership events replay verification skips and links without ordinary offers',async()=>{
 const replay=new InputDecisionReplay(new AbortController().signal),frames=[frame(11),frame(12)];let seq=0;
 const retain=(id:number,time:number)=>{
  const input=stamp(id,time);
  replay.admission({kind:'consider',stamp:input,gates:{capturing:true,checkingCompletion:true},expected:'verification'});
  replay.recovery({version:1,seq:++seq,kind:'retained',stamp:input});
 };
 retain(1,1);retain(2,2);
 const pipeline=createLiveCapturePipeline<Frame>({yieldTask:()=>Promise.resolve(),consume:(f,time)=>{
   replay.link({inputId:f.id-10,frameId:f.id,captureTime:time,phase:'input'});
  },release:f=>{f.closed++;},onError:assert.fail,
  onRecoveryDecision:e=>{replay.recovery({version:1,seq:++seq,...e});}});
 assert.equal(pipeline.offerRecovery([{frame:frames[0],stamp:stamp(1,1)},{frame:frames[1],stamp:stamp(2,2)}]),true);
 await pipeline.flush();const summary=await replay.summary();
 assert.equal(summary.pipeline.offered,0);assert.equal(summary.recovery?.retained,2);
 assert.equal(summary.recovery?.linked,2);assert.equal(summary.recovery?.released,2);
 assert.equal(summary.recovery?.lost,0);assert.equal(summary.settled,true);
});
