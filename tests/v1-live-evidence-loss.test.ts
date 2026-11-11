import {test} from 'node:test';
import assert from 'node:assert/strict';
import {UnknownLifecycle,hashUnknownLifecycle} from '../src/features/card-scanner/session/unknown-lifecycle';
import {UnknownLifecycleReplay} from '../src/features/card-scanner/reproduction/unknown-lifecycle-replay';
import {UNKNOWN_LIFECYCLE_LIMITS,type UnknownUpsert} from '../src/features/card-scanner/session/unknown-lifecycle-types';
import {canStopSharing,canFinishEndedCapture,type CaptureCompletion} from '../src/features/card-scanner/session/auto-completion';
import {canSkipRecovery,canFinishVerifiedCapture} from '../src/features/card-scanner/session/recovery-completion';
import {canConfirmScanGrid,scanCompletion} from '../src/features/card-scanner/session/completion';
import type {ObservationSource} from '../src/features/card-scanner/session/observation-execution';

const key=(group:number)=>({kind:'group' as const,sessionId:'s',group});
const source=(id:string,order:number):ObservationSource=>({sessionId:'s',frameId:order,observationId:id,captureOrder:order,captureTime:order,phase:'input',slot:0});
const warning=(group:number,s:ObservationSource):UnknownUpsert=>({version:1,kind:'upsert',key:key(group),source:s,captureOrder:s.captureOrder,captureTime:s.captureTime,pending:false,reason:'이름 확인',location:null});
const seed={version:1 as const,sessionId:'s',origin:'scan' as const,limits:{...UNKNOWN_LIFECYCLE_LIMITS,active:1}};
function completion(unresolved:number):CaptureCompletion&{pending:number;tailFresh:boolean}{return {expected:1,finalExpected:1,unresolved,dropped:0,pending:0,tailFresh:true,
 cards:[{id:'a',name:'카드',awakening:0,extraCopies:1,countReliable:true,review:[],confidence:1,image:'',time:4,observations:1}],
 latest:new Map([['a',4]]),confirmedNames:new Map([['a',4]]),confirmed:new Map([['a',4]]),inputSettled:true,headerAvailable:true,fieldChangesSettled:true};}

test('discarded live unknown stays unresolved after other entries are recognized',()=>{
 const lifecycle=new UnknownLifecycle(seed);
 lifecycle.apply(warning(1,source('a',1)));
 assert.equal(lifecycle.apply(warning(2,source('b',2))).suppressedReason,'active-limit');
 lifecycle.confirmName(key(1),'a',source('resolved',3),[]);
 assert.equal(lifecycle.active().length,0);
 assert.equal(lifecycle.hasLiveEvidenceLoss(),true);
 const unresolved=Math.max(lifecycle.active().length,Number(lifecycle.hasLiveEvidenceLoss()));
 assert.equal(canStopSharing(completion(unresolved)),false);
 assert.equal(canSkipRecovery(completion(unresolved)),false);
 assert.equal(canFinishVerifiedCapture(completion(unresolved),true),false);
 assert.equal(canFinishEndedCapture({...completion(unresolved),inputClosed:true,headerVerified:true}),false);
 assert.equal(canConfirmScanGrid({expected:1,currentRunRead:1,unresolvedFieldChanges:0,unidentified:[],unresolvedGroups:0,droppedFrames:0,cards:[{review:[]}],unresolvedSourceEvidence:unresolved}),false);
 assert.match(scanCompletion(1,1,0,1,0,lifecycle.hasLiveEvidenceLoss()),/카드 확인 근거 손실/);
 assert.equal(new UnknownLifecycle(seed).hasLiveEvidenceLoss(),false);
});

test('recording-only loss is not confused with lost live evidence',()=>{
 const lifecycle=new UnknownLifecycle({...seed,limits:{...seed.limits,facts:0}},{onEvent:()=>{throw Error('sink');}});
 lifecycle.apply(warning(1,source('a',1)));
 assert.equal(lifecycle.snapshot().complete,false);
 assert.equal(lifecycle.hasLiveEvidenceLoss(),false);
 const sink=new UnknownLifecycle(seed,{onEvent:()=>{throw Error('sink');}});
 sink.apply(warning(1,source('a',1)));
 assert.equal(sink.snapshot().complete,false);
 assert.equal(sink.hasLiveEvidenceLoss(),false);
});

