# 구조 마이그레이션 계획

- 작성일: 2026-11-08
- 상위 문서: `docs/architecture.md`
- 원칙: 배치 이동 + re-export, 배치마다 lint/test/build, 동작 변경 0

## 1. 이동 원칙

1. 한 번에 318개 파일을 옮기지 않는다.
2. 배치 크기는 한 하위 폴더 또는 한 책임 단위로 제한한다.
3. 이동한 파일은 기존 경로에 re-export를 남긴다.
4. 기존 import를 한 번에 모두 고치지 않는다. 새 코드와 이동한 파일부터 새 경로를 쓴다.
5. 각 배치 후 `npm run lint`, `npm test`, `npm run build`를 통과한다.
6. 인식 동작은 Step 5 전까지 바꾸지 않는다.

## 2. Step 3에서 이미 이동한 파일

| 현재 위치 | 이유 |
|---|---|
| `src/shared/card-rarity.ts` | 기능 공용 UI 등급 표시 |
| `src/shared/ui/CardName.tsx` | 기능 공용 카드 이름 UI |
| `src/shared/ui/CardThumbnail.tsx` | 기능 공용 썸네일 UI |
| `src/shared/monitor-latency.ts` | dev 전용 표시 지연 계측을 src로 이동 |
| `src/features/growth/live-results.ts` | growth가 소유하는 결과→성장 입력 변환 |
| `src/features/card-scanner/rejected-raster-plan.ts` | 스캐너 Worker가 쓰는 거절 래스터 계획 |
| `src/features/card-scanner/exact-recording-compression.ts` | 기록 압축·해제 저수준 연산 |
| `src/features/growth/growth-effects.ts` | 성장 효과 활성 판정 |
| `src/features/growth/public.ts` | growth 공개 진입점 |

기존 경로(`src/card-rarity.ts`, `src/CardName.tsx`, `src/CardThumbnail.tsx`, `dev/monitor-latency.ts`, `src/features/live-results.ts`)는 re-export만 남긴다.

## 3. Step 4 — domain/data 분리 (완료)

### 이동한 파일

| 현재 위치 | 책임 |
|---|---|
| `src/domain/inventory-csv.ts` | CSV 경험치·카드 목록 파싱·검증·직렬화 |
| `src/domain/inventory-unowned.ts` | 미보유 카드 계산 |
| `src/domain/growth-types.ts` | 성장 공유 타입 |
| `src/domain/growth.ts` | 성장 비용·신뢰 목록·후보 비교 |
| `src/domain/growth-sequence.ts` | 순차 성장 단계 |
| `src/domain/collection-candidates.ts` | 도감 후보 계산 |
| `src/domain/growth-effects.ts` | 도감 효과 활성 판정 |
| `src/domain/stat-collection.ts` | 스탯 도감 후보 |
| `src/domain/live-results.ts` | 결과 카드 키·성장 입력 변환 |
| `src/domain/raid-progress.ts` | 레이드 세트 진행·다음 계획 |
| `src/domain/raid-ranking.ts` | 레이드 세트 순위 |

### 카탈로그 로딩

- `src/data/catalog.ts`가 `scanner/cards.json`, `growth/master.json`, `raid/master.json` 로딩과 형식 검증을 담당한다.
- `App.tsx`, `GrowthPlanner.tsx`, `RaidCards.tsx`가 이 로더를 사용한다.
- 스캐너 메인 판독기의 `cards.json`·원화·별·패턴 로딩은 `loadScannerJson`을 사용한다.
- 스캐너 Worker·모델·원화 상세 자산 로딩은 Step 5/7에서 `data` 경계로 옮긴다.

### 호환 경로

다음 파일은 기존 import를 유지하기 위한 re-export다.

- `src/inventory-csv.ts`, `src/inventory-unowned.ts`
- `src/features/growth/optimizer.ts`, `growth-sequence.ts`, `collection-candidates.ts`, `growth-effects.ts`, `stat-collection.ts`, `live-results.ts`
- `src/features/raid/raid-progress.ts`, `raid-ranking.ts`

### 결과

- 레이어 위반: **0**
- 런타임 순환: **0**
- 기능 간 직접 의존: **0**
- 타입 전용 순환 경고: **5**
- 새 테스트: `tests/catalog-data.test.ts`
- 검증: `npm run lint` 0 · `npm test` **3,758 tests · 3,754 pass · 0 fail · 4 skipped** · `npm run build` 0 · `git diff --check` 0

