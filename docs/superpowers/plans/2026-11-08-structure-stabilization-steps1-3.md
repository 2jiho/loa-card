# 구조 안정화 1~3단계 실행 계획 (검토용)

- 상태: 검토 대기
- 작성일: 2026-11-08
- 상위 설계: `docs/superpowers/specs/2026-11-08-scanner-generalization-replan-design.md`
- 결정: 구조 안정화 우선(A), 배치 이동 + re-export, 파일·테스트 단위 세분화
- 범위: Step 1~3만. 인식 알고리즘과 UI 동작은 바꾸지 않는다.

## 공통 원칙

1. Step 1~3은 **동작 변경 0**을 목표로 한다. 코퍼스 결과가 달라지면 원인을 찾기 전 진행하지 않는다.
2. 기존 파일은 바로 옮기지 않는다. Step 4부터 배치 이동하고, 이동한 파일은 re-export로 기존 import를 유지한다.
3. 프로그램 출력은 정답으로 승격하지 않는다. 사람 라벨만 정답이다.
4. 각 단계 종료 시 `npm run lint`, `npm test`, `npm run build`를 통과한다.
5. 커밋·푸시·배포는 사용자 요청 전까지 하지 않는다.
6. 새 파일은 테스트와 함께 추가한다. 테스트 없는 구조 파일은 만들지 않는다.

---

## Step 1 — 기준선·구조 감사

### 목표

- 현재 코드·테스트·코퍼스 결과를 재현 가능한 기준선으로 고정한다.
- 318개 `card-scanner` 파일과 `App.tsx`의 실제 의존 관계를 측정한다.
- 이후 구조 변경에서 “동작이 달라졌는지” 비교할 수 있는 기준을 만든다.

### 산출물

| 파일 | 내용 |
|---|---|
| `scripts/audit-architecture.mjs` | import 추출·상대 경로 해석·순환 의존·레이어 분류·요약 |
| `tests/architecture-audit.test.ts` | 파서·해석·순환 탐지 단위 테스트 |
| `docs/architecture-audit.md` | 현재 구조 요약. 개인 경로·비공개 데이터 없이 공개 가능한 수치만 |
| `work/baseline/2026-11-08/manifest.json` | Git HEAD·dirty·Node/npm 버전·package-lock 해시·카탈로그 해시·검증 결과 |
| `work/baseline/2026-11-08/lint.txt` | lint 출력 |
| `work/baseline/2026-11-08/test.txt` | test 출력 |
| `work/baseline/2026-11-08/build.txt` | build 출력 |
| `work/baseline/2026-11-08/architecture.json` | 감사 원본 JSON |
| `work/baseline/2026-11-08/corpus/` | 기존 코퍼스 결과 요약(비공개) |

### `scripts/audit-architecture.mjs` 세부

내보내는 순수 함수:

- `classifyLayer(path)` — `app`, `features/scanner`, `features/growth`, `domain`, `data`, `shared`, `dev`, `tests`, `scripts`, `unknown`.
- `extractImports(source)` — 정적 `import`, `export ... from`, 동적 `import()`, `require()`.
- `resolveImport(fromFile, specifier, fileSet)` — 상대 경로, `../`, 확장자 생략, `/index.ts`, `/index.tsx`.
- `findCycles(graph)` — 2~N 노드 순환 탐지. 결과는 파일 경로 배열.
- `summarize(files)` — 레이어별 파일 수·바이트, 최대 파일 20개, 순환 목록, 기능 간 의존 목록.

CLI:

```sh
node scripts/audit-architecture.mjs --out work/baseline/2026-11-08/architecture.json
```

- `src`, `dev`, `tests`, `scripts`를 스캔한다.
- 결과 JSON에는 파일 경로·바이트·import 대상·레이어·순환 여부를 담는다.
- 개인 PC 절대 경로는 출력하지 않는다. 저장소 상대 경로만 쓴다.

### `tests/architecture-audit.test.ts` 세부

