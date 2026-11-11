import {test} from 'node:test';
import assert from 'node:assert/strict';
import {evaluateGapRecovery,type GapBoundary,type GapCandidate,type GapInventory,type GapRead,type GapSource,type GapVerifier} from '../src/features/card-scanner/session/gap-recovery-experiment';

// A fabricated verifier exercises reducer rules, not real source authenticity.
const src=(frame:string,order:number,slot=0):GapSource=>({sessionId:'s',accountEpoch:'a',sortEpoch:'sort',frameId:frame,
 observationId:`observation-${frame}-${slot}`,slot,captureOrder:order,captureTime:order});
const gap:GapBoundary={kind:'gap',source:src('gap-end',10)};
const inventory:GapInventory={sessionId:'s',accountEpoch:'a',sortEpoch:'sort',ids:['card-a','card-b'],complete:true};
const read=(id:string,frame:string,order:number,slot=0):GapRead=>({source:src(frame,order,slot),id,directName:true,
 usable:true,awakening:1,copies:4,fieldEvidence:'single'});
const a=read('card-a','f11',11),b=read('card-b','f12',12,1);
const verifier:GapVerifier={verifyBoundary:x=>x as GapBoundary,verifyInventory:x=>x as GapInventory,verifyRead:x=>x as GapRead};
const candidates=(first:GapRead=a,second:GapRead=b):GapCandidate[]=>[{id:'card-a',primary:first},{id:'card-b',primary:second}];
const run=(events:unknown[]=[gap],inv:unknown=inventory,items:GapCandidate[]=candidates())=>evaluateGapRecovery(events,inv,items,verifier);

test('no verifier or independent complete inventory cannot clear a gap',()=>{
 assert.equal(evaluateGapRecovery([gap],inventory,candidates()).reason,'source verifier unavailable');
 assert.equal(run([],inventory).reason,'gap boundary missing or exceeds limit');
 assert.equal(run([gap],{...inventory,complete:false}).reason,'unverified complete inventory');
 assert.equal(run([gap],{...inventory,ids:['card-a','card-a']}).reason,'unverified complete inventory');
 assert.equal(run([gap],inventory,[]).reason,'incomplete sweep');
 assert.equal(run().status,'conditional','the fake verifier only makes a conditional external claim');
});

test('old results, same capture time/frame, and foreign sessions or epochs are not new observations',()=>{
 const variants=[{...a,source:src('old',9)},{...a,source:{...a.source,captureTime:10}},
  {...a,source:{...a.source,frameId:'gap-end'}},{...a,source:{...a.source,sessionId:'other'}},
  {...a,source:{...a.source,accountEpoch:'other'}},{...a,source:{...a.source,sortEpoch:'other'}}];
 for(const variant of variants)assert.equal(run([gap],inventory,candidates(variant)).reason,'unverified direct reading');
});

test('a newer obstruction raises the barrier even if the view later looks identical',()=>{
 const obstruction:GapBoundary={kind:'obstruction',source:src('tooltip',20)};
 assert.equal(run([gap,obstruction]).reason,'unverified direct reading');
 const newerGap:GapBoundary={kind:'gap',source:src('second-gap-end',20)};
 assert.equal(run([gap,newerGap]).reason,'unverified direct reading','a second gap invalidates an earlier sweep');
 assert.equal(run([gap,obstruction],inventory,candidates(read('card-a','same-looking-21',21),read('card-b','same-looking-22',22,1))).status,'conditional');
 assert.equal(run([obstruction,gap]).reason,'boundary chronology mismatch');
});

test('sort change, malformed or other epoch boundaries demand a new sweep',()=>{
 assert.equal(run([gap,{kind:'sort-change',source:src('sort-changed',11)}]).reason,'sort changed; new sweep required');
 assert.equal(run([gap,{kind:'obstruction',source:{...src('other',11),sortEpoch:'another'}}]).reason,'boundary epoch mismatch');
 assert.equal(run([gap,{kind:'obstruction',source:{...src('other',11),captureOrder:10}}]).reason,'boundary chronology mismatch');
 assert.equal(run([gap,{kind:'obstruction',source:null}]).reason,'unverified boundary');
 assert.equal(run([gap],{...inventory,sessionId:'foreign'}).reason,'unverified complete inventory');
 assert.equal(run([gap],{...inventory,sortEpoch:'foreign'}).reason,'unverified complete inventory');
});

test('identity, valid card fields and source ownership must be independently established',()=>{
 for(const bad of [{...a,directName:false},{...a,usable:false},{...a,id:'card-b'},
  {...a,awakening:4,copies:10},{...a,copies:-1}])assert.equal(run([gap],inventory,candidates(bad)).status,'unresolved');
 const sameSlot={...b,source:{...a.source,observationId:'other-observation'}};
 assert.equal(run([gap],inventory,candidates(a,sameSlot)).reason,'unverified direct reading');
 assert.equal(run([gap],inventory,[{id:'card-a',primary:a},{id:'card-a',primary:a}]).reason,'candidate identity mismatch');
});

test('repeat evidence needs different, later source and matching field values',()=>{
 const first={...a,fieldEvidence:'repeat' as const},items=(other:GapRead):GapCandidate[]=>[
  {id:'card-a',primary:first,corroboration:other},{id:'card-b',primary:b}];
 assert.equal(run([gap],inventory,items(first)).reason,'unverified independent repetition');
 assert.equal(run([gap],inventory,items({...first,source:src('f13',13),copies:5})).reason,'unverified independent repetition');
 assert.equal(run([gap],inventory,items({...first,source:src('f13',13)})).status,'conditional');
});

test('verifier failure never clears the gap',()=>{
 assert.equal(evaluateGapRecovery([gap],inventory,candidates(),{...verifier,verifyRead:()=>{throw Error('failed');}}).reason,'verification failed');
});