## 4. Step 5 — recognition v2 (진행 중)

### 5.1 기하 정규화·다해상도 홀드아웃 (완료)

- `layout-geometry.ts`로 10×4 격자·카드 크기·메타데이터 상수를 분리했다.
- `detector.ts`가 `normalizeLayoutGeometry`를 사용한다.
- `ObservedGrid`로 헤더 앵커 배율과 카드 격자 배율을 분리할 수 있다.
- 720p·1080p·1440p·4K·관측 격자 행렬을 `tests/layout-geometry.test.ts`로 고정했다.
- video-1 재실행: 카드 384/384/384, 카드별 값 차이 **0**, 4장 라벨 평가 pass.
- 검증: `npm run lint` 0 · `npm test` **3,764 tests · 3,760 pass · 0 fail · 4 skipped** · `npm run build` 0 · `check:architecture` 0.
- 상세: `docs/geometry-holdout.md`.

### 5.2 이름+원화 융합 (완료)

- `identity-fusion.ts`가 이름·원화·초상 근거를 하나의 판정으로 융합한다.
- `recognizer.identify`가 이 판정을 사용한다.
- 정책: 정확한 이름은 이름으로, 모호한 이름은 원화가 같은 ID를 독립 지지할 때만, 원화 단독은 `confirmPortrait` 통과 시에만 확정한다. 이름·원화 충돌은 미확정이다.
- 420장 합성 홀드아웃: 417장 중 **414 정확 · 340 원화 확정 · 3 모호 이름 미확정 · 오확정 0**.
  - 장문 2장(`3201017`, `3202044`)은 원화로 회복.
  - `세티노`·`자크라`·`베히모스`는 원화 마진 부족으로 `인식 필요` 유지.
- video-1 재실행: 384/384/384, 카드 값 차이 0, discarded 67 동일.
- 검증: `npm run lint` 0 · `npm test` **3,772 tests · 3,768 pass · 0 fail · 4 skipped** · `npm run build` 0 · `check:architecture` 0.
- 상세: `docs/identity-fusion.md`.

### 5.3 각성·장수 필드 증거 (완료)

- `singleStillFrameEmptyCandidate`를 추가해 정지 이미지 1장의 명시적 빈 장수 증거를 허용했다.
- `scanner.ts` finalization이 `stillImages` + 관측 1회 + `stablePreviewEmptyCandidate`일 때 0장을 확정한다.
- 동영상은 기존처럼 3회 이상 관측을 요구한다.
- 베스칼(`3200813`) 크롭은 `iconFlat=true · digitsFlat=false · 숫자/아이콘 흔적 없음 · 고주파 가림 없음`으로 빈 장수 후보였다.
- 필드 평가:
  - screenshots-1: 장수 **39/40 → 40/40**, `readableButMissed 1 → 0`, `review 1 → 0`, fail → **pass**
  - screenshots-2: 장수 **37/38 → 38/38**, `readableButMissed 1 → 0`, `review 1 → 0`, fail → **pass**
- 검증: `npm run lint` 0 · `npm test` **3,773 tests · 3,769 pass · 0 fail · 4 skipped** · `npm run build` 0 · `check:architecture` 0.
- 상세: `docs/field-evidence.md`.

## 5. Step 6 — scanner session 분해 (진행 중)

### 6.1 finalization·duplicate 추출 (완료)

| 모듈 | 책임 |
|---|---|
| `session-finalization.ts` | 최종 status·완료 카드/이름/리뷰 수 계산 |
| `session-duplicate.ts` | final duplicate fast 후보·slow 재판독 순위 |

- `scanner.ts`는 이제 두 모듈을 호출하고 상태 변경·discard·영수증만 담당한다.
- `scan-ledger.ts`, `final-duplicate.ts`, `discarded-observations.ts`는 이미 분리돼 있다.
- video-1 재실행:
  - finalization 추출 후 `step6-video1-finalization.json`
  - duplicate 추출 후 `step6-video1-duplicate.json`
  - 두 결과 모두 384/384/384, status 동일, discarded 67, 카드 값 차이 0
- 테스트: `tests/session-finalization.test.ts` 8건, `tests/session-duplicate.test.ts` 7건
- 검증: `npm run lint` 0 · `npm test` **3,792 tests · 3,788 pass · 0 fail · 4 skipped** · `npm run build` 0 · `check:architecture` 0
- 상세: `docs/session-decomposition.md`

### 6.2 diagnostics snapshot (완료)

