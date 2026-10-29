import {test} from 'node:test';
import assert from 'node:assert/strict';
import {AutoCompletionHold,canFinishEndedCapture,canSkipCoveredOriginals,canStopSharing,confirmedCaptureCount,hasCompleteCaptureEvidence,stopCompletedShare} from '../src/features/card-scanner/auto-completion';
import type {CaptureCompletion} from '../src/features/card-scanner/auto-completion';
import {canSkipRecovery} from '../src/features/card-scanner/recovery-completion';
const input=():CaptureCompletion=>({expected:1,finalExpected:1,
 cards:[{id:'a',name:'카드',awakening:0,extraCopies:1,countReliable:true,review:[],confidence:1,image:'',time:0,observations:1}],
 latest:new Map([['a',1]]),confirmedNames:new Map([['a',1]]),confirmed:new Map([['a',1]]),inputSettled:true,headerAvailable:true});

test('auto completion finishes on a static frame after one second without new video callbacks',()=>{
 const hold=new AutoCompletionHold(),state=input();
 assert.equal(hold.observe(state,100),false);
 assert.equal(hold.observe(state,1099),false);

 assert.equal(hold.observe(state,1100),true);
});

test('unknown identities, stale proof, invalid totals and missing headers reset the hold',()=>{
 for(const change of [{expected:2},{finalExpected:2},{expected:0,finalExpected:0},{expected:1.5,finalExpected:1.5},
  {latest:new Map()},{confirmedNames:new Map()}, {inputSettled:false},{headerAvailable:false},
  {latest:new Map([['a',2]])},{confirmedNames:new Map([['a',NaN]])},{cards:[{...input().cards[0],review:['이름 확인']}]}]){
  const hold=new AutoCompletionHold(),state=input();
  hold.observe(state,0);assert.equal(hold.observe({...state,...change},900),false);
  assert.equal(hold.observe(state,1000),false);assert.equal(hold.observe(state,2000),true);
 }
});

test('unread fields keep capture open for fresh observations, even after every name is known',()=>{
 const hold=new AutoCompletionHold(),state=input();hold.observe(state,0);
 state.cards=[{...state.cards[0],awakening:null,extraCopies:null,countReliable:false,review:['각성 확인','추가 장수 확인']}];
 assert.equal(canStopSharing(state),false);
 assert.equal(hold.observe(state,1000),false);
 assert.equal(canSkipRecovery({...state,confirmed:new Map(),pending:2,unresolved:0,dropped:0,tailFresh:true}),false);
 state.cards=input().cards;
 assert.equal(hold.observe(state,1100),false);
 assert.equal(hold.observe(state,2100),true);
});

test('completion preflight keeps acquisition running for known names with unresolved latest fields',()=>{
 const state=input();
 for(const change of [
  {confirmed:new Map<string,number>()},
  {latest:new Map([['a',2]]),confirmedNames:new Map([['a',2]])},
  {confirmedNames:new Map<string,number>()},
  {cards:[{...state.cards[0],awakening:null}]},
  {cards:[{...state.cards[0],extraCopies:null}]},
  {cards:[{...state.cards[0],countReliable:false}]},
  {cards:[{...state.cards[0],awakening:4,extraCopies:10}]},
  {cards:[{...state.cards[0],review:['이름 확인']}]},
  {cards:[{...state.cards[0],review:['최신 각성·장수 확인']}]},
 ])assert.equal(hasCompleteCaptureEvidence({...state,...change}),false);
 assert.equal(hasCompleteCaptureEvidence({...state,expected:2,cards:[state.cards[0],state.cards[0]],
  latest:new Map([['a',1],['b',1]]),confirmedNames:new Map([['a',1],['b',1]]),confirmed:new Map([['a',1],['b',1]])}),false);
});

test('completion preflight permits pending duplicates but retains idle, header and hold checks',()=>{
 const state={...input(),inputSettled:false,headerAvailable:false,finalExpected:null,pending:40};
 assert.equal(hasCompleteCaptureEvidence(state),true,'ready evidence can reserve a flush without requiring an already idle queue');
 assert.equal(canStopSharing(state),false);
 assert.equal(canStopSharing({...state,inputSettled:true}),false);
 assert.equal(canStopSharing({...state,inputSettled:true,headerAvailable:true}),false);
 const verified={...state,inputSettled:true,headerAvailable:true,finalExpected:1},hold=new AutoCompletionHold();
 assert.equal(hold.observe(verified,0),false);
 assert.equal(hold.observe(verified,1000),true);
 const newer={...verified,latest:new Map([['a',2]]),confirmedNames:new Map([['a',2]])};
 assert.equal(hasCompleteCaptureEvidence(newer),false,'an accepted frame invalidates older field proof after the flush');
 assert.equal(canStopSharing(newer),false);
 assert.equal(hold.observe(newer,1001),false);
});