| 테스트 | 검증 |
|---|---|
| `static and dynamic imports are extracted` | `import`, `export from`, `import()`, `require()` |
| `relative specifiers resolve with extensions and index files` | `./a`, `../b.ts`, `./dir` → `dir/index.ts` |
| `two-node and three-node cycles are found` | A→B→A, A→B→C→A |
| `non-cyclic graph returns no cycles` | A→B, A→C |
| `layer classification covers current and target paths` | `src/features/card-scanner/...`, `src/domain/...`, `src/app/...` |
| `summary never includes absolute paths` | Windows/Unix 절대 경로가 결과에 없음 |

### 기준선 실행

```sh
npm run lint
npm test
npm run build
node scripts/audit-architecture.mjs --out work/baseline/2026-11-08/architecture.json
```

이번 Step 1은 **테스트 기준선만** 잡는다. 코퍼스 전체 재실행은 하지 않는다.

- `video-1~7`, `screenshots-1·2`, `beskal`의 기존 결과 JSON은 삭제·수정하지 않고 그대로 보존한다.
- Step 1에서 코퍼스 재실행을 하지 않았으므로 “현재 환경에서 코퍼스가 재현됐다”고 주장하지 않는다.
- 인식 변경(Step 5) 전에는 해당 변경의 평가를 위해 별도 코퍼스 실행을 수행하고, 그때 비교 기준을 새로 만든다.

### 완료 기준

- `lint`, `test`, `build` exit 0.
- `architecture.json` 생성, 순환 의존 목록이 문서와 일치.
- `docs/architecture-audit.md`에 최대 파일 20개와 기능 간 의존 상위 목록이 기록됨.
- 테스트·구조 기준선만 확정됐고, 코퍼스는 재실행하지 않았음을 문서에 명시.
- 동작 변경 0: 인식·UI·저장 코드를 수정하지 않음.

### 롤백

- 새 스크립트·문서·테스트만 삭제하면 원상 복구된다. 기존 소스는 건드리지 않는다.

---

## Step 2 — 평가 계약·정답셋

### 목표

- “읽을 수 있는데 놓침”과 “원래 읽을 수 없음”을 분리하는 평가 계약을 만든다.
- 기존 `work/human-label-*.json` v1을 읽되, 필드별 판독 가능성을 표현할 수 있게 확장한다.
- 인식 코드를 바꾸지 않고 현재 기준선을 평가한다.

### 라벨 스키마 v2

기존 v1 필드 구조를 유지하고 상태를 확장한다.

```json
{
  "kind": "loacard-human-label",
  "version": 2,
  "status": "human-confirmed",
  "scope": "partial",
  "caseId": "...",
  "inputs": [{"index": 0, "sha256": "...", "bytes": 0}],
  "confirmation": {
    "authority": "human-user",
    "recordedAt": "2026-11-08T00:00:00.000Z",
    "question": "...",
    "answer": "...",
    "wording": "verbatim"
  },
  "cards": [
    {
      "id": "3200003",
      "fields": {
        "name": {"status": "known", "value": "국왕 실리안", "evidence": {"inputIndex": 0, "frame": 12}},
        "awakening": {"status": "known", "value": 5, "evidence": {"inputIndex": 0, "frame": 12}},
        "extraCopies": {"status": "known", "value": 0, "evidence": {"inputIndex": 0, "frame": 12}}
      }
    }
  ]
}
```

필드 상태:

| 상태 | 의미 | 평가 |
|---|---|---|
| `known` | 사람이 값을 읽었고 값이 확정됨 | 분모에 포함 |
| `unreadable` | 모든 프레임에서 가려졌거나 읽을 수 없음 | 분모에서 제외, 사유 기록 |
| `unknown` | 아직 라벨링하지 않음 | 평가 불완전, 통과 불가 |

