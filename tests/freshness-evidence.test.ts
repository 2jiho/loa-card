import {test} from 'node:test';
import assert from 'node:assert/strict';
import {FreshnessEvidence,FRESHNESS_EVIDENCE_LIMITS,hashFreshnessEvidence,parseFreshnessCheckpoint,
  parseFreshnessFact,parseFreshnessSeed,type FreshnessBinding,type FreshnessFact,type FreshnessSeed} from '../src/features/card-scanner/freshness-evidence';
import {FreshnessEvidenceReplay} from '../src/features/card-scanner/freshness-evidence-replay';
import {InventoryEvidence,type InventorySource} from '../src/features/card-scanner/inventory-evidence';
import type {ObservationSource} from '../src/features/card-scanner/observation-execution';
import type {ScannedCard} from '../src/features/card-scanner/recognizer';

const sessionId='freshness-regression';
const seed=(groups=2048,facts=20_000):FreshnessSeed=>({version:1,sessionId,limits:{groups,facts}});
const source=(n:number,patch:Partial<ObservationSource>={}):ObservationSource=>({sessionId,frameId:n,
  observationId:`observation-${n}`,captureOrder:n*100,captureTime:n,phase:'input',slot:n%40,...patch});
const binding=(n:number,patch:Partial<FreshnessBinding>={}):FreshnessBinding=>({key:`lineage-${n}`,
  order:n*100,frame:`original-frame/${n}`,stable:true,...patch});
function accepted(n:number,group=n,patch:Partial<Extract<FreshnessFact,{kind:'accepted'}>>={}):FreshnessFact {
  return {version:1,kind:'accepted',group,time:n,source:source(n),binding:binding(n),pixelKey:`pixels-${n}`,
    fieldRevision:`fields-${n}`,requiresProof:true,...patch};
}
function rejected(n:number,group=n,patch:Partial<Extract<FreshnessFact,{kind:'rejected'}>>={}):FreshnessFact {
  return {version:1,kind:'rejected',group,time:n,source:source(n),binding:binding(n),pixelKey:`pixels-${n}`,...patch};
}
function identity(n:number,id=`card-${n}`,patch:Partial<Extract<FreshnessFact,{kind:'identity-linked'}>>={}):FreshnessFact {
  return {version:1,kind:'identity-linked',binding:binding(n),source:source(n),pixelKey:`pixels-${n}`,id,review:[],...patch};
}
function tracker(groups=2048,facts=20_000){
  const proofs=new Map<string,number>(),events:FreshnessFact[]=[];
  const evidence=new FreshnessEvidence(seed(groups,facts),{confirmedFields:()=>proofs,onEvent:fact=>{events.push(fact);}});
  return {proofs,events,evidence};
}
async function checkpoint(evidence:FreshnessEvidence){
  const snapshot=evidence.snapshot();
  return {version:1 as const,complete:snapshot.complete,events:snapshot.facts,
    hash:snapshot.complete?await hashFreshnessEvidence(snapshot):null};
}

test('a clean identity alone does not settle fields and count equality is not an input',()=>{
  const {evidence,proofs}=tracker();
  evidence.apply(accepted(1));evidence.apply(identity(1));
  assert.equal(evidence.settle(),1);
  proofs.set('another-card',999999);
  assert.deepEqual(evidence.guard('capture'),{unresolved:1,settled:false});
  assert.throws(()=>evidence.apply({version:1,kind:'settle',resolved:true}),/property/);
  proofs.set('card-1',100);
  assert.deepEqual(evidence.guard('capture'),{unresolved:0,settled:true});
});

test('the actual inventory reducer keeps null distinct from explicit zero fields',()=>{
  const inventory=new InventoryEvidence();
  const evidence=new FreshnessEvidence(seed(),{confirmedFields:()=>inventory.confirmedFieldOrder});
  const s:InventorySource={...source(1),frame:binding(1).frame};
  const card=(awakening:number|null,extraCopies:number|null):ScannedCard=>({id:'card-1',name:'검증 카드',
    awakening,extraCopies,confidence:1,review:[],image:'',time:1,observations:1,captureOrder:100,countReliable:true,
    capturePosition:{frame:s.frame,slot:s.slot,stable:true,sort:null}});
  evidence.apply(accepted(1));evidence.apply(identity(1));inventory.acceptIdentity(s,'card-1');
  inventory.recordObservation(s,card(0,null),1);
  assert.equal(evidence.settle(),1,'null additional copies cannot make a proof order');
  inventory.recordObservation(s,card(null,0),1);
  assert.equal(evidence.settle(),1,'null awakening cannot make a joint proof order');
  inventory.recordObservation(s,card(0,0),1);
  assert.equal(evidence.settle(),0,'explicit 0 awakening and 0 copies are valid evidence');
});

