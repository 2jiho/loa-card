export interface SessionDiagnosticState {
  expected?: number | null;
  cards?: readonly {review: readonly string[]}[];
  unidentified?: readonly {pending: boolean}[];
  pendingFields?: readonly unknown[];
  discardedObservations?: readonly unknown[];
  recognitionNeeded?: readonly {pinned?: true}[];
  duplicateUnidentifiedObservations?: number;
  currentRunNames?: number;
  currentRunRead?: number;
  unresolvedObservations?: number;
  unknownEvidenceLost?: boolean;
  interrupted?: unknown;
}

export interface SessionDiagnosticSummary {
  expected: number | null;
  read: number;
  unidentified: number;
  inventoryCount: number;
  names: number;
  reviews: number;
  pendingUnidentified: number;
  discarded: number;
  recognitionNeeded: number;
  pinnedRecognition: number;
  duplicateObservations: number;
  pendingFields: number;
  unresolvedObservations: number;
  unknownEvidenceLost: boolean;
  interrupted: boolean;
}

/** Final report counts only. It never reads images, mutates the state, or
 * treats a discarded observation as a confirmed card. */
export function sessionDiagnostics(state: SessionDiagnosticState | undefined): SessionDiagnosticSummary | null {
  if (!state) return null;
  const cards = state.cards ?? [];
  const unidentified = state.unidentified ?? [];
  const recognitionNeeded = state.recognitionNeeded ?? [];
  return {
    expected: state.expected ?? null,
    read: state.currentRunRead ?? 0,
    unidentified: unidentified.filter(item => !item.pending).length,
    inventoryCount: cards.length,
    names: state.currentRunNames ?? 0,
    reviews: cards.filter(card => card.review.length > 0).length,
    pendingUnidentified: unidentified.filter(item => item.pending).length,
    discarded: state.discardedObservations?.length ?? 0,
    recognitionNeeded: recognitionNeeded.length,
    pinnedRecognition: recognitionNeeded.filter(slot => slot.pinned === true).length,
    duplicateObservations: state.duplicateUnidentifiedObservations ?? 0,
    pendingFields: state.pendingFields?.length ?? 0,
    unresolvedObservations: state.unresolvedObservations ?? 0,
    unknownEvidenceLost: state.unknownEvidenceLost === true,
    interrupted: state.interrupted != null,
  };
}
