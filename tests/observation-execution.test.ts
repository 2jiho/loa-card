import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseObservationFact, reduceObservationExecution, observationExecutionSnapshot, hashObservationExecution,
} from '../src/features/card-scanner/observation-execution';
import type {
  ObservationSource, ObservationFact, ObservationExecutionState, ObservationResult,
} from '../src/features/card-scanner/observation-execution';

const source: ObservationSource = {
  sessionId: 'session-1', frameId: 17, observationId: '201', captureOrder: 68_000_001,
  captureTime: 1.7, phase: 'input', slot: 0,
};
function fact(kind: ObservationFact['kind'], attemptId = 1,
  status: 'waiting' | 'read' | 'review' = 'read', result?: ObservationResult): ObservationFact {
  return kind === 'read-finished' ? { version: 1, source, kind, attemptId, status, ...(result ? { result } : {}) }
    : { version: 1, source, kind, attemptId };
}
const apply = (facts: ObservationFact[]) => facts.reduce<ObservationExecutionState | undefined>(
  (previous, event) => reduceObservationExecution(previous, event), undefined)!;

test('queued, reading and finished are distinct and duplicate facts preserve identity', () => {
  const pending = apply([fact('queued')]);
  assert.equal(pending.status, 'waiting');
  const reading = reduceObservationExecution(pending, fact('read-started'));
  assert.equal(reading.status, 'reading');
  assert.equal(pending.status, 'waiting');
  const finished = reduceObservationExecution(reading, fact('read-finished'));
  assert.equal(finished.status, 'read');
  assert.strictEqual(reduceObservationExecution(finished, fact('read-finished')), finished);
  assert.strictEqual(reduceObservationExecution(finished, fact('read-started')), finished);
  assert.strictEqual(reduceObservationExecution(finished, fact('queued')), finished);
  const reordered = { status: finished.status, phase: finished.phase,
    attemptId: finished.attemptId, source: finished.source };
  assert.strictEqual(reduceObservationExecution(reordered, fact('read-finished')), reordered);
});

test('late older attempts cannot finish or reopen a retry using the same observation', () => {
  const retry = apply([fact('read-finished', 1), fact('queued', 2), fact('read-started', 2)]);
  assert.equal(retry.status, 'reading');
  assert.strictEqual(reduceObservationExecution(retry, fact('read-finished', 1, 'review')), retry);
  assert.strictEqual(reduceObservationExecution(retry, fact('queued', 1)), retry);
  const deferred = reduceObservationExecution(retry, fact('read-finished', 2, 'waiting'));
  assert.equal(deferred.status, 'waiting');
  assert.equal(deferred.phase, 'finished');
  assert.strictEqual(reduceObservationExecution(deferred, fact('read-started', 2)), deferred);
  assert.equal(reduceObservationExecution(deferred, fact('read-started', 3)).status, 'reading');
});

function* permutations<T>(values: T[]): Generator<T[]> {
  if (!values.length) { yield []; return; }
  for (let i = 0; i < values.length; i++)
    for (const remaining of permutations([...values.slice(0, i), ...values.slice(i + 1)]))
      yield [values[i], ...remaining];
}

test('all deliveries of two valid attempts converge, including result before queue/start', async () => {
  const facts = [fact('queued', 1), fact('read-started', 1), fact('read-finished', 1, 'waiting'),
    fact('queued', 2), fact('read-started', 2), fact('read-finished', 2, 'review')];
  const expected = apply(facts);
  for (const order of permutations(facts)) assert.deepEqual(apply(order), expected);
  const first = await hashObservationExecution(observationExecutionSnapshot([apply(facts)]));
  const replay = await hashObservationExecution(observationExecutionSnapshot([apply([...facts].reverse())]));
  assert.equal(first, replay);
});

test('source identity and capture evidence stay immutable across attempts and phases', () => {
  const previous = apply([fact('queued')]);
  for (const changed of [
    { sessionId: 'other' }, { frameId: 18 }, { observationId: '202' }, { captureOrder: 68_000_000 },
    { captureTime: 1.6 }, { phase: 'recovery' as const }, { slot: 1 },
  ]) {
    assert.throws(() => reduceObservationExecution(previous,
      { ...fact('read-started', 2), source: { ...source, ...changed } }), /immutable observation source/);
  }
  const recovery = reduceObservationExecution(undefined,
    { ...fact('queued'), source: { ...source, observationId: '202', phase: 'recovery' } });
  assert.equal(recovery.source.phase, 'recovery');
  assert.equal(recovery.source.captureOrder, source.captureOrder);
});