test('uncertain identity cannot borrow another fully confirmed field order',()=>{
  const {evidence,proofs}=tracker();
  evidence.apply(accepted(1));proofs.set('card-1',1000);
  assert.equal(evidence.settle(),1,'fieldRevision and pixel keys never identify the card');
  evidence.apply(identity(1,'card-1',{review:['이름 확인']}));
  assert.equal(evidence.settle(),1,'a fuzzy candidate remains unresolved');
  evidence.apply(identity(1));assert.equal(evidence.settle(),0);
});

test('newer changed fields replace old debt while delayed old proof cannot clear the replacement',()=>{
  const {evidence,proofs}=tracker();
  evidence.apply(accepted(1,7));evidence.apply(identity(1));proofs.set('card-1',100);
  evidence.apply(accepted(2,7));evidence.apply(identity(2,'card-1'));
  assert.equal(evidence.settle(),1);
  assert.equal(evidence.hasBinding(binding(1).key),false,'an unreferenced old completion is outside current debt authority');
  assert.equal(evidence.settle(),1,'old retained observation cannot stand for newer source');
  proofs.set('card-1',200);assert.equal(evidence.settle(),0);
});

test('an older acceptance or rejection cannot replace a newer accepted representative',()=>{
  const {evidence}=tracker();evidence.apply(accepted(3,1));
  evidence.apply(accepted(1,1));evidence.apply(rejected(2,1));
  assert.equal(evidence.snapshot().accepted[0].pixelKey,'pixels-3');
  assert.equal(evidence.snapshot().pending[0].bindingKey,binding(3).key);
  assert.equal(evidence.hasBinding(binding(1).key),false);
  assert.equal(evidence.hasBinding(binding(2).key),false);
});

test('rejected exact observation keeps debt without committing rejected pixels',()=>{
  const {evidence,proofs}=tracker();evidence.apply(accepted(1,1));evidence.apply(identity(1));proofs.set('card-1',100);
  evidence.apply(rejected(2,1));
  assert.equal(evidence.snapshot().accepted[0].pixelKey,'pixels-1');
  assert.equal(evidence.settle(),1);
  evidence.apply(identity(2,'card-1',{source:source(3,{phase:'recovery',captureOrder:200})}));proofs.set('card-1',200);
  assert.equal(evidence.settle(),0,'the very same logical rejected observation can be recovered');
});

test('an unidentified rejection without a retained observation remains unresolved',()=>{
  const {evidence,proofs}=tracker();evidence.apply(rejected(1,1,{binding:null}));
  proofs.set('card-1',1000000);assert.equal(evidence.settle(),1);
  evidence.apply(accepted(2,1));evidence.apply(identity(2));proofs.set('card-2',200);
  assert.equal(evidence.settle(),0,'later actual accepted fields can replace that debt');
});

test('a newer pending rejection ignores an older rejected source without leaking lineages',()=>{
  const {evidence}=tracker();evidence.apply(rejected(3,1));evidence.apply(rejected(2,1));
  assert.equal(evidence.snapshot().pending[0].bindingKey,binding(3).key);
  assert.equal(evidence.snapshot().lineages.length,1);
  assert.equal(evidence.hasBinding(binding(2).key),false);
});

test('same logical observation can have distinct source tuples and changed opaque cache keys',()=>{
  const {evidence,proofs}=tracker(),first=binding(1);
  evidence.apply(accepted(1));evidence.apply(identity(1));proofs.set('card-1',100);
  evidence.apply(accepted(2,1,{binding:first,source:source(2,{captureOrder:100}),pixelKey:'new-cache-local-key'}));
  assert.equal(evidence.snapshot().lineages.length,1);
  assert.equal(evidence.snapshot().lineages[0].identity?.source.observationId,'observation-1');
  assert.equal(evidence.snapshot().lineages[0].identity?.pixelKey,'pixels-1');
  assert.equal(evidence.snapshot().pending[0].pixelKey,'new-cache-local-key');
  assert.equal(evidence.settle(),0,'explicit exact lineage retains original proof order, not latest-use time');
  evidence.apply(identity(1,'card-1',{source:source(3,{phase:'recovery',captureOrder:100}),pixelKey:'reacquired-key'}));
  assert.equal(evidence.snapshot().lineages[0].identity?.source.observationId,'observation-3');
  assert.equal(evidence.snapshot().lineages[0].identity?.pixelKey,'reacquired-key');
});

