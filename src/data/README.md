# src/data

카탈로그·스키마·생성 데이터를 읽는 계층이다.

- 허용: `src/domain`
- 금지: `src/features`, `src/app`, `src/shared`, React, DOM
- 예: `catalog.ts`의 카드·도감·레이드 카탈로그 로딩, 데이터 버전·해시, 생성 JSON 스키마

UI·인식 로직을 두지 않는다.