test('older, tied, covered and ordinary observations retain clean evidence state',()=>{
 const lifecycle=new UnknownLifecycle(seed),first=warning(1,source('a',5));
 lifecycle.apply(first);
 assert.equal(lifecycle.apply(warning(1,source('old',4))).suppressedReason,'older');
 assert.equal(lifecycle.apply(first).suppressedReason,'tied');
 lifecycle.confirmName(key(1),'a',source('resolved',6),[]);
 assert.equal(lifecycle.apply(warning(1,source('covered',5))).suppressedReason,'covered');
 assert.equal(lifecycle.hasLiveEvidenceLoss(),false);
 assert.equal(canStopSharing(completion(0)),true);
});

test('exhausting group proof capacity remains sticky for the session',()=>{
 const lifecycle=new UnknownLifecycle({...seed,limits:{...seed.limits,groups:1}});
 lifecycle.confirmName(key(1),'a',source('a',1),[]);
 lifecycle.confirmName(key(2),'b',source('b',2),[]);
 assert.equal(lifecycle.hasLiveEvidenceLoss(),true);
 assert.equal(new UnknownLifecycle(seed).hasLiveEvidenceLoss(),false);
});

test('conflicting names in one group remain unresolved even after its warning was retired',async()=>{
 const events:unknown[]=[],lifecycle=new UnknownLifecycle(seed,{onEvent:event=>events.push(event)});
 lifecycle.apply(warning(1,source('unknown',1)));
 lifecycle.confirmName(key(1),'a',source('first',2),[]);
 assert.equal(lifecycle.active().length,0);
 assert.equal(lifecycle.hasLiveEvidenceLoss(),false);
 lifecycle.confirmName(key(1),'b',source('contradiction',3),[]);
 assert.equal(lifecycle.hasLiveEvidenceLoss(),true);
 lifecycle.confirmName(key(1),'a',source('later',4),[]);
 assert.equal(lifecycle.hasLiveEvidenceLoss(),true);
 const unresolved=Math.max(lifecycle.active().length,Number(lifecycle.hasLiveEvidenceLoss()));
 assert.equal(canStopSharing(completion(unresolved)),false);
 assert.equal(canFinishEndedCapture({...completion(unresolved),inputClosed:true,headerVerified:true}),false);
 const snapshot=lifecycle.snapshot();
 const complete=snapshot.complete&&!lifecycle.hasLiveEvidenceLoss();
 const replay=new UnknownLifecycleReplay(new AbortController().signal);
 replay.seed(seed);for(const event of events)replay.accept(event);
 replay.checkpoint({version:1,complete,events:snapshot.facts,hash:complete?await hashUnknownLifecycle(snapshot):null});
 const report=await replay.summary();
 assert.equal(report.complete,false);assert.equal(report.matchesCapturedState,null);
});

test('repeated identical name and distinct groups do not create conflicts',()=>{
 const lifecycle=new UnknownLifecycle(seed);
 lifecycle.confirmName(key(1),'a',source('first',1),[]);
 lifecycle.confirmName(key(1),'a',source('same-later',2),[]);
 lifecycle.confirmName(key(2),'b',source('other-group',3),[]);
 assert.equal(lifecycle.hasLiveEvidenceLoss(),false);
 assert.equal(canStopSharing(completion(0)),true);
});

test('v1 historical snapshot hashes remain valid while new lost-evidence checkpoint is partial',async()=>{
 const events:unknown[]=[],lifecycle=new UnknownLifecycle(seed,{onEvent:event=>events.push(event)});
 lifecycle.apply(warning(1,source('a',1)));lifecycle.apply(warning(2,source('b',2)));
 const snapshot=lifecycle.snapshot();assert.equal(snapshot.complete,true);assert.ok(await hashUnknownLifecycle(snapshot));
 const replay=new UnknownLifecycleReplay(new AbortController().signal);replay.seed(seed);for(const event of events)replay.accept(event);
 const complete=snapshot.complete&&!lifecycle.hasLiveEvidenceLoss();
 replay.checkpoint({version:1,complete,events:snapshot.facts,hash:complete?await hashUnknownLifecycle(snapshot):null});
 const report=await replay.summary();assert.equal(report.complete,false);assert.equal(report.matchesCapturedState,null);
});
