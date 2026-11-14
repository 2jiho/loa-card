import test from 'node:test';
import assert from 'node:assert/strict';
import {issuePositiveCompletionReceipt,completionReasons,type ReceiptEvidence} from '../src/features/card-scanner/session/positive-completion';
import {negativeCompletionReasons} from '../src/features/card-scanner/session/negative-completion';
import type {ScannerState} from '../src/features/card-scanner/orchestration/scanner';
import type {ScannedCard} from '../src/features/card-scanner/recognition/recognizer';

const card:ScannedCard={id:'a',name:'카드',awakening:0,extraCopies:0,countReliable:true,
 confidence:1,review:[],image:'',time:1,observations:1,captureOrder:20};
const evidence=():ReceiptEvidence=>({mode:'ended',expected:1,finalExpected:1,cards:[card],
 latest:new Map([['a',20]]),confirmed:new Map([['a',20]]),confirmedNames:new Map([['a',20]]),
 pending:0,unresolved:0,dropped:0,inputSettled:true,tailFresh:true,fieldChangesSettled:true,
 headerAvailable:true,inputClosed:true,headerVerified:true,headerCaptureOrder:20});
const state=()=>({status:'판독 종료',expected:1,currentRunNames:1,currentRunRead:1,unidentified:[],unresolvedObservations:0,
 unresolvedFieldChanges:0,droppedFrames:0,queued:0,activeReadings:0,cards:[card]} as unknown as ScannerState);

test('manual and automatic completion both need positive final evidence',()=>{
 assert.deepEqual(negativeCompletionReasons(state()),[]);
 assert.deepEqual(completionReasons(state()),['스캔을 끝까지 확인하지 못했어요.']);
 for(const mode of ['ended','auto'] as const){
  const receipt=issuePositiveCompletionReceipt({...evidence(),mode});
  assert.deepEqual(receipt,{version:1,mode,expected:1,finalExpected:1});
  assert.deepEqual(completionReasons({...state(),completionReceipt:receipt}),[]);
 }
});

test('missing or changed final header blocks completion even when every known negative is absent',()=>{
 for(const change of [{finalExpected:null},{finalExpected:2},{headerAvailable:false},{headerVerified:false},{tailFresh:false},
  {expected:null},{inputClosed:false},{inputSettled:false}])
  assert.equal(issuePositiveCompletionReceipt({...evidence(),...change}),undefined,JSON.stringify(change));
 for(const change of [{expected:2},{finalExpected:2},{version:2},{mode:'other'}]){
  const receipt={version:1,mode:'ended',expected:1,finalExpected:1,...change} as ScannerState['completionReceipt'];
  assert.ok(completionReasons({...state(),completionReceipt:receipt}).includes('스캔을 끝까지 확인하지 못했어요.'));
 }
});

test('latest name and fields, unknowns, dropped inputs and unfinished work block completion',()=>{
 for(const change of [{latest:new Map([['a',21]])},{confirmedNames:new Map([['a',19]])},{confirmed:new Map([['a',19]])},
  {pending:1},{unresolved:1},{dropped:1},{fieldChangesSettled:false},
  {cards:[{...card,extraCopies:null}]},{cards:[{...card,review:['이름 확인']}]}])
  assert.equal(issuePositiveCompletionReceipt({...evidence(),...change}),undefined);
 const receipt=issuePositiveCompletionReceipt(evidence());
 for(const change of [{unknownEvidenceLost:true},{unresolvedObservations:1},{unresolvedFieldChanges:1},{droppedFrames:1},{interrupted:'failed'}])
  assert.ok(completionReasons({...state(),completionReceipt:receipt,...change} as ScannerState).length>0);
});

test('a later recovery observation invalidates an older final header',()=>{
 assert.ok(issuePositiveCompletionReceipt(evidence()));
 assert.equal(issuePositiveCompletionReceipt({...evidence(),headerCaptureOrder:19}),undefined);
 assert.equal(issuePositiveCompletionReceipt({...evidence(),headerCaptureOrder:NaN}),undefined);
 const later={...evidence(),latest:new Map([['a',21]]),confirmed:new Map([['a',21]]),confirmedNames:new Map([['a',21]])};
 assert.equal(issuePositiveCompletionReceipt(later),undefined);
 assert.ok(issuePositiveCompletionReceipt({...later,headerCaptureOrder:21}));
});
