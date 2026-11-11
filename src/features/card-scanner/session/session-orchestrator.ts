import {
  applyFinalCounters,
  applyFinalStatus,
  discardFinalObservations,
  type DiscardableSessionState,
  type FinalCounters,
  type FinalizableSessionState,
} from './session-finalize';

export interface SessionOrchestrationState<T extends {pending: boolean; reason?: string; time: number}> extends
  DiscardableSessionState<T>, FinalizableSessionState {}

export interface SessionFinalizationOrchestration<T extends {pending: boolean; reason?: string; time: number}> {
  state: SessionOrchestrationState<T>;
  counters: FinalCounters;
  /** Runs after discard and counters, before the final status is applied. */
  beforeFinalStatus: () => void;
  /** Receives the actual discarded count after the mutation. */
  finalStatus: (discardedCount: number) => string;
  drainInputLoss: boolean;
  captureWarning?: string;
  emit: () => void;
}

/** Preserve the finalization order: discard, counters, receipt/grid hooks,
 * final status, then one final emit. Any hook failure propagates before later
 * steps, matching the previous scanner sequence. */
export function orchestrateSessionFinalization<T extends {pending: boolean; reason?: string; time: number}>(
  input: SessionFinalizationOrchestration<T>,
): {discardedCount: number; status: string} {
  const discardedCount = discardFinalObservations(input.state);
  applyFinalCounters(input.state, input.counters);
  input.beforeFinalStatus();
  const status = input.finalStatus(discardedCount);
  applyFinalStatus(input.state, {
    status,
    drainInputLoss: input.drainInputLoss,
    captureWarning: input.captureWarning,
  });
  input.emit();
  return {discardedCount, status};
}
