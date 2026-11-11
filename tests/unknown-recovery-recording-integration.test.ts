import {test} from 'node:test';
import assert from 'node:assert/strict';
import {RunStateTrace,replayRunStateTrace} from '../dev/run-state-trace';
import {entryParts,executionSummary,type ExactEvent} from '../src/features/card-scanner/reproduction/exact-recording-codec';
import {UnknownRecoveryClaimReplay,type UnknownRecoveryClaim} from '../src/features/card-scanner/reproduction/unknown-recovery-claim-replay';
import {UNKNOWN_LIFECYCLE_LIMITS,type UnknownFact} from '../src/features/card-scanner/session/unknown-lifecycle-types';
import {validateArchiveExact} from '../src/features/card-scanner/reproduction/archive-exact-validation';
import {createCanonicalFinalizationFixture} from './helpers/canonical-finalization-fixture';
import type {ReproductionFile} from '../src/features/card-scanner/reproduction/scan-reproduction';

const seed={version:3 as const,sessionId:'s',origin:'scan' as const,limits:UNKNOWN_LIFECYCLE_LIMITS};
const source={sessionId:'s',frameId:1,observationId:'original',captureOrder:7,captureTime:5,phase:'input' as const,slot:0};
const key={kind:'group' as const,sessionId:'s',group:1};
const warning:UnknownFact={version:1,kind:'upsert',key,source,captureOrder:7,captureTime:5,pending:false,reason:'name',location:null};
const rect={x:1,y:1,width:10,height:10};
const claim:UnknownRecoveryClaim={version:3,kind:'recovery-confirmed',target:{key,originalSource:source},
 recovery:{source:{...source,phase:'recovery',frameId:11,observationId:'recovery'},attemptId:2,cardId:'card-a',review:[]},
 physical:{sourceFrameId:42,sha256:'a'.repeat(64),width:100,height:100,captureTime:5,originalContent:rect,recoveryContent:rect,originalPreview:rect,recoveryPreview:rect}};
const signal=()=>AbortSignal.timeout(30_000);
const archive=(events:readonly ExactEvent[])=>new Blob(events.flatMap(event=>entryParts(event)));
const totals=(events:readonly ExactEvent[])=>({complete:true,dropped:0,events:events.length,frames:0});
async function run(facts:readonly {type:string;value:unknown}[],configured=seed) {
 const trace=new RunStateTrace(),events:ExactEvent[]=[];
 const push=(type:string,value:unknown)=>{const time=events.length/100;assert.equal(trace.record(type,value,time),true);events.push({kind:'event',seq:events.length+1,time,type,value});};
 push('unknown-seed',configured);for(const event of facts)push(event.type,event.value);
 return {trace,events,push};
}
const original={type:'unknown-event',value:warning},recovery={type:'unknown-recovery-claim',value:claim};
async function checkpoint(facts:readonly {type:string;value:unknown}[],configured=seed) {
 const core=new UnknownRecoveryClaimReplay(configured);for(const event of facts)core.apply(event.value as UnknownFact|UnknownRecoveryClaim);
 return {version:1,complete:core.snapshot().complete,events:facts.length,hash:await core.hash()};
}

test('v3 replays original and recovery provenance through both readers without authorizing pixels or completion',async()=>{
 for(const facts of [[original,recovery],[recovery,original]]) {
  const recording=await run(facts);recording.push('unknown-checkpoint',await checkpoint(facts));
  const a=await replayRunStateTrace(await recording.trace.snapshotBlob(),signal());
  const b=await executionSummary(archive(recording.events),signal(),totals(recording.events));
  assert.deepEqual(a.unknownLifecycle,b.unknownLifecycle);
  for(const state of [a.unknownLifecycle,b.unknownLifecycle]){
   assert.equal(state.active,0);assert.equal(state.complete,true);assert.equal(state.matchesCapturedState,null);
   assert.deepEqual(state.producerClaim,{scope:'producer-claimed-recovery-replay',pixelsAuthenticated:false,recognitionAuthenticated:false,liveAuthorization:false,matchesClaimedState:true});
  }
 }
});

test('changed claims, truncated envelopes, and later events cannot certify replay',async()=>{
 const facts=[original,recovery],recording=await run(facts);recording.push('unknown-checkpoint',await checkpoint(facts));
 const changed=recording.events.map(event=>event.type==='unknown-recovery-claim'?{...event,value:{...claim,recovery:{...claim.recovery,cardId:'other'}}}:event);
 const mismatch=await executionSummary(archive(changed),signal(),totals(changed));
 assert.equal(mismatch.unknownLifecycle.producerClaim?.matchesClaimedState,false);
 const partial=await executionSummary(archive(recording.events),signal(),{...totals(recording.events),complete:false});
 assert.equal(partial.unknownLifecycle.complete,false);assert.equal(partial.unknownLifecycle.producerClaim?.matchesClaimedState,null);
 recording.push('unknown-event',warning);
 for(const state of [(await replayRunStateTrace(await recording.trace.snapshotBlob(),signal())).unknownLifecycle,
  (await executionSummary(archive(recording.events),signal(),totals(recording.events))).unknownLifecycle]){
  assert.equal(state.complete,false);assert.equal(state.producerClaim?.matchesClaimedState,null);
 }
});

