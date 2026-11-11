# 프로그램 구조

- 작성일: 2026-11-08
- 상태: Step 7.14 적용 (물리 분할·shim 제거 완료)
- 검사: `npm run check:architecture`
- 정책: `scripts/architecture-policy.json`

## 1. 목표 구조

```text
src/
  app/                 # 앱 셸, 내비게이션, 테마, 화면 조합
  domain/              # 순수 규칙·타입
  data/                # 카탈로그, 스키마, 생성 데이터
  features/
    card-scanner/
      capture/         # 공유 입력, 프레임 고정, 시계
      acquisition/     # 창·그리드 검출, 테두리, 품질, 크롭
      recognition/     # 이름, 원화, 각성, 장수, 후보 융합
      session/         # 관측 원장, 병합, 완료, 영수증
      reproduction/    # 기록, 픽셀·상태 재생, 비교
      persistence/     # 백업, 부분 저장, 체크포인트
      ui/              # 모니터, 진행, 리뷰, 재현 화면
      public.ts        # 다른 기능이 쓰는 유일한 진입점
    inventory/
    growth/
    raid/
    merchants/
  shared/              # 공용 UI·훅·유틸
dev/                   # 개발 하네스
tests/                 # 계약·회귀·평가
```

## 2. 레이어 규칙

| From | 허용 | 금지 |
|---|---|---|
| `src/app` | app, root, feature, scanner, domain, data, shared | 없음(최상위) |
| `src` 최상위(root) | app, root, feature, scanner, domain, data, shared | 없음(전환 단계) |
| `src/features/*` | 자기 기능 내부, domain, data, shared | app, root, 다른 기능 내부 |
| `src/features/*/public.ts` | 다른 기능이 import 가능한 유일한 진입점 | 내부 파일 직접 import |
| `src/domain` | domain | features, app, data, shared |
| `src/data` | domain, data | features, app, shared |
| `src/shared` | shared | features, app, domain, data |
| `dev` / `tests` / `scripts` | 모든 레이어 | 없음 |

### 전환 단계 예외

- `src/app`과 `src` 최상위 파일은 Step 8 전까지 스캐너 내부를 직접 import할 수 있다.
- 이 예외는 `App.tsx`를 한 번에 분해하지 않기 위한 것이다. Step 8에서 `scanner/public.ts`로 좁힌다.
- 기능 간 import는 예외 없이 `public.ts`만 허용한다.

## 3. 스캐너 내부 규칙

Step 7.14에서 호환 re-export shim을 제거한 뒤의 규칙이다.

```text
public        → 모든 scanner 하위 폴더 (re-export)
orchestration → 모든 scanner 하위 폴더
ui            → session / domain / data / shared / capture / acquisition / recognition / reproduction / persistence
그 외 하위 폴더 → 서로 import 가능
ui            ← orchestration / ui만 import 가능 (다른 하위 폴더는 ui를 import하지 않음)
orchestration ← public만 import 가능
scanner root 구현 파일 없음 (public.ts 제외)
```

- 레이어 위반 검사는 **런타임 import**만 대상으로 한다. 타입 전용 import는 런타임 결합을 만들지 않으므로 레이어 위반으로 세지 않는다.
- 타입 전용 순환은 계속 경고로 보고한다.
- 런타임 순환은 위반이다.
- `evaluation`은 독립 폴더로 유지한다.

## 4. 공개 진입점

- 다른 기능은 `src/features/<name>/public.ts`만 import한다.
- 현재 공개 진입점:
  - `src/features/growth/public.ts`
  - `src/features/card-scanner/public.ts`
- 공개 진입점은 내부 구현을 re-export할 수 있지만, 다른 기능이 내부 파일을 직접 import하지 않게 한다.

## 5. 검사

```sh
npm run check:architecture
npm run check:architecture -- --json --out work/architecture-check.json
```

- 위반이 하나라도 있으면 exit 1.
- `npm run lint`가 oxlint 뒤에 구조 검사를 실행한다.
- 런타임 순환은 위반이다.
- 타입 전용 순환은 경고다. 런타임 초기화 순서에 영향을 주지 않지만, 구조 개선 대상으로 남긴다.

### 현재 상태 (2026-11-08)

