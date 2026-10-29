import { ScanGrid } from './scan-grid';
import type { GridStatus, ScanGridCell, ScanGridSnapshot } from './scan-grid';
import { observationExecutionSnapshot, parseObservationFact } from './observation-execution';
import type { ObservationExecutionSnapshot, ObservationSource } from './observation-execution';

type Position = Readonly<{ id: string; slot: number }>;
type StatusEntry = readonly [string, GridStatus];
interface CommandArgs {
  placeLive: readonly [readonly Position[], readonly StatusEntry[]];
  liveViewport: readonly [number | null, boolean];
  viewport: readonly [number | null];
  geometry: readonly [number | null];
  begin: readonly [boolean];
  record: readonly [number];
  register: readonly [number, number];
  identify: readonly [number, string];
  confirm: readonly [readonly string[]];
  restorePositions: readonly [readonly Position[]];
  restoreOrder: readonly [readonly string[]];
  resetPositions: readonly [];
  reset: readonly [];
  cell: readonly [number, GridStatus, string | null, number | null];
  group: readonly [number, number, number, boolean, number | null, ObservationSource | null];
  start: readonly [number];
  finish: readonly [number, 'waiting' | 'read' | 'review', number | null];
  stage: readonly [number, string];
}
export type ScanGridCommand = {
  [Method in keyof CommandArgs]: Readonly<{ version: 1; method: Method; args: CommandArgs[Method] }>
}[keyof CommandArgs];
export interface ScanGridReplaySnapshot {
  readonly version: 1;
  readonly grid: ScanGridSnapshot;
  readonly execution: ObservationExecutionSnapshot;
}
export const MAX_SCAN_GRID_COMMAND_BYTES = 1_048_576;
const MAX_SNAPSHOT_BYTES = 16 * 1024 * 1024;
const MAX_EXECUTION_STATES = 20_000;
const MAX_ID = 160, MAX_REASON = 1024;
const METHODS = new Set<keyof CommandArgs>(['placeLive', 'liveViewport', 'viewport', 'geometry', 'begin', 'record',
  'register', 'identify', 'confirm', 'restorePositions', 'restoreOrder', 'resetPositions', 'reset', 'cell', 'group', 'start', 'finish', 'stage']);
const STATUSES = new Set<GridStatus>(['unknown', 'waiting', 'reading', 'read', 'review', 'empty']);

function fail(message: string): never { throw new Error(`Invalid scan grid command: ${message}`); }
function object(value: unknown, keys: readonly string[], required = keys): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail('plain object required');
  const result = value as Record<string, unknown>;
  if (Object.keys(result).some(key => !keys.includes(key)) || required.some(key => !Object.hasOwn(result, key))) fail('unexpected or missing property');
  return result;
}
function number(value: unknown, maximum = Number.MAX_SAFE_INTEGER, minimum = 0): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) fail('integer outside bounds');
  return value as number;
}
function text(value: unknown, maximum = MAX_ID, empty = false): string {
  if (typeof value !== 'string' || (!empty && !value.length) || value.length > maximum) fail('string length');
  return value;
}
function boolean(value: unknown): boolean { if (typeof value !== 'boolean') fail('boolean required'); return value; }
function nullable<T>(value: unknown, parse: (value: unknown) => T): T | null { return value === null ? null : parse(value); }
function array(value: unknown, maximum: number): unknown[] {
  if (!Array.isArray(value) || value.length > maximum) fail('array size');
  for (let i = 0; i < value.length; i++) if (!Object.hasOwn(value, i)) fail('sparse array');
  return value;
}
function tuple(value: unknown, length: number): unknown[] {
  const result = array(value, length); if (result.length !== length) fail('argument count'); return result;
}
function status(value: unknown): GridStatus {
  if (!STATUSES.has(value as GridStatus)) fail('status'); return value as GridStatus;
}
function positions(value: unknown): readonly Position[] {
  // Colliding positions are retained: the real grid intentionally rejects them.
  // Recording that no-op/clear behavior is part of replay, not a repair step.
  return Object.freeze(array(value, 550).map(item => {
    const position = object(item, ['id', 'slot']);
    return Object.freeze({ id: text(position.id), slot: number(position.slot, 549) });
  }));
}
function ids(value: unknown): readonly string[] { return Object.freeze(array(value, 550).map(value => text(value))); }
function statuses(value: unknown): readonly StatusEntry[] {
  const seen = new Set<string>();
  return Object.freeze(array(value, 550).map(item => {
    const pair = tuple(item, 2), id = text(pair[0]);
    if (seen.has(id)) fail('duplicate map key'); seen.add(id);
    return Object.freeze([id, status(pair[1])] as const);
  }));
}
function source(value: unknown): ObservationSource {
  return parseObservationFact({ version: 1, kind: 'queued', source: value, attemptId: 0 }).source;
}
const row = (value: unknown) => number(value, 55, 1);
const top = (value: unknown) => number(value, 52, 1);

