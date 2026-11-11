import {test} from 'node:test';
import assert from 'node:assert/strict';
import {UnidentifiedObstructionFence} from '../src/features/card-scanner/session/completion-obstruction-debt';
import {ObstructionEvidenceReplay,hashObstructionEvidence} from '../src/features/card-scanner/reproduction/obstruction-evidence-replay';
import {parseAcquisitionCapture} from '../src/features/card-scanner/capture/capture-provenance';
import {RunStateTrace,replayRunStateTrace} from '../dev/run-state-trace';
import {entryParts,executionSummary} from '../src/features/card-scanner/reproduction/exact-recording-codec';
import type {ExactEvent} from '../src/features/card-scanner/reproduction/exact-recording-codec';
const signal=()=>new AbortController().signal;
const seed={version:1 as const,sessionId:'session',seedOrder:0};
const acquisition=()=>parseAcquisitionCapture({version:1,sessionId:'session',observationId:'obs',processingFrame:2,acquisitionFrameId:2,
 canonicalSourceFrameId:2,captureTime:1,phase:'input',slot:2,pixelKey:'pixel',sourceWidth:400,sourceHeight:400,
 cropState:'materialized',cropWidth:140,cropHeight:210,nominalBox:{x:0,y:0,width:140,height:210},contentBox:{x:0,y:0,width:140,height:210},
 previewBox:{x:0,y:0,width:140,height:210},capture:{stable:true,stabilitySource:'settled-fields',complete:true,intact:false,labelVisible:false,
 borderAlignment:.5,borderSides:[1,1,0,1],preBorder:{kind:'tooltip',reason:'tooltip'}},quality:{usable:false,reason:'border',sharpness:5}});
const notice={version:1 as const,kind:'notice' as const,sessionId:'session',processingFrame:2,acquisitionFrameId:2,observationId:'obs',captureTime:1,slot:2,preBorderKind:'tooltip' as const};
const empty=()=>({latest:new Map<string,number>(),names:new Map<string,number>(),fields:new Map<string,number>()});
async function checkpoint(){const f=new UnidentifiedObstructionFence();f.notice(1,0);const maps=empty(),snapshot=f.snapshot();
 return {version:1 as const,complete:true,events:1,...snapshot,expected:1,pending:1,hash:await hashObstructionEvidence(snapshot,1,maps.latest,maps.names,maps.fields)};}
test('common replay validates source-matched notice and checkpoint; missing channel is unsupported',async()=>{
 const replay=new ObstructionEvidenceReplay(signal(),empty);assert.equal((await replay.summary()).supported,false);
 replay.seed(seed);replay.acquisition(acquisition());replay.accept(notice);replay.checkpoint(await checkpoint());
 const result=await replay.summary();assert.equal(result.complete,true);assert.equal(result.pending,1);assert.equal(result.matchesCapturedState,true);
 replay.proofsChanged();assert.equal((await replay.summary()).matchesCapturedState,null);
});
test('missing, mismatched and reordered notices cannot attest a complete state',async()=>{
 for(const changed of [{...notice,slot:3},{...notice,sessionId:'other'},{...notice,captureTime:2},{...notice,observationId:'other'}]){
  const r=new ObstructionEvidenceReplay(signal(),empty);r.seed(seed);r.acquisition(acquisition());assert.throws(()=>r.accept(changed),/mismatch/);
 }
 const r=new ObstructionEvidenceReplay(signal(),empty);r.seed(seed);r.acquisition(acquisition());assert.throws(()=>r.checkpoint({}),/Missing obstruction notice/);
 const missing=new ObstructionEvidenceReplay(signal(),empty);assert.throws(()=>missing.accept(notice),/seed/);
});
test('full state trace recognizes obstruction facts without promoting legacy absence',async()=>{
 const trace=new RunStateTrace();let time=0;const add=(name:string,value:unknown)=>assert.equal(trace.record(name,value,time++),true);
 add('inventory-seed',{version:1,cards:[]});add('obstruction-seed',seed);add('acquisition-capture',acquisition());add('obstruction-event',notice);add('obstruction-checkpoint',await checkpoint());
 const result=await replayRunStateTrace(await trace.snapshotBlob(),signal());assert.equal(result.obstruction.matchesCapturedState,true);
 const legacy=await replayRunStateTrace(await new RunStateTrace().snapshotBlob(),signal());assert.equal(legacy.obstruction.supported,false);assert.equal(legacy.obstruction.matchesCapturedState,null);
});

test('exact execution replays source-bound obstruction and distinguishes incomplete or unsupported recordings',async()=>{
 const events:ExactEvent[]=[];
 const add=(type:string,value:unknown)=>events.push({kind:'event',seq:events.length+1,time:events.length,type,value});
 const archive=()=>new Blob(events.flatMap(entry=>entryParts(entry)));
 add('inventory-seed',{version:1,cards:[]});add('obstruction-seed',seed);
 add('acquisition-capture',acquisition());add('obstruction-event',notice);add('obstruction-checkpoint',await checkpoint());
 const totals={complete:true,dropped:0,events:events.length,frames:0};
 const complete=await executionSummary(archive(),signal(),totals);
 assert.equal(complete.obstruction.supported,true);assert.equal(complete.obstruction.complete,true);
 assert.equal(complete.obstruction.pending,1);assert.equal(complete.obstruction.matchesCapturedState,true);
 assert.equal(complete.obstruction.physicalInputVerified,false);assert.equal(complete.obstruction.independentCardSourcesVerified,false);
 const partial=await executionSummary(archive(),signal(),{...totals,complete:false,dropped:1});
 assert.equal(partial.obstruction.complete,false);assert.equal(partial.obstruction.matchesCapturedState,null);
 const legacy=await executionSummary(new Blob([]),signal());
 assert.equal(legacy.obstruction.supported,false);assert.equal(legacy.obstruction.matchesCapturedState,null);
 const changed=events.map(event=>event.type==='obstruction-event'?{...event,value:{...notice,slot:3}}:event);
 await assert.rejects(executionSummary(new Blob(changed.flatMap(entry=>entryParts(entry))),signal()),/mismatch/);
});

