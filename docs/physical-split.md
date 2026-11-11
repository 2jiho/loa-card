# Scanner 물리 분할

- 작성일: 2026-11-08
- 단계: Step 7.1 (UI 배치)
- 원칙: 배치 이동 + 기존 경로 re-export + 배치마다 전체 검증

## 1. 이동한 파일

`src/features/card-scanner/` → `src/features/card-scanner/ui/`

| 파일 | 비고 |
|---|---|
| `ScanActivity.tsx` | 카드 활동 필름 |
| `ScanAttention.tsx` | 재촬영 안내·인식 필요 목록 |
| `ScanReadProgress.tsx` | 진행·판독 수 |
| `ScanMonitor.tsx` | 진행창 |
| `ScanReplayDialog.tsx` | 재현 대화상자 |
| `ExecutionCompletenessNotice.tsx` | 실행 완전성 안내 |
| `InventoryReplayNotice.tsx` | 목록 재생 안내 |

기존 경로는 named re-export만 남겼다.

```ts
export {ScanAttention} from './ui/ScanAttention';
export {ScanMonitor, ScanMonitorPanel} from './ui/ScanMonitor';
export {ScanReadCount, ScanReadProgress} from './ui/ScanReadProgress';
```

- `export *`는 react lint 경고를 만들므로 사용하지 않는다.
- CSS(`scan-activity.css`, `scan-monitor.css`)는 기존 위치에 두고 이동한 컴포넌트가 `../`로 참조한다.

## 2. import 보정

이동한 파일은 한 단계 깊어지므로 상대 import를 보정했다.

- `./x` → `../x`
- `../shared/...` → `../../shared/...` (UI 기준 `../../../shared/...`)
- 같은 배치로 함께 이동한 컴포넌트 import(`./ScanActivity` 등)는 유지
- side-effect CSS import(`import './scan-activity.css'`)도 `../`로 보정

## 3. 검증

| 항목 | 결과 |
|---|---|
| lint | 0 |
| test | **3,800 tests · 3,796 pass · 0 fail · 4 skipped** |
| build | 0 |
| check:architecture | 위반 0 · 런타임 순환 0 · 타입 전용 경고 5 |
| video-1 | **384 / 384 / 384**, status 동일, discarded 67, 카드 값 차이 **0** |
| screenshots-1 | 이름·각성·장수 **40/40**, missed 0, review 0, falseConfirm 0 |
| screenshots-2 | 이름·각성·장수 **38/38**, missed 0, review 0, falseConfirm 0 |

산출물:

- `work/step7-video1-ui.json`
- `work/step7-screenshots1-ui.json`, `work/step7-screenshots1-run.json`
- `work/step7-screenshots2-ui.json`, `work/step7-screenshots2-run.json`
- `work/evaluation/step7-screenshots1.json`, `work/evaluation/step7-screenshots2.json`

## 4. 7.2 capture 배치 (완료)

`src/features/card-scanner/capture/`로 이동:

- `input-source.ts`
- `live-frame-clock.ts`
- `track-frame-source.ts`
- `freeze-live-frame.ts`
- `share-stream-owner.ts`
- `live-capture-pipeline.ts`

- 기존 경로는 `export * from './capture/...'` re-export로 유지한다.
- `live-capture-pipeline.ts`의 `live-input-admission`·`source-frame-correlation` import는 `../`로 보정했다.

검증:

| 항목 | 결과 |
|---|---|
| lint | 0 |
| test | **3,800 tests · 3,796 pass · 0 fail · 4 skipped** |
| build | 0 |
| check:architecture | 위반 0 · 런타임 순환 0 · 타입 전용 경고 5 |
| video-1 | **384 / 384 / 384**, status 동일, discarded 67, 카드 값 차이 **0** |
| screenshots-1 | **40/40**, missed 0, review 0 |
| screenshots-2 | **38/38**, missed 0, review 0 |

산출물:

- `work/step7-video1-capture.json`
- `work/step7-screenshots1-capture.json`, `work/step7-screenshots1-capture-run.json`
- `work/step7-screenshots2-capture.json`, `work/step7-screenshots2-capture-run.json`
- `work/evaluation/step7-screenshots1-capture.json`, `work/evaluation/step7-screenshots2-capture.json`

## 5. 7.3 acquisition 배치 (완료)

`src/features/card-scanner/acquisition/`로 이동:

- `detector.ts`
- `card-borders.ts`
- `border-integrity.ts`
- `card-acquisition.ts`
- `capture-quality.ts`
- `candidate-queue.ts`

