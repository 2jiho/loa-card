import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ScanGrid } from '../src/features/card-scanner/scan-grid';
import type { GridStatus } from '../src/features/card-scanner/scan-grid';
import type { ObservationSource } from '../src/features/card-scanner/observation-execution';
import { applyScanGridCommand, hashScanGridReplay, MAX_SCAN_GRID_COMMAND_BYTES, parseScanGridCommand,
  recordScanGrid, scanGridReplaySnapshot } from '../src/features/card-scanner/scan-grid-command';
import type { ScanGridCommand } from '../src/features/card-scanner/scan-grid-command';

const origin = (trace: number, slot: number, frameId = trace): ObservationSource => ({
  sessionId: 'test-session', frameId, observationId: String(trace), captureOrder: trace * 40,
  captureTime: frameId / 30, phase: 'input', slot,
});
const wire = (value: unknown) => JSON.parse(JSON.stringify(value));

function harness() {
  const commands: ScanGridCommand[] = [], target = new ScanGrid(), replay = new ScanGrid();
  const grid = recordScanGrid(target, command => commands.push(command));
  let applied = 0;
  const step = <T>(operation: (grid: ScanGrid) => T): T => {
    const value = operation(grid);
    while (applied < commands.length) applyScanGridCommand(replay, wire(commands[applied++]));
    assert.deepEqual(scanGridReplaySnapshot(replay), scanGridReplaySnapshot(target));
    return value;
  };
  return { grid, target, replay, commands, step };
}

test('commands replay middle-start, fast/reverse viewports, delayed frame registration and stale reads without OCR', async () => {
  const { grid, target, replay, commands, step } = harness();
  step(g => g.geometry(55)); step(g => g.begin(true));
  step(g => g.viewport(25)); assert.equal(step(g => g.liveViewport(25)), true);
  step(g => g.group(0, 1, 1, true, undefined, origin(1, 0)));
  step(g => g.record(1)); const first = step(g => g.start(1));
  step(g => g.identify(1, 'card-a'));
  assert.equal(grid.snapshot().inventory!.length, 0, 'a read can exist without an absolute position');
  step(g => g.begin(true)); step(g => g.liveViewport(44));
  step(g => g.group(10, 1, 2, false)); step(g => g.record(2));
  step(g => g.register(2, 44)); step(g => g.register(1, 25));
  step(g => g.finish(1, 'read', first));
  assert.equal(grid.snapshot().inventory![440].status, 'read');
  assert.equal(grid.snapshot().inventory![240].status, 'unknown', 'late old position cannot duplicate a card');
  step(g => g.begin(true)); step(g => g.liveViewport(8)); step(g => g.viewport(8));
  step(g => g.group(2, 2, 3, true, undefined, { ...origin(3, 2), phase: 'recovery' }));
  step(g => g.cell(3, 'review', 'tooltip')); step(g => g.cell(4, 'empty'));
  step(g => g.record(3)); step(g => g.register(3, 8));
  step(g => g.finish(3, 'review')); step(g => g.finish(3, 'read'));
  step(g => g.begin(false)); step(g => g.liveViewport(undefined));
  assert.equal(await hashScanGridReplay(scanGridReplaySnapshot(target)), await hashScanGridReplay(scanGridReplaySnapshot(replay)));
  assert.ok(commands.some(command => command.method === 'register'));
  assert.equal(commands.filter(command => command.method === 'finish').length, 3);
});

test('retries, superseding observations, sort changes and resets preserve leases and exact external command order', async () => {
  const { grid, target, replay, commands, step } = harness();
  step(g => g.begin(true)); step(g => g.group(0, 7, 11, true, 1, origin(11, 0)));
  const first = step(g => g.start(11));
  step(g => g.stage(11, 'deferred'));
  const retry = step(g => g.start(11));
  step(g => g.finish(11, 'waiting', first)); assert.equal(grid.snapshot().cells[0].status, 'reading');
  step(g => g.finish(11, 'read', retry));
  step(g => g.identify(7, 'a')); step(g => g.record(1));
  step(g => g.begin(true)); step(g => g.group(1, 8, 12, true)); step(g => g.record(2));
  step(g => g.resetPositions());
  step(g => g.register(2, 5)); assert.equal(grid.snapshot().inventory!.length, 0);
  step(g => g.begin(true)); step(g => g.group(0, 7, 13, false, 20));
  assert.equal(grid.snapshot().cells[0].status, 'read');
  step(g => g.group(0, 7, 14, true, 20)); step(g => g.finish(11, 'read', retry));
  assert.equal(grid.snapshot().cells[0].status, 'waiting');
  const current = step(g => g.start(14)); step(g => g.stage(14, 'dropped'));
  step(g => g.finish(14, 'read', current)); assert.equal(grid.snapshot().cells[0].status, 'review');
  const prior = commands.length; step(g => g.reset());
  assert.equal(commands.length, prior + 1, 'internal resetPositions/liveViewport/begin are not recorded twice');
  step(g => g.begin(true)); step(g => g.group(0, 1, 15, true));
  const next = step(g => g.start(15)); assert.ok(next! > current!);
  step(g => g.finish(15, 'read', next));
  assert.equal(await hashScanGridReplay(scanGridReplaySnapshot(target)), await hashScanGridReplay(scanGridReplaySnapshot(replay)));
  assert.equal(commands.filter(command => command.method === 'finish').length, 5, 'stage internal finish is absent');
});

