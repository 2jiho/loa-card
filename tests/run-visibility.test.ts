import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRunVisibilityObserver } from '../dev/run-visibility';

class VisibilitySource {
  state: DocumentVisibilityState = 'visible';
  failState = false; failHidden = false; failAdd = false; failRemove = false;
  addCalls = 0; removeCalls = 0; listeners = new Set<EventListener>(); lastListener: EventListener | null = null;
  get visibilityState(): DocumentVisibilityState { if (this.failState) throw Error('state getter'); return this.state; }
  get hidden(): boolean { if (this.failHidden) throw Error('hidden getter'); return this.state === 'hidden'; }
  addEventListener(type: 'visibilitychange', listener: EventListener) {
    assert.equal(type, 'visibilitychange'); this.addCalls++; this.lastListener = listener;
    if (this.failAdd) throw Error('add listener'); this.listeners.add(listener);
  }
  removeEventListener(type: 'visibilitychange', listener: EventListener) {
    assert.equal(type, 'visibilitychange'); this.removeCalls++;
    if (this.failRemove) throw Error('remove listener'); this.listeners.delete(listener);
  }
  emit() { for (const listener of this.listeners) listener(new Event('visibilitychange')); }
}

test('visibility starts on the absolute page clock and retains an initially hidden page', () => {
  const source = new VisibilitySource(); source.state = 'hidden'; let clock = 1234;
  const observer = createRunVisibilityObserver(source, { now: () => clock }); clock = 1250;
  const result = observer.snapshot();
  assert.equal(result.version, 1); assert.equal(result.clock, 'page-performance-now');
  assert.equal(result.initial, 'hidden'); assert.equal(result.final, 'hidden'); assert.equal(result.everHidden, true);
  assert.equal(result.initialAtMs, 1234); assert.equal(result.finalAtMs, 1250); assert.equal(result.changes, 0);
  assert.deepEqual(result.events, [{ kind: 'initial', state: 'hidden', hidden: true, atMs: 1234 }]);
  assert.equal(result.invalidClock, 0); assert.equal(result.sourceErrors, 0); observer.dispose();
});

test('only notifications create change events while snapshots sample current final state', () => {
  const source = new VisibilitySource(); let clock = 100;
  const observer = createRunVisibilityObserver(source, { now: () => clock });
  source.state = 'hidden'; clock = 110; source.emit(); clock = 120; source.emit();
  const before = observer.snapshot();
  source.state = 'visible'; clock = 140; const after = observer.snapshot();
  assert.equal(before.changes, 2); assert.equal(after.changes, 2); assert.equal(after.events.length, 3);
  assert.equal(after.final, 'visible'); assert.equal(after.finalAtMs, 140); assert.equal(after.everHidden, true);
  assert.deepEqual(after.events.map(event => [event.state, event.atMs]), [['visible', 100], ['hidden', 110], ['hidden', 120]]);
  assert.equal(before.final, 'hidden'); assert.equal(before.finalAtMs, 120); observer.dispose();
});

test('every summary has detached frozen events which cannot mutate retained observations', () => {
  const source = new VisibilitySource(); let clock = 5;
  const observer = createRunVisibilityObserver(source, { now: () => clock });
  const first = observer.snapshot(), second = observer.snapshot();
  assert.notEqual(first, second); assert.notEqual(first.events, second.events); assert.notEqual(first.events[0], second.events[0]);
  assert.ok(Object.isFrozen(first) && Object.isFrozen(first.events) && first.events.every(Object.isFrozen));
  assert.throws(() => { (first.events as unknown as unknown[]).push({}); }, TypeError);
  assert.throws(() => { (first.events[0] as unknown as { atMs: number }).atMs = 999; }, TypeError);
  source.state = 'hidden'; clock = 6; source.emit();
  assert.equal(first.events.length, 1); assert.equal(first.events[0].atMs, 5);
  assert.equal(observer.snapshot().events.length, 2); observer.dispose();
});

