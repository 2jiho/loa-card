# Scanner session 분해

- 작성일: 2026-11-08
- 단계: Step 6.1
- 원칙: 동작 변경 없이 `scanner.ts`의 책임을 모듈로 분리한다.

## 1. 이번 추출

| 모듈 | 책임 | 하지 않는 일 |
|---|---|---|
| `session-finalization.ts` | 최종 status·완료 카드 수·이름 수·리뷰 수 계산 | 상태 변경·discard·영수증 발행 |
| `session-duplicate.ts` | final duplicate fast 후보 수집, slow 재판독 순위 | OCR·카드 값 확정 |

### `sessionFinalization`

입력:

- `expected`, `cardCount`, `reviews`, `currentRunNames`, `currentRunRead`
- `pinnedRecognition`, `recognitionNeeded`
- `discardedCount`, `unresolvedUnidentified`, `unresolvedGroups`, `unknownSourceUnresolved`, `unknownEvidenceLost`
- `captureOnly`, `drainInputLoss`, `drainStatus`, `obstructionPending`, `unresolvedFieldChanges`

출력:

- `completedCardCount`, `recognizedNameCount`, `reviewForStatus`, `status`

기존 `scanner.ts`의 status 계산과 동일한 문자열·우선순위를 유지한다.

### `session-duplicate`

- `collectFastDuplicateItems`: exact/fuzzy 이름 근거로 추가 OCR 없이 분류 가능한 항목
- `rankSlowDuplicateCandidates`: 짧은 텍스트 우선, score·confidence 순
- `hasCollectedNameCandidate`: 수집된 ID 후보 존재 여부

## 2. 이미 분리돼 있던 책임

| 모듈 | 책임 |
|---|---|
| `scan-ledger.ts` | 관측 원장·단계·미해결 그룹 |
| `final-duplicate.ts` | exact/fuzzy 중복 판정 규칙 |
| `discarded-observations.ts` | 남은 미식별의 discard 변환 |
| `completion.ts` | 완료 문자열·grid 확인 조건 |
| `negative-completion.ts` | 부정 완료 사유 |
| `scan-backup.ts` | 백업 직렬화 |

## 3. 동작 보존 검증

video-1을 finalization 추출 후, duplicate 추출 후 각각 재실행했다.

| 실행 | cards/names/read | status | discarded | 카드 값 차이 |
|---|---|---:|---:|---:|
| `step5-video1-fusion.json` | 384 / 384 / 384 | 동일 | 67 | — |
| `step6-video1-finalization.json` | 384 / 384 / 384 | 동일 | 67 | **0** |
| `step6-video1-duplicate.json` | 384 / 384 / 384 | 동일 | 67 | **0** |

- 누락/추가 카드: **0 / 0**
- reviews: 0, unresolved: 0

## 4. 테스트

| 파일 | 내용 |
|---|---|
| `tests/session-finalization.test.ts` | 8건: 완료 수량, pinned 슬롯, discard, review, capture-only, drain, 가림, 미식별 |
| `tests/session-duplicate.test.ts` | 7건: exact/fuzzy fast 후보, uncollected/weak 거부, slow 순위, 후보 존재 |

## 5. 6.2 diagnostics snapshot (완료)

`session-diagnostics.ts`가 최종 진단 요약을 담당한다.

| 필드 | 의미 |
|---|---|
| `inventoryCount` | 현재 카드 목록 수 |
| `names` / `read` | 이번 스캔 이름·필드 수 |
| `reviews` | 리뷰가 남은 카드 수 |
| `unidentified` / `pendingUnidentified` | 미식별·대기 관측 수 |
| `discarded` | `discardedObservations` 수 |
| `recognitionNeeded` / `pinnedRecognition` | 인식 필요 전체·pinned 슬롯 |
| `pendingFields` | 필드 확인 대기 수 |
| `duplicateObservations` | 중복 진단 수 |
| `unresolvedObservations` | 미해결 관측 수 |
| `unknownEvidenceLost` / `interrupted` | 입력 근거 손실·중단 여부 |

- `createScanDiagnosticSummary`의 `result`가 이 요약을 사용한다.
- `cards` 필드는 리포트에 넣지 않아 기존 failure-only 계약을 유지한다.
- 테스트: `tests/session-diagnostics.test.ts` 4건
- video-1 재실행: 384/384/384, status 동일, discarded 67, 카드 값 차이 0