test('contradictory terminal facts are rejected, never decided by completion arrival', () => {
  const read = apply([fact('read-finished')]);
  assert.throws(() => reduceObservationExecution(read, fact('read-finished', 1, 'review')), /conflicting facts/);
  const review = apply([fact('read-finished', 1, 'review')]);
  assert.throws(() => reduceObservationExecution(review, fact('read-finished')), /conflicting facts/);
});

test('unknown and explicit zero remain distinct and a new attempt does not reuse old fields', async () => {
  const zero = { cardId: 'shandi', awakening: 0, extraCopies: 0, review: [] };
  const unknown = { cardId: 'shandi', awakening: 0, extraCopies: null, review: ['장수 미판독'] };
  const previous = apply([fact('read-finished', 1, 'read', zero)]);
  const next = reduceObservationExecution(previous, fact('queued', 2));
  assert.equal(next.result, undefined);
  const failed = reduceObservationExecution(next, fact('read-finished', 2, 'review', unknown));
  assert.equal(failed.result?.extraCopies, null);
  assert.notEqual(await hashObservationExecution(observationExecutionSnapshot([previous])),
    await hashObservationExecution(observationExecutionSnapshot([failed])));
});

test('facts and snapshots are detached, canonical, and serializable without image objects', async () => {
  const result = { cardId: 'a', awakening: 0, extraCopies: 0, review: [] as string[] };
  const event = JSON.parse(JSON.stringify(fact('read-finished', 1, 'read', result)));
  const state = reduceObservationExecution(undefined, event);
  event.source.frameId = 999; event.result.review.push('mutated');
  assert.equal(state.source.frameId, 17);
  assert.deepEqual(state.result?.review, []);
  assert.ok(Object.isFrozen(state)); assert.ok(Object.isFrozen(state.result?.review));
  const other = reduceObservationExecution(undefined, { ...fact('queued'),
    source: { ...source, observationId: '1', captureOrder: 0 } });
  const before = observationExecutionSnapshot([state, other]);
  const after = observationExecutionSnapshot([other, JSON.parse(JSON.stringify(state))]);
  assert.deepEqual(before, after);
  assert.equal(await hashObservationExecution(before), await hashObservationExecution(after));
  assert.equal(before.observations[0].source.observationId, '1');
  assert.throws(() => parseObservationFact({ ...fact('queued'), canvas: {} }), /unexpected/);
});

test('bounds and unsupported schema reject facts rather than silently truncating evidence', () => {
  for (const value of [
    null, [], { ...fact('queued'), version: 2 }, { ...fact('queued'), attemptId: NaN },
    { ...fact('queued'), attemptId: -1 }, { ...fact('queued'), result: {} },
    { ...fact('queued'), source: { ...source, captureTime: Infinity } },
    { ...fact('queued'), source: { ...source, captureOrder: Number.MAX_SAFE_INTEGER + 1 } },
    { ...fact('queued'), source: { ...source, slot: 40 } },
    { ...fact('queued'), source: { ...source, sessionId: 'x'.repeat(161) } },
    { ...fact('queued'), source: { ...source, pixels: new Uint8Array(4) } },
    fact('read-finished', 1, 'review', { cardId: null, awakening: null, extraCopies: null, review: Array(17).fill('x') }),
    fact('read-finished', 1, 'review', { cardId: null, awakening: null, extraCopies: null, review: ['x'.repeat(257)] }),
    fact('read-finished', 1, 'review', { cardId: null, awakening: null, extraCopies: null, review: new Array(2) }),
  ]) assert.throws(() => parseObservationFact(value), /Invalid observation execution fact/);
  const state = apply([fact('queued')]);
  assert.throws(() => observationExecutionSnapshot([state], 0), /limit exceeded/);
  assert.throws(() => observationExecutionSnapshot([state, state]), /duplicate observation/);
  assert.throws(() => observationExecutionSnapshot([{ ...state, status: 'read' }]), /state status/);
});

test('replaying independent observations never promotes older fields or claims slot ownership', () => {
  const index = new Map<string, ObservationExecutionState>();
  const newer = { ...fact('read-started'), source: { ...source, observationId: '202', captureOrder: source.captureOrder + 1 } };
  const older = fact('read-finished');
  for (const event of [newer, older]) index.set(event.source.observationId,
    reduceObservationExecution(index.get(event.source.observationId), event));
  assert.equal(index.get('202')?.status, 'reading');
  assert.equal(index.get('201')?.status, 'read');
  assert.equal(observationExecutionSnapshot(index.values()).observations.length, 2);
  assert.ok(!('position' in index.get('201')!));
});