test('contradictory recovery and exhausted fact budget stay incomplete in both readers',async()=>{
 for(const [facts,configured] of [
  [[original,recovery,{type:'unknown-recovery-claim',value:{...claim,recovery:{...claim.recovery,cardId:'other'}}}],seed],
  [[original,recovery],{...seed,limits:{...seed.limits,facts:1}}],
 ] as const){
  const recording=await run(facts,configured);recording.push('unknown-checkpoint',await checkpoint(facts,configured));
  for(const state of [(await replayRunStateTrace(await recording.trace.snapshotBlob(),signal())).unknownLifecycle,
   (await executionSummary(archive(recording.events),signal(),totals(recording.events))).unknownLifecycle]){
   assert.equal(state.complete,false);assert.equal(state.hash,null);assert.equal(state.producerClaim?.matchesClaimedState,null);
  }
 }
});

test('recovery claims require explicit v3 and malformed or unknown claim types are rejected',async()=>{
 const legacy={...seed,version:2};
 await assert.rejects(executionSummary(archive([{kind:'event',seq:1,time:0,type:'unknown-seed',value:legacy},{kind:'event',seq:2,time:1,type:'unknown-recovery-claim',value:claim}]),signal()));
 for(const invalid of [{...claim,kind:'unknown'},{...claim,version:4}]){
  const trace=new RunStateTrace();assert.equal(trace.record('unknown-seed',seed,0),true);
  assert.equal(trace.record('unknown-recovery-claim',invalid,1),false);
  await assert.rejects(executionSummary(archive([{kind:'event',seq:1,time:0,type:'unknown-seed',value:seed},{kind:'event',seq:2,time:1,type:'unknown-recovery-claim',value:invalid}]),signal()));
 }
 for(const position of ['before','after'] as const){
  const records:ExactEvent[]=[{kind:'event',seq:1,time:0,type:'unknown-seed',value:seed}];
  const extra:ExactEvent={kind:'event',seq:0,time:0,type:'unknown-future-claim',value:{}};
  const events=(position==='before'?[extra,...records]:[...records,extra]).map((event,index)=>({...event,seq:index+1}));
  await assert.rejects(executionSummary(archive(events),signal(),totals(events)),/알 수 없는 이벤트/);
 }
});

test('reordered envelopes and physically truncated exact records are rejected',async()=>{
 const facts=[original,recovery],recording=await run(facts);recording.push('unknown-checkpoint',await checkpoint(facts));
 const reordered=[recording.events[0],recording.events[2],recording.events[1],recording.events[3]];
 await assert.rejects(executionSummary(archive(reordered),signal(),totals(reordered)));
 const blob=archive(recording.events);
 await assert.rejects(executionSummary(blob.slice(0,blob.size-5),signal(),totals(recording.events)));
});

test('v3 matching producer claims cannot release a protected archive',async()=>{
 const fixture=await createCanonicalFinalizationFixture();
 const seedEntry=fixture.entries.find(e=>e.header.kind==='event'&&e.header.type==='unknown-seed')!;
 if(seedEntry.header.kind!=='event')throw Error('fixture');
 const v3seed={...(seedEntry.header.value as typeof seed),version:3 as const};
 const core=new UnknownRecoveryClaimReplay(v3seed);
 for(const entry of fixture.entries)if(entry.header.kind==='event'&&entry.header.type==='unknown-event')core.apply(entry.header.value as UnknownFact);
 const hash=await core.hash();assert.ok(hash);
 const entries=fixture.entries.map(entry=>entry.header.kind==='event'&&entry.header.type==='unknown-seed'?{...entry,header:{...entry.header,value:v3seed}}:
  entry.header.kind==='event'&&entry.header.type==='unknown-checkpoint'?{...entry,header:{...entry.header,value:{version:1,complete:true,events:core.snapshot().events,hash}}}:entry);
 const recording=fixture.recordingFrom(entries);
 const summary=await executionSummary(recording.blob,signal(),recording.stats);
 assert.equal(summary.unknownLifecycle.producerClaim?.matchesClaimedState,true);
 assert.equal(summary.unknownLifecycle.matchesCapturedState,null);
 const file:ReproductionFile={video:new Blob(),exact:recording.blob,metadata:{version:4,createdAt:'2026-10-01',browser:'test',catalog:'test',build:'test',completed:true,recordState:'complete',warnings:[],duration:1,type:'',bytes:0,seed:[],result:null,exact:recording.stats}};
 assert.equal(await validateArchiveExact(file,signal()),false);
});
