/** Input exhaustion is separate from quantity and field validation. */
export function scanCompletion(expected: number | null, identified: number, review: number, currentRunNames = identified, unresolvedInputs = 0) {
  const quantity = expected === null ? "입력 처리 완료 · 보관함 수량 확인 필요"
    : identified < expected ? `입력 처리 완료 · ${expected - identified}종 추가 수집 필요`
    : identified > expected ? `입력 처리 완료 · 표시 수량보다 ${identified - expected}종 많음 · 목록 확인 필요`
    : currentRunNames < expected ? `입력 처리 완료 · ${expected-currentRunNames}종 이번 스캔 확인 필요`
    : review ? `입력 처리 완료 · 수량 일치 · ${review}종 판독 확인 필요`
    : "입력 처리 완료 · 표시 수량 일치";
  // Quantity equality cannot retire an unidentified observation. This applies
  // to still/offline inputs as well as a screen scan that skipped recovery.
  return unresolvedInputs > 0 ? `${quantity} · 미식별 입력 ${unresolvedInputs}개 확인 필요` : quantity;
}
