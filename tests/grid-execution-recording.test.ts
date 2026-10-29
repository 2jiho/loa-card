import { test } from 'node:test';
import assert from 'node:assert/strict';
import { entryParts, executionSummary } from '../src/features/card-scanner/exact-recording-codec';
import type { ExactEvent } from '../src/features/card-scanner/exact-recording-codec';
import { ScanGrid } from '../src/features/card-scanner/scan-grid';
import { hashScanGridReplay, recordScanGrid, scanGridReplaySnapshot } from '../src/features/card-scanner/scan-grid-command';
import { hashObservationExecution, observationExecutionSnapshot } from '../src/features/card-scanner/observation-execution';
import type { ObservationSource } from '../src/features/card-scanner/observation-execution';
import { ObservationWork } from '../src/features/card-scanner/observation-work';
import {UnknownLifecycle,hashUnknownLifecycle} from '../src/features/card-scanner/unknown-lifecycle';
import {UNKNOWN_LIFECYCLE_LIMITS} from '../src/features/card-scanner/unknown-lifecycle-types';
import type {UnknownSeed,UnknownUpsert} from '../src/features/card-scanner/unknown-lifecycle-types';

const signal = () => new AbortController().signal;
const archive = (events: readonly ExactEvent[]) => new Blob(events.flatMap(event => entryParts(event)));
const source = (trace: number, slot: number): ObservationSource => ({
  sessionId: 'recorded-run', frameId: 1, observationId: String(trace), captureOrder: trace,
  captureTime: 7, phase: 'input', slot,
});
const unknownSeed:UnknownSeed={version:1,sessionId:'recorded-run',origin:'scan',limits:UNKNOWN_LIFECYCLE_LIMITS};
const unknownFact:UnknownUpsert={version:1,kind:'upsert',key:{kind:'group',sessionId:unknownSeed.sessionId,group:1},
 source:source(1,0),captureOrder:1,captureTime:7,pending:false,reason:'이름 확인 필요',location:null};

test('unknown physical-event replay requires explicit complete outer totals and the current domain checkpoint',async()=>{
 const {events,emit}=recording();emit('unknown-seed',unknownSeed);
 const core=new UnknownLifecycle(unknownSeed,{onEvent:fact=>emit('unknown-event',fact)});core.apply(unknownFact);
 const hash=await hashUnknownLifecycle(core.snapshot());emit('unknown-checkpoint',{version:1,complete:true,events:1,hash});
 const totals={complete:true,dropped:0,events:events.length,frames:0};
 const result=await executionSummary(archive(events),signal(),totals);
 assert.deepEqual(result.unknownLifecycle,{supported:true,events:1,active:1,pending:0,final:1,
  complete:true,hash,expectedHash:hash,matchesCapturedState:true});
 const noTotals=await executionSummary(archive(events),signal());
 assert.equal(noTotals.recordingComplete,null);assert.equal(noTotals.unknownLifecycle.complete,false);
 assert.equal(noTotals.unknownLifecycle.matchesCapturedState,null,'a valid component prefix cannot prove the physical file is complete');
 for(const changed of [{...totals,complete:false,dropped:0},{...totals,complete:false,dropped:null}]){
  const partial=await executionSummary(archive(events),signal(),changed);
  assert.equal(partial.unknownLifecycle.complete,false);assert.equal(partial.unknownLifecycle.matchesCapturedState,null);
 }
 emit('unknown-event',{...unknownFact,reason:'판독 시간 초과',captureOrder:2,source:source(2,0)});
 const later=await executionSummary(archive(events),signal(),{...totals,events:events.length});
 assert.equal(later.unknownLifecycle.complete,false);assert.equal(later.unknownLifecycle.expectedHash,null);
 assert.equal(later.unknownLifecycle.matchesCapturedState,null);
});