test('replacing a confirmed identity starts a new coverage hold',()=>{
 const hold=new AutoCompletionHold(),state=input();hold.observe(state,0);
 state.cards=[{...state.cards[0],id:'b'}];state.latest=new Map([['b',2]]);state.confirmedNames=new Map([['b',2]]);
 state.confirmed=new Map([['b',2]]);
 assert.equal(hold.observe(state,1000),false);assert.equal(hold.observe(state,2000),true);
});

test('older fields, restored proofs, zero substitutions and impossible counts cannot stop capture',()=>{
 const state=input();
 for(const confirmed of [new Map<string,number>(),new Map([['a',0]]),new Map([['a',NaN]])])
  assert.equal(canStopSharing({...state,confirmed}),false);
 for(const fields of [{extraCopies:null},{awakening:null},{countReliable:false},{awakening:4,extraCopies:10},{review:['추가 장수 확인']}])
  assert.equal(canStopSharing({...state,cards:[{...state.cards[0],...fields}]}),false);
 assert.equal(canStopSharing({...state,cards:[{...state.cards[0],extraCopies:0}]}),true,'explicitly confirmed zero remains valid');
});

test('duplicate or restored-only identities cannot certify capture',()=>{
 const state=input();
 assert.equal(canStopSharing({...state,expected:2,finalExpected:2,cards:[state.cards[0],state.cards[0]],latest:new Map([['a',1],['b',1]])}),false);
 assert.equal(canStopSharing({...state,confirmedNames:new Map()}),false);
});

test('backward clocks and explicit cancellation cannot inherit a completed hold',()=>{
 const hold=new AutoCompletionHold(),state=input();hold.observe(state,1000);
 assert.equal(hold.observe(state,0),false);hold.reset();
 assert.equal(hold.observe(state,5000),false);
 assert.equal(hold.observe(state,6000),true);
});

test('programmatic sharing completion stops all tracks and explicitly notifies without aborting',()=>{
 const events:string[]=[],controller=new AbortController();
 const stream={getTracks:()=>[{stop(){events.push('video');}},{stop(){events.push('audio');}}]} as unknown as MediaStream;
 stopCompletedShare(stream,()=>events.push('stopped'));
 assert.deepEqual(events,['video','audio','stopped']);assert.equal(controller.signal.aborted,false);
});


test('leftover observations are retained for recovery rather than preventing capture stop',()=>{
 const state={...input(),pending:12,unresolved:3,dropped:1,tailFresh:false};
 const hold=new AutoCompletionHold();
 assert.equal(hold.observe(state,0),false);
 assert.equal(hold.observe(state,1000),true);
 assert.equal(canSkipRecovery({...state,confirmed:new Map([['a',1]])}),false);
 assert.equal(confirmedCaptureCount(state),1);
 assert.equal(confirmedCaptureCount({...state,latest:new Map()}),0,'restored list must not appear as current-run coverage');
});

type EndedCaptureInput=Parameters<typeof canFinishEndedCapture>[0];
const endedInput=():EndedCaptureInput=>({...input(),inputClosed:true,headerVerified:true,
 pending:0,unresolved:5,dropped:0,tailFresh:true});

test('ended capture can skip archive replay after final verification without deleting unmatched observations',()=>{
 const state=endedInput(),before=structuredClone(state);
 assert.equal(canSkipRecovery(state),false,'unmatched observations still exist');
 assert.equal(canStopSharing(state),true,'names and latest fields have the same proof as automatic completion');
 assert.equal(canFinishEndedCapture(state),true);
 assert.deepEqual(state,before,'the exception must not rewrite diagnostics or evidence maps');
 assert.equal(canFinishEndedCapture({...state,cards:[{...state.cards[0],extraCopies:0}]}),true,'an explicitly observed zero is valid');
});

test('ended capture requires closed settled input, a fresh final header, no pending work and no dropped input',()=>{
 const state=endedInput();
 const rejected:[string,Partial<EndedCaptureInput>][]=[
  ['input still open',{inputClosed:false}],['acquisition or readers active',{inputSettled:false}],
  ['final header failed',{headerVerified:false}],['header unavailable',{headerAvailable:false}],
  ['header unread',{finalExpected:null}],['header changed',{finalExpected:2}],
  ['stale final view',{tailFresh:false}],['queued observation',{pending:1}],['lost input',{dropped:1}],
 ];
 for(const [reason,change] of rejected)assert.equal(canFinishEndedCapture({...state,...change}),false,reason);
 for(const expected of [null,0,-1,1.5,NaN,Infinity])
  assert.equal(canFinishEndedCapture({...state,expected,finalExpected:expected}),false,'invalid expected '+expected);
});