- 런타임 순환: **0**
- 레이어 위반: **0**
- 기능 간 직접 의존: **0**
- 타입 전용 순환 경고: **5**
- Step 4에서 정리한 것:
  - `src/domain/inventory-csv.ts`, `inventory-unowned.ts`로 CSV·미보유 계산 이동
  - `src/domain/growth*.ts`, `growth-types.ts`, `collection-candidates.ts`, `stat-collection.ts`, `live-results.ts`로 성장 순수 계산·타입 이동
  - `src/domain/raid-progress.ts`, `raid-ranking.ts`로 레이드 순수 계산 이동
  - `src/data/catalog.ts`로 카드·도감·레이드 카탈로그 로딩 통합, 스캐너 메인 판독기는 `loadScannerJson` 사용
  - 기능 폴더에는 기존 import 호환용 re-export 유지
- Step 5.1: `layout-geometry.ts`로 런타임 기하 정규화·720p/1080p/1440p/4K 홀드아웃 추가.
- Step 5.2: `identity-fusion.ts`로 이름+원화 융합을 `recognizer.identify`에 연결. 420장 합성 414/417 정확·오확정 0, 장문 2장 원화 회복.
- Step 5.3: 정지 이미지 1장의 명시적 빈 장수 증거를 finalization에 연결. screenshots-1·2 장수 40/40·38/38, missed 0, review 0.
- Step 6.1: `session-finalization.ts`, `session-duplicate.ts` 추출. video-1 384/384/384·status·discarded 67·카드 값 차이 0 유지.
- Step 6.2: `session-diagnostics.ts`로 최종 카드·미식별·discard·recognition-needed 요약 추출. `createScanDiagnosticSummary`에 연결.
- Step 6.3a: `session-finalize.ts`로 discard·counter·status 변경 추출. video-1 결과 동일.
- Step 6.3b: `session-orchestrator.ts`로 finalization 순서 추출. beforeFinalStatus 실패 시 status·emit 중단.
- Step 7.1: UI 7개 컴포넌트를 `scanner/ui/`로 이동. 기존 경로 re-export, video-1·screenshots-1·2 결과 유지.
- Step 7.2: capture 6개 파일을 `scanner/capture/`로 이동. video-1·screenshots-1·2 결과 유지.
- Step 7.3: acquisition 6개 파일을 `scanner/acquisition/`로 이동. video-1·screenshots-1·2 결과 유지.
- Step 7.4: recognition 42개 파일을 `scanner/recognition/`로 이동. Worker URL·JSON 경로 유지, loader hook 테스트를 새 경로로 수정.
- Step 7.5: session 11개 파일을 `scanner/session/`으로 이동. completion·ledger·duplicate·finalization·diagnostics 유지.
- Step 7.6: persistence 6개·reproduction 16개 파일을 이동. Worker URL 유지, dev 재현 로더를 실제 구현 경로로 수정.
- Step 7.7: session evidence 5개 파일을 `scanner/session/`으로 이동. `inventory-evidence`·`unknown-lifecycle`·`freshness-evidence`·`observation-history`·`scan-grid`.
- Step 7.8: acquisition clients 13개 파일을 `scanner/acquisition/`으로 이동. Worker URL 유지, root `frame-obstruction-worker`는 `../` 참조.
- Step 7.9: acquisition 잔여 7개 파일(`acquisition-raster`, `acquisition-profile`, `decoded-rgba-*`, `input-acquisition-evidence`, `latest-acquisition-gate`, `experimental-acquisition-receipts`)을 이동. `acquisition-raster` 직접 참조로 정리.
- Step 7.10: `canonical-capture`·replay 잔여·`recognizer`·`card-dictionary`·`scan-monitor-store` 등 28개 파일을 reproduction/acquisition/recognition/ui로 이동. Worker URL·loader hook 경로 수정.
- Step 7.11: `scanner.ts`·`scanner-preparation`·`current-scan-fields`·`observation-execution`·`observation-work`·`scan-monitor-outcome`·`scan-grid-command`를 `session/`으로 이동. loader hook 테스트 3개 경로 수정.
- Step 7.12: completion·unknown·retry·freshness·live 보조 52개를 `session/`으로, recording·native·archive·dev 기록 24개를 `reproduction/`으로 이동. Worker URL·테스트·dev 경로 수정.
- Step 7.13: root의 93개 구현 파일을 capture(25)·acquisition(27)·recognition(5)·session(17)·ui(19)로 이동. root 구현은 `public.ts` 1개만 남음.
- Step 7.14: 호환 re-export shim 323개 삭제, import 1,521개 직접 경로 전환, dangling 633개 복구. `scanner.ts`를 `orchestration/`으로 분리. `scanner:other` 0.
- Step 8.1: `AppShell`·`InventoryWorkspace`·`useInventoryView`·`ScannerSummary` 분리. App.tsx 74,923B → 66,469B.
- Step 8.2: `ScannerWorkspace`·`DevPreviewLatency` 분리. App.tsx 66,469B → 57,791B. `use-scanner-session`는 다음 단계.
- Step 8.3: `use-scanner-session.ts`로 모니터 스토어·시계·deadline 분리. App.tsx 57,791B → 56,004B.
- Step 8.4: `useScannerPreparation`으로 엔진 준비 lifecycle 분리. App.tsx 56,004B → 52,604B.
- Step 8.5: `share-commands.ts`로 창 공유 요청·커서 모드·트랙 중지 분리. App.tsx 52,604B → 51,861B.
- Step 8.6: `openWindowShare`/`closeWindowShare` 공유 전이, `runScanLifecycle` 스캔 실행/정산 분리. App.tsx 51,861B → 40,824B. App 분해 완료.
- Step 8.7: 타입 전용 순환 5개 제거. `recognizer-types.ts`·`reference-types.ts`·`exact-recording-types.ts`로 공유 타입 분리, `FeedbackGridCell`을 `scanner-feedback-receipts.ts`로 이동, 완료·모니터·watchdog 소스 타입을 구조적으로 축소. `check:architecture` 위반 0·경고 0.
- 위반 0을 위해 Step 3에서 정리한 것:
  - `exact-recording-compression.ts` 분리 → `canonical-frame-reader` ↔ `exact-recording-codec` 런타임 순환 제거
  - `growth-effects.ts` 분리 → `optimizer` ↔ `growth-sequence` ↔ `collection-candidates` 런타임 순환 제거
  - `growth/public.ts` 추가 → `raid → growth` 직접 import 제거
  - `shared/card-rarity.ts`, `shared/ui/CardName.tsx`, `shared/ui/CardThumbnail.tsx`, `shared/monitor-latency.ts`로 공용 UI·유틸 이동
  - `growth/live-results.ts`, `card-scanner/rejected-raster-plan.ts`로 기능 소유 코드 이동
  - 기능의 `ScannedCard`·`ScannerState` type import를 `card-scanner/public.ts`로 통일

