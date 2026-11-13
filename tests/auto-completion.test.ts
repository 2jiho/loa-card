import {test} from 'node:test';
import assert from 'node:assert/strict';
import {AutoCompletionHold,canFinishEndedCapture,canSkipCoveredOriginals,canStopSharing,captureInputSettled,confirmedCaptureCount,currentHeaderAvailable,hasCompleteCaptureEvidence,stopCompletedShare} from '../src/features/card-scanner/session/auto-completion';
import type {CaptureCompletion} from '../src/features/card-scanner/session/auto-completion';
import {canSkipRecovery} from '../src/features/card-scanner/session/recovery-completion';
import {canFinishVerifiedCapture} from '../src/features/card-scanner/session/recovery-completion';
import {UnknownLifecycle} from '../src/features/card-scanner/session/unknown-lifecycle';
import {UNKNOWN_LIFECYCLE_LIMITS} from '../src/features/card-scanner/session/unknown-lifecycle-types';
import {ScanLedger} from '../src/features/card-scanner/session/scan-ledger';
const input=():CaptureCompletion=>({expected:1,finalExpected:1,unresolved:0,dropped:0,
 cards:[{id:'a',name:'카드',awakening:0,extraCopies:1,countReliable:true,review:[],confidence:1,image:'',time:0,observations:1}],
 latest:new Map([['a',1]]),confirmedNames:new Map([['a',1]]),confirmed:new Map([['a',1]]),inputSettled:true,headerAvailable:true,fieldChangesSettled:true});

test('removing preview from completion does not bypass capture, reader, source queue or evidence gates',()=>{
 const idle={collectionBusy:false,readingJobs:0,acquisitionSettled:true,queueSettled:true};
 assert.equal(captureInputSettled(idle),true);
 for(const blocked of [{collectionBusy:true},{readingJobs:1},{readingJobs:NaN},{acquisitionSettled:false},{queueSettled:false}]) {
  const state={...input(),inputSettled:captureInputSettled({...idle,...blocked})};
  assert.equal(canStopSharing(state),false);
 }
 for(const blocked of [{unresolved:1},{dropped:1},{fieldChangesSettled:false},{headerAvailable:false},
  {latest:new Map([['a',2]])},{cards:[{...input().cards[0],review:['이름 확인']}]}])
  assert.equal(canStopSharing({...input(),...blocked}),false);
});

test('auto completion finishes on a static frame after one second without new video callbacks',()=>{
 const hold=new AutoCompletionHold(),state=input();
 assert.equal(hold.observe(state,100),false);
 assert.equal(hold.observe(state,1099),false);

 assert.equal(hold.observe(state,1100),true);
});

test('a dropped acquisition blocks auto-stop even when all card and header evidence matches',()=>{
 const state=input(),hold=new AutoCompletionHold();
 assert.equal(hasCompleteCaptureEvidence(state),true);
 assert.equal(hold.observe(state,0),false);
 for(const dropped of [1,2,-1,NaN,Infinity,undefined,null]){
  const missing={...state,dropped} as CaptureCompletion;
  assert.equal(hasCompleteCaptureEvidence(missing),false,`dropped ${String(dropped)}`);
  assert.equal(canStopSharing(missing),false,`dropped ${String(dropped)}`);
  assert.equal(hold.observe(missing,1000),false,`dropped ${String(dropped)}`);
 }
 // Later confirmed cards or repeated frames cannot remove the session's
 // dropped-frame counter. A new scanner invocation starts a new hold and 0.
 const dropped={...state,dropped:1};
 assert.equal(hold.observe(dropped,5000),false);
 const nextScan=new AutoCompletionHold(),fresh=input();
 assert.equal(nextScan.observe(fresh,6000),false);
 assert.equal(nextScan.observe(fresh,7000),true);
});

test('completion and original reuse require an explicit settled field-evidence guard',()=>{
 const state=input(),ended={...state,inputClosed:true,headerVerified:true,metadataSettled:true,tailFresh:true,pending:0};
 assert.equal(canStopSharing(state),true);
 assert.equal(canFinishEndedCapture(ended),true);
 assert.equal(canSkipCoveredOriginals(ended),true);
 for(const fieldChangesSettled of [undefined,null,false,0,'true']){
  const current={...state,fieldChangesSettled} as CaptureCompletion;
  const currentEnded={...ended,fieldChangesSettled} as typeof ended;
  assert.equal(hasCompleteCaptureEvidence(current),false,String(fieldChangesSettled));
  assert.equal(canStopSharing(current),false,String(fieldChangesSettled));
  assert.equal(canFinishEndedCapture(currentEnded),false,String(fieldChangesSettled));
  assert.equal(canSkipCoveredOriginals(currentEnded),false,String(fieldChangesSettled));
 }
});

test('a previous header is unavailable after the latest view is not located',()=>{
 assert.equal(currentHeaderAvailable(true,200,34,1),true);
 assert.equal(currentHeaderAvailable(false,200,34,1),false);
 for(const [width,height,time] of [[0,34,1],[200,0,1],[200,34,NaN],[Infinity,34,1]])
  assert.equal(currentHeaderAvailable(true,width,height,time),false);
});

