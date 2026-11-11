import {test} from 'node:test';
import assert from 'node:assert/strict';
import {sessionDiagnostics} from '../src/features/card-scanner/session/session-diagnostics';
import {createScanDiagnosticSummary} from '../src/features/card-scanner/reproduction/scan-reproduction';

const state = {
  expected: 384,
  currentRunNames: 383,
  currentRunRead: 382,
  cards: [{review: []}, {review: ['장수 확인']}],
  unidentified: [{pending: false}, {pending: true}, {pending: false}],
  pendingFields: [{}, {}],
  discardedObservations: [{}, {}, {}, {}],
  recognitionNeeded: [{pinned: true}, {pinned: false}],
  duplicateUnidentifiedObservations: 3,
  unresolvedObservations: 2,
  unknownEvidenceLost: true,
  interrupted: 'cancelled',
};

test('session diagnostics summarize cards, unresolved, discarded and recognition-needed counts', () => {
  assert.deepEqual(sessionDiagnostics(state), {
    expected: 384,
    read: 382,
    unidentified: 2,
    inventoryCount: 2,
    names: 383,
    reviews: 1,
    pendingUnidentified: 1,
    discarded: 4,
    recognitionNeeded: 2,
    pinnedRecognition: 1,
    duplicateObservations: 3,
    pendingFields: 2,
    unresolvedObservations: 2,
    unknownEvidenceLost: true,
    interrupted: true,
  });
});

test('session diagnostics distinguish null state from observed zero counts', () => {
  assert.equal(sessionDiagnostics(undefined), null);
  assert.deepEqual(sessionDiagnostics({}), {
    expected: null,
    read: 0,
    unidentified: 0,
    inventoryCount: 0,
    names: 0,
    reviews: 0,
    pendingUnidentified: 0,
    discarded: 0,
    recognitionNeeded: 0,
    pinnedRecognition: 0,
    duplicateObservations: 0,
    pendingFields: 0,
    unresolvedObservations: 0,
    unknownEvidenceLost: false,
    interrupted: false,
  });
});

test('session diagnostics do not mutate or count discarded observations as cards', () => {
  const before = JSON.stringify({cards: state.cards.length, unidentified: state.unidentified.length,
    discarded: state.discardedObservations.length});
  const result = sessionDiagnostics(state);
  assert.equal(result?.inventoryCount, 2);
  assert.equal(result?.discarded, 4);
  assert.equal(JSON.stringify({cards: state.cards.length, unidentified: state.unidentified.length,
    discarded: state.discardedObservations.length}), before);
});

test('the diagnostic report carries the extracted summary fields', () => {
  const report = createScanDiagnosticSummary({
    ...state,
    status: '입력 처리 완료',
    pendingFields: [],
    unidentified: [],
    discardedObservations: state.discardedObservations,
  } as unknown as Parameters<typeof createScanDiagnosticSummary>[0], true);
  const result = report.result as {discarded?: number; recognitionNeeded?: number; pinnedRecognition?: number; inventoryCount?: number};
  assert.equal(result.inventoryCount, 2);
  assert.equal(result.discarded, 4);
  assert.equal(result.recognitionNeeded, 2);
  assert.equal(result.pinnedRecognition, 1);
  assert.equal('cards' in (report.result ?? {}), false);
});
