import {test} from 'node:test';
import assert from 'node:assert/strict';
import {HiddenUnknownGuard,type HiddenDiagnosticEvent} from '../src/features/card-scanner/session/unknown-hidden-guard';
import {HiddenGuardReplay,hiddenGuardEventHash,hiddenGuardStateHash} from '../src/features/card-scanner/reproduction/unknown-hidden-replay';
import type {ObservationSource} from '../src/features/card-scanner/session/observation-execution';
import type {UnknownUpsert} from '../src/features/card-scanner/session/unknown-lifecycle-types';

const key={kind:'group' as const,sessionId:'s',group:7};
const source=(id:string,n:number):ObservationSource=>({sessionId:'s',frameId:n,observationId:id,
  captureOrder:n,captureTime:n,phase:'input',slot:0});
const warning=(s:ObservationSource):UnknownUpsert=>({version:1,kind:'upsert',key,source:s,
  captureOrder:s.captureOrder,captureTime:s.captureTime,pending:false,reason:'이름 확인',location:null});
function recorded(limits:{active?:number;proofs?:number;events?:number}={}){
  const events:HiddenDiagnosticEvent[]=[];
  const guard=new HiddenUnknownGuard('s',{...limits,record:event=>{events.push(event);return true;}});
  return {events,guard};
}
async function replay(events:HiddenDiagnosticEvent[]){
  const result=new HiddenGuardReplay();
  for(let i=0;i<events.length;i++)await result.accept(i+1,events[i]);
  return result;
}
async function checkpoint(guard:HiddenUnknownGuard,r:HiddenGuardReplay,complete=true){
  return {version:1 as const,events:r.summary.events,eventHash:r.summary.eventHash,
    stateHash:await hiddenGuardStateHash(guard),complete};
}
test('ordered events reproduce source-bound hidden failures and exact-source resolution',async()=>{
  const {guard,events}=recorded(),a=source('a',1),b=source('b',2);
  guard.failure(warning(a),'unreported');guard.confirmed(key,b,'card',[]);
  const r=await replay(events),before=await checkpoint(guard,r);
  assert.equal(await r.checkpoint(before),true);assert.equal(r.summary.active,1);
  guard.confirmed(key,a,'card',[]);await r.accept(events.length,events.at(-1));
  assert.equal(r.summary.matchesCheckpoint,null,'a later event invalidates the old checkpoint');
  assert.equal(await r.checkpoint(before),false);
  assert.equal(await r.checkpoint(await checkpoint(guard,r)),true);assert.equal(r.summary.active,0);
});
test('producer event chain matches replay while source contents and sequence remain bound',async()=>{
  const {guard,events}=recorded(),a=source('a',1);guard.failure(warning(a),'retired');guard.confirmed(key,a,'card',[]);
  let producer='0'.repeat(64);
  for(let i=0;i<events.length;i++)producer=await hiddenGuardEventHash(producer,i+1,events[i]);
  const r=await replay(events);assert.equal(r.summary.eventHash,producer);
  assert.equal(await r.checkpoint({version:1,events:events.length,eventHash:producer,
    stateHash:await hiddenGuardStateHash(guard),complete:true}),true);
});
test('same totals with different proof sources have different state hashes and later behavior',async()=>{
  const a=source('a',1),b=source('b',2),left=recorded(),right=recorded();
  left.guard.confirmed(key,a,'card',[]);right.guard.confirmed(key,b,'card',[]);
  assert.deepEqual(left.guard.summary(),right.guard.summary());
  assert.notEqual(await hiddenGuardStateHash(left.guard),await hiddenGuardStateHash(right.guard));
  left.guard.failure(warning(a),'unreported');right.guard.failure(warning(a),'unreported');
  assert.equal(left.guard.summary().active,0);assert.equal(right.guard.summary().active,1);
});
test('missing, duplicate, reordered, changed and incomplete events do not verify',async()=>{
  const {guard,events}=recorded();guard.failure(warning(source('a',1)),'unreported');guard.confirmed(key,source('b',2),'card',[]);
  const r=await replay(events),good=await checkpoint(guard,r);
  assert.equal(await r.checkpoint({...good,complete:false}),null);
  assert.equal(await r.checkpoint({...good,eventHash:'f'.repeat(64)}),false);
  assert.equal(await r.checkpoint({...good,stateHash:'f'.repeat(64)}),false);
  const altered=await replay([events[0],events[2],events[1]]);
  assert.notEqual(altered.summary.eventHash,good.eventHash);
  assert.equal(await altered.checkpoint(good),false);
  const missing=await replay([events[0],events[2]]);assert.equal(await missing.checkpoint(good),false);
  await assert.rejects(missing.accept(2,events[1]));assert.equal(missing.summary.invalid,true);
});
test('limit and identity conflict remain sticky and replayable; recording failure is separate',async()=>{
  const a=source('a',1),b=source('b',2),limited=recorded({active:1,proofs:2});
  limited.guard.failure(warning(a),'unreported');limited.guard.failure(warning(b),'unreported');
  limited.guard.confirmed(key,a,'card',[]);
  const r=await replay(limited.events);assert.equal(r.summary.evidenceLost,true);
  assert.equal(await r.checkpoint(await checkpoint(limited.guard,r)),true);
  const conflict=recorded();conflict.guard.confirmed(key,a,'first',[]);conflict.guard.confirmed(key,a,'second',[]);
  assert.equal((await replay(conflict.events)).summary.evidenceLost,true);
  const proofLimit=recorded({proofs:1});proofLimit.guard.confirmed(key,a,'card',[]);proofLimit.guard.confirmed(key,b,'card',[]);
  assert.equal((await replay(proofLimit.events)).summary.evidenceLost,true);
  const lost=new HiddenUnknownGuard('s',{record:()=>false});lost.failure(warning(a),'unreported');
  assert.equal(lost.summary().recording,'partial');assert.equal(lost.summary().evidenceLost,false);
});
test('malformed or concurrent inputs never produce a verified checkpoint',async()=>{
  const {events}=recorded(),r=new HiddenGuardReplay();
  await assert.rejects(r.accept(2,events[0]));assert.equal(r.summary.invalid,true);
  const concurrent=new HiddenGuardReplay(),first=concurrent.accept(1,events[0]);
  await assert.rejects(concurrent.accept(1,events[0]));await first;
  assert.equal(concurrent.summary.invalid,true);assert.equal(await concurrent.checkpoint({}),null);
  const bad=await replay(events);assert.equal(await bad.checkpoint({version:1}),null);assert.equal(bad.summary.invalid,true);
});
test('replay hashes the guard-emitted event and rejects a changing producer value',async()=>{
  const {events}=recorded(),r=await replay(events),fact=warning(source('a',1));
  let reads=0;
  Object.defineProperty(fact,'reason',{enumerable:true,get:()=>++reads===1?'first':'changed'});
  await assert.rejects(r.accept(2,{version:1,kind:'failure',reason:'unreported',fact}),/Hidden event mismatch/);
  assert.equal(r.summary.invalid,true);
});
test('a previous matching checkpoint is not reported while a new checkpoint is being verified',async()=>{
  const {guard,events}=recorded(),r=await replay(events),good=await checkpoint(guard,r);
  assert.equal(await r.checkpoint(good),true);
  const next=r.checkpoint({...good,stateHash:'f'.repeat(64)});
  assert.equal(r.summary.matchesCheckpoint,null);
  assert.equal(await next,false);
  assert.equal(r.summary.matchesCheckpoint,false);
});
test('checkpoint verification snapshots its data before asynchronous hashing',async()=>{
  const {guard,events}=recorded(),r=await replay(events),good=await checkpoint(guard,r);
  const changed={...good,eventHash:'f'.repeat(64)};
  const pending=r.checkpoint(changed);changed.eventHash=good.eventHash;
  assert.equal(await pending,false);
  const accessor={...good};Object.defineProperty(accessor,'stateHash',{enumerable:true,get:()=>good.stateHash});
  assert.equal(await r.checkpoint(accessor),null);
  assert.equal(r.summary.invalid,true);
});
test('overlapping checkpoints invalidate the replay even when the later one is incomplete',async()=>{
  const {guard,events}=recorded(),r=await replay(events),good=await checkpoint(guard,r);
  const first=r.checkpoint(good);
  assert.equal(await r.checkpoint({...good,complete:false}),null);
  assert.equal(await first,null);
  assert.equal(r.summary.invalid,true);
  assert.equal(r.summary.matchesCheckpoint,null);
});
