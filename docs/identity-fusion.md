# 이름+원화 융합

- 작성일: 2026-11-08
- 단계: Step 5.2
- 코드: `src/features/card-scanner/identity-fusion.ts`
- 연결: `recognizer.identify`
- 테스트: `tests/identity-fusion.test.ts`

## 1. 정책

| 증거 | 판정 |
|---|---|
| 정확한 전체 이름, 모호하지 않음 | 이름으로 확정 |
| 정확한 이름이지만 다른 이름에 포함됨 | 원화가 같은 ID를 독립적으로 지지할 때만 확정 |
| 원화만 있고 `confirmPortrait` 통과 | 원화로 확정 |
| 이름과 원화가 다른 ID | **충돌 · 미확정** |
| 원화 마진 부족 | **미확정** |
| 이름 보정 + `confirmArtwork` 통과 | 이름+원화로 확정 |
| 이름 보정만 있고 원화 없음 | **미확정** |
| 이름·원화 모두 없음 | **미확정** |

- `confirmPortrait`: upper/lower ≥ .91, correlation ≥ .94, margin ≥ .2 (above-badge는 left/right ≥ .9 추가)
- `confirmArtwork`: 기존 `artwork-verifier` 기준 유지
- 약한 유사도만으로 카드 ID를 만들지 않는다.
- 이름과 원화가 충돌하면 다수결로 고르지 않는다.

## 2. 420장 합성 홀드아웃

`dev/identity-generalization.ts`가 실제 `recognizer.identify` 경로를 실행한다.

| 경로 | 판독 대상 | 정확 | 원화 확정 | 미확정 | 오확정 |
|---|---:|---:|---:|---:|---:|
| 이름 단독 기준선 | 417 | 415 | — | 2 (장문) | 0 |
| **이름+원화 융합** | 417 | **414** | 340 | **3 (모호 이름)** | **0** |

- 장문 골드 이름 2장은 원화로 회복됐다.
  - `3201017 피요르긴을 휘두르는 바훈투르`: correlation **.9898**, margin **.3144**
  - `3202044 빛을 맞이하는 샨디&진저웨일`: correlation **.9953**, margin **.2065**
- 이름 단독 기준선의 415장에는 부분 문자열 모호 28장이 포함되어 있었다. 융합 경로는 그중 원화 근거가 부족한 3장을 확정하지 않는다.
- 미확정 3장의 근거:
  - `3200119 세티노`: OCR `세티도` 81%, 후보 score .889/gap .222. 원화 top1은 맞지만 lower .521/correlation .751/margin .135.
  - `3200703 자크라`: 이름 `자크라` 91.8~98.1%지만 다른 이름에 포함됨. 원화 correlation .730/margin .059.
  - `3200803 베히모스`: 이름 `베히모스` 94.6~98.2%지만 다른 이름에 포함됨. 원화 correlation .662/margin .091.
- 이 3장은 값을 추정하지 않고 `인식 필요`로 남긴다. 임계값을 낮춰 억지로 확정하지 않는다. 2026-11-08 재분석 결과와 현재 수치는 3절을 따른다.

## 3. 2026-11-08 모호 카드 재분석

현재 `recognizer.identify` 경로로 세 카드를 다시 진단하고, `fuseIdentity`의 실제 게이트를 적용했다. 임계값은 변경하지 않았다.

| ID | 이름 | 이름 근거 | 최선 원화 단계 | 원화 수치 (upper/lower/correlation/margin) | 판정 |
|---|---|---|---|---|---|
| `3200119` 세티노 | `세티도` (81.0%) | 비정확, score .889, gap .222 | above-badge | .9814 / **.8649** / **.9231** / .3177 | **인식 필요** · lower·correlation 미달 |
| `3200703` 자크라 | `자크라` (98.1%) | 정확, score 1, 다른 이름 `자크라와 사르타`에 포함 | above-badge | .9999 / .9753 / .9876 / **.1599** | **인식 필요** · margin 미달 |
| `3200803` 베히모스 | `베히모스` (98.2%) | 정확, score 1, 다른 이름 `폭풍의 베히모스`에 포함 | above-badge | .9993 / **.8189** / **.9091** / .3596 | **인식 필요** · lower·correlation 미달 |

- `3200703`은 이름이 정확하고 원화 top1도 같은 ID지만 margin .1599가 기준 .2에 미달한다.
- `3200803`은 이름이 정확하고 원화 top1도 같은 ID지만 lower .8189와 correlation .9091이 기준 .91/.94에 미달한다.
- `3200119`는 이름 자체가 `세티도`로 비정확하고 원화 lower/correlation도 미달한다.
- 따라서 세 장 모두 **정확한 전체 이름 + 독립 원화 근거**를 동시에 만족하지 못한다. 값을 추정하지 않고 `인식 필요`로 유지한다.
- 회귀 테스트: `tests/identity-fusion.test.ts`의 `the three known ambiguous synthetic cards stay unresolved under the current gates`
- 분석 산출물: `work/identity-ambiguous-analysis.json` (`node --import tsx work/analyze-ambiguous-identity.ts`)

## 4. 한계

- 합성 템플릿은 실제 화면보다 깨끗하다. 414/417은 실제 영상·스크린샷의 정확도가 아니다.
- 미확정 3장은 이름 자체가 다른 카드와 겹친다. 원화 마진이 개선되거나 더 선명한 입력이 있어야 확정할 수 있다.
- 사진 묶음 사례에서 남은 베스칼 장수 `readableButMissed`는 신원이 아니라 필드 판독 문제다([장수 필드 증거](field-evidence.md)).
- 이 문서의 수치는 합성 홀드아웃이다. 실제 화면 공유의 확인은 비공개 기록 재실행으로 하며 그 측정 메모는 `fixtures/local/notes/`에 둔다.

## 5. 재현

```sh
node --import tsx --test tests/identity-fusion.test.ts
# dev 서버 + CDP
node work/cdp-identity-generalization.mjs
```

## 6. 다음

- 각성·장수 필드 증거 분리(Step 5.3)
- 베스칼 장수 리뷰 해소
- 실제 화면 공유·다른 해상도 검증
