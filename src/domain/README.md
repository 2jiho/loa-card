# src/domain

순수 규칙과 타입만 둔다.

- 허용: `src/domain` 내부 import
- 금지: `src/features`, `src/app`, `src/data`, `src/shared`, React, DOM, 브라우저 저장소
- 예: 카드·목록 규칙, 성장·레이드 계산, 스캔 증거 타입

IO·React·카탈로그 로딩은 `src/data` 또는 `src/features`에 둔다.