test('ended capture requires independently current name and field proof even when every card has values',()=>{
 const state=endedInput();
 for(const proof of [new Map<string,number>(),new Map([['a',0]]),new Map([['a',NaN]]),new Map([['a',Infinity]])]){
  assert.equal(canFinishEndedCapture({...state,confirmedNames:proof}),false,'missing or stale current name');
  assert.equal(canFinishEndedCapture({...state,confirmed:proof}),false,'missing or stale current fields');
 }
 assert.equal(canFinishEndedCapture({...state,latest:new Map(),confirmedNames:new Map(),confirmed:new Map()}),false,'seed inventory alone is not a scan');
 assert.equal(canFinishEndedCapture({...state,latest:new Map([['a',2]])}),false);
 assert.equal(canFinishEndedCapture({...state,latest:new Map([['a',2]]),confirmedNames:new Map([['a',2]])}),false,'a newer name does not confirm older fields');
 assert.equal(canFinishEndedCapture({...state,latest:new Map([['a',2]]),confirmed:new Map([['a',2]])}),false,'newer fields do not confirm an older name');
 assert.equal(canFinishEndedCapture({...state,latest:new Map([['a',2]]),confirmedNames:new Map([['a',2]]),confirmed:new Map([['a',2]])}),true);
});

test('ended capture refuses unconfirmed or impossible awakening and count pairs',()=>{
 const state=endedInput();
 const fields:Partial<EndedCaptureInput['cards'][number]>[]=[
  {awakening:null},{extraCopies:null},{countReliable:false},{countReliable:undefined},
  {awakening:NaN},{awakening:Infinity},{awakening:-1},{awakening:6},{awakening:1.5},
  {extraCopies:NaN},{extraCopies:Infinity},{extraCopies:-1},{extraCopies:0.5},{extraCopies:16},
  {awakening:1,extraCopies:15},{awakening:2,extraCopies:13},{awakening:3,extraCopies:10},
  {awakening:4,extraCopies:6},{awakening:5,extraCopies:1},
  {review:['이름 확인']},{review:['최신 각성·장수 확인']},
 ];
 for(const change of fields)
  assert.equal(canFinishEndedCapture({...state,cards:[{...state.cards[0],...change}]}),false,JSON.stringify(change));
});

test('ended capture rejects missing, added, duplicate and substituted identities instead of relying on count equality',()=>{
 const state=endedInput(),card=state.cards[0],other={...card,id:'b'};
 const rejected:Partial<EndedCaptureInput>[]=[
  {cards:[]},{cards:[card,other]},
  {latest:new Map([['a',1],['b',1]])},
  {cards:[other]},
  {latest:new Map([['b',1]])},
  {expected:2,finalExpected:2,cards:[card,card],latest:new Map([['a',1],['b',1]]),
   confirmedNames:new Map([['a',1],['b',1]]),confirmed:new Map([['a',1],['b',1]])},
 ];
 for(const change of rejected)assert.equal(canFinishEndedCapture({...state,...change}),false);
});

test('covered-original gate permits parallel work but cannot declare ended capture complete',()=>{
 const state={...endedInput(),metadataSettled:true,inputSettled:false,pending:80};
 assert.equal(canSkipCoveredOriginals(state),true);
 assert.equal(canFinishEndedCapture(state),false,'pending or active work still prevents completion');
 const before=structuredClone(state);canSkipCoveredOriginals(state);assert.deepEqual(state,before);
});

test('covered-original gate retains current names, fields, final header and source guards',()=>{
 const state={...endedInput(),metadataSettled:true};
 for(const change of [{inputClosed:false},{metadataSettled:false},{headerVerified:false},{headerAvailable:false},
   {tailFresh:false},{dropped:1},{finalExpected:null},{finalExpected:2},{confirmedNames:new Map<string,number>()},
   {confirmed:new Map<string,number>()},{latest:new Map([['a',2]])},
   {cards:[{...state.cards[0],extraCopies:null}]},{cards:[{...state.cards[0],awakening:4,extraCopies:10}]}])
   assert.equal(canSkipCoveredOriginals({...state,...change}),false,JSON.stringify(change));
 const latest=new Map([['a',2]]);
 assert.equal(canSkipCoveredOriginals({...state,latest,confirmedNames:latest,confirmed:latest}),true);
});