test('live/final placements, rejected collisions, repeated IDs and geometry changes use the real grid behavior', async () => {
  const { grid, target, replay, step } = harness();
  step(g => g.geometry(55)); step(g => g.begin(true));
  step(g => g.group(0, 1, 1, true, 1)); step(g => g.identify(1, 'a'));
  step(g => g.placeLive([{ id: 'a', slot: 500 }], new Map([['a', 'waiting']])));
  const lease = step(g => g.start(1)); assert.equal(grid.snapshot().inventory![500].status, 'reading');
  step(g => g.placeLive([{ id: 'a', slot: 500 }], new Map([['a', 'read']])));
  assert.equal(grid.snapshot().inventory![500].status, 'read');
  step(g => g.finish(1, 'read', lease));
  step(g => g.placeLive([{ id: 'a', slot: 20 }, { id: 'b', slot: 20 }], new Map([['a', 'read'], ['b', 'read']])));
  step(g => g.confirm(['a', 'a', 'b']));
  step(g => g.restorePositions([{ id: 'a', slot: 20 }, { id: 'b', slot: 21 }]));
  step(g => g.restoreOrder(['a', 'a'])); step(g => g.restoreOrder(['b', 'a']));
  step(g => g.geometry(40)); assert.equal(grid.snapshot().inventory!.length, 0);
  assert.equal(await hashScanGridReplay(scanGridReplaySnapshot(target)), await hashScanGridReplay(scanGridReplaySnapshot(replay)));
});

test('optional undefined slots have a fixed null wire representation and read-only methods are never recorded', () => {
  const { grid, commands, step } = harness();
  step(g => g.begin(true)); step(g => g.cell(0, 'unknown'));
  step(g => g.group(0, 1, 1, true)); step(g => g.finish(1, 'read'));
  step(g => g.viewport(undefined)); step(g => g.liveViewport(undefined)); step(g => g.geometry(undefined));
  assert.deepEqual(commands[1].args, [0, 'unknown', null, null]);
  assert.deepEqual(commands[2].args, [0, 1, 1, true, null, null]);
  assert.deepEqual(commands[3].args, [1, 'read', null]);
  assert.deepEqual(commands[5].args, [null, true]);
  assert.deepEqual(commands.map(command => parseScanGridCommand(JSON.stringify(command))), commands);
  const before = commands.length;
  grid.snapshot(); grid.viewportSnapshot(grid.snapshot()); grid.executionSnapshot();
  assert.equal(commands.length, before);
  const detached = grid.start; assert.equal(typeof detached(1), 'number', 'method references remain bound to the target');
});

test('recorded maps, arrays and sources are immutable detached data even if caller or target later mutates arguments', () => {
  class MutatingGrid extends ScanGrid {
    override placeLive(positions: { id: string; slot: number }[], statuses: ReadonlyMap<string, GridStatus>) {
      super.placeLive(positions, statuses); positions[0].id = 'target-mutated';
      (statuses as Map<string, GridStatus>).set('target-added', 'review');
    }
  }
  const commands: ScanGridCommand[] = [];
  const grid = recordScanGrid(new MutatingGrid(), command => commands.push(command));
  const placements = [{ id: 'a', slot: 10 }], statuses = new Map<string, GridStatus>([['a', 'read']]);
  grid.placeLive(placements, statuses);
  assert.equal(placements[0].id, 'a', 'target mutation operates on its own copy');
  placements[0].slot = 99; statuses.set('a', 'review');
  assert.deepEqual(commands[0].args, [[{ id: 'a', slot: 10 }], [['a', 'read']]]);
  const source = { ...origin(1, 0) }; grid.begin(true); grid.group(0, 1, 1, true, undefined, source);
  source.captureTime = 999; source.frameId = 999;
  const captured = commands.at(-1)!;
  assert.equal(captured.method, 'group');
  if (captured.method !== 'group') return;
  assert.equal(captured.args[5]!.captureTime, 1 / 30);
  assert.equal(Object.isFrozen(captured.args[5]), true); assert.equal(Object.isFrozen(captured.args), true);
  assert.throws(() => { (captured.args as unknown as unknown[])[0] = 9; }, TypeError);
});

