/** Serializable execution facts. They describe work already decided by the
 * scanner; they do not identify cards, merge inventory or infer positions. */
export interface ObservationSource {
  readonly sessionId: string;
  readonly frameId: number;
  readonly observationId: string;
  readonly captureOrder: number;
  readonly captureTime: number;
  readonly phase: 'input' | 'recovery';
  readonly slot: number;
}

export interface ObservationResult {
  readonly cardId: string | null;
  readonly awakening: number | null;
  readonly extraCopies: number | null;
  readonly review: readonly string[];
}

interface FactBase {
  readonly version: 1;
  readonly source: ObservationSource;
  /** Monotonic for this observation. Deferred work starts a new attempt. */
  readonly attemptId: number;
}
export type ObservationFact =
  | (FactBase & { readonly kind: 'queued' | 'read-started' })
  | (FactBase & {
    readonly kind: 'read-finished';
    readonly status: 'waiting' | 'read' | 'review';
    readonly result?: ObservationResult;
  });

export interface ObservationExecutionState {
  readonly source: ObservationSource;
  readonly attemptId: number;
  readonly phase: 'queued' | 'reading' | 'finished';
  readonly status: 'waiting' | 'reading' | 'read' | 'review';
  readonly result?: ObservationResult;
}

export interface ObservationExecutionSnapshot {
  readonly version: 1;
  readonly observations: readonly ObservationExecutionState[];
}

const MAX_ID_LENGTH = 160;
const MAX_REVIEW_ITEMS = 16;
const MAX_REVIEW_LENGTH = 256;
const DEFAULT_SNAPSHOT_LIMIT = 100_000;

function fail(detail: string): never {
  throw new Error(`Invalid observation execution fact: ${detail}`);
}

function record(value: unknown, keys: readonly string[], required = keys): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail('plain object required');
  const object = value as Record<string, unknown>;
  if (Object.keys(object).some(key => !keys.includes(key)) ||
    required.some(key => !Object.hasOwn(object, key))) fail('unexpected or missing property');
  return object;
}

function integer(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) fail('nonnegative safe integer required');
  return value as number;
}

function identifier(value: unknown): string {
  if (typeof value !== 'string' || !value.length || value.length > MAX_ID_LENGTH) fail('identifier length');
  return value;
}

function sourceFrom(value: unknown): ObservationSource {
  const source = record(value, ['sessionId', 'frameId', 'observationId', 'captureOrder', 'captureTime', 'phase', 'slot']);
  if (typeof source.captureTime !== 'number' || !Number.isFinite(source.captureTime) || source.captureTime < 0)
    fail('capture time');
  if (source.phase !== 'input' && source.phase !== 'recovery') fail('source phase');
  const slot = integer(source.slot);
  if (slot >= 40) fail('slot outside captured grid');
  return Object.freeze({
    sessionId: identifier(source.sessionId), frameId: integer(source.frameId),
    observationId: identifier(source.observationId), captureOrder: integer(source.captureOrder),
    captureTime: source.captureTime, phase: source.phase, slot,
  });
}

function resultFrom(value: unknown): ObservationResult {
  const result = record(value, ['cardId', 'awakening', 'extraCopies', 'review']);
  const cardId = result.cardId === null ? null : identifier(result.cardId);
  const awakening = result.awakening === null ? null : integer(result.awakening);
  const extraCopies = result.extraCopies === null ? null : integer(result.extraCopies);
  // This is a transport bound, not an additional card recognition rule.
  if (!Array.isArray(result.review) || result.review.length > MAX_REVIEW_ITEMS ||
    Array.from(result.review).some(value => typeof value !== 'string' || value.length > MAX_REVIEW_LENGTH)) fail('review size');
  return Object.freeze({ cardId, awakening, extraCopies, review: Object.freeze([...result.review]) });
}

/** Reject malformed/oversized facts; never truncate them into apparently
 * complete evidence. Pixels, model output and diagnostics belong elsewhere. */
export function parseObservationFact(value: unknown): ObservationFact {
  const fact = record(value, ['version', 'source', 'attemptId', 'kind', 'status', 'result'],
    ['version', 'source', 'attemptId', 'kind']);
  if (fact.version !== 1) fail('version');
  const source = sourceFrom(fact.source), attemptId = integer(fact.attemptId);
  if (fact.kind === 'queued' || fact.kind === 'read-started') {
    if (Object.hasOwn(fact, 'status') || Object.hasOwn(fact, 'result')) fail('unfinished work has a result');
    return Object.freeze({ version: 1, source, attemptId, kind: fact.kind });
  }
  if (fact.kind !== 'read-finished' || !['waiting', 'read', 'review'].includes(fact.status as string)) fail('finished status');
  const result = fact.result === undefined ? undefined : resultFrom(fact.result);
  return Object.freeze({ version: 1, source, attemptId, kind: 'read-finished',
    status: fact.status as 'waiting' | 'read' | 'review', ...(result === undefined ? {} : { result }) });
}

