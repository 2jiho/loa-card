import {test} from 'node:test';
import assert from 'node:assert/strict';
import {AutoCompletionHold,canStopSharing,confirmedCaptureCount,stopCompletedShare} from '../src/features/card-scanner/auto-completion';
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
