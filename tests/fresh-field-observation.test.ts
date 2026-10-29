import {test} from 'node:test';
import assert from 'node:assert/strict';
import {FreshObservations} from '../src/features/card-scanner/fresh-observation';
import {CaptureObservations} from '../src/features/card-scanner/capture-quality';
import {CandidateQueue} from '../src/features/card-scanner/candidate-queue';
import {replacePendingCandidate,replaceRetry} from '../src/features/card-scanner/retry-candidate';
import {CardReadAttempts} from '../src/features/card-scanner/card-read-budget';
import {resolvedSavedObservation,type SavedObservation} from '../src/features/card-scanner/saved-acquisition';
import {canFinishVerifiedCapture,canSkipRecovery} from '../src/features/card-scanner/recovery-completion';
import {AutoCompletionHold,canFinishEndedCapture,canSkipCoveredOriginals,canStopSharing,hasCompleteCaptureEvidence} from '../src/features/card-scanner/auto-completion';
import type {ObservationSource} from '../src/features/card-scanner/observation-execution';
import type {ScannedCard} from '../src/features/card-scanner/recognizer';

type Observation=Readonly<{order:number;frame:string;stable:boolean}>;
const observation=(order:number):Observation=>Object.freeze({order,frame:`physical-source/${order}`,stable:true});
function tracking(limit=2048){
  const resolved=new WeakSet<Observation>();
  const isResolved=(value:Observation)=>resolved.has(value);
  return {resolved,isResolved,fresh:new FreshObservations<Observation>(limit,isResolved)};
}
function candidate(group:number,order:number,pixel:string,field:string){
  const saved=observation(order),time=order/100;
  const source:ObservationSource={sessionId:'field-regression',frameId:order,observationId:String(order),
    captureOrder:order,captureTime:time,phase:'input',slot:2};
  return {group,order,stable:true,borderAlignment:1,time,pixel,field,observation:saved,source,
    raster:{pixels:new Uint8Array(140*210*4) as Uint8Array|null,releases:0}};
}
type Candidate=ReturnType<typeof candidate>;
function release(item:Candidate){item.raster.pixels=null;item.raster.releases++;}

test('an exactly retained rejected source can settle during recovery without committing its queue admission',()=>{
  const {fresh,resolved,isResolved}=tracking(),a=observation(100),b=observation(110),unrelated=observation(110);
  fresh.remember(1,'a',1,a,'fields-a');resolved.add(a);fresh.finish(a);
  fresh.rejectChanged(1,1.1,b);
  assert.equal(fresh.unresolvedChanges(),1);
  resolved.add(unrelated);
  assert.equal(fresh.unresolvedChanges(),1,'equal order/frame strings cannot substitute another source object');
  assert.equal(fresh.retryPlan(1,'b',1.2,true,isResolved,()=>false,'fields-b')?.reason,'changed-fields',
    'rejected pixels were not remembered as accepted');
  resolved.add(b);
  assert.equal(fresh.unresolvedChanges(),0,'the actual retained observation can receive recovery proof');
});

test('rejection of an older input cannot revoke a newer accepted source',()=>{
  const {fresh,resolved}=tracking(),a=observation(200);
  fresh.remember(1,'newer',2,a,'fields-newer');resolved.add(a);fresh.finish(a);
  fresh.rejectChanged(1,1.9,observation(190));
  assert.equal(fresh.unresolvedChanges(),0);
});