- 기존 경로는 `export * from './acquisition/...'` re-export로 유지한다.
- 배치 내부 import(`./detector`, `./card-borders`, `./capture-quality`, `./border-integrity`)는 유지하고, 나머지는 `../`로 보정했다.

검증:

| 항목 | 결과 |
|---|---|
| lint | 0 |
| test | **3,800 tests · 3,796 pass · 0 fail · 4 skipped** |
| build | 0 |
| check:architecture | 위반 0 · 런타임 순환 0 · 타입 전용 경고 5 |
| video-1 | **384 / 384 / 384**, status 동일, discarded 67, 카드 값 차이 **0** |
| screenshots-1 | **40/40**, missed 0, review 0 |
| screenshots-2 | **38/38**, missed 0, review 0 |

산출물:

- `work/step7-video1-acquisition.json`
- `work/step7-screenshots1-acquisition.json`, `work/step7-screenshots1-acquisition-run.json`
- `work/step7-screenshots2-acquisition.json`, `work/step7-screenshots2-acquisition-run.json`
- `work/evaluation/step7-screenshots1-acquisition.json`, `work/evaluation/step7-screenshots2-acquisition.json`

## 6. 7.4 recognition 배치 (완료)

`src/features/card-scanner/recognition/`로 이동한 파일(42개):

| 그룹 | 파일 |
|---|---|
| 이름 | `name-reader`, `name-confidence`, `name-confirmation`, `name-diagnostics`, `name-gray-first`, `name-label-contrast`, `name-local-contrast`, `name-pattern`, `name-preprocessing`, `name-visibility`, `neural-reader`, `neural-ocr-worker`, `soft-name-pixels`, `text-mask`, `recognition-input-observer` |
| 원화·등급 | `artwork-verifier`, `portrait-competitors`, `portrait-diagnostics`, `portrait-matcher`, `portrait-ranking`, `visual-fields`, `visual-raster`, `visual-grade-evidence`, `visual-client`, `visual-worker` |
| 각성·장수 | `count-pattern`, `count-confidence`, `count-corroboration`, `counter-evidence`, `star-pattern` |
| OCR·문자열 | `ctc-decoder`, `ctc-lexicon`, `ctc-name-match`, `consensus`, `consensus-recorded-name-v1`, `ocr-canvas-snapshot`, `ocr-nonbudget-timeout`, `ocr-normalization`, `ocr-resource-notice`, `ocr-values`, `ocr-worker-leases` |
| 융합 | `identity-fusion` |

- 기존 경로 42개는 `export * from './recognition/...'` re-export로 유지한다.
- Worker URL은 실제 구현과 같은 `recognition/` 폴더로 함께 이동해 유지했다.
  - `recognition/neural-reader.ts` → `./neural-ocr-worker.ts`
  - `recognition/visual-client.ts` → `./visual-worker.ts`
- `portrait-competitors`의 JSON 경로는 `../portrait-competitor-pins.json`으로 보정했다.
- `name-reader-continuation.test.ts`의 loader hook moduleUrl을 실제 구현 경로로 수정했다.
  - 기존 old-path re-export에는 `import.meta.env.BASE_URL`이 없어 훅이 적용되지 않았다.

검증:

| 항목 | 결과 |
|---|---|
| lint | 0 |
| test | **3,800 tests · 3,796 pass · 0 fail · 4 skipped** |
| build | 0 (`neural-ocr-worker` 번들 생성) |
| check:architecture | 위반 0 · 런타임 순환 0 · 타입 전용 경고 5 |
| video-1 | **384 / 384 / 384**, status 동일, discarded 67, 카드 값 차이 **0** |
| screenshots-1 | **40/40**, missed 0, review 0 |
| screenshots-2 | **38/38**, missed 0, review 0 |

산출물:

- `work/step7-video1-recognition.json`
- `work/step7-screenshots1-recognition.json`, `work/step7-screenshots1-recognition-run.json`
- `work/step7-screenshots2-recognition.json`, `work/step7-screenshots2-recognition-run.json`
- `work/evaluation/step7-screenshots1-recognition.json`, `work/evaluation/step7-screenshots2-recognition.json`

## 7. 7.5 session 배치 (완료)

`src/features/card-scanner/session/`로 이동한 파일(11개):

