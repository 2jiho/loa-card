import {test} from 'node:test';
import assert from 'node:assert/strict';
import {rowCompletionGaps,rowScannerState} from '../src/features/card-scanner/orchestration/row-scanner-state';
import type {RowScanSnapshot} from '../src/features/card-scanner/orchestration/row-scan';
import {completionReasons} from '../src/features/card-scanner/session/positive-completion';
import type {ScannedCard} from '../src/features/card-scanner/recognition/recognizer-types';

const card=(index:number):ScannedCard=>({id:String(1000+index),name:`카드${index}`,awakening:1,extraCopies:2,confidence:1,review:[],image:'',time:index,
  observations:2,countReliable:true} as unknown as ScannedCard);
const snapshot=(change:Partial<RowScanSnapshot>={}):RowScanSnapshot=>({phase:'done',frames:100,locatedFrames:90,located:true,waitingFrames:0,droppedFrames:0,
  waitingReads:0,cards:[card(1),card(2),card(3)],confirmed:3,expected:3,capacity:450,finalExpected:3,unidentifiedCells:0,guidance:{asks:[],notes:[]},...change});

test('a finished scan with the total verified at the end and every card confirmed is complete', () => {
  const state=rowScannerState(snapshot());
  assert.deepEqual(state.completionReceipt,{version:1,mode:'ended',expected:3,finalExpected:3});
  assert.deepEqual(completionReasons(state),[]);
  assert.equal(state.percent,100);
});

test('a matching count alone does not complete the scan', () => {
  // Three cards named for a total of three, but one is not confirmed.
  const state=rowScannerState(snapshot({confirmed:2}));
  assert.equal(state.completionReceipt,undefined);
  assert.deepEqual(rowCompletionGaps(snapshot({confirmed:2})),['1종 각성·장수 확인 필요']);
  assert.ok(completionReasons(state).length>0);
});

test('the total must be read, and read again with the same value at the end', () => {
  assert.deepEqual(rowCompletionGaps(snapshot({expected:null,finalExpected:null})),['표시 수량 미확인']);
  assert.deepEqual(rowCompletionGaps(snapshot({finalExpected:null})),['끝에서 표시 수량을 다시 읽지 못함']);
  assert.deepEqual(rowCompletionGaps(snapshot({finalExpected:4})),['표시 수량이 바뀜 (3 → 4)']);
  assert.equal(rowScannerState(snapshot({finalExpected:4})).completionReceipt,undefined);
});

test('missing cards, unnamed cells and waiting work each keep the scan incomplete', () => {
  assert.deepEqual(rowCompletionGaps(snapshot({cards:[card(1),card(2)],confirmed:2})),['1종 부족']);
  assert.deepEqual(rowCompletionGaps(snapshot({unidentifiedCells:2})),['이름을 읽지 못한 칸 2개']);
  assert.deepEqual(rowCompletionGaps(snapshot({waitingReads:1})),['판독 작업 미완료']);
  for(const change of [{unidentifiedCells:2},{waitingReads:1}])
    assert.equal(rowScannerState(snapshot(change)).completionReceipt,undefined);
});

test('frames passed over in the line are reported as missed frames and do not block completion', () => {
  const state=rowScannerState(snapshot({droppedFrames:337}));
  assert.deepEqual(rowCompletionGaps(snapshot({droppedFrames:337})),[]);
  assert.deepEqual(state.completionReceipt,{version:1,mode:'ended',expected:3,finalExpected:3});
  assert.equal(state.droppedFrames,0);
  assert.equal(state.liveMissedFrames,337);
  assert.ok(state.status.includes('읽지 않고 넘긴 화면 337장'));
  assert.deepEqual(completionReasons(state),[]);
  // The other conditions still decide: passed-over frames never complete a scan by themselves.
  assert.equal(rowScannerState(snapshot({droppedFrames:337,confirmed:2})).completionReceipt,undefined);
});

test('nothing is complete before everything was read', () => {
  const state=rowScannerState(snapshot({phase:'capture'}));
  assert.equal(state.completionReceipt,undefined);
  assert.equal(state.workPhase,'capture');
  assert.ok(state.percent<100);
});