## 6. 타입 전용 순환 방지

타입만 공유하는 모듈은 값 모듈의 타입을 다시 import하지 않도록 별도 leaf 모듈에 둔다.

| 타입 | 위치 | 이유 |
|---|---|---|
| `ScannedCard`, `CountDiagnostics`, `NameEvidence` | `recognition/recognizer-types.ts` | 인식 결과 타입을 `recognizer` 값 모듈에서 분리 |
| `Reference` | `recognition/reference-types.ts` | 원화 비교 타입이 `portrait-matcher`로 역참조하지 않게 분리 |
| `ExactEntry`, `ExactFrame`, `ExactEvent` | `reproduction/exact-recording-types.ts` | 기록 코덱과 재생·증명 모듈의 타입 순환 제거 |
| `FeedbackGridCell` | `ui/scanner-feedback-receipts.ts` | `scan-grid`와 `scanner-feedback` 사이 타입 순환 제거 |

- 완료·모니터·watchdog 모듈은 `ScannerState` 전체를 import하지 않고 필요한 필드만 가진 구조적 타입을 사용한다.
- 구조 검사는 런타임 순환을 위반, 타입 전용 순환을 경고로 보고한다. 현재 둘 다 0이다.

## 7. 규칙을 바꿀 때

1. `scripts/architecture-policy.json`을 수정한다.
2. `tests/architecture-check.test.ts`에 허용·금지 사례를 추가한다.
3. `npm run check:architecture`와 `npm test`를 통과시킨다.
4. 예외를 추가할 때는 이유와 제거 단계(Step)를 이 문서에 기록한다.
