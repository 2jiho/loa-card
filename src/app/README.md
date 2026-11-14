# src/app

앱 셸과 화면 조합만 둔다.

- 허용: `src/features`, `src/domain`, `src/data`, `src/shared`
- 금지: 도메인 규칙·인식·저장 로직의 직접 구현
- 예: `AppShell`, 내비게이션, 테마, `useScannerSession`, `InventoryWorkspace`

`src/app`과 `src/App.tsx`는 지금도 스캐너와 다른 기능의 내부 파일을 직접 import한다. 구조 정책이 앱 셸에 이를 허용한다([프로그램 구조](../../docs/architecture.md)). `public.ts`만 쓰라는 제한은 기능 사이의 import에 적용한다.
