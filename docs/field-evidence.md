# 장수 필드 증거 — 빈 장수(0장)

- 코드: `recognition/count-pattern.ts`(`packCount`, `stablePreviewEmptyCandidate`, `emptyCounterProof`), `session/preview-zero.ts`
- 테스트: `tests/count-pattern-runtime.test.ts`

미판독 `null`과 명시적으로 본 0장을 구분한다. 장수 칸에 아이콘·숫자가 보이지 않는다는 것만으로는 0이 아니다(가림일 수 있다). 이 문서는 0장을 확정할 수 있는 크롭 증거의 계약이다. 스캔 중 언제 이 검사를 하는지는 [스캐너 구조](scanner-pipeline.md#5-병합과-확정)를 따른다.

경로는 `src/features/card-scanner/` 기준이다.

## 1. 빈 장수 증거

`packCount(..., diagnostic=true)`의 진단으로 판정한다. `stablePreviewEmptyCandidate`는 다음을 모두 요구한다.

| 항목 | 값 | 뜻 |
|---|---|---|
| `hasIcon` | `null` | 양수 아이콘으로 판정되지 않음 |
| `emptyFields` | `true` | 장수 칸이 비어 보임 |
| `iconColor` | `false` | 청록 아이콘 색 없음 |
| `iconRemnant` | `false` | 아이콘의 남은 획 없음 |
| `numericEvidence` | `false` | 숫자 획 없음 |
| `iconFlat` | `true` | 아이콘 자리는 평평함 |
| `digitsFlat` | `false` | 숫자 자리는 평평하지 않음(실제 빈 숫자 배경) |
| `highFrequencyCover` | `false` | 고주파 가림 없음 |

아이콘 자리와 숫자 자리가 **둘 다** 평평하면 평평한 불투명 가림(커서·덮개)일 수 있으므로 0으로 보지 않는다.

## 2. 관측 수

`emptyCounterProof(packed, observations, stillImage)`:

| 조건 | 결과 |
|---|---|
| 관측 수가 1 미만이거나 정수가 아님 | `null` |
| 위 증거가 성립하지 않음 | `null` |
| 정지 이미지, 관측 1 | `still-image` |
| 관측 1~2 | `single-observation` |
| 관측 3 이상 | `repeated-observations` |

양수 장수를 한 번의 관측으로 반영하듯 0도 한 번의 관측으로 반영한다. 관측이 늘면 값이 더 단단해질 뿐이고, 뒤의 다른 판독이 있으면 그것으로 바뀐다(최신 기준은 캡처 시각). 이유는 [설계 결정](decisions.md)에 있다.

## 3. 저장 크롭으로 0장 확인

`session/preview-zero.ts`는 각성이 읽혔고 장수가 비었거나 미확정 0이며 리뷰가 장수를 묻는 카드(`needsPreviewZeroProof`)만 다시 본다. 같은 카드의 저장 크롭을 다시 읽는 것이며 새 관측으로 세지 않는다.

- 크롭이 명시적 0(아이콘 없음, 같은 각성)을 읽었거나 위 증거가 성립하면 그 크롭은 0이다.
- 그 크롭보다 **뒤에** 캡처된 크롭에 양수 장수가 있으면 0을 받아들이지 않는다(`selectZeroPreview`). 앞선 관측이 뒤의 관측을 덮지 않는다.

## 4. 한계

- 텍스처가 있는 가림이 숫자 자리를 덮는 경우까지 완전히 배제하지는 못한다.
- 증거 검사가 양수 카드의 크롭에서 오발하지 않는지는 비공개 화면 공유 기록으로 확인한다. 그 측정 메모는 기록 옆의 `fixtures/local/notes/`에 있으며 공개 테스트의 통과를 모든 환경의 보장으로 해석하지 않는다.