- `session-diagnostics.ts`가 최종 카드·미식별·discard·recognition-needed 요약을 만든다.
- `createScanDiagnosticSummary`의 `result`가 이 요약을 사용한다.
- `cards` 필드는 리포트에 넣지 않아 기존 failure-only 계약을 유지한다.
- 테스트: `tests/session-diagnostics.test.ts` 4건
- video-1 재실행: 384/384/384, status 동일, discarded 67, 카드 값 차이 0
- 검증: `npm run lint` 0 · `npm test` **3,792 tests · 3,788 pass · 0 fail · 4 skipped** · `npm run build` 0 · `check:architecture` 0

### 6.3a finalization mutation (완료)

- `session-finalize.ts`가 discard·counter·status 변경을 담당한다.
- `scanner.ts`는 기존 순서대로 호출하고, `session-finalize.ts`는 scanner 타입을 import하지 않는다.
- 테스트: `tests/session-finalize.test.ts` 5건
- video-1 재실행: 384/384/384, status 동일, discarded 67, 카드 값 차이 0
- 검증: `npm run lint` 0 · `npm test` **3,797 tests · 3,793 pass · 0 fail · 4 skipped** · `npm run build` 0 · `check:architecture` 0

### 6.3b finalization orchestrator (완료)

- `session-orchestrator.ts`가 discard → counters → receipt/grid → final status → emit 순서를 담당한다.
- `beforeFinalStatus` 실패 시 status·emit을 실행하지 않는다.
- 테스트: `tests/session-orchestrator.test.ts` 3건
- video-1 재실행: 384/384/384, status 동일, discarded 67, 카드 값 차이 0
- 검증: `npm run lint` 0 · `npm test` **3,800 tests · 3,796 pass · 0 fail · 4 skipped** · `npm run build` 0 · `check:architecture` 0
- 입력·큐·스케줄 루프는 아직 `scanner.ts`에 남아 있으며 Step 7 물리 분할에서 다룬다.

## 6. Step 7 — scanner 물리 분할 (진행 중)

### 7.1 UI 배치 (완료)

`src/features/card-scanner/ui/`로 이동:

- `ScanActivity.tsx`
- `ScanAttention.tsx`
- `ScanReadProgress.tsx`
- `ScanMonitor.tsx`
- `ScanReplayDialog.tsx`
- `ExecutionCompletenessNotice.tsx`
- `InventoryReplayNotice.tsx`

- 기존 경로는 named re-export로 유지한다.
- CSS는 기존 위치에 두고 이동한 컴포넌트가 `../`로 참조한다.
- 검증: lint 0 · **3,800 tests · 3,796 pass · 0 fail · 4 skipped** · build 0 · check 0
- video-1: 384/384/384, status 동일, discarded 67, 카드 값 차이 0
- screenshots-1·2: 40/40·38/38, missed 0, review 0
- 상세: `docs/physical-split.md`

### 7.2 capture 배치 (완료)

`src/features/card-scanner/capture/`로 이동:

- `input-source.ts`
- `live-frame-clock.ts`
- `track-frame-source.ts`
- `freeze-live-frame.ts`
- `share-stream-owner.ts`
- `live-capture-pipeline.ts`

- 기존 경로는 re-export로 유지한다.
- video-1: 384/384/384, status 동일, discarded 67, 카드 값 차이 0
- screenshots-1·2: 40/40·38/38, missed 0, review 0
- 검증: lint 0 · **3,800 tests · 3,796 pass · 0 fail · 4 skipped** · build 0 · check 0

### 7.3 acquisition 배치 (완료)

`src/features/card-scanner/acquisition/`로 이동:

- `detector.ts`
- `card-borders.ts`
- `border-integrity.ts`
- `card-acquisition.ts`
- `capture-quality.ts`
- `candidate-queue.ts`

- 기존 경로는 re-export로 유지한다.
- video-1: 384/384/384, status 동일, discarded 67, 카드 값 차이 0
- screenshots-1·2: 40/40·38/38, missed 0, review 0
- 검증: lint 0 · **3,800 tests · 3,796 pass · 0 fail · 4 skipped** · build 0 · check 0

### 7.4 recognition 배치 (완료)

`src/features/card-scanner/recognition/`로 42개 파일 이동:

- 이름: `name-*`, `neural-reader`, `neural-ocr-worker`, `soft-name-pixels`, `text-mask`, `recognition-input-observer`
- 원화·등급: `artwork-verifier`, `portrait-*`, `visual-*`
- 각성·장수: `count-*`, `counter-evidence`, `star-pattern`
- OCR·문자열: `ctc-*`, `ocr-*`, `consensus*`
- 융합: `identity-fusion`