/** Wire contract: every method has a fixed-length tuple. Optional undefined
 * arguments become null only in their designated tuple slots. Other nulls,
 * missing arguments and unknown properties are rejected, never guessed. */
export function parseScanGridCommand(input: unknown): ScanGridCommand {
  if (typeof input === 'string') {
    if (input.length > MAX_SCAN_GRID_COMMAND_BYTES) fail('payload size');
    input = JSON.parse(input);
  }
  const value = object(input, ['version', 'method', 'args']);
  if (value.version !== 1 || !METHODS.has(value.method as keyof CommandArgs)) fail('version or method');
  const method = value.method as keyof CommandArgs;
  let args: CommandArgs[keyof CommandArgs];
  switch (method) {
    case 'placeLive': { const a = tuple(value.args, 2); args = [positions(a[0]), statuses(a[1])]; break; }
    case 'liveViewport': { const a = tuple(value.args, 2); args = [nullable(a[0], top), boolean(a[1])]; break; }
    case 'viewport': { const a = tuple(value.args, 1); args = [nullable(a[0], top)]; break; }
    case 'geometry': { const a = tuple(value.args, 1); args = [nullable(a[0], row)]; break; }
    case 'begin': { const a = tuple(value.args, 1); args = [boolean(a[0])]; break; }
    case 'record': case 'start': { const a = tuple(value.args, 1); args = [number(a[0])]; break; }
    case 'register': { const a = tuple(value.args, 2); args = [number(a[0]), top(a[1])]; break; }
    case 'identify': { const a = tuple(value.args, 2); args = [number(a[0]), text(a[1])]; break; }
    case 'confirm': case 'restoreOrder': { const a = tuple(value.args, 1); args = [ids(a[0])]; break; }
    case 'restorePositions': { const a = tuple(value.args, 1); args = [positions(a[0])]; break; }
    case 'resetPositions': case 'reset': tuple(value.args, 0); args = []; break;
    case 'cell': {
      const a = tuple(value.args, 4);
      args = [number(a[0], 39), status(a[1]), nullable(a[2], value => text(value, MAX_REASON, true)), nullable(a[3], row)]; break;
    }
    case 'group': {
      const a = tuple(value.args, 6), slot = number(a[0], 39), trace = number(a[2]), fresh = boolean(a[3]);
      const origin = nullable(a[5], source);
      if (fresh && origin && (origin.slot !== slot || origin.observationId !== String(trace))) fail('source does not match trace or slot');
      args = [slot, number(a[1]), trace, fresh, nullable(a[4], row), origin]; break;
    }
    case 'finish': {
      const a = tuple(value.args, 3);
      if (a[1] !== 'waiting' && a[1] !== 'read' && a[1] !== 'review') fail('finished status');
      args = [number(a[0]), a[1], nullable(a[2], value => number(value))]; break;
    }
    case 'stage': { const a = tuple(value.args, 2); args = [number(a[0]), text(a[1], 64)]; break; }
  }
  const command = Object.freeze({ version: 1, method, args: Object.freeze(args) }) as ScanGridCommand;
  if (new TextEncoder().encode(JSON.stringify(command)).byteLength > MAX_SCAN_GRID_COMMAND_BYTES) fail('payload size');
  return command;
}

