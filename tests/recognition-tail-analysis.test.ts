import {test} from 'node:test';
import assert from 'node:assert/strict';
import {analyzeRecognitionTail} from '../scripts/analyze-recognition-tail.mjs';

function fixture() {
  const events: {seq:number;time:number;type:string;value:unknown}[]=[];
  const add=(type:string,value:unknown,time=2)=>events.push({seq:events.length+1,time,type,value});
  const source=(observationId:string,sessionId='s')=>({sessionId,observationId});
  const capture=(observationId:string,group:number,revision:string,time=2,sessionId='s')=>{
    const s=source(observationId,sessionId);
    add('acquisition-capture',{...s,fieldRevision:revision},time);
    add('grid-command',{method:'group',args:[0,group,Number(observationId),true,null,s]},time);
    return s;
  };
  const read=(s:ReturnType<typeof source>,time=2)=>add('recognition-capture',{source:s,acquisition:s,identityPath:'visual-worker'},time);
  const identify=(group:number,id:string)=>add('grid-command',{method:'identify',args:[group,id]});
  return {events,add,capture,read,identify,run:()=>analyzeRecognitionTail({complete:true,dropped:0,events},1000)};
}

test('separates same-observation retry, changed fields and groups later linked to one card',()=>{
  const f=fixture(),a=f.capture('1',1,'a',.5);f.read(a,.5);
  f.read(a);f.read(f.capture('2',1,'b'));f.read(f.capture('3',2,'c'));
  f.identify(1,'card');f.identify(2,'card');
  const r=f.run();
  assert.equal(r.tailEvents,3);assert.equal(r.sameObservationRetry,1);
  assert.equal(r.sameFieldRevision,1);assert.equal(r.changedFieldRevision,1);
  assert.equal(r.firstGroupRead,1);assert.equal(r.repeatedGroupRead,2);
  assert.deepEqual(r.fragmentedCards,[{id:'card',groups:2,reads:3}]);
});

test('session-local observation IDs never join acquisitions from another session',()=>{
  const f=fixture();f.capture('1',1,'a',2,'first');
  f.read({sessionId:'second',observationId:'1'});
  const r=f.run();assert.equal(r.missingAcquisition,1);assert.equal(r.missingGroup,1);assert.equal(r.status,'partial');
});

test('conflicting identities are excluded from retrospective card counts',()=>{
  const f=fixture();f.read(f.capture('1',1,'a'));f.identify(1,'a');f.identify(1,'b');
  const r=f.run();assert.equal(r.groupsWithConflictingIdentity,1);assert.equal(r.identifiedTailCards,0);
});

test('cross-group field revisions stay session-scoped and do not infer identity',()=>{
  const f=fixture();
  f.read(f.capture('1',1,'shared',2,'a'));
  f.read(f.capture('2',2,'shared',2,'a'));
  f.read(f.capture('3',3,'shared',2,'b'));
  const r=f.run();
  assert.equal(r.crossGroupFieldRevisions.count,1);
  assert.equal(r.crossGroupFieldRevisions.groups,2);
  assert.equal(r.identifiedTailCards,0);
  assert.equal(r.groupsWithoutIdentity,3);
  assert.equal(fixture().run().crossGroupFieldRevisions,null);
});

test('missing diagnostics and partial traces cannot claim a zero-work successful measurement',()=>{
  const f=fixture();const empty=f.run();assert.equal(empty.status,'unmeasured');assert.equal(empty.tailGroupCount,null);
  f.read(f.capture('1',1,'a'));
  assert.equal(analyzeRecognitionTail({complete:false,dropped:1,events:f.events},1000).status,'partial');
  assert.throws(()=>analyzeRecognitionTail({complete:true,dropped:0,events:f.events},null));
  assert.throws(()=>analyzeRecognitionTail({complete:true,dropped:0,events:[...f.events].reverse()},1000));
});
