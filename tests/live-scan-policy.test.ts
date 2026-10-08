import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LiveScanCadence, timedCaptureOrder, liveLanePlan } from '../src/features/card-scanner/live-scan-policy';
import { consensus } from '../src/features/card-scanner/consensus';
import type { ScannedCard } from '../src/features/card-scanner/recognizer';
test('a completed acquisition accepts the next delivered frame without a second wall-time delay', () => {
  const cadence = new LiveScanCadence();
  assert.equal(cadence.take(0), true);
  cadence.complete(0, 20);
  assert.equal(cadence.take(19), false);
  assert.equal(cadence.take(20), true);
  assert.equal(cadence.acquisitionMs, 20);
  cadence.complete(30, 1030);
  assert.equal(cadence.take(1029), false);
  assert.equal(cadence.take(1030), true);
  assert.equal(cadence.acquisitionMs, 314);
});
test('older recording recovery cannot overwrite a newer live reliable count', () => {
  const base: ScannedCard = { id:'card', name:'card', awakening:0, extraCopies:2,
    countReliable:true, confidence:1, review:[], image:'', time:0, observations:1 };
  const live = {...base, extraCopies:8, captureOrder:timedCaptureOrder(100, 5, 0)};
  const oldRecovery = {...base, captureOrder:timedCaptureOrder(100, 1, 39)};
  assert.equal(consensus([live, oldRecovery]).extraCopies, 8);
  assert.ok(timedCaptureOrder(100, 0, 0)>100);
  assert.ok(timedCaptureOrder(100, 1.000001, 0)>timedCaptureOrder(100, 1, 39));
});

test('live concurrency is bounded and reserves a separate OCR lane when resources allow',()=>{
 assert.deepEqual(liveLanePlan(2),{fast:1,readers:1});
 assert.deepEqual(liveLanePlan(4),{fast:1,readers:2});
 assert.deepEqual(liveLanePlan(8),{fast:2,readers:4});
 assert.deepEqual(liveLanePlan(128),{fast:2,readers:4});
 assert.deepEqual(liveLanePlan(NaN),{fast:1,readers:1});
});

test('a dedicated short OCR lane cannot be occupied by slow fallback during a live queue gap',async()=>{
 const {liveOcrLane,LiveOcrSchedule}=await import('../src/features/card-scanner/live-scan-policy');
 const short=new LiveOcrSchedule(),full=new LiveOcrSchedule();
 assert.equal(liveOcrLane(0,10,0,2,true,short),undefined);
 assert.equal(liveOcrLane(0,10,1,2,true,full),'full');
 assert.equal(liveOcrLane(1,9,0,2,true,short),'short','new short job starts independently of full OCR');
 assert.equal(liveOcrLane(1,0,1,2,true,full),'short','full lane helps short reads when no full job waits');
 assert.equal(liveOcrLane(0,9,0,2,false,short),'full','after input stops every lane can finish retained work');
 const single=new LiveOcrSchedule();
 for(let i=0;i<8;i++)assert.equal(liveOcrLane(10,10,0,1,true,single),'short');
 assert.equal(liveOcrLane(10,10,0,1,true,single),'full','single-lane devices keep bounded fairness');
});

test('live OCR serves full retries without waiting for capture to end',async()=>{
 const {LiveOcrSchedule}=await import('../src/features/card-scanner/live-scan-policy');
 const schedule=new LiveOcrSchedule();
 assert.equal(schedule.next(0,0),undefined);
 assert.equal(schedule.next(0,2),'full');
 for(let i=0;i<8;i++)assert.equal(schedule.next(100,2),'short');
 assert.equal(schedule.next(100,2),'full','a constantly replenished short queue cannot starve full OCR');
 assert.equal(schedule.next(100,2),'short','new short reads regain priority after a full job');
});

test('live OCR never invents a job in an empty queue and bounds accumulated priority',async()=>{
 const {LiveOcrSchedule}=await import('../src/features/card-scanner/live-scan-policy');
 const schedule=new LiveOcrSchedule();
 for(let i=0;i<1000;i++)assert.equal(schedule.next(1,0),'short');
 assert.equal(schedule.next(0,0),undefined);
 assert.equal(schedule.next(10,1),'full');
 assert.equal(schedule.next(10,0),'short');
});