test('hold restarts for a confirmed field change, but not a new proof of identical values',()=>{
 const hold=new AutoCompletionHold(),state=input();hold.observe(state,0);
 const latest=new Map([['a',2]]);
 const repeated={...state,latest,confirmedNames:latest,confirmed:latest};
 assert.equal(hold.observe(repeated,500),false);
 assert.equal(hold.observe(repeated,1000),true);
 const changed={...repeated,cards:[{...state.cards[0],awakening:1,extraCopies:0}]};
 assert.equal(hold.observe(changed,1001),false);
 assert.equal(hold.observe(changed,2000),false);
 assert.equal(hold.observe(changed,2001),true);
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


test('leftover observations prevent capture stop and remain eligible for recovery',()=>{
 const state={...input(),pending:12,unresolved:3,dropped:1,tailFresh:false};
 const hold=new AutoCompletionHold();
 assert.equal(hold.observe(state,0),false);
 assert.equal(hold.observe(state,1000),false);
 assert.equal(canSkipRecovery({...state,confirmed:new Map([['a',1]])}),false);
 assert.equal(confirmedCaptureCount(state),1);
 assert.equal(confirmedCaptureCount({...state,latest:new Map()}),0,'restored list must not appear as current-run coverage');
});

type EndedCaptureInput=Parameters<typeof canFinishEndedCapture>[0];
const endedInput=():EndedCaptureInput=>({...input(),inputClosed:true,headerVerified:true,
 pending:0,unresolved:0,dropped:0,tailFresh:true});

test('ended capture retains unmatched observations for recovery even when inventory is confirmed',()=>{
 const state=endedInput(),before=structuredClone(state);
 assert.equal(canSkipRecovery(state),true);
 assert.equal(canStopSharing(state),true);
 assert.equal(canFinishEndedCapture(state),true);
 assert.equal(canSkipRecovery({...state,unresolved:1}),false);
 assert.equal(canStopSharing({...state,unresolved:1}),false);
 assert.equal(canFinishEndedCapture({...state,unresolved:1}),false);
 for(const unresolved of [NaN,Infinity,-1,undefined]){
  assert.equal(canStopSharing({...state,unresolved} as CaptureCompletion),false);
  assert.equal(canFinishEndedCapture({...state,unresolved} as EndedCaptureInput),false);
 }
 assert.deepEqual(state,before,'evaluation must not rewrite diagnostics or evidence maps');
 assert.equal(canFinishEndedCapture({...state,cards:[{...state.cards[0],extraCopies:0}]}),true,'an explicitly observed zero is valid');
});

test('live unmatched group blocks stop and both recovery shortcuts until name evidence retires it',()=>{
 const ledger=new ScanLedger(),unknown=new UnknownLifecycle({version:1,sessionId:'session',origin:'scan',limits:UNKNOWN_LIFECYCLE_LIMITS});
 const source=(order:number)=>({sessionId:'session',frameId:order,observationId:`obs-${order}`,
  captureOrder:order,captureTime:order,phase:'input' as const,slot:0});
 const trace=ledger.acquire({frame:2,time:2,slot:0,box:{x:0,y:0,width:140,height:210},phase:'input'});
 ledger.finish(trace,'unidentified',{group:7,reason:'이름 판독 실패'});
 const key={kind:'group' as const,sessionId:'session',group:7};
 unknown.apply({version:1,kind:'upsert',key,source:source(2),captureOrder:2,captureTime:2,
  pending:false,reason:'이름 확인 필요',location:null});
 const latest=new Map([['a',1]]),names=new Map([['a',1]]),fields=new Map([['a',1]]);
 const state=()=>({...endedInput(),latest,confirmedNames:names,confirmed:fields,
  unresolved:Math.max(unknown.active().length,ledger.unresolvedGroups)});
 const hold=new AutoCompletionHold();
 assert.equal(state().unresolved,1);
 assert.equal(canStopSharing(state()),false);
 assert.equal(hold.observe(state(),0),false);assert.equal(hold.observe(state(),10_000),false);
 assert.equal(canFinishEndedCapture(state()),false);
 assert.equal(canFinishVerifiedCapture(state(),true),false);
 // A valid later name event and its corresponding ledger transition are
 // required; a matching count or a later timestamp alone did not retire it.
 assert.equal(unknown.confirmName(key,'a',source(3),[])?.retiredVersions.length,1);
 ledger.finish(trace,'identified',{group:7,cardId:'a'});
 assert.equal(state().unresolved,0);
 latest.set('a',3);names.set('a',3);
 assert.equal(canStopSharing(state()),false,'a new name alone does not prove its current fields');
 fields.set('a',3);
 assert.equal(canFinishEndedCapture(state()),true);
 assert.equal(canFinishVerifiedCapture(state(),true),true);
 assert.equal(hold.observe(state(),10_001),false);assert.equal(hold.observe(state(),11_001),true);
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
   {tailFresh:false},{dropped:1},{fieldChangesSettled:false},{finalExpected:null},{finalExpected:2},{confirmedNames:new Map<string,number>()},
   {confirmed:new Map<string,number>()},{latest:new Map([['a',2]])},
   {cards:[{...state.cards[0],extraCopies:null}]},{cards:[{...state.cards[0],awakening:4,extraCopies:10}]}])
   assert.equal(canSkipCoveredOriginals({...state,...change}),false,JSON.stringify(change));
 const latest=new Map([['a',2]]);
 assert.equal(canSkipCoveredOriginals({...state,latest,confirmedNames:latest,confirmed:latest}),true);
});
