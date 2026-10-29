import test from 'node:test';
import assert from 'node:assert/strict';
import {FreshObservations} from '../src/features/card-scanner/fresh-observation';
import {FreshnessEvidence} from '../src/features/card-scanner/freshness-evidence';
import {FRESHNESS_EVIDENCE_LIMITS} from '../src/features/card-scanner/freshness-evidence-types';
import {FreshnessObservationBridge} from '../src/features/card-scanner/freshness-observation-bridge';
import {InventoryEvidence} from '../src/features/card-scanner/inventory-evidence';
import type {InventorySource} from '../src/features/card-scanner/inventory-evidence';
import type {SavedObservation} from '../src/features/card-scanner/saved-acquisition';
import {resolvedSavedObservation} from '../src/features/card-scanner/saved-acquisition';
import type {ScannedCard} from '../src/features/card-scanner/recognizer';

function source(order=100,time=1,frameId=1):InventorySource {
  return {sessionId:'bridge',frameId,observationId:`use-${frameId}`,captureOrder:order,captureTime:time,
    phase:'input',slot:0,frame:`logical-${order}`};
}
const identity:NonNullable<SavedObservation['identity']>={id:'known',name:'검증 카드',confidence:1,
  nameEvidence:[],review:[],identitySource:'dictionary',maxAwakening:5};
function fields(input:InventorySource,extraCopies:number|null):ScannedCard {
  return {id:identity.id,name:identity.name,awakening:0,extraCopies,countReliable:extraCopies!==null,
    confidence:1,review:extraCopies===null?['장수 확인']:[],image:'',time:input.captureTime,observations:1,
    captureOrder:input.captureOrder,capturePosition:{frame:input.frame,slot:input.slot,stable:true,sort:null}};
}
function setup(groups=2048) {
  const inventory=new InventoryEvidence();
  const evidence=new FreshnessEvidence({version:1,sessionId:'bridge',limits:{...FRESHNESS_EVIDENCE_LIMITS,groups}},
    {confirmedFields:()=>inventory.confirmedFieldOrder});
  const bridge=new FreshnessObservationBridge(evidence);
  const fresh=new FreshObservations<SavedObservation>(groups,value=>resolvedSavedObservation(value,inventory.confirmedFieldOrder),bridge);
  return {inventory,evidence,bridge,fresh};
}

test('live bridge uses actual inventory proof: name, reader finish and null do not establish observed zero',()=>{
  const {inventory,evidence,bridge,fresh}=setup(),input=source(),observation:SavedObservation={order:100,frame:input.frame,stable:true};
  bridge.use(observation,'pixels-a',input);fresh.remember(1,'pixels-a',1,observation,'fields-a',true);
  assert.equal(fresh.unresolvedChanges(),1);
  observation.identity=identity;bridge.linkIdentity(observation,input,'pixels-a');inventory.acceptIdentity(input,identity.id);
  fresh.finish(observation);
  inventory.recordObservation(input,fields(input,null),1);
  assert.equal(fresh.unresolvedChanges(),1,'a finished read and a null count leave source debt');
  inventory.recordObservation(input,fields(input,0),1);
  assert.equal(fresh.unresolvedChanges(),0,'actual reliable zero is current field proof');
  assert.deepEqual(evidence.guard('capture'),{unresolved:0,settled:true});
});

test('new fields retain debt after a late old result and queue replacement completion',()=>{
  const {inventory,bridge,fresh}=setup(),aSource=source(),bSource=source(110,2,2);
  const a:SavedObservation={order:100,frame:aSource.frame,stable:true};
  const b:SavedObservation={order:110,frame:bSource.frame,stable:true};
  bridge.use(a,'a',aSource);fresh.remember(1,'a',1,a,'fields-a',true);
  a.identity=identity;bridge.linkIdentity(a,aSource,'a');inventory.acceptIdentity(aSource,identity.id);
  inventory.recordObservation(aSource,fields(aSource,0),1);
  assert.equal(fresh.unresolvedChanges(),0);
  bridge.use(b,'b',bSource);fresh.remember(1,'b',2,b,'fields-b',true);
  fresh.finish(a);fresh.finish(b);bridge.linkIdentity(a,aSource,'a');
  assert.equal(fresh.unresolvedChanges(),1);
  b.identity=identity;bridge.linkIdentity(b,bSource,'b');
  inventory.acceptIdentity(bSource,identity.id);
  assert.equal(fresh.unresolvedChanges(),1,'clean new identity alone does not borrow old count');
  inventory.recordObservation(bSource,fields(bSource,1),1);
  assert.equal(fresh.unresolvedChanges(),0);
});

test('exact cached object reuse preserves original binding and actual read source across opaque pixel-key changes',()=>{
  const {inventory,evidence,bridge,fresh}=setup(1),original=source(),next=source(110,2,2);
  const a:SavedObservation={order:100,frame:original.frame,stable:true};
  bridge.use(a,'cache-before',original);fresh.remember(1,'cache-before',1,a,'fields-before',true);
  a.identity=identity;bridge.linkIdentity(a,original,'cache-before');inventory.acceptIdentity(original,identity.id);
  inventory.recordObservation(original,fields(original,0),1);
  assert.equal(fresh.unresolvedChanges(),0);
  const b:SavedObservation={order:110,frame:next.frame,stable:true};
  bridge.use(b,'b',next);fresh.remember(2,'b',2,b,'fields-b',true);
  b.identity=identity;bridge.linkIdentity(b,next,'b');inventory.acceptIdentity(next,identity.id);
  inventory.recordObservation(next,fields(next,1),1);
  assert.equal(fresh.unresolvedChanges(),0);
  const reused={...source(100,3,3),frame:original.frame};
  bridge.use(a,'cache-after',reused);fresh.remember(3,'cache-after',3,a,'fields-after',true);
  assert.equal(fresh.unresolvedChanges(),0);
  const lineage=evidence.snapshot().lineages[0];
  assert.equal(lineage.binding.order,100);
  assert.equal(lineage.identity?.source.observationId,original.observationId);
  assert.equal(lineage.identity?.pixelKey,'cache-before','a prior read must not be attributed the new cache key');
});

test('rejected crop keeps debt without committing accepted pixels and can resolve through its retained exact object',()=>{
  const {inventory,evidence,bridge,fresh}=setup(),input=source(),observation:SavedObservation={order:100,frame:input.frame,stable:false};
  bridge.use(observation,'rejected',input);fresh.rejectChanged(4,1,observation);
  assert.equal(evidence.snapshot().accepted.length,0);
  assert.equal(fresh.unresolvedChanges(),1);
  observation.identity=identity;
  const readSource:InventorySource={...input,frameId:9,observationId:'recovery-use',phase:'recovery'};
  bridge.linkIdentity(observation,readSource,'reacquired-cache-key');
  inventory.acceptIdentity(readSource,identity.id);inventory.recordObservation(readSource,fields(readSource,0),1);
  assert.equal(fresh.unresolvedChanges(),0);
});