- 기존 경로 42개는 `export * from './recognition/...'` re-export로 유지한다.
- Worker URL은 실제 구현과 같은 폴더로 이동해 유지한다.
- `tests/name-reader-continuation.test.ts`의 loader hook moduleUrl을 실제 구현 경로로 수정했다.
- video-1: 384/384/384, status 동일, discarded 67, 카드 값 차이 0
- screenshots-1·2: 40/40·38/38, missed 0, review 0
- 검증: lint 0 · **3,800 tests · 3,796 pass · 0 fail · 4 skipped** · build 0 · check 0
- 상세: `docs/physical-split.md`

### 7.5 session 배치 (완료)

`src/features/card-scanner/session/`로 11개 파일 이동:

- `session-finalization.ts`
- `session-finalize.ts`
- `session-orchestrator.ts`
- `session-duplicate.ts`
- `session-diagnostics.ts`
- `scan-ledger.ts`
- `final-duplicate.ts`
- `discarded-observations.ts`
- `completion.ts`
- `negative-completion.ts`
- `positive-completion.ts`

- 기존 경로는 re-export로 유지한다.
- video-1: 384/384/384, status 동일, discarded 67, 카드 값 차이 0
- screenshots-1·2: 40/40·38/38, missed 0, review 0
- 검증: lint 0 · **3,800 tests · 3,796 pass · 0 fail · 4 skipped** · build 0 · check 0
- 상세: `docs/physical-split.md`

### 7.6 persistence·reproduction 배치 (완료)

`src/features/card-scanner/persistence/`로 6개, `src/features/card-scanner/reproduction/`로 16개 파일 이동:

- persistence: `scan-backup`, `progress-backup`, `recording-journal`, `recording-spool`, `archive-journal-mirror`
- reproduction: `scan-reproduction`, `reproduction-session-store`, `reproduction-coverage`, `reproduction-input`, `exact-recording*`, `canonical-frame-index`, `canonical-frame-reader`, `canonical-raster-replay`, `canonical-source-use`, `canonical-storage-attestation`, `debug-capture`, `debug-bundle`

- 기존 경로는 re-export로 유지한다.
- Worker URL(`exact-recording` → `exact-recording-worker`)은 같은 폴더로 함께 이동했다.
- `dev/replay-archive.ts`와 Worker 테스트 4개의 실제 구현 경로를 수정했다.
- video-1: 384/384/384, status 동일, discarded 67, 카드 값 차이 0
- screenshots-1·2: 40/40·38/38, missed 0, review 0
- 검증: lint 0 · **3,800 tests · 3,796 pass · 0 fail · 4 skipped** · build 0 · check 0
- 상세: `docs/physical-split.md`

### 7.7 session evidence 배치 (완료)

`src/features/card-scanner/session/`로 5개 파일 이동:

- `inventory-evidence.ts`
- `unknown-lifecycle.ts`
- `freshness-evidence.ts`
- `observation-history.ts`
- `scan-grid.ts`

- 기존 경로는 re-export로 유지한다.
- `scripts/analyze-observation-timing.mjs`와 `scripts/scan-human-expected.mjs`의 `.ts` import를 실제 구현 경로로 수정했다.
- video-1: 384/384/384, status 동일, discarded 67, 카드 값 차이 0
- screenshots-1·2: 40/40·38/38, missed 0, review 0
- 검증: lint 0 · **3,800 tests · 3,796 pass · 0 fail · 4 skipped** · build 0 · check 0
- 상세: `docs/physical-split.md`

### 7.8 acquisition clients 배치 (완료)

`src/features/card-scanner/acquisition/`로 13개 파일 이동:

- `acquisition-client.ts`, `acquisition-worker.ts`, `saved-acquisition.ts`
- `source-preparation.ts`, `source-preparation-protocol.ts`, `source-preparation-worker.ts`
- `prepared-crop-proof.ts`, `prepared-crop-proof-client.ts`, `prepared-decoded-frames.ts`, `prepared-live-source.ts`, `prepared-native-attestation.ts`, `prepared-recovery-prefetch.ts`, `prepared-slot.ts`

