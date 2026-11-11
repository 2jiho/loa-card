import {test} from 'node:test';
import assert from 'node:assert/strict';
import {UnknownScanSession,unknownRetryCandidateIndex} from '../src/features/card-scanner/session/unknown-scan-session';
import {UnknownLifecycle,UnknownSourceLifecycle,hashUnknownSourceLifecycle} from '../src/features/card-scanner/session/unknown-lifecycle';
import {CardReadAdmissionDenied,CardReadAttempts,isIncompleteCardRead} from '../src/features/card-scanner/recognition/card-read-budget';
import {UNKNOWN_LIFECYCLE_LIMITS} from '../src/features/card-scanner/session/unknown-lifecycle-types';
import type {UnknownUpsert,UnknownFact} from '../src/features/card-scanner/session/unknown-lifecycle-types';
import type {ObservationSource} from '../src/features/card-scanner/session/observation-execution';
import {canStopSharing} from '../src/features/card-scanner/session/auto-completion';
import {canConfirmScanGrid,scanCompletion} from '../src/features/card-scanner/session/completion';
import {FreshObservations} from '../src/features/card-scanner/session/fresh-observation';
import type {CaptureCompletion} from '../src/features/card-scanner/session/auto-completion';

const key={kind:'group' as const,sessionId:'s',group:4};
const source=(id:string,order:number):ObservationSource=>({sessionId:'s',frameId:order,observationId:id,
  captureOrder:order,captureTime:order,phase:'input',slot:0});
const warning=(src:ObservationSource,pending=false):UnknownUpsert=>({version:1,kind:'upsert',key,source:src,
  captureOrder:src.captureOrder,captureTime:src.captureTime,pending,reason:'이름 확인',location:null});
const image=(id:string)=>({pixelKey:id,preview:()=>`preview-${id}`,recognition:()=>`crop-${id}`});
const complete=(unresolved:number):CaptureCompletion=>({expected:1,finalExpected:1,unresolved,dropped:0,
  cards:[{id:'a',name:'카드',awakening:0,extraCopies:1,countReliable:true,review:[],confidence:1,image:'',time:0,observations:1}],
  latest:new Map([['a',1]]),confirmedNames:new Map([['a',1]]),confirmed:new Map([['a',1]]),
  inputSettled:true,headerAvailable:true,fieldChangesSettled:true});

test('a refused same-pixel read remains unresolved and blocks completion in either policy',()=>{
  const attempts=new CardReadAttempts(()=>0);
  attempts.begin('same','short')!.finish();attempts.begin('same','full')!.finish();
  assert.equal(attempts.begin('same','short'),null);
  const failure=new CardReadAdmissionDenied();assert.ok(isIncompleteCardRead(failure));
  const fact={...warning(source('denied',2)),reason:failure.message};
  const v1=new UnknownLifecycle({version:1,sessionId:'s',origin:'scan',limits:UNKNOWN_LIFECYCLE_LIMITS});
  const v2=new UnknownScanSession({sessionId:'s'});
  v1.apply(fact);v2.report(fact,image('denied'));
  assert.equal(v1.active()[0].reason,failure.message);
  assert.equal(v2.active()[0].reason,failure.message);
  assert.equal(canStopSharing(complete(v1.active().length)),false);
  assert.equal(canStopSharing(complete(v2.unresolved())),false);
  assert.equal(attempts.begin('same','full'),null,'unresolved reporting must not refund the pass');
});

test('the experimental session retains same-group sources and blocks completion until the exact source resolves',()=>{
  const session=new UnknownScanSession({sessionId:'s'}),a=source('a',1),b=source('b',2);
  session.report(warning(a),image('a'));session.report(warning(b),image('b'));
  assert.deepEqual(session.active().map(x=>[x.source?.observationId,x.image]),[['a','preview-a'],['b','preview-b']]);
  session.confirmName(key,'a',b,[]);
  assert.equal(session.unresolved(),1);assert.equal(canStopSharing(complete(session.unresolved())),false);
  assert.equal(session.active()[0].image,'preview-a');
  session.confirmName(key,'a',a,[]);
  assert.equal(session.unresolved(),0);assert.equal(canStopSharing(complete(session.unresolved())),true);
});

test('re-showing a failed crop does not establish a source-bound retry',()=>{
  const session=new UnknownScanSession({sessionId:'s'}),fresh=new FreshObservations<object>();
  const a=source('a',1),old={};session.report(warning(a),image('a'));
  fresh.remember(4,'same-pixels',1,old);fresh.finish(old);
  assert.equal(fresh.retryPlan(4,'same-pixels',2,true,()=>false),undefined);
  assert.equal(fresh.retryPlan(4,'different-pixels',2,true,()=>false)?.reason,'fresh-pixels');
  session.confirmName(key,'card',source('new-frame',2),[]);
  assert.equal(session.unresolved(),1);
  assert.equal(canStopSharing(complete(session.unresolved())),false);
  // A successful independent read of the retained original is different from
  // assuming that a newer picture belongs to the same physical observation.
  session.confirmName(key,'card',a,[]);assert.equal(session.unresolved(),0);
});

