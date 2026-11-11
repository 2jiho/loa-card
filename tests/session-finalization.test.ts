import {test} from 'node:test';
import assert from 'node:assert/strict';
import {sessionFinalization, type SessionFinalizationInput} from '../src/features/card-scanner/session/session-finalization';

const base: SessionFinalizationInput = {
  expected: 384,
  cardCount: 384,
  reviews: 0,
  currentRunNames: 384,
  currentRunRead: 384,
  pinnedRecognition: 0,
  recognitionNeeded: 0,
  discardedCount: 0,
  unresolvedUnidentified: 0,
  unresolvedGroups: 0,
  unknownSourceUnresolved: 0,
  unknownEvidenceLost: false,
  captureOnly: false,
  drainInputLoss: false,
  drainStatus: null,
  obstructionPending: false,
  unresolvedFieldChanges: 0,
};

const input = (overrides: Partial<SessionFinalizationInput> = {}): SessionFinalizationInput => ({...base, ...overrides});

test('a complete matching scan keeps the existing completion text', () => {
  const result = sessionFinalization(input());
  assert.equal(result.status, '입력 처리 완료 · 표시 수량 일치');
  assert.equal(result.completedCardCount, 384);
  assert.equal(result.recognizedNameCount, 384);
  assert.equal(result.reviewForStatus, 0);
});

test('pinned recognition slots complete the count without inventing a card', () => {
  const result = sessionFinalization(input({
    cardCount: 383, expected: 384, pinnedRecognition: 1, currentRunNames: 383, currentRunRead: 383,
    recognitionNeeded: 1,
  }));
  assert.equal(result.completedCardCount, 384);
  assert.equal(result.recognizedNameCount, 384);
  assert.equal(result.status, '입력 처리 완료 · 표시 수량 일치 · 1칸 인식 필요(툴팁/커서)');
});

test('pinned slots do not complete an unrelated missing count', () => {
  const result = sessionFinalization(input({
    cardCount: 383, expected: 385, pinnedRecognition: 1, currentRunNames: 383, currentRunRead: 383,
  }));
  assert.equal(result.completedCardCount, 383);
  assert.match(result.status, /2종 추가 수집 필요/u);
});

test('discarded observations are reported as recognition-needed, not unresolved', () => {
  const result = sessionFinalization(input({discardedCount: 62}));
  assert.equal(result.status, '입력 처리 완료 · 표시 수량 일치 · 62건 인식 필요(판독 불가)');
});

test('review and current-run name shortfalls remain visible', () => {
  assert.equal(sessionFinalization(input({reviews: 2})).status,
    '입력 처리 완료 · 수량 일치 · 2종 판독 확인 필요');
  assert.equal(sessionFinalization(input({currentRunNames: 382, currentRunRead: 382})).status,
    '입력 처리 완료 · 2종 이번 스캔 확인 필요');
});

test('capture-only and drain statuses keep their existing precedence', () => {
  assert.equal(sessionFinalization(input({captureOnly: true})).status,
    '카드 획득·품질 검사 완료 · OCR 실행 안 함');
  assert.equal(sessionFinalization(input({drainInputLoss: true, drainStatus: '입력 손실'})).status, '입력 손실');
  assert.equal(sessionFinalization(input({
    drainInputLoss: true, drainStatus: '입력 손실', discardedCount: 3, recognitionNeeded: 1,
    obstructionPending: true,
  })).status, '입력 손실');
});

test('obstruction and unresolved field changes append after the base status', () => {
  assert.equal(sessionFinalization(input({obstructionPending: true})).status,
    '입력 처리 완료 · 표시 수량 일치 · 가림 해제 후 카드 목록 전체 재확인 필요');
  assert.equal(sessionFinalization(input({unresolvedFieldChanges: 1})).status,
    '입력 처리 완료 · 표시 수량 일치 · 확인할 화면 관측 있음');
  assert.equal(sessionFinalization(input({obstructionPending: true, unresolvedFieldChanges: 1})).status,
    '입력 처리 완료 · 표시 수량 일치 · 가림 해제 후 카드 목록 전체 재확인 필요');
});

test('unidentified and unknown-source evidence stay in the completion calculation', () => {
  assert.equal(sessionFinalization(input({unresolvedUnidentified: 1})).status,
    '입력 처리 완료 · 표시 수량 일치 · 미식별 입력 1개 확인 필요');
  assert.equal(sessionFinalization(input({unknownSourceUnresolved: 2})).status,
    '입력 처리 완료 · 표시 수량 일치 · 미식별 입력 2개 확인 필요');
  assert.equal(sessionFinalization(input({unknownEvidenceLost: true})).status,
    '입력 처리 완료 · 표시 수량 일치 · 카드 확인 근거 손실 · 새 스캔 필요');
});