test('exact recording cannot claim obstruction-state proof after receipt loss even if totals declare complete',async()=>{
 const events:ExactEvent[]=[];
 const add=(type:string,value:unknown)=>events.push({kind:'event',seq:events.length+1,time:events.length,type,value});
 add('inventory-seed',{version:1,cards:[]});add('obstruction-seed',seed);add('acquisition-capture',acquisition());
 add('obstruction-recording-error',{reason:'sink not acknowledged'});
 const result=await executionSummary(new Blob(events.flatMap(entry=>entryParts(entry))),signal(),{complete:true,dropped:0,events:events.length,frames:0});
 assert.equal(result.obstruction.supported,true);assert.equal(result.obstruction.complete,false);assert.equal(result.obstruction.matchesCapturedState,null);
});

test('recovered older obstruction uses original capture time and cannot replace a newer input boundary',async()=>{
 const replay=new ObstructionEvidenceReplay(signal(),empty),v2={...seed,version:2 as const};replay.seed(v2);
 const later=parseAcquisitionCapture({...acquisition(),processingFrame:10,acquisitionFrameId:10,captureTime:5,observationId:'later'});
 replay.acquisition(later);replay.accept({...notice,version:2,processingFrame:10,acquisitionFrameId:10,captureTime:5,observationId:'later',phase:'input'});
 const old=parseAcquisitionCapture({...acquisition(),processingFrame:11,acquisitionFrameId:2,captureTime:1,observationId:'old',phase:'recovery'});
 replay.acquisition(old);replay.accept({...notice,version:2,processingFrame:11,acquisitionFrameId:2,captureTime:1,observationId:'old',phase:'recovery'});
 const fence=new UnidentifiedObstructionFence();fence.notice(5,0);fence.notice(1,0);const maps=empty(),snapshot=fence.snapshot();
 replay.checkpoint({version:1,complete:true,events:2,...snapshot,expected:1,pending:1,
  hash:await hashObstructionEvidence(snapshot,1,maps.latest,maps.names,maps.fields)});
 const result=await replay.summary();assert.equal(result.complete,true);assert.equal(result.matchesCapturedState,true);
 assert.equal(result.pending,1,'old replay is not fresh name or field proof');
 const mismatch=new ObstructionEvidenceReplay(signal(),empty);mismatch.seed(v2);mismatch.acquisition(old);
 assert.throws(()=>mismatch.accept({...notice,version:2,processingFrame:11,acquisitionFrameId:2,captureTime:1,observationId:'old',phase:'input'}),/mismatch/);
});

test('exact recording replays late recovery input with its original timestamp',async()=>{
 const events:ExactEvent[]=[];const add=(type:string,value:unknown)=>events.push({kind:'event',seq:events.length+1,time:events.length,type,value});
 add('inventory-seed',{version:1,cards:[]});add('obstruction-seed',{...seed,version:2});
 add('acquisition-capture',parseAcquisitionCapture({...acquisition(),processingFrame:10,acquisitionFrameId:10,captureTime:5,observationId:'later'}));
 add('obstruction-event',{...notice,version:2,processingFrame:10,acquisitionFrameId:10,captureTime:5,observationId:'later',phase:'input'});
 add('acquisition-capture',parseAcquisitionCapture({...acquisition(),processingFrame:11,acquisitionFrameId:2,captureTime:1,observationId:'old',phase:'recovery'}));
 add('obstruction-event',{...notice,version:2,processingFrame:11,acquisitionFrameId:2,captureTime:1,observationId:'old',phase:'recovery'});
 const fence=new UnidentifiedObstructionFence();fence.notice(5,0);fence.notice(1,0);const maps=empty(),snapshot=fence.snapshot();
 add('obstruction-checkpoint',{version:1,complete:true,events:2,...snapshot,expected:1,pending:1,
  hash:await hashObstructionEvidence(snapshot,1,maps.latest,maps.names,maps.fields)});
 const result=await executionSummary(new Blob(events.flatMap(entry=>entryParts(entry))),signal(),{complete:true,dropped:0,events:events.length,frames:0});
 assert.equal(result.obstruction.complete,true);assert.equal(result.obstruction.matchesCapturedState,true);assert.equal(result.obstruction.pending,1);
});

test('legacy v1 obstruction recording ignores old recovery acquisitions as originally recorded',async()=>{
 const replay=new ObstructionEvidenceReplay(signal(),empty);replay.seed(seed);
 replay.acquisition(parseAcquisitionCapture({...acquisition(),phase:'recovery'}));
 const fence=new UnidentifiedObstructionFence(),maps=empty(),snapshot=fence.snapshot();
 replay.checkpoint({version:1,complete:true,events:0,...snapshot,expected:1,pending:0,
  hash:await hashObstructionEvidence(snapshot,1,maps.latest,maps.names,maps.fields)});
 const result=await replay.summary();assert.equal(result.complete,true);assert.equal(result.matchesCapturedState,true);
});