test('sparse fields in the same fuzzy group are selected before an active or resolved old read can suppress them',()=>{
  for(const prior of ['active','resolved'] as const)for(const elapsed of [.1,.749]){
    const {fresh,resolved,isResolved}=tracking(),a=observation(100);
    const groups=new CaptureObservations(),before=new Uint8Array(3240).fill(100),after=before.slice();
    after[900]+=100;
    const group=groups.offerDetailed(before,2,10,true);
    fresh.remember(group.id,'pixels-a',1,a,'fields-a');
    if(prior==='resolved'){resolved.add(a);fresh.finish(a);}
    const repeated=groups.offerDetailed(after,2,10,true);
    assert.equal(repeated.id,group.id);assert.equal(repeated.decision,'duplicate');
    const plan=fresh.retryPlan(group.id,'pixels-b',1+elapsed,true,isResolved,()=>false,'fields-b');
    assert.equal(plan?.reason,'changed-fields',`${prior}, ${elapsed}s must retain the last changed input`);
    assert.equal(Object.hasOwn(plan!,'exactConfirmed'),false,'a fuzzy match or revision cannot lend identity');
    assert.equal(fresh.unresolvedChanges(),0,'selection alone is not a queue acceptance receipt');
  }
});

test('field-change selection still rejects invalid, older and exact repeated pixels',()=>{
  const {fresh,isResolved}=tracking(),a=observation(100);
  fresh.remember(1,'pixels-a',1,a,'fields-a');
  for(const time of [.9,NaN,Infinity,-Infinity])
    assert.equal(fresh.retryPlan(1,'pixels-b',time,true,isResolved,()=>false,'fields-b'),undefined);
  assert.equal(fresh.retryPlan(1,'pixels-a',1.1,true,isResolved,()=>false,'fields-b'),undefined,
    'a revision cannot turn the same exact crop key into a new budget');
  assert.equal(fresh.unresolvedChanges(),0);
});

test('a usable unsettled field change survives while unsettled legacy or portrait-only retries remain rejected',()=>{
  const {fresh,isResolved}=tracking(),a=observation(100);
  fresh.remember(1,'pixels-a',1,a,'fields-a');
  const changed=fresh.retryPlan(1,'pixels-b',1.1,false,isResolved,()=>false,'fields-b');
  assert.equal(changed?.reason,'changed-fields');assert.equal(Object.hasOwn(changed!,'exactConfirmed'),false);
  assert.equal(fresh.retryPlan(1,'portrait-only',2,false,isResolved,()=>false,'fields-a'),undefined);
  assert.equal(fresh.retryPlan(1,'legacy-no-revision',2,false,isResolved),undefined);
  assert.equal(fresh.retryPlan(100,'missing-metadata',2,false,isResolved,()=>false,'fields-b')?.reason,'changed-fields');
  assert.equal(fresh.retryPlan(100,'missing-metadata',2,false,isResolved),undefined);
});

test('a newly settled view can improve the same field revision once without lending identity or refunding the exact crop budget',()=>{
  const {fresh,isResolved}=tracking(),a=Object.freeze({...observation(100),stable:false});
  fresh.remember(1,'same-pixels',1,a,'same-fields');
  let now=0;const attempts=new CardReadAttempts(()=>now);
  const short=attempts.begin('same-pixels','short')!;
  now=1500;short.finish();
  const settled=fresh.retryPlan(1,'same-pixels',1.1,true,isResolved,()=>false,'same-fields');
  assert.equal(settled?.reason,'changed-fields');assert.equal(Object.hasOwn(settled!,'exactConfirmed'),false);
  const b=observation(110);
  fresh.remember(1,'same-pixels',1.1,b,'same-fields',true);
  assert.equal(fresh.unresolvedChanges(),1,'settled promotion still needs an actual field proof');
  assert.equal(fresh.retryPlan(1,'same-pixels',1.2,true,isResolved,()=>false,'same-fields'),undefined,
    'the same settled revision must not continuously promote itself');
  const full=attempts.begin('same-pixels','full')!;
  assert.equal(full.budget.remaining(),1500,'the promotion does not restart the three-second crop budget');
  now=3000;full.finish();
  assert.equal(attempts.begin('same-pixels','full'),null);
  assert.equal(attempts.begin('same-pixels',false),null,'no visual pass may reopen an exhausted exact crop');
});