test('unknown identities get OCR first without losing or reordering field retries',async()=>{
 const {shiftOcrRetry}=await import('../src/features/card-scanner/live-scan-policy');
 const queue=[{id:'count-a',needsIdentity:false},{id:'count-b',needsIdentity:false},{id:'name-a',needsIdentity:true},{id:'name-b',needsIdentity:true},{id:'count-c',needsIdentity:false}];
 assert.equal(shiftOcrRetry(queue)?.id,'name-a');
 assert.equal(shiftOcrRetry(queue)?.id,'name-b');
 assert.deepEqual(queue.map(x=>x.id),['count-a','count-b','count-c']);
 assert.equal(shiftOcrRetry(queue)?.id,'count-a');
 queue.push({id:'new-name',needsIdentity:true});
 assert.equal(shiftOcrRetry(queue)?.id,'new-name');
 assert.equal(shiftOcrRetry(queue)?.id,'count-b');
 assert.equal(shiftOcrRetry(queue)?.id,'count-c');
 assert.equal(shiftOcrRetry(queue),undefined);
});

test('OCR prioritizes still-unread groups over repeated name retries without dropping their fields',async()=>{
 const {shiftOcrRetry}=await import('../src/features/card-scanner/live-scan-policy');
 const reads=new Map<string,number>();
 const queue=[{id:'count',group:'known',needsIdentity:false},
  {id:'a1',group:'a',needsIdentity:true},{id:'a2',group:'a',needsIdentity:true},
  {id:'b1',group:'b',needsIdentity:true},{id:'a3',group:'a',needsIdentity:true}];
 const priority=(item:typeof queue[number])=>reads.get(item.group)??0;
 assert.equal(shiftOcrRetry(queue,priority)?.id,'a1');reads.set('a',1);
 assert.equal(shiftOcrRetry(queue,priority)?.id,'b1');reads.set('b',1);
 assert.equal(shiftOcrRetry(queue,priority)?.id,'a2');
 assert.equal(shiftOcrRetry(queue,priority)?.id,'a3');
 assert.equal(shiftOcrRetry(queue,priority)?.id,'count');
 assert.equal(shiftOcrRetry(queue,priority),undefined);
});

test('missing fields outrank already-confirmed repeats and newer count changes keep their priority',async()=>{
 const {retryWorkPriority,shiftOcrRetry}=await import('../src/features/card-scanner/live-scan-policy');
 const confirmed=new Map([['known',20]]);
 const stale={needsIdentity:false,fieldTarget:{id:'known',order:10}};
 const current={needsIdentity:false,fieldTarget:{id:'known',order:21}};
 const missing={needsIdentity:false,fieldTarget:{id:'unconfirmed',order:15}};
 const queue=[stale,current,missing];
 const score=(item:typeof stale)=>retryWorkPriority(item,5,confirmed);
 assert.equal(shiftOcrRetry(queue,score),missing,'a card with no confirmed fields gets its first chance before repeat checks');
 assert.equal(shiftOcrRetry(queue,score),current,'an older reliable counter cannot certify a newer observation');
 assert.equal(shiftOcrRetry(queue,score),stale,'redundant jobs are preserved');
 assert.equal(retryWorkPriority({needsIdentity:true},3,confirmed),3);
 confirmed.set('unconfirmed',15);
 assert.ok(score(missing)>score(current),'same-frame reliable field confirmation is enough to reprioritize');
});

test('a replenished name queue cannot starve an unconfirmed counter',async()=>{
 const {LiveRetrySchedule,retryWorkPriority}=await import('../src/features/card-scanner/live-scan-policy');
 const schedule=new LiveRetrySchedule(),confirmed=new Map([['done',10]]);
 const stale={id:'stale',needsIdentity:false,fieldTarget:{id:'done',order:1}};
 const urgent={id:'counter',needsIdentity:false,fieldTarget:{id:'pending',order:5}};
 const queue=[stale,...Array.from({length:10},(_,i)=>({id:`name${i}`,needsIdentity:true,fieldTarget:undefined})),urgent];
 const priority=(item:typeof queue[number])=>retryWorkPriority(item,0,confirmed);
 for(let i=0;i<8;i++)assert.equal(schedule.shift(queue,priority)?.id,`name${i}`);
 assert.equal(schedule.shift(queue,priority)?.id,'counter');
 assert.equal(schedule.shift(queue,priority)?.id,'name8');
 assert.equal(schedule.shift(queue,priority)?.id,'name9');
 assert.equal(schedule.shift(queue,priority)?.id,'stale');
 assert.equal(schedule.shift(queue,priority),undefined);
});
