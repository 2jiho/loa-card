import {test} from 'node:test';
import assert from 'node:assert/strict';
import {AutoCompletionDiagnostics,InputWaitSampler,autoCompletionMessage,boundedAutoCompletionDiagnostic,completionEvidenceGate} from '../src/features/card-scanner/session/auto-completion-diagnostics';
import {hasCompleteCaptureEvidence} from '../src/features/card-scanner/session/auto-completion';
import type {CaptureCompletion} from '../src/features/card-scanner/session/auto-completion';

const input=():CaptureCompletion=>({expected:1,finalExpected:1,unresolved:0,dropped:0,
 cards:[{id:'a',name:'카드',awakening:0,extraCopies:1,countReliable:true,review:[],confidence:1,image:'',time:0,observations:1}],
 latest:new Map([['a',1]]),confirmedNames:new Map([['a',1]]),confirmed:new Map([['a',1]]),inputSettled:true,headerAvailable:true,fieldChangesSettled:true});

test('diagnostic distinguishes missing inventory, unresolved fresh captures, names and fields',()=>{
 const state=input();
 for(const [changes,gate] of [
  [{dropped:1},'input-dropped'],
  [{expected:2},'inventory'],
  [{unresolved:1},'latest-observations'],
  [{fieldChangesSettled:false},'latest-observations'],
  [{confirmedNames:new Map()},'names'],
  [{confirmed:new Map()},'fields'],
  [{cards:[{...state.cards[0],extraCopies:null}]},'fields'],
 ] as const){const changed={...state,...changes};assert.equal(completionEvidenceGate(changed),gate);assert.equal(hasCompleteCaptureEvidence(changed),false);}
 assert.equal(completionEvidenceGate(state),undefined);
 assert.equal(hasCompleteCaptureEvidence(state),true);
});

test('an unavailable or invalid dropped count never reports completion',()=>{
 const state=input();
 for(const dropped of [undefined,null,-1,NaN,Infinity,1]){
  const current={...state,dropped} as CaptureCompletion;
  assert.equal(completionEvidenceGate(current),'input-dropped');
  assert.equal(hasCompleteCaptureEvidence(current),false);
 }
 assert.match(autoCompletionMessage('input-dropped'),/처음부터 다시 스캔/);
});

test('an absent freshness guard reports unresolved latest observations',()=>{
 for(const fieldChangesSettled of [undefined,null,false]){
  const current={...input(),fieldChangesSettled} as CaptureCompletion;
  assert.equal(completionEvidenceGate(current),'latest-observations');
  assert.equal(hasCompleteCaptureEvidence(current),false);
 }
});

test('diagnostic is bounded, detached and keeps failed header attempts independently',()=>{
 const tracker=new AutoCompletionDiagnostics(),state=input();
 tracker.attempted();tracker.mismatch();tracker.attempted();tracker.error();
 const result=tracker.snapshot(state,13,'latest-observations');
 assert.deepEqual(result,{gate:'latest-observations',expected:1,identities:1,names:1,fields:1,unresolved:13,
  inputPending:false,headerAvailable:true,headerAttempts:2,headerMismatches:1,headerErrors:1});
 assert.deepEqual(boundedAutoCompletionDiagnostic({...result,arbitrary:'not copied'}),result);
 assert.equal(boundedAutoCompletionDiagnostic({...result,unresolved:NaN}),undefined);
 assert.equal(boundedAutoCompletionDiagnostic({...result,gate:'unknown'}),undefined);
 const getter={...result};Object.defineProperty(getter,'fields',{get(){throw Error('must not run');}});
 assert.equal(boundedAutoCompletionDiagnostic(getter),undefined);
 assert.match(autoCompletionMessage(result.gate),/다시 (보여|넘겨) 주세요/);
});

test('early inventory diagnostic preserves unavailable freshness instead of claiming zero',()=>{
 const tracker=new AutoCompletionDiagnostics();
 const snapshot=tracker.inventory({expected:394,identities:20,names:17,fields:15,unresolved:null,inputPending:true,headerAvailable:false});
 assert.equal(snapshot.gate,'inventory');assert.equal(snapshot.unresolved,null);assert.equal(snapshot.names,17);
 assert.deepEqual(boundedAutoCompletionDiagnostic(snapshot),snapshot);
});

test('input wait diagnostics retain sampled overlapping causes without implying continuous duration',()=>{
 const tracker=new AutoCompletionDiagnostics(),sampler=new InputWaitSampler();
 assert.equal(sampler.snapshot(),undefined);
 sampler.observe({collection:true,preview:false,readers:true,acquisition:false},100);
 sampler.observe({collection:true,preview:true,readers:false,acquisition:true},400);
 sampler.observe({collection:false,preview:false,readers:false,acquisition:false},300); // clock regression is visible
 const summary=sampler.snapshot()!;
 assert.deepEqual(summary,{version:1,samples:3,dropped:0,clockErrors:1,spanMs:300,maxGapMs:300,
  collection:2,preview:1,readers:1,acquisition:1,none:1,
  current:{collection:false,preview:false,readers:false,acquisition:false}});
 const diagnostic={...tracker.snapshot(input(),0,'input'),inputWait:summary};
 assert.deepEqual(boundedAutoCompletionDiagnostic(diagnostic),diagnostic);
 assert.equal(boundedAutoCompletionDiagnostic({...diagnostic,inputWait:{...summary,samples:1}}),undefined);
 const getter={...summary.current};Object.defineProperty(getter,'readers',{get(){throw Error('must not run');}});
 assert.equal(boundedAutoCompletionDiagnostic({...diagnostic,inputWait:{...summary,current:getter}}),undefined);
 // Pre-existing recordings omit this data, rather than presenting zero waits.
 assert.equal(boundedAutoCompletionDiagnostic(tracker.snapshot(input(),0,'input'))?.inputWait,undefined);
});
