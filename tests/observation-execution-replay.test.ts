import test from 'node:test';
import assert from 'node:assert/strict';
import {ScanGrid} from '../src/features/card-scanner/scan-grid';
import {entryParts,executionSummary} from '../src/features/card-scanner/exact-recording-codec';
import {hashObservationExecution} from '../src/features/card-scanner/observation-execution';
import type {ObservationFact,ObservationSource} from '../src/features/card-scanner/observation-execution';
import {MAX_REPLAY_OBSERVATIONS,ObservationExecutionReplay} from '../src/features/card-scanner/observation-execution-replay';

const signal=()=>new AbortController().signal;
const source:ObservationSource={sessionId:'scan-1',frameId:1,observationId:'1',captureOrder:100,
 captureTime:10,phase:'input',slot:0};
function queued(id:number):ObservationFact{return {version:1,kind:'queued',source:{...source,observationId:String(id)},attemptId:0};}
function archive(facts:ObservationFact[]){
 return new Blob(facts.flatMap((value,index)=>entryParts({kind:'event',seq:index+1,time:index/100,type:'observation-fact',value})));
}

test('live grid facts replay from the actual archive reader to the same canonical state hash',async()=>{
 const facts:ObservationFact[]=[];const grid=new ScanGrid(fact=>facts.push(fact));grid.begin(true);
 for(let id=1;id<=4;id++)grid.group(id-1,id,id,true,undefined,{...source,observationId:String(id),slot:id-1});
 const reading=grid.start(1);grid.finish(1,'read',reading);
 grid.start(2);grid.finish(3,'review');
 const result=await executionSummary(archive(facts),signal());
 assert.equal(result.events,facts.length);
 assert.deepEqual(result.observations,{supported:true,facts:facts.length,observations:4,
  waiting:1,reading:1,read:1,review:1,hash:await hashObservationExecution(grid.executionSnapshot())});
 assert.deepEqual(Object.keys(result.observations).sort(),['supported','facts','observations','waiting','reading','read','review','hash'].sort());
 assert.equal(result.cards.length,0,'execution replay does not infer recognized card identities');
});

test('late attempts converge while capture time and source phase remain in the state hash',async()=>{
 const facts:ObservationFact[]=[queued(1),{...queued(1),kind:'read-started',attemptId:1},
  {...queued(1),kind:'read-finished',attemptId:1,status:'waiting'},
  {...queued(1),kind:'read-started',attemptId:2},
  {...queued(1),kind:'read-finished',attemptId:2,status:'read'}];
 const expected=await executionSummary(archive(facts),signal());
 const reversed=await executionSummary(archive([...facts].reverse()),signal());
 assert.deepEqual(reversed.observations,expected.observations);
 const recovery=facts.map(fact=>({...fact,source:{...fact.source,captureTime:0.5,phase:'recovery' as const}}));
 const recovered=await executionSummary(archive(recovery),signal());
 assert.equal(recovered.observations.read,1);
 assert.notEqual(recovered.observations.hash,expected.observations.hash,'older source time must not become event arrival time');
 const mixed=await executionSummary(archive([...facts,...recovery.map(fact=>({...fact,source:{...fact.source,observationId:'2'}}))]),signal());
 assert.equal(mixed.observations.observations,2);assert.equal(mixed.observations.read,2);
});

test('archive event order and contradictory facts fail explicitly',async()=>{
 const fact=queued(1),event={kind:'event' as const,seq:1,time:0,type:'observation-fact',value:fact};
 await assert.rejects(executionSummary(new Blob([...entryParts(event),...entryParts(event)]),signal()),/이벤트 순서/);
 await assert.rejects(executionSummary(archive([
  {...fact,kind:'read-finished',status:'read'}, {...fact,kind:'read-finished',status:'review'},
 ]),signal()),/conflicting facts/);
 await assert.rejects(executionSummary(archive([fact,{...fact,source:{...fact.source,frameId:2}}]),signal()),/immutable observation source/);
 const unsupported=new Blob(entryParts({...event,value:{...fact,version:2}}));
 await assert.rejects(executionSummary(unsupported,signal()),/version/);
});