test('unknown execution loss and altered valid facts stay distinguishable from seedless legacy support',async()=>{
 const {events,emit}=recording();emit('unknown-seed',unknownSeed);
 const core=new UnknownLifecycle(unknownSeed);core.apply(unknownFact);
 emit('unknown-event',unknownFact);const hash=await hashUnknownLifecycle(core.snapshot());
 emit('unknown-checkpoint',{version:1,complete:true,events:1,hash});
 const totals=()=>({complete:true,dropped:0,events:events.length,frames:0});
 const changed=events.map(event=>event.type==='unknown-event'?{...event,value:{...unknownFact,reason:'다른 이유'}}:event);
 const mismatch=await executionSummary(archive(changed),signal(),totals());
 assert.equal(mismatch.unknownLifecycle.complete,true);assert.equal(mismatch.unknownLifecycle.matchesCapturedState,false);
 emit('unknown-recording-error',{error:'event-sink-failed'});
 const lost=await executionSummary(archive(events),signal(),totals());
 assert.equal(lost.recordingComplete,false);assert.equal(lost.unknownLifecycle.matchesCapturedState,null);
 const legacy=await executionSummary(new Blob(),signal(),{complete:true,dropped:0,events:0,frames:0});
 assert.equal(legacy.unknownLifecycle.supported,false);assert.equal(legacy.unknownLifecycle.complete,false);
 assert.equal(legacy.unknownLifecycle.hash,null);assert.equal(legacy.unknownLifecycle.matchesCapturedState,null);
});

test('unknown exact metadata strictly rejects malformed facts and missing seed or event counts',async()=>{
 for(const [type,value]of [['unknown-event',unknownFact],['unknown-checkpoint',{version:1,complete:true,events:0,hash:'a'.repeat(64)}],
   ['unknown-seed',{...unknownSeed,extra:true}]]as const){
  await assert.rejects(executionSummary(archive([{kind:'event',seq:1,time:0,type,value}]),signal()));
 }
 const {events,emit}=recording();emit('unknown-seed',unknownSeed);emit('unknown-event',unknownFact);
 emit('unknown-checkpoint',{version:1,complete:true,events:2,hash:'a'.repeat(64)});
 await assert.rejects(executionSummary(archive(events),signal()),/이벤트 수/);
});

function recording() {
  const events: ExactEvent[] = [];
  const emit = (type: string, value: unknown) => events.push({
    kind: 'event', seq: events.length + 1, time: events.length / 100, type, value,
  });
  const raw = new ScanGrid(fact => emit('observation-fact', fact));
  const grid = recordScanGrid(raw, command => emit('grid-command', command));
  const checkpoint = async () => {
    const hash = await hashScanGridReplay(scanGridReplaySnapshot(raw));
    emit('grid-checkpoint', { complete: true, hash });
    return hash;
  };
  return { events, emit, raw, grid, checkpoint };
}

