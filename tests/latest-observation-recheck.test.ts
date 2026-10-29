import {test} from 'node:test';
import assert from 'node:assert/strict';
import {CaptureObservations} from '../src/features/card-scanner/capture-quality';
import {FreshObservations} from '../src/features/card-scanner/fresh-observation';
import {needsLatestSavedProof,resolvedSavedObservation,type SavedObservation} from '../src/features/card-scanner/saved-acquisition';
import {CardReadAttempts,CardReadTimeout} from '../src/features/card-scanner/card-read-budget';
import {countReliability} from '../src/features/card-scanner/count-confidence';
import {confirmedReadingCount} from '../src/features/card-scanner/recovery-completion';
import {CURRENT_FIELD_REVIEW,pendingScanFields,projectCurrentScanFields} from '../src/features/card-scanner/current-scan-fields';
import type {ScannedCard} from '../src/features/card-scanner/recognizer';

function setup(){
  const observation={order:10,frame:'capture/1',stable:true,identity:{id:'card',review:[]}} as unknown as SavedObservation;
  const groups=new CaptureObservations(),fresh=new FreshObservations<SavedObservation>();
  const pixels=new Uint8Array(3240).fill(10),bad=new Uint8Array(3240).fill(40);
  const goodGroup=groups.offerDetailed(pixels,2,10,true).id;
  fresh.remember(goodGroup,'exact-good',1,observation);fresh.finish(observation);
  const failedGroup=groups.offerDetailed(bad,2,10,true).id;
  assert.notEqual(failedGroup,goodGroup);
  const latest=new Map([['card',20]]),confirmed=new Map([['card',10]]);
  const resolved=(o:SavedObservation)=>resolvedSavedObservation(o,confirmed);
  const needs=(o:SavedObservation)=>needsLatestSavedProof(o,latest,confirmed);
  return {observation,groups,fresh,pixels,goodGroup,latest,confirmed,resolved,needs};
}

test('a good earlier group can supply a genuinely new stable proof after a later failed group',()=>{
  const s=setup();
  const again=s.groups.offerDetailed(s.pixels,2,10,true);
  assert.equal(again.id,s.goodGroup);assert.equal(again.decision,'duplicate');
  const card={id:'card',awakening:0,extraCopies:0,countReliable:true,review:[]} as unknown as ScannedCard;
  const completion=()=>confirmedReadingCount({cards:[card],latest:s.latest,confirmed:s.confirmed});
  assert.equal(completion(),0,'the old zero does not certify the newer failed capture');
  const plan=s.fresh.retryPlan(s.goodGroup,'exact-good',2,true,s.resolved,s.needs);
  assert.equal(plan?.reason,'latest-proof');assert.equal(plan?.exactConfirmed,s.observation);
  const incoming={...s.observation,order:30,frame:'capture/3'};
  s.fresh.remember(s.goodGroup,'exact-good',2,incoming);
  assert.equal(s.fresh.retryPlan(s.goodGroup,'exact-good',3,true,s.resolved,s.needs),undefined,'pending recheck cannot be enqueued twice');
  const reliability=countReliability({stable:true,borderAlignment:.7,awakening:0,extraCopies:0,iconPresent:false});
  assert.equal(reliability,'stable-frame');
  s.latest.set('card',30);s.confirmed.set('card',30);s.fresh.finish(incoming);
  assert.equal(completion(),1);
  assert.equal(s.fresh.retryPlan(s.goodGroup,'exact-good',3,true,s.resolved,s.needs),undefined,'a current proof does not keep reopening');
});

test('same-frame, unstable and changed-pixel observations cannot borrow an exact confirmed identity',()=>{
  const s=setup();
  assert.equal(s.fresh.retryPlan(s.goodGroup,'exact-good',1,true,s.resolved,s.needs),undefined);
  assert.equal(s.fresh.retryPlan(s.goodGroup,'exact-good',2,false,s.resolved,s.needs),undefined);
  const changed=s.fresh.retryPlan(s.goodGroup,'new-positive-counter',2,true,s.resolved,s.needs);
  assert.equal(changed?.reason,'latest-proof');
  assert.equal(changed?.exactConfirmed,undefined,'positive-count changes require normal identity and field reading');
  const incoming={order:30,frame:'capture/3',stable:true,identity:s.observation.identity};
  s.fresh.remember(s.goodGroup,'new-positive-counter',2,incoming);s.fresh.finish(incoming);
  s.latest.set('card',30);
  assert.equal(s.fresh.retryPlan(s.goodGroup,'new-positive-counter',3,true,s.resolved,s.needs),undefined,'an unresolved exact image cannot retry forever');
  assert.equal(needsLatestSavedProof({...s.observation,identity:{...s.observation.identity!,review:['이름 확인']}},s.latest,s.confirmed),false);
});

test('a verified new visual recheck is one bounded pass and never resets exhausted OCR attempts',()=>{
  const s=setup(),plan=s.fresh.retryPlan(s.goodGroup,'exact-good',2,true,s.resolved,s.needs)!;
  let now=0;const attempts=new CardReadAttempts(()=>now);
  attempts.begin('exact-good')!.finish();attempts.begin('exact-good')!.finish();
  assert.equal(attempts.begin('exact-good',false),null);
  const visual=attempts.beginVerifiedVisual(plan)!;
  assert.equal(visual.budget.remaining(),3000);
  assert.equal(attempts.beginVerifiedVisual(plan),null,'a token cannot authorize concurrent or repeated checks');
  now=3001;assert.throws(()=>visual.budget.check(),CardReadTimeout);visual.finish();
  assert.equal(attempts.begin('exact-good'),null,'OCR budget remains spent after the visual recheck');
});

test('reusing an older identified recovery crop cannot certify a newer failed field observation',()=>{
  const s=setup();
  s.confirmed.set('card',15);
  const old={id:'card',name:'기존 카드',awakening:0,extraCopies:0,countReliable:true,review:[],
    captureOrder:15,time:1.5,image:'confirmed',confidence:1,observations:1} as ScannedCard;
  const failed={...old,captureOrder:20,time:2,image:'newer-failure',extraCopies:null,countReliable:false,review:['추가 장수 확인']};
  const snapshot={latest:[...s.latest],confirmed:[...s.confirmed],card:structuredClone(old)};
  assert.equal(resolvedSavedObservation(s.observation,s.confirmed),true,'old fields can be reused after this crop identity is confirmed');
  const evidence={latest:s.latest,confirmed:s.confirmed};
  const [published]=projectCurrentScanFields([old],evidence);
  assert.equal(confirmedReadingCount({cards:[published],...evidence}),0);
  assert.ok(published.review.includes(CURRENT_FIELD_REVIEW));
  assert.equal(published.countReliable,false);
  const pending=pendingScanFields([{card:failed,borderAlignment:.8}],evidence);
  assert.equal(pending.length,1);assert.equal(pending[0].captureOrder,20);assert.equal(pending[0].image,'newer-failure');
  assert.deepEqual({latest:[...s.latest],confirmed:[...s.confirmed],card:old},snapshot,'reuse supplies no new field proof');
});
