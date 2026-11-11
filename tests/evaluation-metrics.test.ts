import {test} from 'node:test';
import assert from 'node:assert/strict';
import {parseCaseLabel} from '../src/features/card-scanner/evaluation/labels';
import {evaluateCase} from '../src/features/card-scanner/evaluation/metrics';
import type {EvaluationCard, EvaluationRun} from '../src/features/card-scanner/evaluation/types';

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

function label(cards: unknown[], scope: 'partial' | 'full' = 'partial') {
  return parseCaseLabel({
    kind: 'loacard-human-label',
    version: 2,
    status: 'human-confirmed',
    scope,
    caseId: 'case-1',
    cards,
  });
}

function resultCard(id: string, name: string | null, awakening: number | null, extraCopies: number | null, review: string[] = []): EvaluationCard {
  return {id, name, awakening, extraCopies, review};
}

function run(cards: EvaluationCard[], expected = cards.length): EvaluationRun {
  return {
    expected,
    cards,
    unidentified: 0,
    unresolvedObservations: 0,
    discardedObservations: 0,
    recognitionNeeded: 0,
    completionReasons: [],
  };
}

test('known values count in the denominator and exact values pass', () => {
  const report = evaluateCase(
    label([knownCard('a', '국왕 실리안', 5, 0)]),
    run([resultCard('a', '국왕 실리안', 5, 0)]),
  );
  assert.equal(report.verdict, 'pass');
  assert.equal(report.fields.name.readable, 1);
  assert.equal(report.fields.name.exact, 1);
  assert.equal(report.fields.awakening.exact, 1);
  assert.equal(report.fields.extraCopies.exact, 1);
  assert.equal(report.readableButMissed, 0);
  assert.equal(report.falseConfirm, 0);
});

test('unreadable fields are excluded but a confirmed value is a false confirmation', () => {
  const labels = label([
    card('a', {
      name: {status: 'known', value: '국왕 실리안'},
      awakening: {status: 'known', value: 0},
      extraCopies: {status: 'unreadable', reason: '툴팁 가림'},
    }),
  ]);
  const excluded = evaluateCase(labels, run([resultCard('a', '국왕 실리안', 0, null)]));
  assert.equal(excluded.fields.extraCopies.unreadable, 1);
  assert.equal(excluded.fields.extraCopies.readable, 0);
  assert.equal(excluded.falseConfirm, 0);
  assert.equal(excluded.verdict, 'pass');
  const confirmed = evaluateCase(labels, run([resultCard('a', '국왕 실리안', 0, 0)]));
  assert.equal(confirmed.falseConfirm, 1);
  assert.equal(confirmed.verdict, 'fail');
});

test('unknown labels make the evaluation incomplete', () => {
  const report = evaluateCase(
    label([
      card('a', {
        name: {status: 'known', value: '국왕 실리안'},
        awakening: {status: 'known', value: 0},
        extraCopies: {status: 'unknown'},
      }),
    ]),
    run([resultCard('a', '국왕 실리안', 0, 0)]),
  );
  assert.equal(report.complete, false);
  assert.equal(report.unlabeled, 1);
  assert.equal(report.verdict, 'incomplete');
});

test('null is not an observed zero', () => {
  const report = evaluateCase(
    label([knownCard('a', '국왕 실리안', 0, 0)]),
    run([resultCard('a', '국왕 실리안', 0, null)]),
  );
  assert.equal(report.fields.extraCopies.missed, 1);
  assert.equal(report.fields.extraCopies.falseConfirm, 0);
  assert.equal(report.readableButMissed, 1);
  assert.equal(report.verdict, 'fail');
});

test('wrong confirmed value is a false confirmation', () => {
  const report = evaluateCase(
    label([knownCard('a', '국왕 실리안', 2, 0)]),
    run([resultCard('a', '국왕 실리안', 3, 0)]),
  );
  assert.equal(report.fields.awakening.falseConfirm, 1);
  assert.equal(report.fields.awakening.missed, 0);
  assert.equal(report.verdict, 'fail');
});

test('a missing result card is missed, not guessed', () => {
  const report = evaluateCase(
    label([knownCard('a', '국왕 실리안', 0, 0)]),
    run([]),
  );
  assert.deepEqual(report.missingResultCards, ['a']);
  assert.equal(report.readableButMissed, 3);
  assert.equal(report.falseConfirm, 0);
});

test('review on a readable card fails while partial extra cards are reported', () => {
  const labels = label([knownCard('a', '국왕 실리안', 0, 0)]);
  const withReview = evaluateCase(labels, run([
    resultCard('a', '국왕 실리안', 0, 0, ['장수 확인']),
    resultCard('unlabeled', '베스칼', 0, null),
  ]));
  assert.equal(withReview.review, 1);
  assert.equal(withReview.readableReview, 1);
  assert.deepEqual(withReview.unlabeledResultCards, ['unlabeled']);
  assert.equal(withReview.verdict, 'fail');
});

test('fields outside the label scope are not counted as incomplete', () => {
  const partial = parseCaseLabel({
    kind: 'loacard-human-label',
    version: 1,
    status: 'human-confirmed',
    scope: 'partial',
    caseId: 'case-copies-only',
    cards: [{id: 'a', fields: {extraCopies: {status: 'known', value: 12}}}],
  });
  const report = evaluateCase(partial, run([resultCard('a', '다른 이름', 0, 12)]));
  assert.deepEqual(report.fieldScope, ['extraCopies']);
  assert.equal(report.fields.extraCopies.exact, 1);
  assert.equal(report.unlabeled, 0);
  assert.equal(report.verdict, 'pass');
});

test('full-scope extra result cards fail even without a review', () => {
  const report = evaluateCase(
    label([knownCard('a', '국왕 실리안', 0, 0)], 'full'),
    run([resultCard('a', '국왕 실리안', 0, 0), resultCard('extra', '베스칼', 0, 0)]),
  );
  assert.equal(report.scope, 'full');
  assert.equal(report.unlabeledResultCards.length, 1);
  assert.equal(report.verdict, 'fail');
});