test('the initial event and first 63 notifications fit the cap while latest state and dropped count keep updating', () => {
  const source = new VisibilitySource(); let clock = 0;
  const observer = createRunVisibilityObserver(source, { now: () => clock });
  for (let index = 1; index <= 70; index++) { clock = index; source.state = index % 2 ? 'hidden' : 'visible'; source.emit(); }
  clock = 71; const result = observer.snapshot();
  assert.equal(result.events.length, 64); assert.equal(result.changes, 70); assert.equal(result.dropped, 7);
  assert.equal(result.events[0].atMs, 0, 'a real clock value of zero is valid');
  assert.equal(result.events.at(-1)?.atMs, 63); assert.equal(result.final, 'visible'); assert.equal(result.finalAtMs, 71);
  assert.equal(result.everHidden, true); observer.dispose();
});

test('nonfinite, negative, thrown and backwards clock samples stay null without resetting the last valid clock', () => {
  const source = new VisibilitySource(); let clock: number | Error = NaN;
  const observer = createRunVisibilityObserver(source, { now: () => { if (clock instanceof Error) throw clock; return clock; } });
  clock = -1; assert.equal(observer.snapshot().finalAtMs, null);
  source.state = 'hidden'; clock = Infinity; source.emit(); clock = 10; source.emit();
  clock = 9; const backwards = observer.snapshot(); assert.equal(backwards.finalAtMs, null); assert.equal(backwards.invalidClock, 4);
  assert.equal(backwards.initialAtMs, null); assert.equal(backwards.final, 'hidden'); assert.equal(backwards.changes, 2);
  assert.deepEqual(backwards.events.map(event => event.atMs), [null, null, 10]);
  clock = 11; assert.equal(observer.snapshot().finalAtMs, 11);
  clock = Error('clock failed'); const failed = observer.snapshot(); assert.equal(failed.finalAtMs, null); assert.equal(failed.invalidClock, 5);
  assert.equal(failed.sourceErrors, 0); clock = 12; assert.equal(observer.dispose().finalAtMs, 12);
});

test('dispose records one stable final sample, detaches once and ignores even a retained late callback', () => {
  const source = new VisibilitySource(); let clock = 50, reads = 0;
  const observer = createRunVisibilityObserver(source, { now: () => { reads++; return clock; } });
  const late = source.lastListener!; clock = 60; const final = observer.dispose(); const finalReads = reads;
  source.state = 'hidden'; clock = 80; late(new Event('visibilitychange'));
  const again = observer.dispose(), snapshot = observer.snapshot();
  assert.deepEqual(again, final); assert.deepEqual(snapshot, final); assert.notEqual(snapshot.events, final.events);
  assert.equal(reads, finalReads); assert.equal(source.removeCalls, 1); assert.equal(source.listeners.size, 0);
  assert.equal(final.disposed, true); assert.equal(final.finalAtMs, 60); assert.equal(final.final, 'visible'); assert.equal(final.changes, 0);
});

test('source getter failures preserve unknown fields and null times without throwing or counting clock errors', () => {
  const source = new VisibilitySource(); source.failState = true; source.failHidden = true; let clock = 100;
  const observer = createRunVisibilityObserver(source, { now: () => clock });
  source.failState = false; clock = 110; const partial = observer.snapshot();
  assert.equal(partial.initial, 'unknown'); assert.equal(partial.initialAtMs, null); assert.equal(partial.events[0].hidden, null);
  assert.equal(partial.final, 'visible'); assert.equal(partial.finalAtMs, null); assert.equal(partial.sourceErrors, 3); assert.equal(partial.invalidClock, 0);
  source.failHidden = false; source.state = 'hidden'; clock = 120; source.emit();
  const final = observer.dispose(); assert.equal(final.final, 'hidden'); assert.equal(final.finalAtMs, 120);
  assert.equal(final.everHidden, true); assert.equal(final.changes, 1); assert.equal(final.sourceErrors, 3);
});

test('listener failures remain diagnostic and a callback surviving failed detach stays inert', () => {
  const source = new VisibilitySource(); source.failRemove = true;
  const observer = createRunVisibilityObserver(source, { now: () => 1 });
  const final = observer.dispose(); assert.equal(final.sourceErrors, 1); assert.equal(source.listeners.size, 1);
  source.state = 'hidden'; source.emit(); assert.deepEqual(observer.snapshot(), final); assert.equal(observer.dispose().sourceErrors, 1);
  const addFailure = new VisibilitySource(); addFailure.failAdd = true;
  const notAttached = createRunVisibilityObserver(addFailure, { now: () => 2 });
  assert.equal(notAttached.dispose().sourceErrors, 1); assert.equal(addFailure.removeCalls, 1);
});