test('same group, frame string, order, and pixel label do not create shared observation identity',()=>{
  const {evidence,proofs}=tracker();evidence.apply(accepted(1,1));evidence.apply(identity(1));proofs.set('card-1',1000);
  const different=binding(1,{key:'different-object'});
  evidence.apply(accepted(2,1,{binding:different,source:source(2,{captureOrder:100}),pixelKey:'pixels-1'}));
  assert.equal(evidence.settle(),1,'binding identity must be explicit, not inferred from matching metadata');
});

test('immutable source alias mismatch fails closed and cannot certify settled state',()=>{
  const {evidence}=tracker();evidence.apply(accepted(1));
  assert.throws(()=>evidence.apply(identity(1,'card-1',{source:source(1,{slot:9})})),/source alias/);
  assert.equal(evidence.snapshot().lostChange,true);
  assert.equal(evidence.snapshot().complete,false);
  assert.ok(evidence.snapshot().losses.includes('association-conflict'));
});

test('a source alias cannot silently change its logical observation binding',()=>{
  const {evidence}=tracker();evidence.apply(accepted(1));
  assert.throws(()=>evidence.apply(accepted(1,2,{binding:binding(1,{key:'another-key'})})),/source alias/);
});

test('binding key metadata is immutable even when used by a new source',()=>{
  for(const patch of [{order:101},{frame:'different-frame'},{stable:false}]){
    const {evidence}=tracker();evidence.apply(accepted(1));
    const altered=binding(1,patch);
    assert.throws(()=>evidence.apply(accepted(2,1,{binding:altered,source:source(2,{captureOrder:altered.order})})),/binding changed/);
    assert.equal(evidence.snapshot().complete,false);
  }
});

test('binding capture order cannot borrow an earlier proof through a later source tuple',()=>{
  for(const kind of ['accepted','rejected','identity-linked'] as const){
    const {evidence,proofs}=tracker();proofs.set('card-1',0);
    if(kind==='identity-linked')evidence.apply(accepted(1));
    const badBinding=binding(1,{order:0});
    const fact=kind==='accepted'?accepted(1,1,{binding:badBinding}):kind==='rejected'?rejected(1,1,{binding:badBinding}):identity(1,'card-1',{binding:badBinding});
    assert.throws(()=>evidence.apply(fact),/capture order mismatch/);
    assert.equal(evidence.snapshot().complete,false);
  }
});

test('untracked identity and a different session fail instead of fabricating a binding',()=>{
  const {evidence}=tracker();
  assert.throws(()=>evidence.apply(identity(1)),/no retained binding/);
  const other=tracker().evidence;
  assert.throws(()=>other.apply(accepted(1,1,{source:source(1,{sessionId:'another-session'})})),/session/);
});

test('unresolved eviction is sticky and all retained metadata remains bounded',()=>{
  const {evidence,proofs}=tracker(2);
  for(let n=1;n<=12;n++)evidence.apply(accepted(n));
  let snapshot=evidence.snapshot();
  assert.equal(snapshot.accepted.length,2);assert.equal(snapshot.pending.length,2);
  assert.ok(snapshot.lineages.length<=4);assert.equal(snapshot.lostChange,true);
  assert.equal(evidence.hasBinding(binding(1).key),false);
  for(let n=11;n<=12;n++){evidence.apply(identity(n));proofs.set(`card-${n}`,n*100);}
  assert.equal(evidence.settle(),1,'later good observations cannot erase lost earlier debt');
  snapshot=evidence.snapshot();assert.equal(snapshot.pending.length,0);
});

test('a resolved entry evicted before explicit settlement does not create false loss',()=>{
  const {evidence,proofs}=tracker(1);
  evidence.apply(accepted(1));evidence.apply(identity(1));proofs.set('card-1',100);
  evidence.apply(accepted(2));
  assert.equal(evidence.snapshot().lostChange,false);
  assert.equal(evidence.hasBinding(binding(1).key),false);
  assert.equal(evidence.settle(),1);
});

test('snapshot and hash preserve lazy debt until an ordered settlement command',async()=>{
  const {evidence,proofs}=tracker();evidence.apply(accepted(1));evidence.apply(identity(1));proofs.set('card-1',100);
  const before=evidence.snapshot(),hash=await hashFreshnessEvidence(before);
  assert.equal(before.pending.length,1);assert.equal(evidence.snapshot().pending.length,1);
  assert.equal(await hashFreshnessEvidence(evidence.snapshot()),hash);
  assert.equal(evidence.settle(),0);
  assert.notEqual(await hashFreshnessEvidence(evidence.snapshot()),hash);
});