- 기존 경로는 re-export로 유지한다.
- Worker URL은 같은 폴더로 함께 이동했고, root `frame-obstruction-worker`는 `../`로 참조한다.
- 테스트·dev의 실제 Worker entry 경로를 수정했다.
- video-1: 384/384/384, status 동일, discarded 67, 카드 값 차이 0
- screenshots-1·2: 40/40·38/38, missed 0, review 0
- 검증: lint 0 · **3,800 tests · 3,796 pass · 0 fail · 4 skipped** · build 0 · check 0
- 상세: `docs/physical-split.md`

### 7.9 acquisition leftovers 배치 (완료)

`src/features/card-scanner/acquisition/`로 7개 파일 이동:

- `acquisition-raster.ts`, `acquisition-profile.ts`
- `decoded-rgba-client.ts`, `decoded-rgba-worker.ts`
- `input-acquisition-evidence.ts`, `latest-acquisition-gate.ts`, `experimental-acquisition-receipts.ts`

- 기존 경로는 re-export로 유지한다.
- Worker URL(`decoded-rgba-client` → `decoded-rgba-worker`)은 같은 폴더로 함께 이동했다.
- `acquisition/detector`, `acquisition/card-acquisition`, `recognition/visual-fields`가 `acquisition-raster`를 직접 참조하도록 정리했다.
- video-1: 384/384/384, status 동일, discarded 67, 카드 값 차이 0
- screenshots-1·2: 40/40·38/38, missed 0, review 0
- 검증: lint 0 · **3,800 tests · 3,796 pass · 0 fail · 4 skipped** · build 0 · check 0
- 상세: `docs/physical-split.md`

### 7.10 scanner:other 배치 (완료)

28개 파일을 책임별 하위 폴더로 이동:

- reproduction(10): `canonical-capture`, `freshness-evidence-replay`, `inventory-evidence-replay`, `live-input-decision-replay`, `observation-execution-replay`, `obstruction-evidence-replay`, `unknown-hidden-replay`, `unknown-lifecycle-replay`, `unknown-recovery-claim-replay`, `retry-receipt-replay`
- acquisition(2): `frame-obstruction-worker`, `frame-obstruction-candidate`
- recognition(4): `recognizer`, `card-dictionary`, `card-read-budget`, `capture-metadata`
- ui(12): `candidate-preview*`, `scan-monitor-store`, `scan-watchdog`, `scanner-feedback*`, `scan-attention-guidance`, `attention-card-image`, `replay-version-notice`

- 기존 경로는 re-export로 유지한다.
- Worker URL·loader hook·스크립트 `.ts` import를 실제 구현 경로로 수정했다.
- `ui/scan-attention-guidance.ts`는 root re-export를 사용해 `ui → recognition` 위반을 피했다.
- video-1: 384/384/384, status 동일, discarded 67, 카드 값 차이 0
- screenshots-1·2: 40/40·38/38, missed 0, review 0
- 검증: lint 0 · **3,800 tests · 3,796 pass · 0 fail · 4 skipped** · build 0 · check 0
- 상세: `docs/physical-split.md`

### 7.11 session root 배치 (완료)

`src/features/card-scanner/session/`로 7개 파일 이동:

- `scanner.ts`, `scanner-preparation.ts`
- `current-scan-fields.ts`, `observation-execution.ts`, `observation-work.ts`
- `scan-monitor-outcome.ts`, `scan-grid-command.ts`

- 기존 경로는 re-export로 유지한다.
- loader hook 테스트 3개의 moduleUrl·dependency specifier를 새 경로에 맞췄다.
- `scripts/analyze-observation-timing.mjs`의 import를 새 경로로 수정했다.
- video-1: 384/384/384, status 동일, discarded 67, 카드 값 차이 0
- screenshots-1·2: 40/40·38/38, missed 0, review 0
- 검증: lint 0 · **3,800 tests · 3,796 pass · 0 fail · 4 skipped** · build 0 · check 0
- 상세: `docs/physical-split.md`

### 7.12 session·reproduction 대량 배치 (완료)

root에 남아 있던 76개 구현 파일 이동:

- session(52): `completion-*`, `auto-completion*`, `recovery-*`, `unknown-*`, `retry-*`, `freshness-*`, `fresh-observation`, `reobservation-evidence`, `field-retry`, `scan-deadline`, `scan-evidence-union`, `recognition-needed`, `inventory-position`, `observed-inventory-layout`, `metadata-order`, `sort-position-reset`, `confirmed-name-groups`, `merge-frames`, `finish-timing`, `live-*`, `reading-feedback`, `active-reading-counter`, `reader-work-wake`, `unidentified-diagnostics`, `delivered-input-coverage`, `input-loss-evidence`, `source-version-evidence`
- reproduction(24): `recording-*`, `native-frame-storage`, `source-store-timing`, `rgba-window-policy`, `raw-session-archive`, `canonical-finalization-proof`, `canonical-source-publication`, `archive-exact-validation*`, `dev-replay-archive`, `dev-blob-hash*`, `optional-recording`, `encoded-pixel-residual`