function sameSource(a: ObservationSource, b: ObservationSource) {
  return a.sessionId === b.sessionId && a.observationId === b.observationId && a.frameId === b.frameId &&
    a.captureOrder === b.captureOrder && a.captureTime === b.captureTime && a.phase === b.phase && a.slot === b.slot;
}

function sameResult(a: ObservationResult | undefined, b: ObservationResult | undefined) {
  return a === b || !!a && !!b && a.cardId === b.cardId && a.awakening === b.awakening &&
    a.extraCopies === b.extraCopies && a.review.length === b.review.length &&
    a.review.every((reason, index) => reason === b.review[index]);
}

const phaseRank = { queued: 0, reading: 1, finished: 2 } as const;

/** O(1), per observation: callers own their index and replace only this entry.
 * Arrival order is not evidence order. A finished attempt cannot be reopened
 * by a late start, and a previous attempt cannot finish its replacement.
 * Valid facts may arrive out of order or more than once. Conflicting terminal
 * facts for one attempt are rejected rather than resolved by arrival order. */
export function reduceObservationExecution(
  previous: ObservationExecutionState | undefined, value: ObservationFact,
): ObservationExecutionState {
  const fact = parseObservationFact(value);
  if (previous && !sameSource(previous.source, fact.source)) fail('immutable observation source changed');
  const phase = fact.kind === 'queued' ? 'queued' : fact.kind === 'read-started' ? 'reading' : 'finished';
  if (previous && (fact.attemptId < previous.attemptId ||
    fact.attemptId === previous.attemptId && phaseRank[phase] < phaseRank[previous.phase])) return previous;
  const next: ObservationExecutionState = Object.freeze({
    source: fact.source, attemptId: fact.attemptId, phase,
    status: fact.kind === 'read-finished' ? fact.status : phase === 'reading' ? 'reading' : 'waiting',
    ...(fact.kind === 'read-finished' && fact.result !== undefined ? { result: fact.result } : {}),
  });
  if (previous && fact.attemptId === previous.attemptId && phase === previous.phase) {
    if (next.status !== previous.status || !sameResult(next.result, previous.result)) fail('conflicting facts for one attempt');
    return previous;
  }
  return next;
}

function stateFrom(value: ObservationExecutionState): ObservationExecutionState {
  record(value, ['source', 'attemptId', 'phase', 'status', 'result'], ['source', 'attemptId', 'phase', 'status']);
  if (value.phase !== 'queued' && value.phase !== 'reading' && value.phase !== 'finished') fail('state phase');
  if (value.phase !== 'finished' && (value.status !== (value.phase === 'reading' ? 'reading' : 'waiting') ||
    value.result !== undefined)) fail('state status');
  return reduceObservationExecution(undefined, {
    version: 1, source: value.source, attemptId: value.attemptId,
    ...(value.phase === 'finished' ? { kind: 'read-finished', status: value.status as 'waiting' | 'read' | 'review',
      ...(value.result === undefined ? {} : { result: value.result }) }
      : { kind: value.phase === 'reading' ? 'read-started' : 'queued' }),
  });
}

/** Canonical, detached snapshot for regression checks, not the live hot path.
 * A limit breach throws; it must not be mistaken for a complete smaller run. */
export function observationExecutionSnapshot(
  states: Iterable<ObservationExecutionState>, limit = DEFAULT_SNAPSHOT_LIMIT,
): ObservationExecutionSnapshot {
  integer(limit);
  const observations: ObservationExecutionState[] = [];
  const seen = new Set<string>();
  for (const value of states) {
    if (observations.length >= limit) fail('snapshot limit exceeded');
    const state = stateFrom(value);
    const key = JSON.stringify([state.source.sessionId, state.source.observationId]);
    if (seen.has(key)) fail('duplicate observation in snapshot');
    seen.add(key); observations.push(state);
  }
  observations.sort((a, b) => {
    const as = a.source, bs = b.source;
    if (as.sessionId !== bs.sessionId) return as.sessionId < bs.sessionId ? -1 : 1;
    return as.captureOrder - bs.captureOrder ||
      (as.observationId < bs.observationId ? -1 : as.observationId > bs.observationId ? 1 : 0);
  });
  return Object.freeze({ version: 1, observations: Object.freeze(observations) });
}

/** A hash of serialized execution state, not a claim that recognition is right. */
export async function hashObservationExecution(snapshot: ObservationExecutionSnapshot): Promise<string> {
  if (snapshot.version !== 1) fail('snapshot version');
  const canonical = observationExecutionSnapshot(snapshot.observations);
  const bytes = new TextEncoder().encode(JSON.stringify(canonical));
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return Array.from(digest, value => value.toString(16).padStart(2, '0')).join('');
}