test('only a genuinely newer changed-field candidate may replace a stable pending crop with an unsettled one',()=>{
  const released:string[]=[];
  const queue=new CandidateQueue<{group:number;order:number;stable:boolean;changedFields?:boolean;key:string}>(1,
    item=>released.push(item.key),replacePendingCandidate);
  const a={group:1,order:100,stable:true,key:'a'};
  assert.equal(queue.push(a),true);
  assert.equal(queue.push({group:1,order:110,stable:false,key:'portrait'}),false);
  assert.equal(queue.push({group:1,order:100,stable:false,changedFields:true,key:'same-time'}),false);
  assert.equal(queue.push({group:1,order:90,stable:false,changedFields:true,key:'older'}),false);
  const b={group:1,order:110,stable:false,changedFields:true,key:'changed-b'};
  assert.equal(queue.push(b),true);assert.deepEqual(released,['a']);
  assert.equal(queue.shift(),b);assert.equal(queue.length,0);
});

test('portrait-only pixel changes do not create field-change work while ordinary unresolved retries remain available',()=>{
  const {fresh,resolved,isResolved}=tracking(),a=observation(100);
  fresh.remember(1,'portrait-a',1,a,'unchanged-fields');
  assert.equal(fresh.retryPlan(1,'portrait-b',1.1,true,isResolved,()=>false,'unchanged-fields'),undefined);
  fresh.finish(a);
  const unresolved=fresh.retryPlan(1,'portrait-b',2,true,isResolved,()=>false,'unchanged-fields');
  assert.equal(unresolved?.reason,'fresh-pixels','existing unresolved retry policy is distinct from changed fields');
  resolved.add(a);
  assert.equal(fresh.retryPlan(1,'portrait-b',2,true,isResolved,()=>false,'unchanged-fields'),undefined);
  assert.equal(fresh.unresolvedChanges(),0);
});

test('a rejected changed crop keeps completion debt and can be accepted again without remembering discarded pixels',()=>{
  const {fresh,resolved,isResolved}=tracking(),a=observation(100),b=candidate(1,110,'pixels-b','fields-b');
  fresh.remember(1,'pixels-a',1,a,'fields-a');
  const queue=new CandidateQueue<Candidate>(1,release,replaceRetry),blocker=candidate(2,100,'other','other');
  assert.equal(queue.push(blocker),true);
  assert.equal(fresh.retryPlan(1,b.pixel,b.time,true,isResolved,()=>false,b.field)?.reason,'changed-fields');
  assert.equal(queue.push(b),false);
  fresh.rejectChanged(1,b.time);
  assert.equal(fresh.unresolvedChanges(),1);
  assert.equal(fresh.retryPlan(1,b.pixel,b.time,true,isResolved,()=>false,b.field)?.reason,'changed-fields',
    'a rejected proposal must not become the remembered pixel revision');
  assert.equal(queue.shift(),blocker);release(blocker);
  assert.equal(queue.push(b),true);
  fresh.remember(b.group,b.pixel,b.time,b.observation,b.field,true);
  resolved.add(a);fresh.finish(a);
  assert.equal(fresh.unresolvedChanges(),1,'late old proof cannot settle the accepted newer crop');
  const accepted=queue.shift()!;
  assert.equal(accepted,b);assert.equal(accepted.source.captureTime,1.1);
  assert.equal(accepted.observation.frame,'physical-source/110');
  fresh.finish(b.observation);
  assert.equal(fresh.unresolvedChanges(),1,'reader termination alone supplies no fields');
  resolved.add(b.observation);
  assert.equal(fresh.unresolvedChanges(),0);
  release(b);assert.equal(b.raster.releases,1);assert.equal(blocker.raster.releases,1);
});

