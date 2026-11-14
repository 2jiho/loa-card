# 프로그램 구조

- 작성일: 2026-11-08, 갱신: 2026-11-14
- 검사: `npm run check:architecture`
- 정책: `scripts/architecture-policy.json`

## 1. 구조

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
      ui/              # 진행 창, 진행 표시, 확인 항목
      orchestration/   # 스캔 실행의 조합 (runScanner, 줄 중심 스캔)
      evaluation/      # 평가 계약
      public.ts        # 다른 기능이 쓰는 진입점
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

### 앱 셸의 예외

- `src/app`과 `src` 최상위 파일은 스캐너와 다른 기능의 내부 파일을 직접 import할 수 있다. 정책(`scripts/architecture-policy.json`)이 이를 허용한다.
- 현재 앱은 스캐너의 `orchestration/scanner`, `ui/`, `session/`, `persistence/`와 성장 기능의 내부 파일 등을 직접 import한다. `public.ts`로 좁히는 일은 하지 않았다.
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

### 현재 상태

`node scripts/check-architecture.mjs`로 확인한다(2026-11-14: `0 violation(s), 0 warning(s)`).

- 런타임 순환: 0
- 레이어 위반: 0
- 기능 간 직접 의존: 0
- 타입 전용 순환 경고: 0
- 앱 셸 모듈은 [App 모듈](app-decomposition.md)에 정리했다.
- 폴더 이동 단계의 기록은 [물리 분할](physical-split.md)과 [마이그레이션](architecture-migration.md)에 있다. 그 문서가 인용한 파일 상당수는 v0.3.0에서 지웠다.

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
4. 예외를 추가할 때는 이유와 제거 조건을 이 문서에 기록한다.
