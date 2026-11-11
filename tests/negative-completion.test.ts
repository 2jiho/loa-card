import test from 'node:test';
import assert from 'node:assert/strict';
import {negativeCompletionReasons} from '../src/features/card-scanner/session/negative-completion';
import type {ScannerState} from '../src/features/card-scanner/orchestration/scanner';

const clean=()=>({status:'판독 종료',expected:1,currentRunNames:1,currentRunRead:1,unidentified:[],unresolvedObservations:0,
 unresolvedFieldChanges:0,droppedFrames:0,queued:0,activeReadings:0,cards:[{id:'a',name:'a',awakening:0,extraCopies:0,review:[],countReliable:true}]} as unknown as ScannerState);

test('known negative or missing facts are rejected; no-negative is not positive proof',()=>{
 assert.deepEqual(negativeCompletionReasons(clean()),[]); // only no negative facts, not a receipt
 const patches=[{expected:null},{currentRunNames:undefined},{currentRunRead:0},
  {unidentified:[{pending:true}]},{unresolvedObservations:2},{unresolvedObservations:undefined},
  {unresolvedFieldChanges:2},{unresolvedFieldChanges:undefined},{unknownEvidenceLost:true},{drainInputLoss:{reason:'test'}},
  {droppedFrames:1},{droppedFrames:undefined},{queued:1},{activeReadings:1},
  {cards:[{id:'a',name:'a',awakening:null,extraCopies:0,review:[]}]},
  {cards:[{id:'a',name:'a',awakening:0,extraCopies:null,review:[]}]},
  {cards:[{id:'a',name:'a',awakening:0,extraCopies:0,review:['장수 확인']}]},
  {cards:[{id:'a',name:'a',awakening:4,extraCopies:10,review:[]}]},
  {cards:[{id:'a',name:'a',awakening:0,extraCopies:0,review:[]},{id:'stale',name:'stale',awakening:0,extraCopies:0,review:[]}]},
  {expected:2,currentRunNames:2,currentRunRead:2,cards:[{id:'a',name:'a',awakening:0,extraCopies:0,review:[]},{id:'a',name:'a',awakening:0,extraCopies:0,review:[]}]},
  {interrupted:'failed'}];
 for(const patch of patches)assert.ok(negativeCompletionReasons({...clean(),...patch} as ScannerState).length,JSON.stringify(patch));
});

test('discarded observations are recognition-needed, not unresolved',()=>{
 const reasons=negativeCompletionReasons({...clean(),unidentified:[],
  discardedObservations:[{image:'data:image/png;base64,a',time:1,pending:false,reason:'판독 불가'},
   {image:'data:image/png;base64,b',time:2,pending:false,reason:'카드 뒷면'}]} as ScannerState);
 assert.ok(reasons.includes('인식 필요 2건'));
 assert.equal(reasons.some(reason=>reason.includes('미식별')),false);
});

test('positively obstructed slots are reported as recognition-needed without inventing a card',()=>{
 const reasons=negativeCompletionReasons({...clean(),recognitionNeeded:[
   {slot:3,captureTime:10,reason:'툴팁 패널 가림'},
   {slot:14,captureTime:12,reason:'커서 가림'}]} as ScannerState);
 assert.ok(reasons.includes('인식 필요 2칸'));
 assert.equal(reasons.some(reason=>reason.includes('카드 값 확인 필요')),false);
});

test('a field-only shortage is not reported as missing card identities',()=>{
 const card={id:'a',name:'a',awakening:0,extraCopies:0,review:[],countReliable:true};
 const fieldOnly=negativeCompletionReasons({...clean(),expected:2,currentRunNames:2,currentRunRead:1,
  cards:[card,{...card,id:'b',name:'b',review:['장수 확인']}]} as ScannerState);
 assert.ok(fieldOnly.includes('1종 각성·장수 확인 필요'));
 assert.equal(fieldOnly.some(reason=>reason.includes('종 부족')),false);
 const identityMissing=negativeCompletionReasons({...clean(),expected:2,currentRunNames:1,currentRunRead:1,
  cards:[card]} as ScannerState);
 assert.ok(identityMissing.includes('1종 부족'));
});