test('one pending newer crop coalesces B to C without losing chronology to old completion or an older replacement',()=>{
  const {fresh,resolved,isResolved}=tracking(),a=candidate(1,100,'a','fields-a');
  const released:Candidate[]=[],queue=new CandidateQueue<Candidate>(1,item=>{
    released.push(item);fresh.finish(item.observation);release(item);
  },replaceRetry);
  assert.equal(queue.push(a),true);fresh.remember(1,a.pixel,a.time,a.observation,a.field);
  assert.equal(queue.shift(),a,'A is owned by the active reader, not by the pending queue');
  const b=candidate(1,110,'b','fields-b'),c=candidate(1,120,'c','fields-c');
  for(const item of [b,c]){
    assert.equal(fresh.retryPlan(1,item.pixel,item.time,true,isResolved,()=>false,item.field)?.reason,'changed-fields');
    assert.equal(queue.push(item),true);
    fresh.remember(1,item.pixel,item.time,item.observation,item.field,true);
  }
  assert.equal(queue.length,1);assert.deepEqual(released,[b]);
  assert.equal(b.raster.pixels,null);assert.equal(b.raster.releases,1);
  resolved.add(a.observation);fresh.finish(a.observation);release(a);
  resolved.add(b.observation);fresh.finish(b.observation);
  assert.equal(fresh.unresolvedChanges(),1,'finishing replaced B or active A must not settle C');
  const older=candidate(1,115,'late-b','fields-b');
  assert.equal(queue.push(older),false,'optional queue replacement policy rejects an older capture');
  assert.equal(older.raster.releases,0,'rejected input ownership stays with the caller');release(older);
  fresh.remember(1,older.pixel,older.time,older.observation,older.field,true);
  assert.equal(fresh.retryPlan(1,'older-still',1.19,true,isResolved,()=>false,'fields-old'),undefined);
  assert.equal(fresh.retryPlan(1,c.pixel,1.3,true,isResolved,()=>false,c.field),undefined,
    'an older remember call cannot change the current accepted revision');
  assert.equal(queue.shift(),c);assert.equal(c.source.captureOrder,120);assert.equal(c.source.captureTime,1.2);
  fresh.finish(c.observation);assert.equal(fresh.unresolvedChanges(),1);
  resolved.add(c.observation);assert.equal(fresh.unresolvedChanges(),0);release(c);
  assert.equal(queue.length,0);
  for(const item of [a,b,c,older])assert.equal(item.raster.releases,1);
});

test('unknown changed fields cannot use a complete old inventory to bypass any completion gate',()=>{
  const identity:NonNullable<SavedObservation['identity']>={id:'known-a',name:'단위 검증 카드',confidence:1,
    nameEvidence:[],review:[],identitySource:'dictionary',maxAwakening:5};
  const a:SavedObservation={order:100,frame:'source/a',stable:true,identity};
  const b:SavedObservation={order:110,frame:'source/b',stable:true};
  const confirmed=new Map([['known-a',100]]),latest=new Map([['known-a',100]]),
    confirmedNames=new Map([['known-a',100]]),fresh=new FreshObservations<SavedObservation>(2048,
    value=>resolvedSavedObservation(value,confirmed));
  fresh.remember(1,'a',1,a,'fields-a');fresh.finish(a);
  fresh.remember(1,'b',1.1,b,'fields-b',true);fresh.finish(b);
  const card:ScannedCard={id:identity.id,name:identity.name,awakening:0,extraCopies:0,countReliable:true,
    confidence:1,review:[],image:'',time:1,observations:1,captureOrder:100};
  const state=()=>({expected:1,finalExpected:1,cards:[card],latest,confirmedNames,confirmed,inputSettled:true,headerAvailable:true,
    pending:0,unresolved:5,dropped:0,tailFresh:true,inputClosed:true,headerVerified:true,metadataSettled:true,
    fieldChangesSettled:fresh.unresolvedChanges()===0});
  const before=state(),hold=new AutoCompletionHold();
  assert.equal(hasCompleteCaptureEvidence({...before,fieldChangesSettled:true}),true,
    'the pre-existing inventory is otherwise fully confirmed');
  assert.equal(canFinishEndedCapture({...before,fieldChangesSettled:true}),true,
    'the ordinary unmatched-crop exception is enabled in this control');
  assert.equal(fresh.unresolvedChanges(),1);
  for(const [name,result] of [
    ['preflight',hasCompleteCaptureEvidence(before)],['share stop',canStopSharing(before)],
    ['ended capture',canFinishEndedCapture(before)],['covered originals',canSkipCoveredOriginals(before)],
    ['recovery skip',canSkipRecovery({...before,unresolved:0})],
    ['verified auto-stop',canFinishVerifiedCapture(before,true)],
  ] as const)assert.equal(result,false,name);
  assert.equal(hold.observe(before,0),false);assert.equal(hold.observe(before,10_000),false);
  b.identity=identity;
  latest.set('known-a',110);confirmedNames.set('known-a',110);
  assert.equal(fresh.unresolvedChanges(),1,'a newly accepted name does not confirm the old count at order 100');
  confirmed.set('known-a',110);
  card.captureOrder=110;card.time=1.1;card.extraCopies=1;
  assert.equal(fresh.unresolvedChanges(),0,'this source identity plus current field proof settles the change');
  const after=state();
  assert.equal(canFinishEndedCapture(after),true);
  assert.equal(canFinishVerifiedCapture(after,true),true);
  assert.equal(hold.observe(after,10_001),false);assert.equal(hold.observe(after,11_001),true);
});