| 파일 | 책임 |
|---|---|
| `session-finalization.ts` | 최종 status·완료 카드/이름/리뷰 수 |
| `session-finalize.ts` | discard·counter·status 변경 |
| `session-orchestrator.ts` | finalization 순서 |
| `session-duplicate.ts` | final duplicate fast 후보·slow 순위 |
| `session-diagnostics.ts` | 최종 진단 요약 |
| `scan-ledger.ts` | 관측 원장·단계·미해결 그룹 |
| `final-duplicate.ts` | exact/fuzzy 중복 판정 |
| `discarded-observations.ts` | 남은 미식별의 discard 변환 |
| `completion.ts` | 완료 문자열·grid 확인 조건 |
| `negative-completion.ts` | 부정 완료 사유 |
| `positive-completion.ts` | 긍정 완료 영수증 |

- 기존 경로 11개는 `export * from './session/...'` re-export로 유지한다.
- 배치 내부 import(`./completion`, `./discarded-observations`, `./final-duplicate`, `./negative-completion`, `./session-finalize`)는 유지하고, 나머지는 `../`로 보정했다.
- `session-duplicate`·`final-duplicate`의 `name-diagnostics` import는 root re-export를 거쳐 `recognition/name-diagnostics`로 연결된다(전환 단계).

검증:

| 항목 | 결과 |
|---|---|
| lint | 0 |
| test | **3,800 tests · 3,796 pass · 0 fail · 4 skipped** |
| build | 0 |
| check:architecture | 위반 0 · 런타임 순환 0 · 타입 전용 경고 5 |
| video-1 | **384 / 384 / 384**, status 동일, discarded 67, 카드 값 차이 **0** |
| screenshots-1 | **40/40**, missed 0, review 0 |
| screenshots-2 | **38/38**, missed 0, review 0 |

산출물:

- `work/step7-video1-session.json`
- `work/step7-screenshots1-session.json`, `work/step7-screenshots1-session-run.json`
- `work/step7-screenshots2-session.json`, `work/step7-screenshots2-session-run.json`
- `work/evaluation/step7-screenshots1-session.json`, `work/evaluation/step7-screenshots2-session.json`

## 8. 7.6 persistence·reproduction 배치 (완료)

### `src/features/card-scanner/persistence/` (6개)

| 파일 | 책임 |
|---|---|
| `scan-backup.ts` | 스캔 결과 백업 |
| `progress-backup.ts` | 진행 상태 백업 |
| `partial-store.ts` | 부분 결과 저장 |
| `recording-journal.ts` | 기록 저널 |
| `recording-spool.ts` | 기록 스풀 |
| `archive-journal-mirror.ts` | 기록 미러 |

### `src/features/card-scanner/reproduction/` (16개)

| 파일 | 책임 |
|---|---|
| `scan-reproduction.ts` | 재현 번들·리포트 |
| `reproduction-session-store.ts` | 재현 세션 저장소 |
| `reproduction-coverage.ts` | 입력 커버리지 |
| `reproduction-input.ts` | 재현 입력 |
| `exact-recording.ts` | 정확 기록 |
| `exact-recording-codec.ts` | 기록 코덱 |
| `exact-recording-compression.ts` | 기록 압축 |
| `exact-recording-prefix.ts` | 기록 prefix |
| `exact-recording-worker.ts` | 기록 Worker |
| `canonical-frame-index.ts` | 정본 프레임 색인 |
| `canonical-frame-reader.ts` | 정본 프레임 재생 |
| `canonical-raster-replay.ts` | 정본 래스터 재생 |
| `canonical-source-use.ts` | 정본 소스 사용 |
| `canonical-storage-attestation.ts` | 저장소 증명 |
| `debug-capture.ts` | 디버그 캡처 |
| `debug-bundle.ts` | 디버그 번들 |

- 기존 경로 22개는 `export * from './persistence/...'`·`export * from './reproduction/...'` re-export로 유지한다.
- 서로 다른 하위 폴더 간 import는 매핑 기반으로 직접 경로를 만들었다.
  - `reproduction/exact-recording.ts` → `../persistence/recording-journal`
  - `reproduction/exact-recording-worker.ts` → `../persistence/archive-journal-mirror`
- Worker URL은 같은 폴더로 함께 이동해 유지했다: `reproduction/exact-recording.ts` → `./exact-recording-worker.ts`.
- `dev/replay-archive.ts`는 재현 파서를 실제 구현 경로(`reproduction/scan-reproduction.ts`)에서 로드하도록 수정했다.
- Worker 테스트 4개와 `capture-originals` type import를 실제 구현 경로로 수정했다.

검증:

