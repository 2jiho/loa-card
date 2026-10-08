/** Input exhaustion is separate from quantity and field validation. */
export function scanCompletion(expected: number | null, identified: number, review: number) {
  if (expected === null) return "입력 처리 완료 · 보관함 수량 확인 필요";
  if (identified < expected) return `입력 처리 완료 · ${expected - identified}종 추가 수집 필요`;
  if (identified > expected) return `입력 처리 완료 · 표시 수량보다 ${identified - expected}종 많음 · 목록 확인 필요`;
  if (review) return `입력 처리 완료 · 수량 일치 · ${review}종 판독 확인 필요`;
  return "입력 처리 완료 · 표시 수량 일치";
}