- 기존 경로는 re-export로 유지한다.
- Worker URL·테스트·dev 경로를 새 구현 위치로 수정했다.
- video-1: 384/384/384, status 동일, discarded 67, 카드 값 차이 0
- screenshots-1·2: 40/40·38/38, missed 0, review 0
- 검증: lint 0 · **3,800 tests · 3,796 pass · 0 fail · 4 skipped** · build 0 · check 0
- 상세: `docs/physical-split.md`

### 7.13 최종 root 배치 (완료)

root의 93개 구현 파일 이동:

- capture(25): `streaming-delta-source`, `generic-bounded-input`, `bounded-blob-input`, `capture-*`, `continuous-capture`, `live-input-admission`, `media-lineage`, `scanner-input-frame` 등
- acquisition(27): `verified-*`, `overlay-quality`, `fixed-grid-rescue`, `native-yuv-recipe`, `restored-pixel-capability`, `empty-slot`, `detector-*`, `layout-geometry`, `exact-pixel-cache`, `area-gray`, `observation-pixels`, `pixel-*`, `field-pixel-regions`, `metadata-regions` 등
- recognition(5): `count-source-probe`, `count-source-provenance`, `frame-name-evidence`, `frame-name-offline`, `identity-fields`
- session(17): `grid-*`, `scroll-*`, `scanner-name-*`, `matching-scanner-preparation`, `metadata-scheduling`, `live-inventory` 등
- ui(19): `scan-monitor-*`, `scan-read-detail`, `scan-activity`, `scan-film`, `read-progress`, `preview-*`, `review-display`, `live-scroll-preview` 등

- 기존 경로는 re-export로 유지한다.
- 서로 다른 하위 폴더 간 import는 root re-export를 경유한다.
- 같은 session 폴더의 준비·관측 모듈은 직접 참조로 정리했다.
- video-1: 384/384/384, status 동일, discarded 67, 카드 값 차이 0
- screenshots-1·2: 40/40·38/38, missed 0, review 0
- 검증: lint 0 · **3,800 tests · 3,796 pass · 0 fail · 4 skipped** · build 0 · check 0
- 상세: `docs/physical-split.md`

### 7.14 호환 re-export 제거 (완료)

- root shim 323개 삭제.
- `src`·`dev`·`tests`·`scripts` import 1,521개를 실제 구현 경로로 재작성.
- dangling import 633개 복구.
- `scanner.ts`를 `orchestration/`으로 이동하고 composition root로 분리.
- `debug-store` → capture, `scanner-feedback-summary` → session 이동.
- `ui/ScanReplayDialog`는 `public.ts`를 사용.
- `evaluation/`을 레이어 분류에 추가.
- `scanner:other` 0, root 구현은 `public.ts`만 남음.
- 정책: UI leaf, orchestration root, 레이어 검사는 런타임 import만 적용.
- video-1: 384/384/384, status 동일, discarded 67, 카드 값 차이 0
- screenshots-1·2: 40/40·38/38, missed 0, review 0
- 검증: lint 0 · **3,800 tests · 3,796 pass · 0 fail · 4 skipped** · build 0 · check 0
- 상세: `docs/physical-split.md`

## 7. Step 8 — App 분해

| 현재 | 목표 |
|---|---|
| `App.tsx` 전체 | `app/AppShell.tsx` |
| 공유·스캔 실행 | `app/ScannerWorkspace.tsx`, `app/useScannerSession.ts` |
| 목록·CSV | `app/InventoryWorkspace.tsx`, `app/useInventoryCsv.ts` |
| 테마·내비게이션 | `app/ThemeProvider.tsx`, `app/navigation.ts` |

Step 8 종료 후 `app`은 `features/*/public.ts`만 import하도록 정책을 좁힌다.

## 8. 검증 명령

```sh
npm run check:architecture
npm run lint
npm test
npm run build
```

각 배치의 결과는 `work/architecture-check.json`과 테스트 출력으로 남긴다. 코퍼스 재실행이 필요한 변경은 `docs/evaluation.md`의 리포트를 함께 남긴다.
