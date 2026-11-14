# App 모듈

`src/App.tsx`는 앱 상태와 이벤트 처리기를 가진다. 화면 조합과 스캔 실행은 `src/app/`의 모듈로 나눴다. UI 동작과 상태의 소유는 App에 남는다. 의존 규칙은 [프로그램 구조](architecture.md)를 따른다.

| 모듈 | 책임 |
|---|---|
| `src/app/AppShell.tsx` | 헤더, 내비게이션, main 랜드마크, 푸터, 사용법 대화상자 |
| `src/app/ScannerWorkspace.tsx` | 공유 시작·중지, CSV, 준비·진행 상태, 미리보기, 진행 창 |
| `src/app/InventoryWorkspace.tsx` | 카드 목록 필터·검색·그리드·페이지·정렬/용량 표시 |
| `src/app/use-inventory-view.ts` | 이름 검색, 한국어 숫자 정렬, 40장 페이지 계산 |
| `src/app/ScannerSummary.tsx` | 카드 외 메뉴의 스캔 요약 |
| `src/app/use-scanner-session.ts` | 진행 창 스토어(`useScanMonitorSession`), 2분 입력 시계·시간 초과(`useScannerClock`), 엔진 준비(`useScannerPreparation`) |
| `src/app/share-commands.ts` | 창 공유 요청, 커서 판별, 공유 열기·닫기 전이, 모든 트랙의 독립 중지 |
| `src/app/scan-lifecycle.ts` | 스캔 실행(`runScanLifecycle`), 상태 발행, 완료·미완료 처리, 진행 체크포인트 |
| `src/app/scan-state-fallback.ts` | 최종 상태 없이 중단된 스캔에서 보여 줄 목록 |

- `useScannerClock`은 시계·시간 초과 파생값만 가진다. `firstInputAt`/`lastInputAt`은 App이 가진다.
- `useScannerPreparation`은 준비 슬롯·메시지·정리 불확실 상태를 가진다. abort controller는 App이 가지고 `onCleanupUncertain`으로 연결한다.
- `openWindowShare`는 선택기·재생·epoch fencing만 맡는다. 스캔 완료는 `scan-lifecycle`이 맡는다.
- `runScanLifecycle`은 App의 상태 setter·ref를 주입받아 실행한다.