| 항목 | 결과 |
|---|---|
| lint | 0 |
| test | **3,800 tests · 3,796 pass · 0 fail · 4 skipped** |
| build | 0 |
| check:architecture | 위반 0 · 런타임 순환 0 · 타입 전용 경고 5 |
| video-1 | **384 / 384 / 384**, status 동일, discarded 67, 카드 값 차이 **0** |
| screenshots-1 | **40/40**, missed 0, review 0 |
| screenshots-2 | **38/38**, missed 0, review 0 |

산출물:

- `work/step7-video1-persistence-reproduction.json`
- `work/step7-screenshots1-persistence-reproduction.json`, `work/step7-screenshots1-persistence-reproduction-run.json`
- `work/step7-screenshots2-persistence-reproduction.json`, `work/step7-screenshots2-persistence-reproduction-run.json`
- `work/evaluation/step7-screenshots1-persistence-reproduction.json`, `work/evaluation/step7-screenshots2-persistence-reproduction.json`

## 9. 7.7 session evidence 배치 (완료)

`src/features/card-scanner/session/`로 이동한 파일(5개):

| 파일 | 책임 |
|---|---|
| `inventory-evidence.ts` | 카드·관측 증거 병합·동의 |
| `unknown-lifecycle.ts` | 미식별 수명주기 |
| `freshness-evidence.ts` | 최신 관측 증거 |
| `observation-history.ts` | 카드별 관측 이력 |
| `scan-grid.ts` | 스캔 그리드 상태 |

- 기존 경로 5개는 `export * from './session/...'` re-export로 유지한다.
- 배치 내부 import(`./observation-history`)는 유지하고, `consensus`·`name-confirmation`·`current-scan-fields`·`observation-execution`·`observation-work`·`recognizer`·`card-dictionary`·`capture-metadata`는 `../`로 보정했다.
- `scripts/analyze-observation-timing.mjs`와 `scripts/scan-human-expected.mjs`의 `.ts` import를 실제 구현 경로로 수정했다.

검증:

| 항목 | 결과 |
|---|---|
| lint | 0 |
| test | **3,800 tests · 3,796 pass · 0 fail · 4 skipped** |
| build | 0 |
| check:architecture | 위반 0 · 런타임 순환 0 · 타입 전용 경고 5 |
| video-1 | **384 / 384 / 384**, status 동일, discarded 67, 카드 값 차이 **0** |
| screenshots-1 | **40/40**, missed 0, review 0 |
| screenshots-2 | **38/38**, missed 0, review 0 |

산출물:

- `work/step7-video1-session-evidence.json`
- `work/step7-screenshots1-session-evidence.json`, `work/step7-screenshots1-session-evidence-run.json`
- `work/step7-screenshots2-session-evidence.json`, `work/step7-screenshots2-session-evidence-run.json`
- `work/evaluation/step7-screenshots1-session-evidence.json`, `work/evaluation/step7-screenshots2-session-evidence.json`

## 10. 7.8 acquisition clients 배치 (완료)

`src/features/card-scanner/acquisition/`로 이동한 파일(13개):

| 그룹 | 파일 |
|---|---|
| 클라이언트·Worker | `acquisition-client.ts`, `acquisition-worker.ts`, `saved-acquisition.ts` |
| 소스 준비 | `source-preparation.ts`, `source-preparation-protocol.ts`, `source-preparation-worker.ts` |
| 준비된 입력 | `prepared-crop-proof.ts`, `prepared-crop-proof-client.ts`, `prepared-decoded-frames.ts`, `prepared-live-source.ts`, `prepared-native-attestation.ts`, `prepared-recovery-prefetch.ts`, `prepared-slot.ts` |

- 기존 경로 13개는 `export * from './acquisition/...'` re-export로 유지한다.
- Worker URL은 같은 폴더로 함께 이동해 유지했다.
  - `acquisition/acquisition-client.ts` → `./acquisition-worker.ts`
  - `acquisition/source-preparation.ts` → `./source-preparation-worker.ts`
- root에 남은 `frame-obstruction-worker`는 `acquisition/acquisition-worker.ts`에서 `../frame-obstruction-worker.ts`로 참조한다.
- 테스트·dev의 실제 Worker entry 경로를 수정했다.
  - `tests/acquisition-measured-raster.test.ts`, `tests/acquisition-prepared-worker.test.ts`
  - `tests/acquisition-rejected-client.test.ts`, `tests/prepared-crop-worker.test.ts`, `tests/prepared-slot.test.ts`
  - `dev/prepared-crop-browser-proof.ts`, `dev/recording-raster-proof.ts`

검증:

| 항목 | 결과 |
|---|---|
| lint | 0 |
| test | **3,800 tests · 3,796 pass · 0 fail · 4 skipped** |
| build | 0 |
| check:architecture | 위반 0 · 런타임 순환 0 · 타입 전용 경고 5 |
| video-1 | **384 / 384 / 384**, status 동일, discarded 67, 카드 값 차이 **0** |
| screenshots-1 | **40/40**, missed 0, review 0 |
| screenshots-2 | **38/38**, missed 0, review 0 |

산출물:

- `work/step7-video1-acquisition-clients.json`
- `work/step7-screenshots1-acquisition-clients.json`, `work/step7-screenshots1-acquisition-clients-run.json`
- `work/step7-screenshots2-acquisition-clients.json`, `work/step7-screenshots2-acquisition-clients-run.json`
- `work/evaluation/step7-screenshots1-acquisition-clients.json`, `work/evaluation/step7-screenshots2-acquisition-clients.json`

## 11. 7.9 acquisition leftovers 배치 (완료)

`src/features/card-scanner/acquisition/`로 이동한 파일(7개):

| 파일 | 책임 |
|---|---|
| `acquisition-raster.ts` | 래스터 컨텍스트·픽셀 관측 |
| `acquisition-profile.ts` | 획득 측정 프로필 |
| `decoded-rgba-client.ts` | 디코드 RGBA 클라이언트 |
| `decoded-rgba-worker.ts` | 디코드 RGBA Worker |
| `input-acquisition-evidence.ts` | 입력·획득 증거 |
| `latest-acquisition-gate.ts` | 최신 획득 게이트 |
| `experimental-acquisition-receipts.ts` | 실험적 획득 영수증 |

- 기존 경로 7개는 `export * from './acquisition/...'` re-export로 유지한다.
- Worker URL 유지: `acquisition/decoded-rgba-client.ts` → `./decoded-rgba-worker.ts`.
- `acquisition/detector.ts`·`acquisition/card-acquisition.ts`가 같은 폴더의 `acquisition-raster`를 직접 참조하도록 정리했다.
- `recognition/visual-fields.ts`도 `../acquisition/acquisition-raster`를 직접 참조한다.
- `tests/count-pattern-runtime.test.ts`의 type import를 실제 구현 경로로 수정했다.

검증:

| 항목 | 결과 |
|---|---|
| lint | 0 |
| test | **3,800 tests · 3,796 pass · 0 fail · 4 skipped** |
| build | 0 |
| check:architecture | 위반 0 · 런타임 순환 0 · 타입 전용 경고 5 |
| video-1 | **384 / 384 / 384**, status 동일, discarded 67, 카드 값 차이 **0** |
| screenshots-1 | **40/40**, missed 0, review 0 |
| screenshots-2 | **38/38**, missed 0, review 0 |

산출물:

- `work/step7-video1-acquisition-leftovers.json`
- `work/step7-screenshots1-acquisition-leftovers.json`, `work/step7-screenshots1-acquisition-leftovers-run.json`
- `work/step7-screenshots2-acquisition-leftovers.json`, `work/step7-screenshots2-acquisition-leftovers-run.json`
- `work/evaluation/step7-screenshots1-acquisition-leftovers.json`, `work/evaluation/step7-screenshots2-acquisition-leftovers.json`

## 12. 7.10 scanner:other 배치 (완료)

`scanner:other`에 남아 있던 28개 파일을 책임별 하위 폴더로 이동했다.

### `reproduction/` (10개)

- `canonical-capture.ts`
- `freshness-evidence-replay.ts`, `inventory-evidence-replay.ts`, `live-input-decision-replay.ts`
- `observation-execution-replay.ts`, `obstruction-evidence-replay.ts`
- `unknown-hidden-replay.ts`, `unknown-lifecycle-replay.ts`, `unknown-recovery-claim-replay.ts`
- `retry-receipt-replay.ts`

### `acquisition/` (2개)

- `frame-obstruction-worker.ts`, `frame-obstruction-candidate.ts`

### `recognition/` (4개)

- `recognizer.ts`, `card-dictionary.ts`, `card-read-budget.ts`, `capture-metadata.ts`

### `ui/` (12개)

- `candidate-preview.ts`, `candidate-preview-image.ts`, `candidate-preview-worker.ts`
- `scan-monitor-store.ts`, `scan-watchdog.ts`
- `scanner-feedback.ts`, `scanner-feedback-state.ts`, `scanner-feedback-receipts.ts`, `scanner-feedback-summary.ts`
- `scan-attention-guidance.ts`, `attention-card-image.ts`, `replay-version-notice.ts`

