import {scanCompletion} from './completion';

export interface SessionFinalizationInput {
  expected: number | null;
  cardCount: number;
  reviews: number;
  currentRunNames: number | null;
  currentRunRead: number | null;
  /** Explicit recognition-needed slots seeded from a known frame target. */
  pinnedRecognition: number;
  /** All recognition-needed slots, pinned or live obstruction. */
  recognitionNeeded: number;
  discardedCount: number;
  unresolvedUnidentified: number;
  unresolvedGroups: number;
  unknownSourceUnresolved: number;
  unknownEvidenceLost: boolean;
  captureOnly: boolean;
  drainInputLoss: boolean;
  drainStatus: string | null;
  obstructionPending: boolean;
  unresolvedFieldChanges: number;
}

export interface SessionFinalizationSummary {
  completedCardCount: number;
  recognizedNameCount: number;
  reviewForStatus: number;
  status: string;
}

/** Compute only the final status/count projection. This does not mutate the
 * scanner state, discard observations, or issue a completion receipt. */
export function sessionFinalization(input: SessionFinalizationInput): SessionFinalizationSummary {
  const completedCardCount = input.cardCount +
    (input.pinnedRecognition > 0 && input.cardCount + input.pinnedRecognition === input.expected
      ? input.pinnedRecognition : 0);
  const recognizedNameCount = (input.currentRunNames ?? 0) +
    (completedCardCount > input.cardCount ? completedCardCount - input.cardCount : 0);
  const reviewForStatus = completedCardCount > input.cardCount ? 0 : Math.max(
    input.reviews,
    (input.currentRunNames ?? 0) - (input.currentRunRead ?? 0),
  );
  const unresolved = input.discardedCount ? 0 : Math.max(
    input.unresolvedUnidentified,
    input.unresolvedGroups,
    Math.max(0, input.unknownSourceUnresolved - Number(input.unknownEvidenceLost)),
  );
  let status = input.drainInputLoss ? (input.drainStatus ?? '')
    : input.captureOnly ? "카드 획득·품질 검사 완료 · OCR 실행 안 함"
      : scanCompletion(input.expected, completedCardCount, reviewForStatus, recognizedNameCount,
        unresolved, input.unknownEvidenceLost);
  if (!input.drainInputLoss) {
    if (input.discardedCount) status += ` · ${input.discardedCount}건 인식 필요(판독 불가)`;
    if (input.recognitionNeeded) status += ` · ${input.recognitionNeeded}칸 인식 필요(툴팁/커서)`;
    if (input.obstructionPending) status += ' · 가림 해제 후 카드 목록 전체 재확인 필요';
    else if (input.unresolvedFieldChanges) status += ' · 확인할 화면 관측 있음';
  }
  return {completedCardCount, recognizedNameCount, reviewForStatus, status};
}
