import { reduceObservationExecution } from './observation-execution';
import type { ObservationExecutionState, ObservationFact, ObservationSource } from './observation-execution';

export type ObservationWorkStatus = 'waiting' | 'read' | 'review';

/** One observation's command adapter. The reducer owns all execution-state
 * changes; callers own this object's lifetime and any spatial projection. */
export class ObservationWork {
  private current: ObservationExecutionState;
  private activeLease: number | undefined;
  private nextLease = 0;
  private readonly onFact?: (fact: ObservationFact) => void;

  constructor(source: ObservationSource, onFact?: (fact: ObservationFact) => void) {
    const fact: ObservationFact = { version: 1, source, attemptId: 0, kind: 'queued' };
    this.current = reduceObservationExecution(undefined, fact);
    this.onFact = onFact;
    this.publish(fact);
  }

  get state(): ObservationExecutionState { return this.current; }
  get source(): ObservationSource { return this.current.source; }

  private publish(fact: ObservationFact) {
    // Source is the reducer's detached, validated copy; later caller mutations
    // cannot change capture time, phase or identity in an already-emitted fact.
    this.onFact?.(Object.freeze({ ...fact, source: this.current.source }));
  }

  private apply(fact: ObservationFact, lease: number | undefined): boolean {
    const next = reduceObservationExecution(this.current, fact);
    if (next === this.current) return false;
    this.current = next;
    this.activeLease = lease;
    this.publish(fact);
    return true;
  }

  /** A retry always starts a new attempt, including after a completed read. */
  start(): number {
    const lease = this.nextLease + 1;
    const fact: ObservationFact = { version: 1, source: this.source,
      attemptId: this.current.attemptId + 1, kind: 'read-started' };
    // Validate and apply before committing the counter, then publish. A callback
    // error keeps the applied state visible and is not silently swallowed.
    const next = reduceObservationExecution(this.current, fact);
    this.current = next;
    this.nextLease = lease;
    this.activeLease = lease;
    this.publish(fact);
    return lease;
  }

  /** A leased late completion cannot finish a retry or overwrite a stage
   * correction. Unleased corrections are explicit new attempts once finished. */
  finish(status: ObservationWorkStatus, lease?: number): boolean {
    if (lease !== undefined && lease !== this.activeLease) return false;
    return this.apply({ version: 1, source: this.source,
      attemptId: this.current.attemptId + (this.current.phase === 'finished' ? 1 : 0),
      kind: 'read-finished', status }, undefined);
  }

  cancel(lease?: number): boolean { return this.finish('review', lease); }
}