test('actual grid commands and interleaved lifecycle facts survive the archive and match the captured checkpoint', async () => {
  const { events, emit, raw, grid, checkpoint } = recording();
  grid.geometry(55); grid.begin(true); grid.viewport(30); grid.liveViewport(30);
  for (let trace = 1; trace <= 4; trace++) grid.group(trace - 1, trace, trace, true, undefined, source(trace, trace - 1));
  grid.record(1);
  const first = grid.start(1); grid.stage(1, 'deferred');
  const retry = grid.start(1);
  grid.finish(1, 'waiting', first); // A delayed attempt must not finish its replacement.
  grid.identify(1, 'card-a'); grid.finish(1, 'read', retry);
  grid.start(2); grid.finish(3, 'review');
  // A new viewport arrives before the old frame receives its absolute row.
  grid.begin(true); grid.liveViewport(8); grid.viewport(8);
  grid.group(0, 1, 5, false); grid.record(2);
  grid.register(2, 8); grid.register(1, 30);
  grid.placeLive([{ id: 'card-a', slot: 70 }], new Map([['card-a', 'read']]));
  assert.equal(raw.snapshot().inventory![70].status, 'read');
  // Recovery work has lifecycle facts but no grid position or grid command.
  const recovery = new ObservationWork({ ...source(9, 0), frameId: 9, captureTime: 0.5, phase: 'recovery' },
    fact => emit('observation-fact', fact));
  const lease = recovery.start(); recovery.finish('read', lease);
  const expectedHash = await checkpoint();
  const expectedObservationHash = await hashObservationExecution(observationExecutionSnapshot([
    ...raw.executionSnapshot().observations, recovery.state,
  ]));
  const commandCount = events.filter(event => event.type === 'grid-command').length;
  const factCount = events.filter(event => event.type === 'observation-fact').length;
  const blob = archive(events);
  const actual = await executionSummary(blob, signal());
  assert.equal(actual.events, events.length);
  assert.equal(actual.frames, 0);
  assert.equal(actual.kinds['grid-command'], commandCount);
  assert.deepEqual(actual.grid, { supported: true, commands: commandCount, hash: expectedHash,
    expectedHash, matchesCapturedState: true });
  assert.deepEqual(actual.observations, { supported: true, facts: factCount, observations: 5,
    waiting: 1, reading: 1, read: 2, review: 1, hash: expectedObservationHash });
  assert.equal(actual.cards.length, 0, 'display identity is not a reconstructed recognition result');
  assert.deepEqual(await executionSummary(blob, signal()), actual, 'the same recorded execution replays consistently');
  const groupAt = events.findIndex(event => event.type === 'grid-command' &&
    (event.value as { method: string }).method === 'group');
  assert.equal(events[groupAt + 1].type, 'observation-fact', 'the external command is recorded before its resulting fact');
});

test('sort reset, superseded observations and stale leases replay to the captured retained-state hash', async () => {
  const { events, raw, grid, checkpoint } = recording();
  grid.begin(true); grid.group(0, 1, 1, true, 20, source(1, 0));
  const old = grid.start(1); grid.identify(1, 'a'); grid.record(1);
  grid.resetPositions(); grid.register(1, 20); // Pending positions from the previous sort were discarded.
  grid.begin(true); grid.group(0, 1, 2, true, 1, source(2, 0));
  grid.finish(1, 'read', old);
  const current = grid.start(2); grid.finish(2, 'read', current);
  grid.confirm(['a']); grid.restorePositions([{ id: 'a', slot: 0 }]);
  grid.restoreOrder(['a']); grid.liveViewport(undefined, false);
  const hash = await checkpoint();
  const result = await executionSummary(archive(events), signal());
  assert.equal(result.grid.hash, hash); assert.equal(result.grid.matchesCapturedState, true);
  assert.equal(raw.executionSnapshot().observations.length, 1);
  assert.equal(result.observations.observations, 2, 'all emitted observations and the retained grid cache have different scopes');
});

test('a changed valid command reports a mismatch rather than accepting matching card totals', async () => {
  const { events, grid, checkpoint } = recording();
  grid.begin(true); grid.group(0, 1, 1, true, 1, source(1, 0));
  const lease = grid.start(1); grid.finish(1, 'read', lease); grid.liveViewport(1);
  const expectedHash = await checkpoint();
  const changed = events.map(event => event.type === 'grid-command' &&
    (event.value as { method: string }).method === 'liveViewport'
    ? { ...event, value: { version: 1, method: 'liveViewport', args: [2, true] } } : event);
  const original = await executionSummary(archive(events), signal());
  const mismatch = await executionSummary(archive(changed), signal());
  assert.equal(mismatch.grid.expectedHash, expectedHash);
  assert.notEqual(mismatch.grid.hash, expectedHash);
  assert.equal(mismatch.grid.matchesCapturedState, false);
  assert.deepEqual(mismatch.observations, original.observations, 'equal work results do not prove equal map placement');
});