- 기존 경로 28개는 `export * from './...'` re-export로 유지한다.
- `acquisition/acquisition-worker.ts`의 `frame-obstruction-worker` URL을 `./`로 수정했다.
- recognition 내부의 `card-dictionary`·`capture-metadata`·`card-read-budget`·`recognizer` import를 같은 폴더 직접 참조로 정리했다.
- `ui/scan-attention-guidance.ts`는 전환 단계에서 root re-export(`../recognizer`)를 사용해 `ui → recognition` 직접 의존 위반을 피했다.
- `tests/recognizer-diagnostic-scope.test.ts`의 loader hook 경로를 `recognition/recognizer.ts`로 수정했다.
- 스크립트·테스트의 `.ts` 직접 import를 실제 구현 경로로 수정했다.

검증:

| 항목 | 결과 |
|---|---|
| lint | 0 |
| test | **3,800 tests · 3,796 pass · 0 fail · 4 skipped** |
| build | 0 |
| check:architecture | 위반 0 · 런타임 순환 0 · 타입 전용 경고 5 |
| video-1 | **384 / 384 / 384**, status 동일, discarded 67, 카드 값 차이 **0** |
| screenshots-1 | **40/40**, missed 0, review 0 |
| screenshots-2 | **38/38**, missed 0, review 0 |

산출물:

- `work/step7-video1-scanner-other.json`
- `work/step7-screenshots1-scanner-other.json`, `work/step7-screenshots1-scanner-other-run.json`
- `work/step7-screenshots2-scanner-other.json`, `work/step7-screenshots2-scanner-other-run.json`
- `work/evaluation/step7-screenshots1-scanner-other.json`, `work/evaluation/step7-screenshots2-scanner-other.json`

## 13. 7.11 session root 배치 (완료)

`src/features/card-scanner/session/`로 이동한 파일(7개):

| 파일 | 책임 |
|---|---|
| `scanner.ts` | 스캔 오케스트레이션 |
| `scanner-preparation.ts` | 스캐너 준비·자원 소유권 |
| `current-scan-fields.ts` | 최신 필드·미해결 필드 |
| `observation-execution.ts` | 관측 실행 원장 |
| `observation-work.ts` | 관측 작업 큐 |
| `scan-monitor-outcome.ts` | 진행창 결과 요약 |
| `scan-grid-command.ts` | 스캔 그리드 명령·해시 |

- 기존 경로 7개는 `export * from './session/...'` re-export로 유지한다.
- `scanner.ts`의 대량 import는 `../`로 보정했고, 같은 배치 파일은 `./`로 유지했다.
- loader hook 테스트 3개의 moduleUrl과 dependency specifier를 새 경로에 맞췄다.
  - `tests/scanner-preparation.test.ts`, `tests/matching-scanner-preparation.test.ts`, `tests/scanner-name-operation.test.ts`
- `scripts/analyze-observation-timing.mjs`의 `scan-grid-command.ts` import를 새 경로로 수정했다.

검증:

| 항목 | 결과 |
|---|---|
| lint | 0 |
| test | **3,800 tests · 3,796 pass · 0 fail · 4 skipped** |
| build | 0 |
| check:architecture | 위반 0 · 런타임 순환 0 · 타입 전용 경고 5 |
| video-1 | **384 / 384 / 384**, status 동일, discarded 67, 카드 값 차이 **0** |
| screenshots-1 | **40/40**, missed 0, review 0 |
| screenshots-2 | **38/38**, missed 0, review 0 |

산출물:

- `work/step7-video1-session-root.json`
- `work/step7-screenshots1-session-root.json`, `work/step7-screenshots1-session-root-run.json`
- `work/step7-screenshots2-session-root.json`, `work/step7-screenshots2-session-root-run.json`
- `work/evaluation/step7-screenshots1-session-root.json`, `work/evaluation/step7-screenshots2-session-root.json`

## 14. 7.12 session·reproduction 대량 배치 (완료)

root에 남아 있던 76개 구현 파일을 이동했다.

### `session/` (52개)

