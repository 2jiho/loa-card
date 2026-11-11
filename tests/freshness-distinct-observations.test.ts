import {test} from 'node:test';
import assert from 'node:assert/strict';
import {FreshObservations} from '../src/features/card-scanner/session/fresh-observation';
import {FreshnessEvidence} from '../src/features/card-scanner/session/freshness-evidence';
import {FRESHNESS_EVIDENCE_LIMITS} from '../src/features/card-scanner/session/freshness-evidence-types';
import {FreshnessObservationBridge} from '../src/features/card-scanner/session/freshness-observation-bridge';
import {InventoryEvidence} from '../src/features/card-scanner/session/inventory-evidence';
import type {InventorySource} from '../src/features/card-scanner/session/inventory-evidence';
import {FreshnessEvidenceReplay} from '../src/features/card-scanner/reproduction/freshness-evidence-replay';
import {hashFreshnessEvidence} from '../src/features/card-scanner/session/freshness-evidence';
import type {FreshnessFact} from '../src/features/card-scanner/session/freshness-evidence-types';
import {resolvedSavedObservation,type SavedObservation} from '../src/features/card-scanner/acquisition/saved-acquisition';
import type {ScannedCard} from '../src/features/card-scanner/recognition/recognizer';

test('different inputs in the same fuzzy group cannot retire an unidentified earlier input',()=>{
  const inventory=new InventoryEvidence();
  const evidence=new FreshnessEvidence({version:2,sessionId:'distinct',limits:FRESHNESS_EVIDENCE_LIMITS},
    {confirmedFields:()=>inventory.confirmedFieldOrder});
  const bridge=new FreshnessObservationBridge(evidence);
  const fresh=new FreshObservations<SavedObservation>(2048,value=>resolvedSavedObservation(value,inventory.confirmedFieldOrder),bridge);
  const source=(n:number):InventorySource=>({sessionId:'distinct',frameId:n,observationId:`obs-${n}`,
    captureOrder:n*100,captureTime:n,phase:'input',slot:0,frame:`view-${n}`});
  const a=source(1),b=source(2);
  const first:SavedObservation={order:a.captureOrder,frame:a.frame,stable:true};
  const second:SavedObservation={order:b.captureOrder,frame:b.frame,stable:true};
  bridge.use(first,'first-pixels',a);fresh.remember(7,'first-pixels',1,first,'first-fields',true);
  fresh.finish(first);
  assert.equal(fresh.unresolvedChanges(),1);
  bridge.use(second,'second-pixels',b);fresh.remember(7,'second-pixels',2,second,'second-fields',true);
  second.identity={id:'b',name:'카드 B',confidence:1,nameEvidence:[],review:[],identitySource:'dictionary',maxAwakening:5};
  bridge.linkIdentity(second,b,'second-pixels');inventory.acceptIdentity(b,'b');
  const card:ScannedCard={id:'b',name:'카드 B',awakening:0,extraCopies:1,countReliable:true,
    confidence:1,review:[],image:'',time:2,observations:1,captureOrder:200,
    capturePosition:{frame:b.frame,slot:0,stable:true,sort:null}};
  inventory.recordObservation(b,card,1);fresh.finish(second);
  assert.equal(fresh.unresolvedChanges(),1,'group reuse does not prove the earlier source was card B');
  assert.equal(evidence.guard('capture').settled,false);
  first.identity={id:'a',name:'카드 A',confidence:1,nameEvidence:[],review:[],identitySource:'dictionary',maxAwakening:5};
  bridge.linkIdentity(first,a,'first-pixels');inventory.acceptIdentity(a,'a');
  inventory.recordObservation(a,{...card,id:'a',name:'카드 A',time:1,captureOrder:100,
    capturePosition:{frame:a.frame,slot:0,stable:true,sort:null}},1);
  assert.equal(fresh.unresolvedChanges(),0,'actual field proof for the retained first source resolves it');
});

function factSource(n:number){return {sessionId:'policy',frameId:n,observationId:`use-${n}`,captureOrder:n*100,captureTime:n,phase:'input' as const,slot:0};}
function fact(n:number){return {version:1 as const,kind:'accepted' as const,group:7,time:n,source:factSource(n),
 binding:{key:`binding-${n}`,order:n*100,frame:`frame-${n}`,stable:true},pixelKey:`pixels-${n}`,fieldRevision:null,requiresProof:true};}
function linked(n:number){return {version:1 as const,kind:'identity-linked' as const,binding:fact(n).binding,source:factSource(n),pixelKey:`pixels-${n}`,id:`card-${n}`,review:[]};}

test('version 2 retains late older input and keeps the newer accepted representative',()=>{
 const proof=new Map<string,number>(),evidence=new FreshnessEvidence({version:2,sessionId:'policy',limits:FRESHNESS_EVIDENCE_LIMITS},{confirmedFields:()=>proof});
 evidence.apply(fact(2));evidence.apply(fact(1));
 assert.equal(evidence.snapshot().accepted[0].bindingKey,'binding-2');
 assert.equal(evidence.guard('capture').unresolved,2);
 evidence.apply(linked(2));proof.set('card-2',200);
 assert.equal(evidence.guard('capture').unresolved,1);
 evidence.apply(linked(1));proof.set('card-1',100);
 assert.equal(evidence.guard('capture').unresolved,0);
});

test('exact same logical binding is one pending debt even with a new use',()=>{
 const proof=new Map<string,number>(),evidence=new FreshnessEvidence({version:2,sessionId:'policy',limits:FRESHNESS_EVIDENCE_LIMITS},{confirmedFields:()=>proof});
 const first=fact(1),second={...first,time:2,source:{...first.source,frameId:2,observationId:'reuse-2',captureTime:2}};
 evidence.apply(first);evidence.apply(second);assert.equal(evidence.guard('capture').unresolved,1);
 evidence.apply(linked(1));proof.set('card-1',100);assert.equal(evidence.guard('capture').unresolved,0);
});

test('version 2 bounds distinct debt and records unresolved evictions',()=>{
 const evidence=new FreshnessEvidence({version:2,sessionId:'policy',limits:{groups:2,facts:100}},{confirmedFields:()=>new Map()});
 for(const n of [1,2,3])evidence.apply(fact(n));
 assert.equal(evidence.snapshot().pending.length,2);assert.equal(evidence.snapshot().lostChange,true);
 assert.equal(evidence.guard('capture').unresolved,3);
});

test('legacy v1 remains replayable while v2 records and replays distinct debts',async()=>{
 for(const version of [1,2] as const){
  const proofs=new Map<string,number>(),events:FreshnessFact[]=[];
  const seed={version,sessionId:'policy',limits:FRESHNESS_EVIDENCE_LIMITS};
  const live=new FreshnessEvidence(seed,{confirmedFields:()=>proofs,onEvent:event=>{events.push(event);}});
  live.apply(fact(1));live.apply(fact(2));live.apply(linked(2));proofs.set('card-2',200);
  assert.equal(live.guard('capture').unresolved,version===1?0:1);
  const checkpoint={version:1 as const,complete:true,events:events.length,hash:await hashFreshnessEvidence(live.snapshot())};
  const replay=new FreshnessEvidenceReplay(AbortSignal.timeout(5000),()=>proofs);
  replay.seed(seed);for(const event of events)replay.accept(event);replay.checkpoint(checkpoint);
  assert.equal((await replay.summary()).matchesCapturedState,true,`version ${version}`);
 }
});