test('legacy and missing/incomplete checkpoints distinguish unsupported replay from unknown equality', async () => {
  const { events, emit, grid, checkpoint } = recording();
  grid.begin(true); grid.group(0, 1, 1, true, 1, source(1, 0)); grid.finish(1, 'read');
  const withoutCheckpoint = archive(events);
  const missing = await executionSummary(withoutCheckpoint, signal());
  assert.equal(missing.grid.supported, true); assert.match(missing.grid.hash!, /^[a-f0-9]{64}$/);
  assert.equal(missing.grid.expectedHash, null); assert.equal(missing.grid.matchesCapturedState, null);
  await checkpoint(); emit('grid-checkpoint', { complete: false, error: 'checkpoint interrupted' });
  const incomplete = await executionSummary(archive(events), signal());
  assert.equal(incomplete.grid.hash, missing.grid.hash);
  assert.equal(incomplete.grid.expectedHash, null, 'a later failed checkpoint invalidates an older expected hash');
  assert.equal(incomplete.grid.matchesCapturedState, null);
  const legacy = events.filter(event => event.type === 'observation-fact');
  for (const blob of [new Blob(), archive(legacy), archive([{ kind: 'event', seq: 1, time: 0,
    type: 'grid-checkpoint', value: { complete: true, hash: 'a'.repeat(64) } }])]) {
    const result = await executionSummary(blob, signal());
    assert.equal(result.grid.supported, false); assert.equal(result.grid.commands, 0);
    assert.equal(result.grid.hash, null); assert.equal(result.grid.matchesCapturedState, null);
  }
});

test('invalid grid commands, checkpoints and reordered events fail through the archive parser', async () => {
  const invalidCommands = [
    { version: 1, method: '__proto__', args: [] },
    { version: 1, method: 'cell', args: [40, 'read', null, null] },
    { version: 1, method: 'finish', args: [1, 'reading', null] },
    { version: 1, method: 'restorePositions', args: [[{ id: 'a', slot: 550 }]] },
  ];
  for (const value of invalidCommands) await assert.rejects(executionSummary(archive([
    { kind: 'event', seq: 1, time: 0, type: 'grid-command', value },
  ]), signal()));
  const invalidCheckpoints = [null, [], {}, { complete: 'true', hash: 'a'.repeat(64) },
    { complete: true }, { complete: true, hash: 'A'.repeat(64) }, { complete: true, hash: 1 },
    { complete: true, hash: 'a'.repeat(64), extra: true }, { complete: false, hash: 'a'.repeat(64) },
    { complete: false, error: 1 }, { complete: false, error: 'x'.repeat(2001) }];
  for (const value of invalidCheckpoints) await assert.rejects(executionSummary(archive([
    { kind: 'event', seq: 1, time: 0, type: 'grid-checkpoint', value },
  ]), signal()), /지도 검증/);
  const { events, grid, checkpoint } = recording();
  grid.begin(true); grid.group(0, 1, 1, true, undefined, source(1, 0)); await checkpoint();
  await assert.rejects(executionSummary(archive([...events, events[0]]), signal()), /이벤트 순서/);
  const reversed = [...events]; [reversed[0], reversed[1]] = [reversed[1], reversed[0]];
  await assert.rejects(executionSummary(archive(reversed), signal()), /이벤트 순서/);
});

test('cancellation before and during command replay rejects instead of publishing a partial hash match', async () => {
  const { events, grid, checkpoint } = recording();
  grid.begin(true);
  for (let index = 0; index < 600; index++) grid.liveViewport(index % 52 + 1);
  await checkpoint();
  const blob = archive(events), cancelled = new AbortController(); cancelled.abort();
  await assert.rejects(executionSummary(blob, cancelled.signal), { name: 'AbortError' });
  const running = new AbortController(), prior = Object.getOwnPropertyDescriptor(globalThis, 'scheduler');
  let yielded = 0;
  Object.defineProperty(globalThis, 'scheduler', { configurable: true, value: {
    yield: async () => { yielded++; running.abort(); },
  } });
  try {
    await assert.rejects(executionSummary(blob, running.signal), { name: 'AbortError' });
    assert.equal(yielded, 1, 'large command batches provide an actual cooperative cancellation point');
  } finally {
    if (prior) Object.defineProperty(globalThis, 'scheduler', prior);
    else Reflect.deleteProperty(globalThis, 'scheduler');
  }
  assert.equal((await executionSummary(blob, signal())).grid.matchesCapturedState, true);
});
