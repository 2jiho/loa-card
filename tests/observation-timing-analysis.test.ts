import {test} from 'node:test';
import assert from 'node:assert/strict';
import {analyzeObservationTiming} from '../scripts/analyze-observation-timing.mjs';

function fixture() {
  const events: {seq:number;time:number;type:string;value:unknown}[]=[];
  const add=(time:number,kind:string,attemptId=0,sessionId='s')=>events.push({seq:events.length+1,time,
    type:'observation-fact',value:{source:{sessionId,observationId:'1'},kind,attemptId}});
  return {events,add,run:()=>analyzeObservationTiming({complete:true,dropped:0,events})};
}
test('separates initial wait, retry wait and task duration from unleased corrections',()=>{
  const f=fixture();f.add(0,'queued');f.add(1,'read-finished');
  f.add(2,'read-started',2);f.add(3,'read-finished',2);
  f.add(4,'read-started',3);f.add(6,'read-finished',3);
  const r=f.run();assert.equal(r.firstReadWaitMs.p50,2000);assert.equal(r.retryFromInitialQueueMs.p50,4000);
  assert.equal(r.readTaskMs.count,2);assert.equal(r.finishesWithoutStart,1);assert.equal(r.status,'measured');
  assert.deepEqual(r.matchedTaskActivity,{spanMs:4000,occupiedMs:3000,gapMs:1000,summedTaskMs:3000});
});
test('overlapping readers contribute once to occupied wall time',()=>{
  const f=fixture();f.add(0,'queued');f.add(0,'queued',0,'other');
  f.add(1,'read-started',1);f.add(2,'read-started',1,'other');
  f.add(4,'read-finished',1);f.add(5,'read-finished',1,'other');
  assert.deepEqual(f.run().matchedTaskActivity,{spanMs:4000,occupiedMs:4000,gapMs:0,summedTaskMs:6000});
  assert.deepEqual(f.run().matchedTaskConcurrency.durationMsByActiveTasks,{'1':2000,'2':2000});
});

test('concurrency aggregates touching boundaries and records idle gaps without counting unfinished work',()=>{
  const f=fixture();f.add(0,'queued');f.add(1,'read-started',1);f.add(2,'read-finished',1);
  f.add(2,'read-started',2);f.add(3,'read-finished',2);
  f.add(4,'read-started',3);f.add(5,'read-finished',3);f.add(6,'read-started',4);
  const r=f.run();assert.deepEqual(r.matchedTaskConcurrency.durationMsByActiveTasks,{'0':1000,'1':3000});
  assert.equal(r.unfinishedAttempts,1);assert.equal(r.status,'partial');
});

test('read gaps count overlapping first waits once and exclude outside the read span',()=>{
  const f=fixture();f.add(0,'queued');f.add(0,'queued',0,'b');f.add(0,'queued',0,'c');
  f.add(1,'read-started',1);f.add(2,'read-finished',1);
  f.add(4,'read-started',1,'b');f.add(5,'read-finished',1,'b');
  f.add(6,'read-started',1,'c');f.add(7,'read-finished',1,'c');
  const r=f.run();assert.equal(r.readGapEvidence.gapWithFirstReadWaitingMs,3000);
  assert.equal(r.readGapEvidence.otherGapMs,0);
});

test('retry gaps and unmatched never-started work are not claimed as first-read waiting',()=>{
  const f=fixture();f.add(0,'queued');f.add(1,'read-started',1);f.add(2,'read-finished',1);
  f.add(3,'queued',0,'never-started');f.add(4,'read-started',2);f.add(5,'read-finished',2);
  const r=f.run();assert.equal(r.readGapEvidence.gapWithFirstReadWaitingMs,0);
  assert.equal(r.readGapEvidence.otherGapMs,2000);
});
test('missing queue in another session and unfinished attempts remain partial evidence',()=>{
  const f=fixture();f.add(0,'queued');f.add(1,'read-started',1,'other');f.add(2,'read-finished',1,'other');
  f.add(3,'read-started',1);
  const r=f.run();assert.equal(r.startsWithoutQueue,1);assert.equal(r.unfinishedAttempts,1);assert.equal(r.status,'partial');
});
test('empty and truncated traces never imply zero latency success',()=>{
  const f=fixture();assert.equal(f.run().readTaskMs.p50,null);assert.equal(f.run().status,'unmeasured');
  f.add(0,'queued');f.add(1,'read-started',1);f.add(2,'read-finished',1);
  assert.equal(analyzeObservationTiming({complete:false,dropped:1,events:f.events}).status,'partial');
});
test('rejects duplicate work and backwards clock measurements',()=>{
  const f=fixture();f.add(0,'queued');f.add(1,'read-started',1);f.add(2,'read-started',1);
  assert.throws(f.run,/Duplicate/);
  f.events.pop();f.add(.5,'read-finished',1);assert.throws(f.run,/monotonic/);
});
test('grid commands regenerate live timings without duplicating observation logs',()=>{
  const events=[
    {seq:1,time:0,type:'grid-command',value:{version:1,method:'group',args:[0,1,1,true,null,{sessionId:'s',observationId:'1',frameId:1,captureOrder:1,captureTime:0,phase:'input',slot:0}]}},
    {seq:2,time:2,type:'grid-command',value:{version:1,method:'start',args:[1]}},
    {seq:3,time:.5,type:'input-lineage',value:{}},
    {seq:4,time:3,type:'grid-command',value:{version:1,method:'finish',args:[1,'read',1]}},
  ];
  const r=analyzeObservationTiming({complete:true,dropped:0,events});
  assert.equal(r.gridFacts,3);assert.equal(r.firstReadWaitMs.p50,2000);
  assert.equal(r.readTaskMs.p50,1000);assert.equal(r.unfinishedAttempts,0);
});