- `unreadable`에는 `reason`을 필수로 둔다: `가림`, `카드 뒷면`, `저대비·블러`, `화면 밖`, `기타`.
- `known`에는 `evidence.inputIndex`와 `evidence.frame`을 권장한다. 없으면 경고만 하고 거부하지 않는다.
- v1 파일은 `version: 1`로 읽고, 메모리에서 v2로 승격한다. 원본 파일은 수정하지 않는다.

### 평가 지표 정의

| 지표 | 정의 |
|---|---|
| `nameReadable` | `name.status === "known"`인 카드 수 |
| `nameExact` | `nameReadable` 중 결과 카드 ID와 이름이 라벨과 정확히 같은 수 |
| `awakeningReadable` / `awakeningExact` | 같은 방식의 각성 지표 |
| `copiesReadable` / `copiesExact` | 같은 방식의 장수 지표 |
| `readableButMissed` | 라벨은 `known`인데 결과가 없음·`null`·`인식 필요`인 경우 |
| `unreadable` | 라벨이 `unreadable`인 필드. 사유별 집계 |
| `falseConfirm` | 결과가 라벨과 다른 값을 확정했거나 다른 카드 ID로 확정한 경우 |
| `review` | 결과 카드의 `review`가 비어 있지 않은 수 |
| `unlabeled` | 라벨이 `unknown`인 필드. 하나라도 있으면 평가 미완료 |

`falseConfirm`은 커버리지보다 우선한다. `falseConfirm > 0`이면 다른 지표가 좋아도 실패다.

### 산출물

| 파일 | 내용 |
|---|---|
| `src/features/card-scanner/evaluation/types.ts` | 라벨·결과·리포트 타입 |
| `src/features/card-scanner/evaluation/labels.ts` | v1 읽기·v2 검증·해시·마이그레이션 |
| `src/features/card-scanner/evaluation/run-result.ts` | 기존 스캔 결과 JSON → 평가용 결과 |
| `src/features/card-scanner/evaluation/metrics.ts` | 지표 계산 |
| `scripts/evaluate-run.mjs` | 라벨 + 실행 결과 → 리포트 CLI |
| `tests/evaluation-labels.test.ts` | 라벨 파서·검증 |
| `tests/evaluation-metrics.test.ts` | 지표 계산 |
| `tests/fixtures/evaluation/valid-label.json` | 정상 v2 라벨 |
| `tests/fixtures/evaluation/v1-label.json` | v1 라벨 |
| `tests/fixtures/evaluation/duplicate-card.json` | 중복 카드 ID |
| `tests/fixtures/evaluation/unknown-field.json` | `unknown` 필드 |
| `docs/evaluation.md` | 라벨 작성법·지표·게이트·케이스 추가 절차 |

### `scripts/evaluate-run.mjs` CLI

```sh
node --import tsx scripts/evaluate-run.mjs \
  work/human-label-40cards.json \
  work/screenshots1-cdp-result.json \
  --out work/evaluation/screenshots1.json
```

- 라벨이 부분 범위면 `scope: "partial"`로 표시하고, 분모는 라벨된 카드만 센다.
- 결과에 라벨에 없는 카드가 있으면 `unlabeledResultCard`로 별도 표시한다.
- 종료 코드:
  - `0`: 오확정 0, 읽을 수 있는 필드 전부 일치, 미라벨 0
  - `2`: 값 불일치 또는 `readableButMissed`
  - `3`: 라벨 불완전(`unknown`) 또는 결과 형식 미지원
  - `1`: 입력 파일 오류

### 테스트 세부

| 테스트 | 검증 |
|---|---|
| `known values count in the denominator` | `known` 3장 중 3장 일치 → 100% |
| `unreadable fields are excluded but reported` | `unreadable` 1장이 분모에서 빠지고 사유에 남음 |
| `unknown labels make the evaluation incomplete` | `unknown` 1개 → exit 3, `unlabeled > 0` |
| `null is not an observed zero` | 라벨 0, 결과 `null` → `readableButMissed`, 오확정 아님 |
| `wrong confirmed value is a false confirmation` | 라벨 2, 결과 3 → `falseConfirm` |
| `different card id is a false confirmation` | 라벨 A, 결과 B → `falseConfirm` |
| `v1 labels migrate without changing values` | v1 4장 → v2 4장, 값 동일 |
| `duplicate card ids are rejected` | 같은 ID 2장 → 파서 오류 |
| `label hash is stable` | 같은 내용 → 같은 SHA-256 |