test('strict command parsing rejects malformed methods, indices, oversized inputs and invalid observation sources before mutation', () => {
  const grid = new ScanGrid(); grid.begin(true); grid.group(0, 1, 1, true, 1); grid.identify(1, 'a'); grid.confirm(['a']);
  const before = scanGridReplaySnapshot(grid);
  const commands: unknown[] = [
    { version: 1, method: '__proto__', args: [] }, { version: 1, method: 'snapshot', args: [] },
    { version: 2, method: 'reset', args: [] }, { version: 1, method: 'reset', args: [], extra: 1 },
    { version: 1, method: 'reset', args: [0] }, { version: 1, method: 'begin', args: [null] },
    { version: 1, method: 'start', args: [-1] }, { version: 1, method: 'record', args: [Infinity] },
    { version: 1, method: 'register', args: [1, 53] }, { version: 1, method: 'liveViewport', args: [0, true] },
    { version: 1, method: 'geometry', args: [56] }, { version: 1, method: 'cell', args: [40, 'read', null, null] },
    { version: 1, method: 'cell', args: [0, 'bad', null, null] }, { version: 1, method: 'cell', args: [0, 'read', 'x'.repeat(1025), null] },
    { version: 1, method: 'cell', args: [0, 'read', undefined, undefined] },
    { version: 1, method: 'identify', args: [1, 'x'.repeat(161)] },
    { version: 1, method: 'restorePositions', args: [[{ id: 'a', slot: 550 }]] },
    { version: 1, method: 'confirm', args: [Array(551).fill('a')] },
    { version: 1, method: 'confirm', args: [new Array(1)] },
    { version: 1, method: 'placeLive', args: [[], [['a', 'read'], ['a', 'review']]] },
    { version: 1, method: 'placeLive', args: [[], Array(551).fill(['a', 'read'])] },
    { version: 1, method: 'group', args: [0, 1, 2, true, null, origin(2, 1)] },
    { version: 1, method: 'group', args: [0, 1, 2, true, null, { ...origin(2, 0), captureTime: NaN }] },
    { version: 1, method: 'group', args: [0, 1, 2, true, null, { ...origin(2, 0), phase: 'old' }] },
    { version: 1, method: 'finish', args: [1, 'reading', null] },
    { version: 1, method: 'stage', args: [1, 'x'.repeat(65)] },
    ' '.repeat(MAX_SCAN_GRID_COMMAND_BYTES + 1),
  ];
  for (const command of commands) {
    assert.throws(() => applyScanGridCommand(grid, command));
    assert.deepEqual(scanGridReplaySnapshot(grid), before);
  }
  let recorded = 0; const wrapper = recordScanGrid(grid, () => recorded++);
  assert.throws(() => wrapper.group(0, 1, 2, true, 1, origin(2, 1)));
  assert.equal(recorded, 0); assert.deepEqual(scanGridReplaySnapshot(grid), before);
});

test('canonical hash includes viewport, positions and observation attempts, independent of JSON property order', async () => {
  const grid = new ScanGrid(); grid.begin(true); grid.group(0, 1, 1, true); grid.record(1);
  const first = scanGridReplaySnapshot(grid), firstHash = await hashScanGridReplay(first);
  const reverseKeys = (value: unknown): unknown => Array.isArray(value) ? value.map(reverseKeys)
    : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).reverse().map(([key, item]) => [key, reverseKeys(item)])) : value;
  assert.equal(await hashScanGridReplay(reverseKeys(wire(first)) as typeof first), firstHash);
  grid.liveViewport(31); assert.notEqual(await hashScanGridReplay(scanGridReplaySnapshot(grid)), firstHash);
  grid.liveViewport(undefined, false); grid.register(1, 31);
  const positioned = await hashScanGridReplay(scanGridReplaySnapshot(grid)); assert.notEqual(positioned, firstHash);
  grid.finish(1, 'read'); const read = await hashScanGridReplay(scanGridReplaySnapshot(grid));
  const lease = grid.start(1); grid.finish(1, 'read', lease);
  assert.equal(grid.snapshot().cells[0].status, 'read');
  assert.notEqual(await hashScanGridReplay(scanGridReplaySnapshot(grid)), read, 'same marker can represent a later observation attempt');
  await assert.rejects(hashScanGridReplay({ ...first, extra: true } as typeof first));
  await assert.rejects(hashScanGridReplay({ ...first, grid: { ...first.grid, inventory: Array(551).fill({ status: 'read' }) } }));
});

test('recent capture projection is replayed and validated without inventing absolute positions', async()=>{
  const commands:ScanGridCommand[]=[],grid=recordScanGrid(new ScanGrid(),command=>commands.push(command));
  grid.begin(true);grid.group(23,1,1,true);grid.cell(4,'empty');grid.record(7);
  const snapshot=scanGridReplaySnapshot(grid),hash=await hashScanGridReplay(snapshot);
  assert.equal(snapshot.grid.recentFrame?.cells[23].status,'waiting');
  assert.equal(snapshot.grid.recentFrame?.cells[4].status,'empty');
  assert.deepEqual(snapshot.grid.inventory,[]);
  const replay=new ScanGrid();commands.forEach(command=>applyScanGridCommand(replay,wire(command)));
  assert.equal(await hashScanGridReplay(scanGridReplaySnapshot(replay)),hash);
  const altered=wire(snapshot);altered.grid.recentFrame!.cells[23].status='reading';
  assert.notEqual(await hashScanGridReplay(altered),hash);
  const short=wire(snapshot);short.grid.recentFrame!.cells.pop();
  await assert.rejects(hashScanGridReplay(short),/40 slots/);
  const invalid=wire(snapshot);invalid.grid.recentFrame!.frame=-1;
  await assert.rejects(hashScanGridReplay(invalid),/bounds/);
});
