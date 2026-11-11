import {test} from 'node:test';
import assert from 'node:assert/strict';
import {
  LabelError,
  canonicalLabelJson,
  migrateV1Label,
  parseCaseLabel,
} from '../src/features/card-scanner/evaluation/labels';
import {toEvaluationRun} from '../src/features/card-scanner/evaluation/run-result';

type FieldInput = {status: string; value?: string | number; reason?: string};

function card(id: string, fields: {name: FieldInput; awakening: FieldInput; extraCopies: FieldInput}) {
  return {id, fields};
}

function knownCard(id: string, name: string, awakening: number, extraCopies: number) {
  return card(id, {
    name: {status: 'known', value: name},
    awakening: {status: 'known', value: awakening},
    extraCopies: {status: 'known', value: extraCopies},
  });
}

function label(cards: unknown[], overrides: Record<string, unknown> = {}) {
  return {
    kind: 'loacard-human-label',
    version: 2,
    status: 'human-confirmed',
    scope: 'partial',
    caseId: 'case-1',
    cards,
    ...overrides,
  };
}

test('v2 labels accept known, unreadable and unknown fields', () => {
  const parsed = parseCaseLabel(label([
    card('a', {
      name: {status: 'known', value: '국왕 실리안'},
      awakening: {status: 'known', value: 5},
      extraCopies: {status: 'unreadable', reason: '툴팁 가림'},
    }),
    card('b', {
      name: {status: 'unknown'},
      awakening: {status: 'unknown'},
      extraCopies: {status: 'unknown'},
    }),
  ]));
  assert.equal(parsed.version, 2);
  assert.equal(parsed.cards[0].fields.name.value, '국왕 실리안');
  assert.equal(parsed.cards[0].fields.extraCopies.status, 'unreadable');
  assert.equal(parsed.cards[1].fields.name.status, 'unknown');
});

test('duplicate card ids are rejected', () => {
  assert.throws(
    () => parseCaseLabel(label([knownCard('a', '국왕 실리안', 5, 0), knownCard('a', '국왕 실리안', 5, 0)])),
    (error: unknown) => error instanceof LabelError && /duplicate/u.test(error.message),
  );
});

test('known field values must be in their valid range', () => {
  assert.throws(() => parseCaseLabel(label([knownCard('a', '', 5, 0)])), /non-empty/u);
  assert.throws(() => parseCaseLabel(label([knownCard('a', '국왕 실리안', 6, 0)])), /0\.\.5/u);
  assert.throws(() => parseCaseLabel(label([knownCard('a', '국왕 실리안', 5, 16)])), /0\.\.15/u);
});

test('unreadable fields require a reason and forbid a value', () => {
  assert.throws(() => parseCaseLabel(label([
    card('a', {
      name: {status: 'unreadable'},
      awakening: {status: 'known', value: 0},
      extraCopies: {status: 'known', value: 0},
    }),
  ])), /reason/u);
  assert.throws(() => parseCaseLabel(label([
    card('a', {
      name: {status: 'unreadable', value: '국왕 실리안', reason: '가림'},
      awakening: {status: 'known', value: 0},
      extraCopies: {status: 'known', value: 0},
    }),
  ])), /value is not allowed/u);
});

test('v1 labels migrate without changing values', () => {
  const migrated = migrateV1Label({
    kind: 'loacard-human-label',
    version: 1,
    status: 'human-confirmed',
    scope: 'partial',
    caseId: 'case-v1',
    cards: [knownCard('a', '국왕 실리안', 5, 0)],
  });
  assert.equal(migrated.version, 2);
  assert.equal(migrated.cards[0].fields.name.value, '국왕 실리안');
  assert.equal(migrated.cards[0].fields.awakening.value, 5);
});

test('v1 labels may cover only the fields that were actually checked', () => {
  const migrated = migrateV1Label({
    kind: 'loacard-human-label',
    version: 1,
    status: 'human-confirmed',
    scope: 'partial',
    caseId: 'case-v1-partial',
    cards: [{id: 'a', fields: {extraCopies: {status: 'known', value: 12}}}],
  });
  assert.deepEqual(migrated.fieldScope, ['extraCopies']);
  assert.equal(migrated.cards[0].fields.extraCopies.value, 12);
  assert.equal(migrated.cards[0].fields.name.status, 'unknown');
});

test('canonical json is stable across card and field order', () => {
  const first = parseCaseLabel(label([
    knownCard('b', '빛을 맞이하는 실리안', 0, 15),
    knownCard('a', '국왕 실리안', 5, 0),
  ]));
  const second = parseCaseLabel(label([
    card('a', {
      extraCopies: {status: 'known', value: 0},
      awakening: {status: 'known', value: 5},
      name: {status: 'known', value: '국왕 실리안'},
    }),
    card('b', {
      name: {status: 'known', value: '빛을 맞이하는 실리안'},
      extraCopies: {status: 'known', value: 15},
      awakening: {status: 'known', value: 0},
    }),
  ]));
  assert.equal(canonicalLabelJson(first), canonicalLabelJson(second));
});

test('run result adapter reads allCards and preserves null values', () => {
  const run = toEvaluationRun({
    expected: 2,
    allCards: [
      {id: 'a', name: '국왕 실리안', awakening: 0, extraCopies: null, review: []},
      {id: 'b', name: '베스칼', awakening: 0, extraCopies: 0, review: ['장수 확인']},
    ],
    unidentified: 1,
    unresolvedObservations: 0,
    discardedObservations: 2,
    recognitionNeeded: [{slot: 7}],
    completionReasons: ['인식 필요 2건'],
  });
  assert.equal(run.expected, 2);
  assert.equal(run.cards[0].extraCopies, null);
  assert.equal(run.cards[1].review[0], '장수 확인');
  assert.equal(run.unidentified, 1);
  assert.equal(run.discardedObservations, 2);
  assert.equal(run.recognitionNeeded, 1);
});

test('run result adapter rejects a numeric card count without allCards', () => {
  assert.throws(() => toEvaluationRun({cards: 384}), /allCards/u);
});
