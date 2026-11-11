import {discardRemainingObservations} from './discarded-observations';

export interface DiscardableSessionState<T extends {pending: boolean; reason?: string; time: number} = {pending: boolean; reason?: string; time: number}> {
  unidentified: T[];
  discardedObservations?: T[];
  unresolvedObservations?: number;
}

export interface FinalizableSessionState {
  currentRunNames?: number;
  currentRunRead?: number;
  unresolvedFieldChanges?: number;
  identifiedAfterSharing?: {id: string; name: string}[];
  unknownEvidenceLost?: boolean;
  percent?: number;
  status?: string;
  captureWarning?: string;
}

export interface FinalCounters {
  currentRunNames: number;
  currentRunRead: number;
  unresolvedFieldChanges: number;
  identifiedAfterSharing?: {id: string; name: string}[];
  unknownEvidenceLost: boolean;
}

/** Move remaining hard observations into the recognition-needed bucket. The
 * evidence objects and reasons are preserved; no card or value is created. */
export function discardFinalObservations<T extends {pending: boolean; reason?: string; time: number}>(
  state: DiscardableSessionState<T>,
): number {
  const count = state.unidentified.length;
  if (!count) return 0;
  state.discardedObservations = discardRemainingObservations(state.unidentified);
  state.unidentified = [];
  state.unresolvedObservations = 0;
  return count;
}

export function applyFinalCounters(state: FinalizableSessionState, counters: FinalCounters): void {
  state.currentRunNames = counters.currentRunNames;
  state.currentRunRead = counters.currentRunRead;
  state.unresolvedFieldChanges = counters.unresolvedFieldChanges;
  if (counters.identifiedAfterSharing !== undefined) {
    state.identifiedAfterSharing = counters.identifiedAfterSharing;
  }
  state.unknownEvidenceLost = counters.unknownEvidenceLost;
}

export function applyFinalStatus(state: FinalizableSessionState, input: {
  status: string;
  drainInputLoss: boolean;
  captureWarning?: string;
}): void {
  state.percent = 100;
  state.status = input.status;
  if (input.drainInputLoss) state.captureWarning = input.captureWarning;
}