### 기존 라벨 적용

- `work/human-label-4cards.json` (video-7)
- `work/human-label-40cards.json` (screenshots-1)
- `work/human-label-shots2-38cards.json` (screenshots-2)
- `work/human-label-video1-4cards.json`
- `work/human-label-video3-8cards.json`
- `work/human-label-video3-review2.json`

이 파일들은 **읽기 전용**으로 사용한다. v2로 변환한 사본이 필요하면 `work/evaluation/labels/`에 만들고 원본은 건드리지 않는다.

### 완료 기준

- 위 라벨과 기존 결과 JSON으로 평가 리포트가 생성된다.
- `falseConfirm`이 0인지, `readableButMissed`가 몇 건인지 입력별로 확인된다.
- `unknown` 라벨이 있으면 “평가 미완료”로 표시되고, 완료로 세지 않는다.
- 인식·UI 코드 변경 0.
- `npm run lint`, `npm test`, `npm run build` 통과.

### 롤백

- 새 `evaluation/` 모듈·스크립트·테스트·문서만 삭제하면 원상 복구된다. 기존 라벨 파일은 수정하지 않는다.

---

## Step 3 — 구조 계약·의존 규칙

### 목표

- 목표 폴더 구조와 의존 방향을 문서·정책 파일로 고정한다.
- 기존 위반은 기준선으로 허용하되, **새 위반은 즉시 실패**하게 만든다.
- Step 4의 배치 이동 대상 목록을 확정한다.

### 목표 구조

```text
src/
  app/
  domain/
  data/
  features/
    scanner/
      capture/
      acquisition/
      recognition/
      session/
      persistence/
      ui/
    inventory/
    growth/
    raid/
    merchants/
  shared/
dev/
  evaluation/
tests/
  contract/
  regression/
  evaluation/
```

### 레이어 규칙

| From | 허용 | 금지 |
|---|---|---|
| `src/app` | `features`, `domain`, `data`, `shared` | 없음(최상위) |
| `src/features/*` | 자기 기능 내부, `domain`, `data`, `shared` | `app`, 다른 기능의 내부 파일 |
| `src/features/*/public.ts` | 다른 기능이 import 가능한 유일한 진입점 | 내부 파일 직접 import |
| `src/domain` | `domain`만 | `features`, `app`, `data`, `shared` |
| `src/data` | `domain` | `features`, `app`, `shared` |
| `src/shared` | `shared`만 | `features`, `app`, `domain`, `data` |
| `dev` | 모든 레이어 | 없음(개발 하네스) |
| `tests` | 모든 레이어 | 없음 |

스캐너 내부 규칙(Step 7 이후 적용):

```text
capture → acquisition → recognition → session
ui → session
persistence → session
recognition → domain / shared
session → domain / shared
```

- 역방향 import는 금지한다.
- `capture`가 `recognition`을 직접 호출하지 않는다. 세션 오케스트레이터가 연결한다.

### 기존 위반 처리

- Step 1의 `architecture.json`에서 현재 위반 목록을 만든다.
- **Step 3에서 기존 위반을 전부 수정한다.** baseline 허용 목록은 만들지 않는다.
- 위반이 많으면 Step 3 안에서 `import 경로 수정`, `public.ts 추출`, `폴더 이동` 배치로 나눠 수정한다. 각 배치는 동작 변경 0을 유지한다.
- Step 3 종료 시 `node scripts/check-architecture.mjs`는 위반 0으로 exit 0이어야 한다.
- 수정 과정에서 파일을 옮기면 re-export로 기존 import를 유지하고, 배치마다 lint/test/build를 통과한다.

### 산출물