/** Explicit dispatch only. Copy mutable arguments once more so a target method
 * cannot mutate the immutable command retained by the recording callback. */
function execute(grid: ScanGrid, command: ScanGridCommand): void | number | boolean {
  switch (command.method) {
    case 'placeLive': return grid.placeLive(command.args[0].map(value => ({ ...value })), new Map(command.args[1]));
    case 'liveViewport': return grid.liveViewport(command.args[0] ?? undefined, command.args[1]);
    case 'viewport': return grid.viewport(command.args[0] ?? undefined);
    case 'geometry': return grid.geometry(command.args[0] ?? undefined);
    case 'begin': return grid.begin(command.args[0]);
    case 'record': return grid.record(command.args[0]);
    case 'register': return grid.register(...command.args);
    case 'identify': return grid.identify(...command.args);
    case 'confirm': return grid.confirm([...command.args[0]]);
    case 'restorePositions': return grid.restorePositions(command.args[0].map(value => ({ ...value })));
    case 'restoreOrder': return grid.restoreOrder([...command.args[0]]);
    case 'resetPositions': return grid.resetPositions();
    case 'reset': return grid.reset();
    case 'cell': return grid.cell(command.args[0], command.args[1], command.args[2] ?? undefined, command.args[3] ?? undefined);
    case 'group': return grid.group(command.args[0], command.args[1], command.args[2], command.args[3],
      command.args[4] ?? undefined, command.args[5] === null ? undefined : { ...command.args[5] });
    case 'start': return grid.start(command.args[0]);
    case 'finish': return grid.finish(command.args[0], command.args[1], command.args[2] ?? undefined);
    case 'stage': return grid.stage(...command.args);
  }
}

export function applyScanGridCommand(grid: ScanGrid, command: unknown): void | number | boolean {
  return execute(grid, parseScanGridCommand(command));
}

function fromCall(method: keyof CommandArgs, supplied: unknown[]): ScanGridCommand {
  let args = [...supplied];
  const optional = (index: number) => { args[index] = supplied[index] === undefined ? null : supplied[index]; };
  switch (method) {
    case 'liveViewport': optional(0); args[1] = supplied[1] === undefined ? true : supplied[1]; break;
    case 'viewport': case 'geometry': optional(0); break;
    case 'cell': optional(2); optional(3); break;
    case 'group': optional(4); optional(5); break;
    case 'finish': optional(2); break;
    case 'placeLive': {
      const map = supplied[1] as ReadonlyMap<string, GridStatus>;
      if (!map || !Number.isSafeInteger(map.size) || map.size < 0 || map.size > 550 || typeof map.entries !== 'function') fail('status map');
      const entries: unknown[] = [];
      for (const entry of map.entries()) { if (entries.length >= 550) fail('status map size'); entries.push(entry); }
      args[1] = entries; break;
    }
  }
  return parseScanGridCommand({ version: 1, method, args });
}

/** Call only when recording is enabled; ordinary scans keep the original grid.
 * Commands precede their state mutation and retain external call order. They
 * are not idempotent events: replay each exactly once in the recorded order.
 * Methods run with target this, so internal calls (reset -> begin, stage ->
 * finish) are intentionally absent. Read-only methods are bound but not logged. */