## 6. 6.3a finalization mutation (완료)

`session-finalize.ts`가 finalization 상태 변경을 담당한다.

| 함수 | 책임 |
|---|---|
| `discardFinalObservations` | 남은 미식별을 `discardedObservations`로 이동, unresolved 0 |
| `applyFinalCounters` | 이름·필드 수, 미해결 필드, 공유 후 식별, 입력 근거 손실 반영 |
| `applyFinalStatus` | `percent=100`, 최종 status, drain warning 반영 |

- `scanner.ts`는 이 함수들을 기존 순서대로 호출한다.
- `session-finalize.ts`는 scanner 타입을 import하지 않고 구조적 제네릭을 사용해 새 타입 순환을 만들지 않는다.
- 테스트: `tests/session-finalize.test.ts` 5건
- video-1 재실행: 384/384/384, status 동일, discarded 67, 카드 값 차이 0

## 7. 6.3b finalization orchestrator (완료)

`session-orchestrator.ts`가 finalization 순서를 고정한다.

```text
discardFinalObservations
→ applyFinalCounters
→ beforeFinalStatus (완료 영수증·grid 확인)
→ finalStatus (sessionFinalization)
→ applyFinalStatus
→ emit
```

- `scanner.ts`는 카운터·loss·영수증/grid 콜백만 제공하고 순서는 오케스트레이터가 담당한다.
- `beforeFinalStatus` 실패 시 status·emit을 실행하지 않는다.
- 테스트: `tests/session-orchestrator.test.ts` 3건
- video-1 재실행: 384/384/384, status 동일, discarded 67, 카드 값 차이 0
- 입력·큐·스케줄 루프는 아직 `scanner.ts`에 남아 있으며 Step 7 물리 분할에서 다룬다.

### 7.1 session 물리 배치 (완료)

Step 7.5에서 session 책임 11개 파일을 `src/features/card-scanner/session/`으로 이동했다.
기존 root 경로는 re-export만 남아 있어 `scanner.ts`와 테스트 import는 유지된다.

| 파일 | 책임 |
|---|---|
| `session-finalization.ts` | 최종 status·완료 수 |
| `session-finalize.ts` | discard·counter·status 변경 |
| `session-orchestrator.ts` | finalization 순서 |
| `session-duplicate.ts` | final duplicate 후보·순위 |
| `session-diagnostics.ts` | 최종 진단 요약 |
| `scan-ledger.ts` | 관측 원장 |
| `final-duplicate.ts` | 중복 판정 규칙 |
| `discarded-observations.ts` | 미식별 discard 변환 |
| `completion.ts` | 완료 문자열 |
| `negative-completion.ts` | 부정 완료 사유 |
| `positive-completion.ts` | 긍정 완료 영수증 |

- 검증: lint 0 · **3,800 tests · 3,796 pass · 0 fail · 4 skipped** · build 0 · check 0
- video-1: 384/384/384, status 동일, discarded 67, 카드 값 차이 0
- screenshots-1·2: 40/40·38/38, missed 0, review 0

### 7.2 session evidence 배치 (완료)

Step 7.7에서 세션 증거 5개 파일을 `session/`으로 이동했다.

| 파일 | 책임 |
|---|---|
| `inventory-evidence.ts` | 카드·관측 증거 병합·동의 |
| `unknown-lifecycle.ts` | 미식별 수명주기 |
| `freshness-evidence.ts` | 최신 관측 증거 |
| `observation-history.ts` | 카드별 관측 이력 |
| `scan-grid.ts` | 스캔 그리드 상태 |

- 기존 경로는 re-export로 유지한다.
- 검증: lint 0 · **3,800 tests · 3,796 pass · 0 fail · 4 skipped** · build 0 · check 0
- video-1: 384/384/384, status 동일, discarded 67, 카드 값 차이 0
- screenshots-1·2: 40/40·38/38, missed 0, review 0

## 8. 다음

1. Step 7 물리 분할: `session/`, `recognition/`, `acquisition/` 등 하위 폴더 이동
2. Step 8 App 분해
3. Step 9 실제 화면 공유 E2E
4. 모호한 합성 카드 3장·타입 전용 경고 5개 정리