test('legacy or unknown events report unsupported instead of a successful empty replay',async()=>{
 for(const blob of [new Blob(),new Blob(entryParts({kind:'event',seq:1,time:0,type:'read-start',value:{id:1}})),
  new Blob(entryParts({kind:'event',seq:1,time:0,type:'future-event',value:{anything:true}}))]){
  const result=await executionSummary(blob,signal());
  assert.deepEqual(result.observations,{supported:false,facts:0,observations:0,waiting:0,reading:0,read:0,review:0,hash:null});
 }
});

test('inspection never decompresses or hashes frame payloads',async()=>{
 const invalidCompressedPixels=new Uint8Array([255,255,255]);
 const blob=new Blob([...entryParts({kind:'frame',id:1,time:0,width:1,height:1,key:true,hash:'0'.repeat(64),codec:'lz4'},invalidCompressedPixels),
  ...entryParts({kind:'event',seq:1,time:1,type:'observation-fact',value:queued(1)})]);
 const result=await executionSummary(blob,signal());
 assert.equal(result.frames,1);assert.equal(result.observations.waiting,1);
 assert.equal(result.observations.supported,true);
});

test('observation storage is hard bounded and session-local trace IDs do not collide',async()=>{
 assert.equal(MAX_REPLAY_OBSERVATIONS,20_000);
 assert.throws(()=>new ObservationExecutionReplay(signal(),MAX_REPLAY_OBSERVATIONS+1),/한도/);
 const replay=new ObservationExecutionReplay(signal(),2);
 replay.accept(queued(1));replay.accept(queued(1));
 replay.accept({...queued(1),source:{...source,sessionId:'scan-2'}});
 assert.equal((await replay.summary()).observations,2);
 assert.equal((await replay.summary()).facts,3);
 assert.throws(()=>replay.accept(queued(2)),/한도 초과/);
 const full=new ObservationExecutionReplay(signal());
 for(let id=1;id<=MAX_REPLAY_OBSERVATIONS;id++)full.accept(queued(id));
 assert.throws(()=>full.accept(queued(MAX_REPLAY_OBSERVATIONS+1)),/한도 초과/);
});

test('cancelled inspection and replay stop before publishing a summary',async()=>{
 const aborted=new AbortController();aborted.abort();
 await assert.rejects(executionSummary(archive([queued(1)]),aborted.signal),{name:'AbortError'});
 const replay=new ObservationExecutionReplay(aborted.signal);
 assert.throws(()=>replay.accept(queued(1)),{name:'AbortError'});
 await assert.rejects(replay.summary(),{name:'AbortError'});
 const running=new AbortController();
 const many=archive(Array.from({length:600},()=>queued(1)));
 const timer=setTimeout(()=>running.abort(),0);
 try{await assert.rejects(executionSummary(many,running.signal),{name:'AbortError'});}
 finally{clearTimeout(timer);}
 const hashing=new AbortController();const final=new ObservationExecutionReplay(hashing.signal);final.accept(queued(1));
 const summary=final.summary();hashing.abort();
 await assert.rejects(summary,{name:'AbortError'});
});

test('a yielded summary counts and hashes one immutable instant of observation state',async()=>{
 const replay=new ObservationExecutionReplay(signal());replay.accept(queued(1));
 const before=replay.summary();
 replay.accept({...queued(1),kind:'read-started',attemptId:1});replay.accept(queued(2));
 const first=await before,latest=await replay.summary();
 assert.equal(first.facts,1);assert.equal(first.observations,1);assert.equal(first.waiting,1);assert.equal(first.reading,0);
 assert.equal(latest.facts,3);assert.equal(latest.observations,2);assert.equal(latest.waiting,1);assert.equal(latest.reading,1);
 const check=await executionSummary(archive([queued(1)]),signal());
 assert.deepEqual(first,check.observations);
});
