import {test} from 'node:test';
import assert from 'node:assert/strict';
import {
  applyFinalCounters,
  applyFinalStatus,
  discardFinalObservations,
  type DiscardableSessionState,
  type FinalizableSessionState,
} from '../src/features/card-scanner/session/session-finalize';

type TestState = FinalizableSessionState & DiscardableSessionState;

function observation(order: number, reason?: string) {
  return {image: `data:image/png;base64,${order}`, time: order, pending: false, captureOrder: order, ...(reason === undefined ? {} : {reason})};
}

function state(overrides: Partial<TestState> = {}): TestState {
  return {unidentified: [], ...overrides};
}

test('discarding final observations clears unresolved state without creating cards', () => {
  const target = state({unidentified: [observation(1, '툴팁 가림'), observation(2)], unresolvedObservations: 2});
  assert.equal(discardFinalObservations(target), 2);
  assert.deepEqual(target.unidentified, []);
  assert.equal(target.unresolvedObservations, 0);
  assert.equal(target.discardedObservations?.length, 2);
  assert.equal(target.discardedObservations?.[0].reason, '툴팁 가림');
  assert.equal(target.discardedObservations?.[1].reason, '판독 불가');
  assert.equal('cards' in target, false);
});

test('discarding an empty list is a no-op', () => {
  const target = state({unresolvedObservations: 3});
  assert.equal(discardFinalObservations(target), 0);
  assert.equal(target.discardedObservations, undefined);
  assert.equal(target.unresolvedObservations, 3);
});

test('final counters are applied in one place', () => {
  const target = state({identifiedAfterSharing: [{id: 'old', name: '이전'}]});
  applyFinalCounters(target, {
    currentRunNames: 383,
    currentRunRead: 382,
    unresolvedFieldChanges: 1,
    identifiedAfterSharing: [{id: 'new', name: '새 카드'}],
    unknownEvidenceLost: true,
  });
  assert.equal(target.currentRunNames, 383);
  assert.equal(target.currentRunRead, 382);
  assert.equal(target.unresolvedFieldChanges, 1);
  assert.deepEqual(target.identifiedAfterSharing, [{id: 'new', name: '새 카드'}]);
  assert.equal(target.unknownEvidenceLost, true);
});

test('omitted identifiedAfterSharing is not overwritten', () => {
  const target = state({identifiedAfterSharing: [{id: 'old', name: '이전'}]});
  applyFinalCounters(target, {currentRunNames: 1, currentRunRead: 1, unresolvedFieldChanges: 0, unknownEvidenceLost: false});
  assert.deepEqual(target.identifiedAfterSharing, [{id: 'old', name: '이전'}]);
});

test('final status owns percent, status and drain warning', () => {
  const target = state({captureWarning: '이전 경고'});
  applyFinalStatus(target, {status: '입력 처리 완료', drainInputLoss: false, captureWarning: '새 경고'});
  assert.equal(target.percent, 100);
  assert.equal(target.status, '입력 처리 완료');
  assert.equal(target.captureWarning, '이전 경고');

  applyFinalStatus(target, {status: '입력 손실', drainInputLoss: true, captureWarning: '새 경고'});
  assert.equal(target.percent, 100);
  assert.equal(target.status, '입력 손실');
  assert.equal(target.captureWarning, '새 경고');
});