| 파일 | 내용 |
|---|---|
| `docs/architecture.md` | 목표 구조·레이어 규칙·이동 원칙·public 진입점 규칙 |
| `docs/architecture-migration.md` | Step 4~8의 파일 그룹·이동 순서·re-export 전략 |
| `scripts/check-architecture.mjs` | 정책 검사·위반 수집·JSON 출력 |
| `scripts/architecture-policy.json` | 허용/금지 edge, 스캐너 내부 규칙 |
| `tests/architecture-check.test.ts` | 정책 판정·위반 수집 단위 테스트 |
| `src/domain/README.md` | domain에 둘 것/두지 말 것 |
| `src/data/README.md` | data에 둘 것/두지 말 것 |
| `src/app/README.md` | app에 둘 것/두지 말 것 |
| `src/features/card-scanner/public.ts` | 스캐너 기능의 공개 진입점(초기에는 기존 export re-export) |

### `scripts/check-architecture.mjs` 세부

순수 함수:

- `isAllowedEdge(fromLayer, toLayer, policy)`.
- `classifyFeaturePath(path)` — 기능 이름·하위 폴더.
- `isPublicEntry(path)` — `public.ts` / `index.ts`만 허용.
- `collectViolations(records, policy)` — 모든 위반 수집.
- `formatViolation(violation)` — 파일·라인·import·규칙.

CLI:

```sh
node scripts/check-architecture.mjs
node scripts/check-architecture.mjs --json --out work/architecture-check.json
```

- 위반이 하나라도 있으면 exit 1.
- Step 3 종료 시 위반 0을 목표로 한다.

### `package.json` 변경

```json
{
  "scripts": {
    "check:architecture": "node scripts/check-architecture.mjs",
    "lint": "oxlint src dev vite.config.ts scripts && node scripts/check-architecture.mjs"
  }
}
```

- Step 3에서는 `lint`에 연결한다.
- 기존 위반을 모두 수정한 뒤 연결하므로, Step 3 종료 시 lint가 통과한다.
- 이후 새 위반을 만든 변경은 lint에서 실패한다.

### 테스트 세부

| 테스트 | 검증 |
|---|---|
| `app may import features, domain, data, shared` | 허용 edge |
| `features may not import app` | 금지 edge |
| `features may not import another feature's internal file` | `features/growth/optimizer.ts` 직접 import 실패 |
| `features may import another feature's public entry` | `features/growth/public.ts` 허용 |
| `domain may not import features` | 금지 edge |
| `any policy violation fails` | 위반 1건 → exit 1 |
| `zero violations passes` | 위반 0건 → exit 0 |
| `scanner internal reverse edge fails after Step 7` | `session → capture` 금지 |
| `absolute paths are not printed` | 출력에 드라이브 문자·홈 경로 없음 |

### 이동 대상 목록 (Step 4 입력)

`docs/architecture-migration.md`에 다음 그룹을 기록한다.

| 그룹 | 현재 예 | 목표 |
|---|---|---|
| 도메인 규칙 | `src/card-rarity.ts`, `src/inventory-csv.ts`, `src/inventory-unowned.ts`, `src/features/growth/optimizer.ts`, `src/features/raid/raid-ranking.ts` | `src/domain/...` |
| 카탈로그·데이터 | `public/scanner/*`, 카탈로그 로딩 코드 | `src/data/...` |
| 스캐너 캡처 | `input-source.ts`, `live-frame-clock.ts`, `freeze-live-frame.ts`, `live-capture-pipeline.ts`, `share-stream-owner.ts` | `features/scanner/capture/` |
| 스캐너 획득 | `detector.ts`, `card-borders.ts`, `border-integrity.ts`, `card-acquisition.ts`, `capture-quality.ts`, `candidate-queue.ts` | `features/scanner/acquisition/` |
| 스캐너 인식 | `name-reader.ts`, `neural-reader.ts`, `portrait-matcher.ts`, `artwork-verifier.ts`, `count-*.ts`, `star-*.ts`, `visual-*.ts`, `ocr-*.ts` | `features/scanner/recognition/` |
| 스캐너 세션 | `scanner.ts`, `scan-ledger.ts`, `inventory-evidence.ts`, `freshness-*.ts`, `unknown-*.ts`, `completion*.ts`, `final-duplicate.ts` | `features/scanner/session/` |
| 스캐너 저장 | `scan-backup.ts`, `progress-backup.ts`, `partial-store.ts`, `exact-recording*.ts`, `scan-reproduction.ts` | `features/scanner/persistence/` |
| 스캐너 UI | `ScanMonitor.tsx`, `ScanAttention.tsx`, `ScanReadProgress.tsx`, `ScanReplayDialog.tsx`, `scan-monitor-store.ts` | `features/scanner/ui/` |
| 앱 셸 | `App.tsx`, `main.tsx`, `src/ui/*`, 내비게이션·테마 | `src/app/` |