test('guard facts must agree with recomputed actual debt and never accept count-only completion',()=>{
  const {evidence}=tracker();evidence.apply(accepted(1));
  assert.throws(()=>evidence.apply({version:1,kind:'guard-check',guard:'capture',unresolved:0,settled:true}),/guard disagrees/);
  const valid=tracker();valid.evidence.apply(accepted(1));
  assert.deepEqual(valid.evidence.guard('recovery'),{unresolved:1,settled:false});
  assert.equal(valid.evidence.snapshot().guards[0].guard,'recovery');
});

test('fact and sink recording failures leave live state transitions running but incomplete',()=>{
  const limited=tracker(2,2);limited.evidence.apply(accepted(1));limited.evidence.apply(identity(1));
  limited.proofs.set('card-1',100);assert.equal(limited.evidence.settle(),0);
  assert.equal(limited.events.length,2);assert.equal(limited.evidence.snapshot().facts,3);
  assert.equal(limited.evidence.snapshot().complete,false);
  assert.deepEqual(limited.evidence.snapshot().losses,['fact-limit']);
  let calls=0;
  const failed=new FreshnessEvidence(seed(),{confirmedFields:()=>new Map(),onEvent:()=>{calls++;throw Error('disk failed');},onIncomplete:()=>{throw Error('sink failed too');}});
  assert.doesNotThrow(()=>failed.apply(accepted(1)));
  assert.equal(failed.settle(),1);assert.equal(calls,1);assert.equal(failed.snapshot().complete,false);
  assert.deepEqual(failed.snapshot().losses,['event-sink-failed']);
});

test('false event-sink receipt is incomplete and cannot certify a full checkpoint',async()=>{
  const evidence=new FreshnessEvidence(seed(),{confirmedFields:()=>new Map(),onEvent:()=>false});
  evidence.guard('final');assert.deepEqual(await checkpoint(evidence),{version:1,complete:false,events:1,hash:null});
});

test('strict facts reject accessors, sparse/oversized reviews, unknown fields and malformed source values',()=>{
  let invoked=0;
  const accessor={...accepted(1)};
  Object.defineProperty(accessor,'kind',{enumerable:true,get(){invoked++;return 'accepted';}});
  assert.throws(()=>parseFreshnessFact(accessor),/data property/);assert.equal(invoked,0);
  const sourceAccessor={...source(1)};
  Object.defineProperty(sourceAccessor,'captureTime',{enumerable:true,get(){invoked++;return 1;}});
  assert.throws(()=>parseFreshnessFact({...accepted(1),source:sourceAccessor}),/data property/);assert.equal(invoked,0);
  const bad=[{...accepted(1),resolved:true},{...accepted(1),time:NaN},{...accepted(1),pixelKey:'x'.repeat(1025)},
    {...accepted(1),source:source(1,{slot:40})},{...accepted(1),source:source(1,{captureTime:2})},
    {...accepted(1),requiresProof:1},{...identity(1),review:Array(1)},{...identity(1),review:['x'.repeat(257)]},
    {...identity(1),review:Array(17).fill('')},{...identity(1),id:''},
    {...accepted(1),binding:{...binding(1),order:Infinity}}];
  for(const fact of bad)assert.throws(()=>parseFreshnessFact(fact));
});

test('strict seeds and checkpoints cannot normalize unknown/oversized or partial data into complete',()=>{
  assert.deepEqual(parseFreshnessSeed(seed()).limits,FRESHNESS_EVIDENCE_LIMITS);
  for(const value of [seed(0),seed(2049),seed(1,20_001),{...seed(),version:2},{...seed(),sessionId:''}])
    assert.throws(()=>parseFreshnessSeed(value));
  for(const value of [{version:1,complete:true,events:0,hash:null},
    {version:1,complete:false,events:0,hash:'a'.repeat(64)},
    {version:1,complete:1,events:0,hash:null},{version:1,complete:false,events:-1,hash:null}])
    assert.throws(()=>parseFreshnessCheckpoint(value));
});

test('ordered replay matches the common live state and exact captured checkpoint',async()=>{
  const live=tracker();live.evidence.apply(accepted(1));live.evidence.apply(identity(1));
  live.proofs.set('card-1',100);live.evidence.guard('final');
  const replay=new FreshnessEvidenceReplay(AbortSignal.timeout(5000),()=>live.proofs);
  replay.seed(seed());for(const fact of live.events)replay.accept(fact);
  replay.checkpoint(await checkpoint(live.evidence));const result=await replay.summary();
  assert.equal(result.complete,true);assert.equal(result.matchesCapturedState,true);
  assert.equal(result.unresolved,0);assert.equal(result.events,live.events.length);
});

