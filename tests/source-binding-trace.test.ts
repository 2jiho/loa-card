import {test} from 'node:test';
import assert from 'node:assert/strict';
import {RunStateTrace,parseRunStateTrace,replayRunStateTrace} from '../dev/run-state-trace';
import {SourceBindingMetadataDiagnostics} from '../src/features/card-scanner/acquisition/saved-acquisition';

const signal=()=>new AbortController().signal;
const source={sessionId:'test',frameId:17,observationId:'original',captureOrder:137,captureTime:1,phase:'input',slot:0};
const sample=()=>({scope:'prepared-source-metadata-only',pixelsAuthenticated:false,originalSource:{...source},originalGroup:3,
 recoverySource:{...source,phase:'recovery',frameId:99,observationId:'recovery'},
 physical:{sourceFrameId:7,captureTime:1,width:100,height:100,hash:'a'.repeat(64)},
 content:{x:10,y:10,width:40,height:60},preview:{x:8,y:8,width:44,height:64},
 path:'reacquired',originalJoinedAtMatch:true,recoveryJoinedAtMatch:false});
const summary=()=>{const diag=new SourceBindingMetadataDiagnostics('test');const value=diag.snapshot();diag.close();return value;};

test('source metadata survives compression in order, detached, without altering reducers',async()=>{
 const trace=new RunStateTrace(),value=sample(),stats=summary();
 assert.equal(trace.record('source-binding-metadata',value,1),true);
 assert.equal(trace.record('source-binding-metadata-summary',stats,2),true);
 value.originalSource.observationId='changed';stats.inputAttempts=999;
 const parsed=await parseRunStateTrace(await trace.snapshotBlob(),signal());
 assert.equal(parsed.complete,true);assert.equal(parsed.dropped,0);
 assert.deepEqual(parsed.events.map(e=>[e.seq,e.type]),[[1,'source-binding-metadata'],[2,'source-binding-metadata-summary']]);
 const first=parsed.events[0];assert.equal(first.type,'source-binding-metadata');
 if(first.type==='source-binding-metadata'){
  assert.equal(first.value.originalSource.observationId,'original');assert.equal(first.value.pixelsAuthenticated,false);
  assert.equal(first.value.originalJoinedAtMatch,true);assert.equal(first.value.recoveryJoinedAtMatch,false);
 }
 const last=parsed.events[1];assert.equal(last.type,'source-binding-metadata-summary');
 if(last.type==='source-binding-metadata-summary')assert.equal(last.value.inputAttempts,0);
 const replay=await replayRunStateTrace(await trace.snapshotBlob(),signal());
 const empty=await replayRunStateTrace(await new RunStateTrace().snapshotBlob(),signal());
 for(const key of ['grid','observations','inventory','input','unknownLifecycle','freshness','obstruction'] as const)
  assert.deepEqual(replay[key],empty[key]);
});

test('source metadata invalid or over limit makes selected state record incomplete',async()=>{
 for(const value of [{...sample(),pixelsAuthenticated:true},{...sample(),extra:'untrusted'},
  {...sample(),physical:{...sample().physical,hash:'bad'}},{...sample(),path:'unknown'},
  {...summary(),inputAttempts:-1},{...summary(),pixelsAuthenticated:true}]){
  const trace=new RunStateTrace(),kind=Object.hasOwn(value,'originalSource')?'source-binding-metadata':'source-binding-metadata-summary';
  assert.equal(trace.record(kind,value,0),false);const parsed=await parseRunStateTrace(await trace.snapshotBlob(),signal());
  assert.equal(parsed.complete,false);assert.equal(parsed.dropped,1);
  await assert.rejects(replayRunStateTrace(await trace.snapshotBlob(),signal()),/불완전/);
 }
 const small=new RunStateTrace({maxEvents:1});
 assert.equal(small.record('source-binding-metadata',sample(),0),true);
 assert.equal(small.record('source-binding-metadata-summary',summary(),1),false);
 const parsed=await parseRunStateTrace(await small.snapshotBlob(),signal());
 assert.equal(parsed.complete,false);assert.equal(parsed.dropped,1);assert.equal(parsed.events.length,1);
 await assert.rejects(replayRunStateTrace(await small.snapshotBlob(),signal()),/불완전/);
});
