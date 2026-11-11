import { test } from "node:test";
import assert from "node:assert/strict";
import { canConfirmScanGrid, scanCompletion } from "../src/features/card-scanner/session/completion";

test('seed count cannot certify names that were not seen in this scan',()=>{
  assert.match(scanCompletion(394,394,0,40),/354종 이번 스캔 확인 필요/);
  assert.match(scanCompletion(394,394,0,394),/표시 수량 일치/);
});

test("input completion distinguishes missing, excess, unreadable quantity and field review", () => {
  assert.match(scanCompletion(null, 40, 0), /수량 확인 필요/);
  assert.match(scanCompletion(385, 384, 2), /1종 추가 수집 필요/);
  assert.match(scanCompletion(384, 385, 0), /1종 많음/);
  assert.match(scanCompletion(384, 384, 2), /2종 판독 확인 필요/);
  assert.equal(scanCompletion(384, 384, 0), "입력 처리 완료 · 표시 수량 일치");
  assert.equal(scanCompletion(0, 0, 0), "입력 처리 완료 · 표시 수량 일치");
});

test('offline and still completion cannot hide unidentified inputs behind matching inventory totals',()=>{
  assert.equal(scanCompletion(384,384,0,384,1),'입력 처리 완료 · 표시 수량 일치 · 미식별 입력 1개 확인 필요');
  assert.match(scanCompletion(384,383,1,383,86),/1종 추가 수집 필요 · 미식별 입력 86개 확인 필요$/);
  assert.match(scanCompletion(null,40,0,40,2),/보관함 수량 확인 필요 · 미식별 입력 2개 확인 필요$/);
});

test('final grid restoration does not mark unmatched observations as confirmed',()=>{
 const state={expected:1,currentRunRead:1,unresolvedFieldChanges:0,unidentified:[],unresolvedGroups:0,droppedFrames:0,cards:[{review:[]}]};
 assert.equal(canConfirmScanGrid(state),true);
 assert.equal(canConfirmScanGrid({...state,unidentified:[{pending:false}]}),false);
 assert.equal(canConfirmScanGrid({...state,unresolvedGroups:1}),false);
 assert.equal(canConfirmScanGrid({...state,unresolvedFieldChanges:1}),false);
 assert.equal(canConfirmScanGrid({...state,unresolvedFieldChanges:undefined}),false,'unknown diagnostic is not a zero');
 assert.equal(canConfirmScanGrid({...state,cards:[{review:['이름 확인']}]}),false);
 assert.equal(canConfirmScanGrid({...state,currentRunRead:0}),false);
});

test('source-scoped unresolved evidence blocks final grid restoration without changing legacy callers',()=>{
 const state={expected:1,currentRunRead:1,unresolvedFieldChanges:0,unidentified:[],unresolvedGroups:0,droppedFrames:0,cards:[{review:[]}]};
 assert.equal(canConfirmScanGrid(state),true,'v1 and legacy callers do not have source evidence');
 assert.equal(canConfirmScanGrid({...state,unresolvedSourceEvidence:undefined}),true);
 assert.equal(canConfirmScanGrid({...state,unresolvedSourceEvidence:0}),true);
 for(const value of [1,-1,NaN,Infinity,null])
  assert.equal(canConfirmScanGrid({...state,unresolvedSourceEvidence:value} as Parameters<typeof canConfirmScanGrid>[0]),false);
});

test('lost source evidence is explained separately from a known unresolved input count',()=>{
 assert.equal(scanCompletion(1,1,0,1,0,true),
  '입력 처리 완료 · 표시 수량 일치 · 카드 확인 근거 손실 · 새 스캔 필요');
 assert.match(scanCompletion(1,1,0,1,2,true),/미식별 입력 2개 확인 필요 · 카드 확인 근거 손실/);
 assert.equal(scanCompletion(1,1,0,1),'입력 처리 완료 · 표시 수량 일치');
});

test('a dropped input never produces an all-confirmed grid even when the card total matches',()=>{
 const state={expected:1,currentRunRead:1,unresolvedFieldChanges:0,unidentified:[],unresolvedGroups:0,droppedFrames:0,cards:[{review:[]}]};
 assert.equal(canConfirmScanGrid(state),true,'a new scan starts with an explicit zero');
 for(const droppedFrames of [1,-1,NaN,Infinity,undefined,null]){
  assert.equal(canConfirmScanGrid({...state,droppedFrames} as Parameters<typeof canConfirmScanGrid>[0]),false,`droppedFrames=${String(droppedFrames)}`);
 }
});