test('later inventory proof events invalidate a checkpoint without silently settling snapshot state',async()=>{
  const live=tracker();live.evidence.apply(accepted(1));live.evidence.apply(identity(1));
  const replay=new FreshnessEvidenceReplay(AbortSignal.timeout(5000),()=>live.proofs);
  replay.seed(seed());for(const fact of live.events)replay.accept(fact);
  replay.checkpoint(await checkpoint(live.evidence));assert.equal((await replay.summary()).matchesCapturedState,true);
  live.proofs.set('card-1',100);replay.proofsChanged();
  const changed=await replay.summary();assert.equal(changed.complete,false);assert.equal(changed.matchesCapturedState,null);
  assert.equal(changed.pending,1,'no unrecorded implicit settlement from hashing');
});

test('later freshness fact invalidates a checkpoint even if state is otherwise unchanged',async()=>{
  const live=tracker();live.evidence.guard('final');
  const replay=new FreshnessEvidenceReplay(AbortSignal.timeout(5000),()=>live.proofs);
  replay.seed(seed());replay.accept(live.events[0]);replay.checkpoint(await checkpoint(live.evidence));
  replay.accept({version:1,kind:'settle'});assert.equal((await replay.summary()).complete,false);
});

test('proof updates during asynchronous summary hashing cannot return a stale complete match',async()=>{
  const live=tracker();live.evidence.guard('final');
  const replay=new FreshnessEvidenceReplay(AbortSignal.timeout(5000),()=>live.proofs);
  replay.seed(seed());replay.accept(live.events[0]);replay.checkpoint(await checkpoint(live.evidence));
  const pending=replay.summary();replay.proofsChanged();
  const result=await pending;assert.equal(result.complete,false);assert.equal(result.matchesCapturedState,null);
});

test('missing inventory seed, duplicate freshness seed and truncated checkpoint are rejected',async()=>{
  const noInventory=new FreshnessEvidenceReplay(AbortSignal.timeout(5000),()=>{throw Error('inventory seed absent');});
  assert.throws(()=>noInventory.seed(seed()),/inventory seed absent/);
  const noSeed=new FreshnessEvidenceReplay(AbortSignal.timeout(5000),()=>new Map());
  assert.throws(()=>noSeed.accept(accepted(1)),/시작 상태 없이/);
  const duplicate=new FreshnessEvidenceReplay(AbortSignal.timeout(5000),()=>new Map());
  duplicate.seed(seed());assert.throws(()=>duplicate.seed(seed()),/중복/);
  const truncated=new FreshnessEvidenceReplay(AbortSignal.timeout(5000),()=>new Map());
  truncated.seed(seed());truncated.accept({version:1,kind:'settle'});
  assert.throws(()=>truncated.checkpoint({version:1,complete:true,events:2,hash:'a'.repeat(64)}),/이벤트 수 불일치/);
  await assert.rejects(truncated.summary(),/유효하지 않은/);
});

test('legacy unsupported channel and partial recording are never reported as complete matches',async()=>{
  const empty=new FreshnessEvidenceReplay(AbortSignal.timeout(5000),()=>new Map());
  const unsupported=await empty.summary();assert.equal(unsupported.supported,false);assert.equal(unsupported.matchesCapturedState,null);
  const live=tracker(1,1);live.evidence.guard('capture');live.evidence.guard('final');
  const partial=new FreshnessEvidenceReplay(AbortSignal.timeout(5000),()=>live.proofs);
  partial.seed(seed(1,1));partial.accept(live.events[0]);partial.checkpoint(await checkpoint(live.evidence));
  const result=await partial.summary();assert.equal(result.supported,true);assert.equal(result.complete,false);
  assert.equal(result.expectedHash,null);assert.equal(result.matchesCapturedState,null);
});

test('100000 no-op UI queries keep the fact budget and only real lazy retirement emits settlement',()=>{
  const {evidence,proofs,events}=tracker();evidence.apply(accepted(1));evidence.apply(identity(1));
  const before=evidence.snapshot().facts;
  for(let i=0;i<50_000;i++)assert.equal(evidence.settle(),1);
  assert.equal(evidence.snapshot().facts,before);assert.equal(events.length,before);
  proofs.set('card-1',100);assert.equal(evidence.settle(),0);
  assert.equal(evidence.snapshot().facts,before+1);assert.equal(events.at(-1)?.kind,'settle');
  for(let i=0;i<50_000;i++)assert.equal(evidence.settle(),0);
  assert.equal(evidence.snapshot().facts,before+1);assert.equal(events.length,before+1);
});