- 이 표는 Step 3에서 확정하고, Step 4에서 파일 목록을 더 잘게 확장한다.
- 각 그룹은 `public.ts` 또는 `index.ts` re-export로 기존 import를 유지한다.

### 완료 기준

- `node scripts/check-architecture.mjs` exit 0, 위반 0.
- `npm run lint`에 구조 검사가 포함되어 통과.
- `docs/architecture.md`와 `docs/architecture-migration.md` 리뷰 완료.
- `src/features/card-scanner/public.ts`가 기존 공개 API를 re-export하고 빌드 통과.
- 동작 변경 0: 인식·UI·저장 코드 수정 없음.
- `npm test`, `npm run build` 통과.

### 롤백

- `package.json`의 lint 연결을 되돌리고, 새 정책·체커·문서를 삭제하면 원상 복구된다. 기존 소스는 건드리지 않는다.

---

## 실행 결과 (2026-11-08)

### Step 1 — 완료

- `npm run lint` → 0
- `npm test` → **3,727 tests · 3,723 pass · 0 fail · 4 skipped**
- `npm run build` → 0
- 구조 감사: **1,014파일 · 7.39MB · 순환 의존 6 · 기능 간 의존 1 · 스캐너 내부 의존 0**
- 산출물:
  - `scripts/audit-architecture.mjs`
  - `tests/architecture-audit.test.ts` (7 tests)
  - `docs/architecture-audit.md`
  - `work/baseline/2026-11-08/manifest.json` 및 lint/test/build/architecture 원본
- 코퍼스 전체 재실행은 하지 않았다. 기존 결과 JSON은 보존만 했다.

### Step 2 — 완료

- `npm run lint` → 0
- `npm test` → **3,745 tests · 3,741 pass · 0 fail · 4 skipped**
- `npm run build` → 0
- 산출물:
  - `src/features/card-scanner/evaluation/types.ts`
  - `src/features/card-scanner/evaluation/labels.ts`
  - `src/features/card-scanner/evaluation/run-result.ts`
  - `src/features/card-scanner/evaluation/metrics.ts`
  - `scripts/evaluate-run.mjs`
  - `tests/evaluation-labels.test.ts`, `tests/evaluation-metrics.test.ts`
  - `tests/fixtures/evaluation/*.json`
  - `docs/evaluation.md`
- 기존 라벨 기준선:

| 케이스 | 판정 | 이름 | 각성 | 장수 | readableButMissed | falseConfirm | review |
|---|---|---|---:|---:|---:|---:|---:|---:|
| screenshots-1 | fail | 40/40 | 40/40 | 39/40 | 1 | 0 | 1 |
| screenshots-2 | fail | 38/38 | 38/38 | 37/38 | 1 | 0 | 1 |
| video-1 | pass | 4/4 | 4/4 | 4/4 | 0 | 0 | 0 |
| video-7 | pass | 4/4 | 4/4 | 4/4 | 0 | 0 | 0 |
| video-3 (8종) | pass | 8/8 | 8/8 | 8/8 | 0 | 0 | 0 |
| video-3 (리뷰 2종) | pass | — | — | 2/2 | 0 | 0 | 0 |