test('retry deduplication replaces only the identical original candidate',()=>{
  const a={group:4,source:{...source('a',1),frame:'frame-a'}},b={group:4,source:{...source('b',2),frame:'frame-b'}};
  assert.equal(unknownRetryCandidateIndex([a],a),0);
  assert.equal(unknownRetryCandidateIndex([a],b),-1);
  assert.equal(unknownRetryCandidateIndex([a],{...a,source:{...a.source,frame:'other'}}),-1);
  assert.equal(unknownRetryCandidateIndex([a],{...a,group:5}),-1);
});

test('live evidence loss remains blocking after retained warnings are resolved',()=>{
  const losses:string[]=[],session=new UnknownScanSession({sessionId:'s',limits:{...UNKNOWN_LIFECYCLE_LIMITS,active:1},
    onEvidenceLoss:loss=>losses.push(loss)}),a=source('a',1),b=source('b',2);
  session.report(warning(a),image('a'));session.report(warning(b),image('b'));
  session.confirmName(key,'a',a,[]);
  assert.deepEqual(losses,['active-limit']);assert.equal(session.active().length,0);
  assert.equal(session.hasEvidenceLoss(),true);assert.equal(canStopSharing(complete(session.unresolved())),false);
});

test('every source evidence loss blocks both automatic stop and manual final confirmation',()=>{
  const a=source('a',1),b=source('b',2);
  for(const kind of ['active-limit','proof-limit','identity-conflict'] as const){
    const losses:string[]=[];
    const session=new UnknownScanSession({sessionId:'s',limits:{...UNKNOWN_LIFECYCLE_LIMITS,
      ...(kind==='active-limit'?{active:1}:{}),...(kind==='proof-limit'?{groups:1}:{})},
      onEvidenceLoss:loss=>losses.push(loss)});
    if(kind==='active-limit'){
      session.report(warning(a),image('a'));session.report(warning(b),image('b'));
      session.confirmName(key,'a',a,[]);
    }else if(kind==='proof-limit'){
      session.confirmName(key,'a',a,[]);session.confirmName(key,'b',b,[]);
    }else{
      session.confirmName(key,'a',a,[]);session.confirmName(key,'b',a,[]);
    }
    assert.deepEqual(losses,[kind]);assert.equal(session.active().length,0);
    assert.equal(session.hasEvidenceLoss(),true);assert.equal(session.unresolved(),1);
    assert.equal(canStopSharing(complete(session.unresolved())),false,`${kind}: automatic stop`);
    const state={expected:1,currentRunRead:1,unresolvedFieldChanges:0,unidentified:[],unresolvedGroups:0,
      droppedFrames:0,cards:[{review:[]}],unresolvedSourceEvidence:session.unresolved()};
    assert.equal(canConfirmScanGrid(state),false,`${kind}: final grid`);
    assert.match(scanCompletion(1,1,0,1,session.unresolved()-Number(session.hasEvidenceLoss()),session.hasEvidenceLoss()),
      /카드 확인 근거 손실 · 새 스캔 필요$/,`${kind}: final status`);
  }
});

test('recorded events reproduce the live source state and checkpoint hash',async()=>{
  const events:{type:string;value:unknown}[]=[],session=new UnknownScanSession({sessionId:'s',recording:{
    record:(type,value)=>{events.push({type,value});return true;},incomplete:()=>assert.fail('unexpected loss')}});
  const a=source('a',1),b=source('b',2);
  session.report(warning(a,true),image('a'));session.report(warning(b),image('b'));
  session.report(warning(a,false),image('a'));session.confirmName(key,'card',a,[]);
  assert.equal(await session.checkpoint(),true);
  const replay=new UnknownSourceLifecycle(session.seed);
  for(const event of events)if(event.type==='unknown-event')replay.apply(event.value as UnknownFact);
  const checkpoint=events.find(event=>event.type==='unknown-checkpoint')!.value as {complete:boolean;hash:string};
  assert.deepEqual(replay.snapshot(),session.snapshot());assert.equal(checkpoint.complete,true);
  assert.equal(await hashUnknownSourceLifecycle(replay.snapshot()),checkpoint.hash);
});

test('recording failure does not invent lost live input',async()=>{
  const losses:string[]=[],session=new UnknownScanSession({sessionId:'s',onEvidenceLoss:loss=>losses.push(loss),recording:{
    record:type=>type!=='unknown-event',incomplete:()=>{}}}),a=source('a',1);
  session.report(warning(a),image('a'));session.confirmName(key,'card',a,[]);
  assert.equal(session.unresolved(),0);assert.equal(session.hasEvidenceLoss(),false);
  assert.equal(session.snapshot().complete,false);assert.deepEqual(losses,[]);
  assert.equal(await session.checkpoint(),true);
});