test('unresolved metadata eviction leaves a bounded loss latch that later known observations cannot erase',()=>{
  const {fresh,resolved}=tracking(2),latest:Observation[]=[];
  for(let group=1;group<=12;group++){
    const a=observation(group*100),b=observation(group*100+1);
    fresh.remember(group,`a/${group}`,group,a,`fields-a/${group}`);
    fresh.remember(group,`b/${group}`,group+.01,b,`fields-b/${group}`,true);
    latest.push(b);
    assert.ok(fresh.unresolvedChanges()<=3,'two retained debts plus one loss marker, never a history-sized counter');
  }
  assert.equal(fresh.unresolvedChanges(),3);
  for(const value of latest){resolved.add(value);fresh.finish(value);}
  assert.equal(fresh.unresolvedChanges(),1,'discarded unknown history cannot be reconstructed from later completions');
  fresh.remember(100,'new',100,observation(10000),'new-fields');
  assert.equal(fresh.unresolvedChanges(),1,'ordinary new work must not reset an overflow warning');
});

test('resolved metadata eviction does not manufacture an unresolved loss marker',()=>{
  const {fresh,resolved}=tracking(2);
  for(let group=1;group<=8;group++){
    const a=observation(group*100),b=observation(group*100+1);
    fresh.remember(group,`a/${group}`,group,a,`fields-a/${group}`);
    fresh.remember(group,`b/${group}`,group+.01,b,`fields-b/${group}`,true);
    resolved.add(b);
  }
  assert.equal(fresh.unresolvedChanges(),0);
});

test('a fuzzy group that outlives freshness metadata receives new inspection and explicit proof debt',()=>{
  const {fresh,resolved,isResolved}=tracking(2),groups=new CaptureObservations(4);
  const pixels=new Uint8Array(3240).fill(100),a=observation(100);
  const first=groups.offerDetailed(pixels,2,10,true);
  fresh.remember(first.id,'a',1,a,'fields-a');resolved.add(a);fresh.finish(a);
  fresh.remember(100,'other-a',1.01,observation(101),'other-a');
  fresh.remember(101,'other-b',1.02,observation(102),'other-b');
  const changed=pixels.slice();changed[900]+=100;
  const stillGrouped=groups.offerDetailed(changed,2,10,true);
  assert.equal(stillGrouped.id,first.id);assert.equal(stillGrouped.decision,'duplicate');
  const plan=fresh.retryPlan(first.id,'b',1.1,true,isResolved,()=>false,'fields-b');
  assert.equal(plan?.reason,'changed-fields');assert.equal(Object.hasOwn(plan!,'exactConfirmed'),false);
  assert.equal(fresh.unresolvedChanges(),0);
  const b=observation(110);
  fresh.remember(first.id,'b',1.1,b,'fields-b',plan?.reason==='changed-fields');
  assert.equal(fresh.unresolvedChanges(),1,'a missing prior entry must not suppress completion debt');
  fresh.finish(b);assert.equal(fresh.unresolvedChanges(),1);
  resolved.add(b);assert.equal(fresh.unresolvedChanges(),0);
});

