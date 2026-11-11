import {test} from 'node:test';
import assert from 'node:assert/strict';
import {orchestrateSessionFinalization} from '../src/features/card-scanner/session/session-orchestrator';
import type {DiscardableSessionState, FinalizableSessionState} from '../src/features/card-scanner/session/session-finalize';

type TestState = FinalizableSessionState & DiscardableSessionState;

function observation(order: number, reason?: string) {
  return {image: `data:image/png;base64,${order}`, time: order, pending: false, captureOrder: order, ...(reason === undefined ? {} : {reason})};
}

function state(overrides: Partial<TestState> = {}): TestState {
  return {unidentified: [], ...overrides};
}

test('finalization order is discard, counters, receipt/grid, status, emit', () => {
  const target = state({unidentified: [observation(1, '가림'), observation(2)], unresolvedObservations: 2, captureWarning: '이전'});
  const order: string[] = [];
  let seen: {discarded: number; names?: number; status?: string} = {discarded: -1};
  const result = orchestrateSessionFinalization({
    state: target,
    counters: {currentRunNames: 383, currentRunRead: 382, unresolvedFieldChanges: 1, unknownEvidenceLost: false},
    beforeFinalStatus: () => {
      order.push('receipt-grid');
      assert.deepEqual(target.unidentified, []);
      assert.equal(target.discardedObservations?.length, 2);
      assert.equal(target.currentRunNames, 383);
      assert.equal(target.currentRunRead, 382);
    },
    finalStatus: discarded => {
      order.push('status');
      seen = {discarded, names: target.currentRunNames, status: target.status};
      return '입력 처리 완료 · 표시 수량 일치';
    },
    drainInputLoss: false,
    captureWarning: '새 경고',
    emit: () => order.push('emit'),
  });
  assert.deepEqual(order, ['receipt-grid', 'status', 'emit']);
  assert.deepEqual(seen, {discarded: 2, names: 383, status: undefined});
  assert.equal(result.discardedCount, 2);
  assert.equal(result.status, '입력 처리 완료 · 표시 수량 일치');
  assert.equal(target.percent, 100);
  assert.equal(target.status, '입력 처리 완료 · 표시 수량 일치');
  assert.equal(target.captureWarning, '이전');
});

test('drain status receives its warning after the final status', () => {
  const target = state({captureWarning: '이전'});
  orchestrateSessionFinalization({
    state: target,
    counters: {currentRunNames: 0, currentRunRead: 0, unresolvedFieldChanges: 0, unknownEvidenceLost: true},
    beforeFinalStatus: () => {},
    finalStatus: () => '입력 손실',
    drainInputLoss: true,
    captureWarning: '새 경고',
    emit: () => {},
  });
  assert.equal(target.status, '입력 손실');
  assert.equal(target.captureWarning, '새 경고');
});

test('a receipt/grid failure prevents status and emit', () => {
  const target = state();
  const order: string[] = [];
  assert.throws(() => orchestrateSessionFinalization({
    state: target,
    counters: {currentRunNames: 1, currentRunRead: 1, unresolvedFieldChanges: 0, unknownEvidenceLost: false},
    beforeFinalStatus: () => { order.push('receipt-grid'); throw Error('grid failed'); },
    finalStatus: () => { order.push('status'); return 'should not run'; },
    drainInputLoss: false,
    emit: () => order.push('emit'),
  }), /grid failed/u);
  assert.deepEqual(order, ['receipt-grid']);
  assert.equal(target.status, undefined);
  assert.equal(target.percent, undefined);
});
