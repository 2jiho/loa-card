import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ObservationWork } from '../src/features/card-scanner/observation-work';
import { reduceObservationExecution } from '../src/features/card-scanner/observation-execution';
import type { ObservationExecutionState, ObservationFact, ObservationSource } from '../src/features/card-scanner/observation-execution';

const source: ObservationSource = { sessionId: 'capture', frameId: 8, observationId: '12',
  captureOrder: 50, captureTime: 1.25, phase: 'recovery', slot: 7 };

test('standalone recovery work emits the same queue/read/finish contract without any grid placement', () => {
  const facts: ObservationFact[] = [];
  const work = new ObservationWork(source, fact => facts.push(fact));
  assert.equal(work.state.phase, 'queued'); assert.equal(work.state.status, 'waiting');
  const lease = work.start(); assert.equal(work.state.phase, 'reading');
  assert.equal(work.finish('read', lease), true);
  assert.deepEqual(facts.map(fact => fact.kind), ['queued', 'read-started', 'read-finished']);
  assert.deepEqual(facts.map(fact => fact.attemptId), [0, 1, 1]);
  assert.equal(work.state.status, 'read'); assert.deepEqual(work.source, source);
  let replayed: ObservationExecutionState | undefined;
  for (const fact of facts) replayed = reduceObservationExecution(replayed, fact);
  assert.deepEqual(replayed, work.state);
});

test('cloned retry candidates share leases and ignore late completions from the prior reader', () => {
  const facts: ObservationFact[] = [];
  const candidate = { work: new ObservationWork(source, fact => facts.push(fact)) };
  const first = candidate.work.start();
  candidate.work.finish('waiting', first);
  const retry = { ...candidate };
  const second = retry.work.start();
  assert.notEqual(first, second);
  const before = retry.work.state, count = facts.length;
  assert.equal(candidate.work.finish('read', first), false);
  assert.equal(retry.work.state, before); assert.equal(facts.length, count);
  assert.equal(retry.work.finish('review', second), true);
  assert.equal(candidate.work.finish('read', first), false);
  assert.equal(retry.work.state.status, 'review');
});

test('stage corrections invalidate leases and completed-state corrections get explicit new attempts', () => {
  const facts: ObservationFact[] = [];
  const work = new ObservationWork(source, fact => facts.push(fact));
  assert.equal(work.finish('review'), true);
  assert.equal(work.finish('read'), true);
  assert.deepEqual(facts.map(fact => fact.attemptId), [0, 0, 1]);
  const lease = work.start(); assert.equal(work.state.attemptId, 2);
  assert.equal(work.cancel(), true);
  const count = facts.length, ended = work.state;
  assert.equal(work.finish('read', lease), false);
  assert.equal(work.cancel(lease), false);
  assert.equal(work.state, ended); assert.equal(facts.length, count);
  const retry = work.start(); assert.equal(work.state.attemptId, 3);
  assert.equal(work.finish('read', retry), true);
});

test('source is detached and frozen, and no callback receives ignored or malformed transitions', () => {
  const original = { ...source }; const facts: ObservationFact[] = [];
  const work = new ObservationWork(original, fact => facts.push(fact));
  original.captureTime = 99; original.phase = 'input';
  const lease = work.start();
  assert.equal(work.source.captureTime, 1.25); assert.equal(work.source.phase, 'recovery');
  assert.equal(Object.isFrozen(work.source), true); assert.equal(Object.isFrozen(work.state), true);
  assert.equal(Object.isFrozen(facts[0]), true);
  const before = work.state, count = facts.length;
  assert.throws(() => work.finish('invalid' as 'read', lease), /finished status/);
  assert.equal(work.state, before); assert.equal(facts.length, count);
  assert.equal(work.finish('read', lease), true);
  assert.equal(work.finish('read', lease), false);
  assert.equal(facts.length, count + 1);
  assert.throws(() => new ObservationWork({ ...source, captureTime: NaN }, fact => facts.push(fact)), /capture time/);
  assert.equal(facts.length, count + 1);
});

test('work retains only its current state and independent observations do not share mutable execution', () => {
  const a = new ObservationWork(source);
  const b = new ObservationWork({ ...source, observationId: '13', frameId: 9, phase: 'input', captureTime: 5 });
  const first = a.start(); const second = b.start();
  b.finish('read', second); a.finish('waiting', first);
  assert.equal(b.state.status, 'read'); assert.equal(a.state.status, 'waiting');
  for (let i = 0; i < 100; i++) a.finish('read', a.start());
  assert.equal(a.state.attemptId, 101); assert.equal(b.state.attemptId, 1);
  assert.equal(a.source.captureTime, 1.25); assert.equal(b.source.captureTime, 5);
});

test('observer errors propagate after an already validated transition instead of being swallowed', () => {
  let fail = false;
  const work = new ObservationWork(source, () => { if (fail) throw new Error('recording failed'); });
  fail = true;
  assert.throws(() => work.start(), /recording failed/);
  assert.equal(work.state.phase, 'reading');
  fail = false;
  assert.equal(work.cancel(), true); assert.equal(work.state.status, 'review');
});
