import test from 'node:test';
import assert from 'node:assert/strict';
import {createCoverageFrameSelector,COVERAGE_COLUMNS} from '../src/features/card-scanner/capture/coverage-frame-selector';
import type {CoverageCandidate} from '../src/features/card-scanner/capture/coverage-frame-selector';
import {createLiveCapturePipeline} from '../src/features/card-scanner/capture/live-capture-pipeline';

const candidate=(inputId:number,rowStart:number|null,bytes=1):CoverageCandidate=>({inputId,capturedAt:inputId,estimatedBytes:bytes,
  selection:rowStart===null?null:{rowStart,rowCount:4}});
const all=(value:boolean)=>new Array<boolean>(4*COVERAGE_COLUMNS).fill(value);

test('a frame over uncovered rows beats a newer frame over rows already covered',()=>{
  const selector=createCoverageFrameSelector();
  selector.started({rowStart:0,rowCount:4});selector.outcome(all(true));
  const covered=candidate(2,0),fresh=candidate(1,10),newestCovered=candidate(3,1);
  const {chosen,dropped}=selector.choose([covered,fresh,newestCovered]);
  assert.equal(chosen,fresh);
  // Older candidates are dropped so acquisition stays monotonic in capture time.
  assert.deepEqual(dropped,[]);
});

test('choosing a later frame drops older candidates but never the chosen or newer ones',()=>{
  const selector=createCoverageFrameSelector();
  selector.started({rowStart:0,rowCount:4});selector.outcome(all(true));
  const a=candidate(1,0),b=candidate(2,20),c=candidate(3,0);
  const {chosen,dropped}=selector.choose([a,b,c]);
  assert.equal(chosen,b);assert.deepEqual(dropped,[a]);
});

test('incomplete cells keep a row partial and its frames stay attractive',()=>{
  const selector=createCoverageFrameSelector();
  const slots=all(true);slots[0]=false;slots[11]=false;           // row 0 col 0, row 1 col 1
  selector.started({rowStart:0,rowCount:4});selector.outcome(slots);
  assert.deepEqual({complete:selector.snapshot().complete,partial:selector.snapshot().partial},{complete:2,partial:2});
  selector.started({rowStart:10,rowCount:4});selector.outcome(all(true));
  const {chosen}=selector.choose([candidate(1,0),candidate(2,10)]);
  assert.equal(chosen.inputId,1,'two missing cells outweigh a newer frame over fully covered rows');
});

test('frames without a hint fall back to newest first and never throw',()=>{
  const selector=createCoverageFrameSelector();
  assert.equal(selector.choose([candidate(1,null),candidate(2,null)]).chosen.inputId,2);
  selector.started(null);selector.outcome(all(true));
  assert.equal(selector.snapshot().none,55);
  assert.throws(()=>selector.choose([]));
});

test('outcome only counts the frame that was started and clears it',()=>{
  const selector=createCoverageFrameSelector();
  selector.outcome(all(true));                                   // nothing started: ignored
  assert.equal(selector.snapshot().complete,0);
  selector.started({rowStart:53,rowCount:4});selector.outcome(all(true)); // rows beyond 54 are ignored
  assert.equal(selector.snapshot().complete,2);
  selector.outcome(all(true));
  assert.equal(selector.snapshot().complete,2);
  selector.reset();
  assert.equal(selector.snapshot().complete,0);
});

test('retain always keeps the newest frame, honours count and byte budgets and is deterministic',()=>{
  const run=()=>{
    const selector=createCoverageFrameSelector();
    selector.started({rowStart:0,rowCount:4});selector.outcome(all(true));
    const pending=[candidate(1,0),candidate(2,20),candidate(3,30)];
    return selector.retain(candidate(4,0),pending,3,100).map(entry=>entry.inputId);
  };
  assert.deepEqual(run(),run(),'same facts give the same result');
  const kept=run();
  assert.equal(kept.length,3,'maxPending counts the incoming frame');
  assert.ok(kept.includes(4),'the newest frame is never evicted');
  assert.deepEqual(kept,[...kept].sort((x,y)=>x-y),'ordered by capture time');
  assert.ok(kept.includes(2)&&kept.includes(3)&&!kept.includes(1),'the covered frame is evicted first');
  const selector=createCoverageFrameSelector();
  assert.deepEqual(selector.retain(candidate(9,0,60),[candidate(8,5,60)],4,100).map(entry=>entry.inputId),[9],'byte budget');
  assert.deepEqual(selector.retain(candidate(9,0,200),[],4,100),[],'an oversized incoming frame is rejected');
});

test('pipeline with the selector acquires the most useful frame and releases every frame once',async()=>{
  const selector=createCoverageFrameSelector();
  selector.started({rowStart:0,rowCount:4});selector.outcome(all(true));
  const seen:number[]=[],released:number[]=[],decisions:string[]=[];
  let hold!:()=>void;const held=new Promise<void>(resolve=>{hold=resolve;});
  const pipeline=createLiveCapturePipeline<number>({maxPendingFrames:4,selector,maxRetainedBytes:1000,
    yieldTask:()=>Promise.resolve(),
    consume:async frame=>{seen.push(frame);if(frame===1)await held;},release:frame=>{released.push(frame);},
    onDecision:event=>{decisions.push(event.kind);},onError:assert.fail});
  const stamp=(id:number)=>({inputId:id,captureTime:id,observedAtMs:id});
  pipeline.offer(1,1,stamp(1),{rowStart:0,rowCount:4});
  await new Promise<void>(resolve=>setImmediate(resolve));
  assert.deepEqual(seen,[1],'frame 1 is active and blocked');
  // Frame 1 is active. Cover-already frames 2 and 4 compete with uncovered frame 3.
  pipeline.offer(2,2,stamp(2),{rowStart:0,rowCount:4});
  pipeline.offer(3,3,stamp(3),{rowStart:20,rowCount:4});
  pipeline.offer(4,4,stamp(4),{rowStart:0,rowCount:4});
  hold();await pipeline.flush();
  assert.deepEqual(seen,[1,3,4]);
  assert.deepEqual([...released].sort(),[1,2,3,4],'each frame is released exactly once');
  assert.ok(decisions.includes('replaced'));
});

test('without a selector four pending frames are rejected as before',()=>{
  assert.throws(()=>createLiveCapturePipeline<number>({maxPendingFrames:4,yieldTask:async()=>{},consume:()=>{},release:()=>{},onError:assert.fail}),TypeError);
});