- 완료·회복: `completion-drain-*`, `completion-obstruction-debt`, `completion-current-view`, `completion-frame-retention`, `completion-header-snapshot`, `completion-input-diagnostic`, `completion-race-guard`, `completion-view-roi`, `completion-wake`, `auto-completion`, `auto-completion-diagnostics`, `recovery-pipeline`, `recovery-completion`
- 미식별·재시도: `unknown-crop-retention`, `unknown-diagnostic-sidecars`, `unknown-hidden-guard`, `unknown-scan-session`, `unknown-observations`, `unknown-source-policy`, `unknown-lifecycle-types`, `retry-candidate`, `retry-quality`, `retry-receipt-state`
- 최신·재관측: `freshness-evidence-types`, `freshness-observation-bridge`, `fresh-observation`, `reobservation-evidence`, `field-retry`, `scan-deadline`, `scan-evidence-union`, `recognition-needed`
- 위치·병합: `inventory-position`, `observed-inventory-layout`, `metadata-order`, `sort-position-reset`, `confirmed-name-groups`, `merge-frames`, `finish-timing`
- live·판독 상태: `live-scan-policy`, `live-work-priority`, `live-obstruction-hint`, `reading-feedback`, `active-reading-counter`, `reader-work-wake`
- 입력 증거: `unidentified-diagnostics`, `delivered-input-coverage`, `input-loss-evidence`, `source-version-evidence`

### `reproduction/` (24개)

- 기록: `recording-work-queue`, `recording-input-raster`, `recording-compression`, `recording-frame-integrity`, `recording-snapshots`, `recording-readiness`, `recording-raster-pipeline`, `recording-raster-worker`, `optional-recording`, `encoded-pixel-residual`
- 저장·정본: `native-frame-storage`, `source-store-timing`, `rgba-window-policy`, `raw-session-archive`, `canonical-finalization-proof`, `canonical-source-publication`
- archive: `archive-exact-validation`, `archive-exact-validation-client`, `archive-exact-validation-worker`
- dev 기록: `dev-replay-archive`, `dev-blob-hash`, `dev-blob-hash-core`, `dev-blob-hash-worker`, `dev-blob-hash-limits`

- 기존 경로 76개는 `export * from './session/...'`·`export * from './reproduction/...'` re-export로 유지한다.
- Worker URL은 같은 폴더로 함께 이동해 유지했다.
  - `recording-raster-pipeline` → `recording-raster-worker`
  - `dev-blob-hash` → `dev-blob-hash-worker`
  - `archive-exact-validation-client` → `archive-exact-validation-worker`
- `tests/recording-raster-worker.test.ts`와 `dev/replay-archive.ts`의 경로를 새 구현 위치로 수정했다.

검증:

| 항목 | 결과 |
|---|---|
| lint | 0 |
| test | **3,800 tests · 3,796 pass · 0 fail · 4 skipped** |
| build | 0 |
| check:architecture | 위반 0 · 런타임 순환 0 · 타입 전용 경고 5 |
| video-1 | **384 / 384 / 384**, status 동일, discarded 67, 카드 값 차이 **0** |
| screenshots-1 | **40/40**, missed 0, review 0 |
| screenshots-2 | **38/38**, missed 0, review 0 |

산출물:

- `work/step7-video1-batch12.json`
- `work/step7-screenshots1-batch12.json`, `work/step7-screenshots1-batch12-run.json`
- `work/step7-screenshots2-batch12.json`, `work/step7-screenshots2-batch12-run.json`
- `work/evaluation/step7-screenshots1-batch12.json`, `work/evaluation/step7-screenshots2-batch12.json`

## 15. 7.13 최종 root 배치 (완료)

root에 남아 있던 93개 구현 파일을 5개 하위 폴더로 이동했다.

| 폴더 | 수 | 대표 파일 |
|---|---:|---|
| `capture/` | 25 | `streaming-delta-source`, `generic-bounded-input`, `bounded-blob-input`, `capture-encoder`, `continuous-capture`, `live-input-admission`, `media-lineage`, `scanner-input-frame` |
| `acquisition/` | 27 | `verified-recovery-read`, `verified-crop-reader`, `overlay-quality`, `fixed-grid-rescue`, `native-yuv-recipe`, `restored-pixel-capability`, `empty-slot`, `detector-*`, `layout-geometry`, `exact-pixel-cache`, `area-gray`, `observation-pixels`, `pixel-*`, `field-pixel-regions`, `metadata-regions` |
| `recognition/` | 5 | `count-source-probe`, `count-source-provenance`, `frame-name-evidence`, `frame-name-offline`, `identity-fields` |
| `session/` | 17 | `advisory-obstruction-experiment`, `gap-recovery-experiment`, `grid-*`, `live-inventory`, `matching-scanner-preparation`, `metadata-scheduling`, `obstruction-recording-receipt`, `scanner-name-*`, `scroll-*` |
| `ui/` | 19 | `scan-monitor-message`, `scan-monitor-feedback-dom`, `scan-read-detail`, `scan-activity`, `scan-film`, `read-progress`, `preview-*`, `monitor-estimated-cell`, `frozen-viewport-hint`, `use-live-obstruction-hint`, `review-display`, `live-scroll-preview`, `recording-ui-policy` |

