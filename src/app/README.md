# src/app

앱 셸과 화면 조합만 둔다.

- 허용: `src/features`, `src/domain`, `src/data`, `src/shared`
- 금지: 도메인 규칙·인식·저장 로직의 직접 구현
- 예: `AppShell`, 내비게이션, 테마, `useScannerSession`, `InventoryWorkspace`

Step 8 전까지는 `src/App.tsx`가 스캐너 내부를 직접 import할 수 있다. Step 8 후에는 `features/*/public.ts`만 사용한다.
