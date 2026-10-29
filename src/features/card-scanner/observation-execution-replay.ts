import {
  hashObservationExecution, observationExecutionSnapshot, parseObservationFact, reduceObservationExecution,
} from './observation-execution';
import type {ObservationExecutionState} from './observation-execution';
import {yieldForCapture} from './input-source';

export const MAX_REPLAY_OBSERVATIONS = 20_000;

interface ObservationCounts {
  facts: number;
  observations: number;
  waiting: number;
  reading: number;
  read: number;
  review: number;
}
export type ObservationReplaySummary = ObservationCounts & (
  | {supported: false; hash: null}
  | {supported: true; hash: string}
);

/** Replays recorded lifecycle facts only. Retains one bounded, pixel-free
 * state per observation; no OCR, card inventory or screen placement is rebuilt.
 * The event archive reader owns sequence validation and cooperative yielding. */
export class ObservationExecutionReplay {
  private readonly signal: AbortSignal;
  private readonly limit: number;
  private readonly states = new Map<string, ObservationExecutionState>();
  private facts = 0;

  constructor(signal: AbortSignal, limit = MAX_REPLAY_OBSERVATIONS) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_REPLAY_OBSERVATIONS)
      throw Error('관측 재생 한도는 1~20,000건이어야 합니다.');
    this.signal = signal;
    this.limit = limit;
  }

  accept(value: unknown) {
    this.signal.throwIfAborted();
    const fact = parseObservationFact(value);
    // Trace IDs are local to a session; never merge two runs' observations.
    const key = JSON.stringify([fact.source.sessionId, fact.source.observationId]);
    const previous = this.states.get(key);
    if (!previous && this.states.size >= this.limit) throw Error('관측 상태 재생 한도 초과');
    this.states.set(key, reduceObservationExecution(previous, fact));
    this.facts++;
  }

  async summary(): Promise<ObservationReplaySummary> {
    this.signal.throwIfAborted();
    const counts: ObservationCounts = {
      facts: this.facts, observations: this.states.size, waiting: 0, reading: 0, read: 0, review: 0,
    };
    if (!this.facts) return {...counts, supported: false, hash: null};
    // Hold immutable references from this instant so concurrent ingestion
    // cannot mix newer states with the already sampled counts while yielding.
    const states = [...this.states.values()];
    // Let cancellation/painting run before canonicalization. State hashing is
    // a bounded diagnostic step, never performed in the live feedback lane.
    await yieldForCapture(this.signal);
    const snapshot = observationExecutionSnapshot(states, this.limit);
    for (const state of snapshot.observations) counts[state.status]++;
    await yieldForCapture(this.signal);
    const hash = await hashObservationExecution(snapshot);
    this.signal.throwIfAborted();
    return {...counts, supported: true, hash};
  }
}