- screenshots-1·2의 실패는 베스칼 장수(라벨 0, 결과 `null`) 1건과 그 리뷰 1건이다. 오확정은 0이다.
- `video-3 (리뷰 2종)`은 v1 라벨이 `extraCopies`만 확인했으므로 `fieldScope: ["extraCopies"]`로 평가했다.
- `unlabeledResultCards`는 부분 라벨 범위 밖 결과 카드(344·346·380·393·375·381)이며 partial scope에서 실패로 세지 않는다.

### Step 3 — 완료

- `npm run lint` → **0** (oxlint + `check:architecture`)
- `npm test` → **3,753 tests · 3,749 pass · 0 fail · 4 skipped**
- `npm run build` → **0**
- 구조 검사: **레이어 위반 0 · 런타임 순환 0 · 타입 전용 경고 6**
- 적용한 정책:
  - `src/app`/`src` 최상위는 Step 8 전까지 스캐너 내부 import 허용
  - 기능 간 import는 `features/*/public.ts`만 허용
  - `domain`/`data`/`shared`의 역방향 import 금지
  - 스캐너 하위 폴더 규칙은 Step 7 이후 적용
- 정리한 런타임 순환:
  - `exact-recording-compression.ts` 분리로 `canonical-frame-reader` ↔ `exact-recording-codec` 제거
  - `growth-effects.ts` 분리로 `optimizer` ↔ `growth-sequence` ↔ `collection-candidates` 제거
  - `growth/public.ts`로 `raid → growth` 직접 import 제거
- 이동·추가:
  - `src/shared/card-rarity.ts`, `src/shared/ui/CardName.tsx`, `src/shared/ui/CardThumbnail.tsx`, `src/shared/monitor-latency.ts`
  - `src/features/growth/live-results.ts`, `src/features/growth/growth-effects.ts`, `src/features/growth/public.ts`
  - `src/features/card-scanner/rejected-raster-plan.ts`, `src/features/card-scanner/exact-recording-compression.ts`, `src/features/card-scanner/public.ts`
  - 기존 경로 re-export 유지
- 산출물:
  - `scripts/check-architecture.mjs`
  - `scripts/architecture-policy.json`
  - `tests/architecture-check.test.ts` (6 tests)
  - `docs/architecture.md`, `docs/architecture-migration.md`
  - `src/domain/README.md`, `src/data/README.md`, `src/app/README.md`
- 남은 타입 전용 순환 6개는 런타임 초기화에 영향을 주지 않아 경고로 유지한다. Step 5~7에서 모듈 경계를 정리할 때 함께 줄인다.

## 1~3단계 리뷰 체크리스트

- [x] Step 1은 테스트 기준선만 잡는다. (사용자 선택)
- [x] Step 2의 필드별 `known`/`unreadable`/`unknown` 정의가 맞는가?
- [x] Step 2의 `falseConfirm` 우선 원칙이 맞는가?
- [x] Step 3의 폴더 이름과 레이어 규칙이 맞는가?
- [x] 기존 위반은 Step 3에서 전부 수정한다. (사용자 선택)
- [x] `features/*/public.ts` 진입점 규칙을 받아들일 수 있는가?
- [ ] Step 4 이동 대상 그룹이 맞는가?

## 다음 단계

Step 1~3은 완료됐다. 다음은 Step 4다.

1. `src/inventory-csv.ts`, `src/inventory-unowned.ts`, 성장·레이드 순수 계산을 `src/domain/`으로 이동한다.
2. `public/scanner/*` 로딩·스키마를 `src/data/`로 모은다.
3. 이동한 파일은 기존 경로 re-export를 남긴다.
4. 배치마다 `npm run lint`, `npm test`, `npm run build`를 통과한다.
5. Step 4 완료 후 `docs/architecture-migration.md`의 표와 실제 파일 목록을 대조해 보여준다.