export function recordScanGrid(grid: ScanGrid, onCommand: (command: ScanGridCommand) => void): ScanGrid {
  const bound = new Map<PropertyKey, unknown>();
  return new Proxy(grid, {
    get(target, key) {
      const value: unknown = Reflect.get(target, key, target);
      if (typeof value !== 'function') return value;
      if (!bound.has(key)) bound.set(key, METHODS.has(key as keyof CommandArgs) ? (...args: unknown[]) => {
        const command = fromCall(key as keyof CommandArgs, args);
        onCommand(command);
        return execute(target, command);
      } : value.bind(target));
      return bound.get(key);
    },
  });
}

function cell(value: unknown): ScanGridCell {
  const item = object(value, ['status', 'reason', 'row'], ['status']);
  return Object.freeze({ status: status(item.status),
    ...(item.reason === undefined ? {} : { reason: text(item.reason, MAX_REASON, true) }),
    ...(item.row === undefined ? {} : { row: row(item.row) }) });
}
function gridSnapshot(value: unknown): ScanGridSnapshot {
  const item = object(value, ['located', 'cells', 'inventory', 'totalRows', 'estimatedTop', 'liveTop', 'liveTracking', 'recent', 'recentFrame'], ['located', 'cells']);
  const result: ScanGridSnapshot = { located: boolean(item.located), cells: array(item.cells, 40).map(cell) };
  if (item.inventory !== undefined) result.inventory = array(item.inventory, 550).map(cell);
  if (item.totalRows !== undefined) result.totalRows = row(item.totalRows);
  if (item.estimatedTop !== undefined) result.estimatedTop = top(item.estimatedTop);
  if (item.liveTop !== undefined) result.liveTop = top(item.liveTop);
  if (item.liveTracking !== undefined) result.liveTracking = boolean(item.liveTracking);
  if (item.recent !== undefined) {
    const r = object(item.recent, ['captured', 'read', 'waiting', 'reading', 'review'], ['captured', 'read', 'waiting', 'review']);
    result.recent = Object.freeze({ captured: number(r.captured, 40), read: number(r.read, 40), waiting: number(r.waiting, 40), review: number(r.review, 40),
      ...(r.reading === undefined ? {} : { reading: number(r.reading, 40) }) });
  }
  if(item.recentFrame!==undefined) {
    const frame=object(item.recentFrame,['frame','cells']),cells=array(frame.cells,40).map(cell);
    if(cells.length!==40)fail('recent frame needs exactly 40 slots');
    Object.freeze(cells);result.recentFrame=Object.freeze({frame:number(frame.frame),cells});
  }
  Object.freeze(result.cells); if (result.inventory) Object.freeze(result.inventory);
  return Object.freeze(result);
}
function replaySnapshot(value: unknown): ScanGridReplaySnapshot {
  const item = object(value, ['version', 'grid', 'execution']); if (item.version !== 1) fail('snapshot version');
  const execution = object(item.execution, ['version', 'observations']); if (execution.version !== 1) fail('execution version');
  const states = array(execution.observations, MAX_EXECUTION_STATES);
  return Object.freeze({ version: 1, grid: gridSnapshot(item.grid),
    execution: observationExecutionSnapshot(states as ObservationExecutionSnapshot['observations'], MAX_EXECUTION_STATES) });
}

/** Public projected state, including positions and retained observation work.
 * This is not a checkpoint of ScanGrid's private pending-frame/identity caches;
 * reproduce those by replaying the complete command stream from a fresh grid. */
export function scanGridReplaySnapshot(grid: ScanGrid): ScanGridReplaySnapshot {
  return replaySnapshot({ version: 1, grid: grid.snapshot(), execution: grid.executionSnapshot() });
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([key, child]) => [key, canonical(child)]));
  return value;
}

/** Equality of replayed display/work state, never recognition accuracy. */
export async function hashScanGridReplay(snapshot: ScanGridReplaySnapshot): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(canonical(replaySnapshot(snapshot))));
  if (bytes.byteLength > MAX_SNAPSHOT_BYTES) fail('snapshot size');
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return Array.from(digest, value => value.toString(16).padStart(2, '0')).join('');
}
