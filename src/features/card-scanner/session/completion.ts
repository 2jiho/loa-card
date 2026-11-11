/** Input exhaustion is separate from quantity and field validation. */
export function scanCompletion(expected: number | null, identified: number, review: number, currentRunNames = identified, unresolvedInputs = 0, unknownEvidenceLost = false) {
  const quantity = expected === null ? "입력 처리 완료 · 보관함 수량 확인 필요"
    : identified < expected ? `입력 처리 완료 · ${expected - identified}종 추가 수집 필요`
    : identified > expected ? `입력 처리 완료 · 표시 수량보다 ${identified - expected}종 많음 · 목록 확인 필요`
    : currentRunNames < expected ? `입력 처리 완료 · ${expected-currentRunNames}종 이번 스캔 확인 필요`
    : review ? `입력 처리 완료 · 수량 일치 · ${review}종 판독 확인 필요`
    : "입력 처리 완료 · 표시 수량 일치";
  // Quantity equality cannot retire an unidentified observation. This applies
  // to still/offline inputs as well as a screen scan that skipped recovery.
  const withInputs = unresolvedInputs > 0 ? `${quantity} · 미식별 입력 ${unresolvedInputs}개 확인 필요` : quantity;
  // A lost evidence marker is not a count of missing cards. Even if every
  // retained warning was resolved, it requires a fresh scan.
  return unknownEvidenceLost ? `${withInputs} · 카드 확인 근거 손실 · 새 스캔 필요` : withInputs;
}

/** Position reconstruction is display-only; it must not paint all cards as
 * confirmed while an observation is unmatched or an input was dropped. */
export function canConfirmScanGrid(input:{expected:number|null;currentRunRead?:number;unresolvedFieldChanges?:number;
  unidentified:readonly unknown[];unresolvedGroups:number;droppedFrames:number;cards:readonly {review:readonly string[]}[];
  /** Absent for legacy/group-v1; otherwise the source-v2 bound, including any evidence loss. */
  unresolvedSourceEvidence?:number}):boolean {
  return input.droppedFrames===0 && input.unresolvedFieldChanges===0 && input.unidentified.length===0 && input.unresolvedGroups===0 &&
    (input.unresolvedSourceEvidence===undefined || input.unresolvedSourceEvidence===0) &&
    Number.isSafeInteger(input.expected) && input.expected!>0 && input.currentRunRead===input.expected &&
    input.cards.length===input.expected && input.cards.every(card=>card.review.length===0);
}
