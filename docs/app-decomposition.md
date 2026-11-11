# App 분해

- 작성일: 2026-11-08
- 단계: Step 8.6
- 원칙: UI 동작을 바꾸지 않고 앱 셸·스캔 화면·목록·요약·세션 시계·엔진 준비·공유 전이·스캔 실행/정산을 분리한다.

## 1. 분리한 모듈

| 모듈 | 책임 |
|---|---|
| `src/app/AppShell.tsx` | 헤더, 내비게이션, main 랜드마크, 푸터, 사용법 대화상자 |
| `src/app/ScannerWorkspace.tsx` | 공유 시작·중지, CSV, 준비·진행 상태, 미리보기, 모니터 |
| `src/app/DevPreviewLatency.tsx` | 개발 모드 표시 지연 계측 |
| `src/app/InventoryWorkspace.tsx` | 카드 목록 필터·검색·그리드·페이지·정렬/용량 표시 |
| `src/app/use-inventory-view.ts` | 이름 검색, 한국어 숫자 정렬, 40장 페이지 계산 |
| `src/app/ScannerSummary.tsx` | 비카드 탭의 스캔 요약 카드 |
| `src/app/use-scanner-session.ts` | 모니터 스토어·개발 지연 probe, 2분 입력 시계·시간 초과, 스캐너 엔진 준비 |
| `src/app/share-commands.ts` | 창 공유 요청, 커서 판별, 공유 전이, 모든 트랙의 독립 중지 |
| `src/app/scan-lifecycle.ts` | 스캔 실행, 결과 발행, 완료 판정, 진행 백업, 진단 기록 정산 |

- `useScanMonitorSession`은 store/probe/publish만 소유한다.
- `useScannerClock`은 clock·timeout·deadline 파생값만 소유하고, `firstInputAt`/`lastInputAt`은 App이 유지한다.
- `useScannerPreparation`은 준비 슬롯·메시지·정리 불확실 상태·정산 추적을 소유한다. abort controller는 App이 소유하고 `onCleanupUncertain` 콜백으로 연결한다.
- `openWindowShare`는 선택기·재생·epoch fencing만 소유한다. 스캔 완료는 `scan-lifecycle`이 소유한다.
- `runScanLifecycle`은 App의 상태 setter·ref를 주입받아 실행한다. UI와 상태 소유권은 App에 남는다.

## 2. 크기 변화

| 파일 | 이전 | 이후 |
|---|---:|---:|
| `src/App.tsx` | 74,923 B | 40,824 B |
| `src/app/AppShell.tsx` | — | 3,929 B |
| `src/app/ScannerWorkspace.tsx` | — | 12,667 B |
| `src/app/DevPreviewLatency.tsx` | — | 1,486 B |
| `src/app/InventoryWorkspace.tsx` | — | 5,730 B |
| `src/app/use-inventory-view.ts` | — | 1,494 B |
| `src/app/use-scanner-session.ts` | — | 7,825 B |
| `src/app/share-commands.ts` | — | 4,886 B |
| `src/app/scan-lifecycle.ts` | — | 14,325 B |
| `src/app/ScannerSummary.tsx` | — | 2,282 B |

## 3. 검증

| 항목 | 결과 |
|---|---|
| lint | 0 |
| test | **3,807 tests · 3,803 pass · 0 fail · 4 skipped** |
| build | 0 |
| check:architecture | 위반 0 · 런타임 순환 0 · 타입 전용 경고 5 |
| video-1 | **384 / 384 / 384**, status 동일, discarded 67, 카드 값 차이 **0** |
| screenshots-1 | **40/40**, missed 0, review 0 |
| screenshots-2 | **38/38**, missed 0, review 0 |

산출물:

- `work/step8-6-video1.json`
- `work/step8-6-screenshots1.json`, `work/step8-6-screenshots1-run.json`
- `work/step8-6-screenshots2.json`, `work/step8-6-screenshots2-run.json`
- `work/evaluation/step8-6-screenshots1.json`, `work/evaluation/step8-6-screenshots2.json`

## 4. 다음 단계

- Step 8은 사실상 완료됐다. `App.tsx`는 여전히 앱 상태와 이벤트 핸들러를 소유하지만, UI·세션 시계·엔진 준비·공유 전이·스캔 실행/정산은 각각 분리됐다.
- 다음은 Step 9 실제 화면 공유 E2E다.
- 실제 공유·다른 해상도 검증, 모호한 합성 카드 3장, 타입 전용 경고 5개가 남아 있다.
