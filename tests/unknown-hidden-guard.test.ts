import {test} from 'node:test';
import assert from 'node:assert/strict';
import {UnknownLifecycle} from '../src/features/card-scanner/session/unknown-lifecycle';
import {UNKNOWN_LIFECYCLE_LIMITS,type UnknownUpsert} from '../src/features/card-scanner/session/unknown-lifecycle-types';
import type {ObservationSource} from '../src/features/card-scanner/session/observation-execution';
import {HiddenUnknownGuard,hiddenUnknownEnabled,type HiddenDiagnosticEvent} from '../src/features/card-scanner/session/unknown-hidden-guard';
import {parseScannerExperiment} from '../dev/latest-pixel-gate-report';

const key={kind:'group' as const,sessionId:'s',group:7};
const source=(id:string,n:number):ObservationSource=>({sessionId:'s',frameId:n,observationId:id,captureOrder:n,captureTime:n,phase:'input',slot:0});
const warning=(s:ObservationSource,pending=false):UnknownUpsert=>({version:1,kind:'upsert',key,source:s,captureOrder:s.captureOrder,
  captureTime:s.captureTime,pending,reason:'이름 확인',location:null});
function state(record?:(event:HiddenDiagnosticEvent)=>boolean){
  const legacy=new UnknownLifecycle({version:1,sessionId:'s',origin:'scan',limits:UNKNOWN_LIFECYCLE_LIMITS});
  const guard=new HiddenUnknownGuard('s',{record});
  return {legacy,guard,fail(s:ObservationSource,pending=false){
    const f=warning(s,pending),previous=legacy.active().find(x=>x.key.kind==='group'&&x.key.group===key.group),effect=legacy.apply(f);
    guard.groupEffect(f,previous,effect);
  },confirm(s:ObservationSource,id='card',review:string[]=[]){
    guard.confirmed(key,s,id,review);
    const effect=legacy.confirmName(key,id,s,review);
    if(effect)guard.groupEffect(null,undefined,effect);
  }};
}

test('DEV opt-in rejects ambiguous flags and defaults to off',()=>{
 assert.equal(parseScannerExperiment('','hiddenUnknownProbe'),false);
 assert.equal(parseScannerExperiment('?hiddenUnknownProbe=0','hiddenUnknownProbe'),false);
 assert.equal(parseScannerExperiment('?hiddenUnknownProbe=1','hiddenUnknownProbe'),true);
 assert.throws(()=>parseScannerExperiment('?hiddenUnknownProbe=1&hiddenUnknownProbe=1','hiddenUnknownProbe'));
 assert.throws(()=>parseScannerExperiment('?hiddenUnknownProbe=true','hiddenUnknownProbe'));
 assert.equal(hiddenUnknownEnabled(true,undefined),false);
 assert.equal(hiddenUnknownEnabled(true,true),true);
 assert.equal(hiddenUnknownEnabled(false,true),false,'production ignores even an explicit flag');
});
test('distinct fuzzy-group success cannot erase a hidden failure; exact source can',()=>{
 const t=state(),a=source('a',1),b=source('b',2);t.fail(a);t.confirm(b);
 assert.equal(t.legacy.active().length,0);assert.equal(t.guard.summary().active,1);
 t.confirm(a);assert.equal(t.guard.summary().active,0);
});
test('a late, older hidden failure stays unresolved and does not alter v1 state',()=>{
 const t=state(),a=source('a',1),b=source('b',2);t.confirm(b);t.fail(a);
 assert.equal(t.legacy.active().length,0);assert.equal(t.guard.summary().active,1);
 t.confirm(a);assert.equal(t.guard.summary().active,0);
});
test('replaced final entries persist; same-source pending and repeats are not invented failures',()=>{
 const t=state(),a=source('a',1),b=source('b',2);t.fail(a,true);t.fail(a);t.fail(a);assert.equal(t.guard.summary().active,0);
 t.fail(b);assert.equal(t.guard.summary().active,1);t.confirm(b);assert.equal(t.guard.summary().active,1);
 t.confirm(a);assert.equal(t.guard.summary().active,0);
});
test('unreported final failure is traceable and uncertain reviews never clear it',()=>{
 const events:HiddenDiagnosticEvent[]=[],g=new HiddenUnknownGuard('s',{record:e=>{events.push(e);return true;}}),a=source('a',1);
 g.failure(warning(a),'unreported');g.confirmed(key,a,'a',['이름 확인']);assert.equal(g.summary().active,1);
 g.confirmed(key,a,'a',[]);assert.equal(g.summary().active,0);
 assert.deepEqual(events.map(e=>e.kind),['seed','failure','confirmed']);
 assert.equal(g.summary().recording,'complete');assert.equal(g.summary().admitted,3);
 assert.doesNotMatch(JSON.stringify(events),/data:image|recognitionImage|pixelKey/);
});
test('recording absence, event rejection, exceptions and event caps are not success',()=>{
 const noSink=new HiddenUnknownGuard('s');assert.equal(noSink.summary().recording,'not-requested');
 const rejected=new HiddenUnknownGuard('s',{record:()=>false});rejected.failure(warning(source('a',1)),'unreported');
 assert.equal(rejected.summary().recording,'partial');assert.equal(rejected.summary().active,1);
 const failed=new HiddenUnknownGuard('s',{record:()=>{throw Error('sink');}});assert.equal(failed.summary().recording,'partial');
 const limited=new HiddenUnknownGuard('s',{events:1,record:()=>true});limited.failure(warning(source('a',1)),'unreported');
 limited.confirmed(key,source('a',1),'a',[]);assert.equal(limited.summary().recording,'partial');assert.equal(limited.summary().active,0);
 assert.equal(limited.summary().admitted,1);
});
test('proof and active overflow plus contradictory identities remain lost',()=>{
 const a=source('a',1),b=source('b',2),g=new HiddenUnknownGuard('s',{active:1,proofs:2});
 g.failure(warning(a),'unreported');g.failure(warning(b),'unreported');g.confirmed(key,a,'a',[]);assert.equal(g.summary().evidenceLost,true);
 const h=new HiddenUnknownGuard('s');h.confirmed(key,a,'a',[]);h.confirmed(key,a,'b',[]);assert.equal(h.summary().evidenceLost,true);
 const i=new HiddenUnknownGuard('s',{proofs:1});i.confirmed(key,a,'a',[]);i.confirmed(key,b,'b',[]);assert.equal(i.summary().evidenceLost,true);
});