test('metadata-only freshness tracking does not take raster ownership away from the bounded candidate queue',()=>{
  const {fresh}=tracking(2),a=candidate(1,100,'a','fields-a'),b=candidate(1,110,'b','fields-b');
  const queue=new CandidateQueue<Candidate>(1,release,replaceRetry);
  for(const item of [a,b]){
    assert.equal(queue.push(item),true);
    fresh.remember(item.group,item.pixel,item.time,item.observation,item.field,item===b);
    assert.deepEqual(Object.keys(item.observation).sort(),['frame','order','stable']);
    assert.equal(Object.isFrozen(item.observation),true);
  }
  assert.equal(a.raster.pixels,null);assert.equal(a.raster.releases,1);
  assert.equal(b.raster.pixels?.byteLength,140*210*4);
  queue.clear();queue.clear();
  assert.equal(b.raster.pixels,null);assert.equal(b.raster.releases,1);
  assert.equal(queue.length,0);assert.equal(fresh.unresolvedChanges(),1,
    'releasing pixels is not equivalent to confirming the retained metadata');
  // This proves ownership/release behavior, not garbage collection or a JS heap cap.
});

test('an accepted field change forming a new visual group cannot disappear behind the old complete inventory',()=>{
  const {fresh,resolved}=tracking(),groups=new CaptureObservations();
  const before=new Uint8Array(3240).fill(100),after=before.slice();
  after.fill(104,864,2016);
  const first=groups.offerDetailed(before,2,10,true),second=groups.offerDetailed(after,2,10,true);
  assert.equal(first.decision,'new');assert.equal(second.decision,'new');assert.notEqual(first.id,second.id);
  const a=candidate(first.id,100,'pixels-a','fields-a'),b=candidate(second.id,110,'pixels-b','fields-b');
  const queue=new CandidateQueue<Candidate>(1,release,replacePendingCandidate);
  assert.equal(queue.push(a),true);
  fresh.remember(a.group,a.pixel,a.time,a.observation,a.field,true);
  assert.equal(queue.shift(),a);resolved.add(a.observation);fresh.finish(a.observation);release(a);
  assert.equal(fresh.unresolvedChanges(),0);
  const card:ScannedCard={id:'known-a',name:'단위 검증 카드',awakening:0,extraCopies:0,countReliable:true,
    confidence:1,review:[],image:'',time:1,observations:1,captureOrder:100};
  const completion=()=>({expected:1,finalExpected:1,cards:[card],latest:new Map([['known-a',100]]),
    confirmedNames:new Map([['known-a',100]]),confirmed:new Map([['known-a',100]]),inputSettled:true,
    headerAvailable:true,pending:0,unresolved:1,dropped:0,tailFresh:true,inputClosed:true,headerVerified:true,
    fieldChangesSettled:fresh.unresolvedChanges()===0});
  assert.equal(canFinishEndedCapture(completion()),true,'the old inventory otherwise satisfies the unmatched-input exception');
  assert.equal(queue.push(b),true);
  // No duplicate retry plan exists for a newly created group: every accepted
  // source needs proof independently of the visual grouping decision.
  fresh.remember(b.group,b.pixel,b.time,b.observation,b.field,true);
  assert.equal(fresh.unresolvedChanges(),1);
  assert.equal(queue.shift(),b);fresh.finish(b.observation);release(b);
  assert.equal(fresh.unresolvedChanges(),1,'a failed new-group reader cannot confirm a source through the old group');
  assert.equal(hasCompleteCaptureEvidence(completion()),false);
  assert.equal(canStopSharing(completion()),false);
  assert.equal(canFinishEndedCapture(completion()),false);
  assert.equal(canFinishVerifiedCapture(completion(),true),false);
  assert.equal(canSkipRecovery({...completion(),unresolved:0}),false);
  assert.equal(a.raster.releases,1);assert.equal(b.raster.releases,1);
});