- 기존 경로 93개는 `export * from './<folder>/...'` re-export로 유지한다.
- 서로 다른 하위 폴더 간 import는 root re-export를 경유해 레이어 위반을 피했다.
- 같은 `session/` 폴더 안의 `scanner-preparation`·`scan-grid`·`observation-execution` 등은 직접 참조로 정리했다. 이는 loader hook 테스트가 준비 모듈을 한 인스턴스로 보게 하기 위함이다.
- loader hook 테스트의 `scanner-name-operation`·`matching-scanner-preparation` URL을 새 경로로 수정했다.

검증:

| 항목 | 결과 |
|---|---|
| lint | 0 |
| test | **3,800 tests · 3,796 pass · 0 fail · 4 skipped** |
| build | 0 |
| check:architecture | 위반 0 · 런타임 순환 0 · 타입 전용 경고 5 |
| video-1 | **384 / 384 / 384**, status 동일, discarded 67, 카드 값 차이 **0** |
| screenshots-1 | **40/40**, missed 0, review 0 |
| screenshots-2 | **38/38**, missed 0, review 0 |

산출물:

- `work/step7-video1-batch13.json`
- `work/step7-screenshots1-batch13.json`, `work/step7-screenshots1-batch13-run.json`
- `work/step7-screenshots2-batch13.json`, `work/step7-screenshots2-batch13-run.json`
- `work/evaluation/step7-screenshots1-batch13.json`, `work/evaluation/step7-screenshots2-batch13.json`

## 16. 7.14 호환 re-export 제거 (완료)

- root의 호환 re-export shim **323개를 삭제**했다.
- `src`, `dev`, `tests`, `scripts`의 import 1,521개를 실제 하위 폴더 경로로 재작성했다.
- 삭제 후 하위 폴더에 남은 dangling import 633개를 파일명 기반으로 복구했다.
- `scanner.ts`는 `orchestration/`으로 이동해 composition root로 분리했다.
- `debug-store`는 `capture/`, `scanner-feedback-summary`는 `session/`으로 이동했다.
- `ui/ScanReplayDialog`는 orchestrator 대신 `public.ts`를 사용한다.
- `evaluation/`을 레이어 분류에 추가했다.

### 최종 구조

| 레이어 | 파일 수 |
|---|---:|
| `scanner:capture` | 32 |
| `scanner:acquisition` | 55 |
| `scanner:recognition` | 51 |
| `scanner:session` | 92 |
| `scanner:reproduction` | 50 |
| `scanner:persistence` | 6 |
| `scanner:ui` | 36 |
| `scanner:orchestration` | 1 |
| `scanner:public` | 1 |
| `scanner:evaluation` | 4 |
| **`scanner:other`** | **0** |

- root에는 `public.ts`만 남았다.
- `scanner:other` 예외를 제거했고, 새 root 구현 파일은 구조 검사에서 위반이다.
- 레이어 검사는 런타임 import만 대상으로 한다. UI는 leaf, orchestration은 root다.
- 호환 shim이 없으므로 모든 import는 실제 구현 경로를 가리킨다.

검증:

| 항목 | 결과 |
|---|---|
| lint | 0 |
| test | **3,800 tests · 3,796 pass · 0 fail · 4 skipped** |
| build | 0 |
| check:architecture | 위반 0 · 런타임 순환 0 · 타입 전용 경고 5 · `scanner:other` 0 |
| video-1 | **384 / 384 / 384**, status 동일, discarded 67, 카드 값 차이 **0** |
| screenshots-1 | **40/40**, missed 0, review 0 |
| screenshots-2 | **38/38**, missed 0, review 0 |

산출물:

- `work/step7-video1-batch14.json`
- `work/step7-screenshots1-batch14.json`, `work/step7-screenshots1-batch14-run.json`
- `work/step7-screenshots2-batch14.json`, `work/step7-screenshots2-batch14-run.json`
- `work/evaluation/step7-screenshots1-batch14.json`, `work/evaluation/step7-screenshots2-batch14.json`

## 17. 남은 한계

- 타입 전용 순환 경고 5개가 남아 있다.
- 실제 화면 공유·다른 해상도 검증은 아직이다.
- 모호한 합성 카드 3장(`세티노`·`자크라`·`베히모스`)이 미확정이다.
- 다음은 Step 8 App 분해, Step 9 실제 화면 공유 E2E다.
