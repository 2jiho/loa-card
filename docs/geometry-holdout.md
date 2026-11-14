# 기하 정규화·다해상도 홀드아웃

- 작성일: 2026-11-08
- 단계: Step 5 recognition v2 — 첫 번째 하위 단계
- 코드: `src/features/card-scanner/acquisition/layout-geometry.ts`, `acquisition/detector.ts`
- 테스트: `tests/layout-geometry.test.ts`, `tests/detector-candidate.test.ts`

## 1. 변경

- 검출기의 10×4 격자·카드 크기·메타데이터 상수를 `DEFAULT_LAYOUT`으로 모았다.
- `normalizeLayoutGeometry(origin, mediaWidth, mediaHeight, observed?)`가 앵커 원점·배율을 받아 레이아웃을 만든다.
- `ObservedGrid`를 추가해 헤더 앵커 배율과 카드 격자 배율을 분리했다.
  - 헤더·성장 탭·정렬·스크롤바·영역은 `anchorScale`을 쓴다.
  - 카드 셀은 `gridScale`과 관측 `columnStep`/`rowStep`을 쓴다.
- 기존 메타데이터 박스의 비반올림 좌표를 유지하고, 카드 셀만 반올림한다.
- `Layout.geometry`에 `source`, `anchorScale`, `gridScale`, `cardAspect`, `columnStep`, `rowStep`, `visibleCells`, `bounds`를 기록한다.

## 2. 홀드아웃 행렬

동일한 상대 앵커를 720p·1080p·1440p·4K로 균등 축소/확대한 기하 검사다.

| 해상도 | 배율 | 첫 셀 | 보이는 셀 | 결과 |
|---|---:|---|---:|---|
| 1280×720 | 0.5 | x 169 · y 143 · 70×105 | 40 | pass |
| 1920×1080 | 0.75 | x 254 · y 215 · 105×157.5 | 40 | pass |
| 2560×1440 | 1.0 | x 338 · y 286 · 140×210 | 40 | pass |
| 3840×2160 | 1.5 | x 507 · y 429 · 210×315 | 40 | pass |

추가 검사:

| 조건 | 검증 |
|---|---|
| 앵커 1.0 / 격자 1.1 | `gridScale=1.1`, 카드 154×231, 헤더는 앵커 배율 유지 |
| 관측 `columnStep=170`, `rowStep=250` | 셀 1 x=508, 행 1 y=536으로 실제 이동 |
| 잘못된 원점·화면 크기·2:3이 아닌 카드 | 거부 |
| 균등 배율 | 기준 셀 좌표와 ±1px 이내 |

## 3. 한계

- 실제 1080p·4K·다른 UI 배율 캡처가 아니다. 균등 스케일 변형과 관측 격자 계약만 검증했다.
- 이미지 레벨의 앵커 검출·카드 테두리 검출은 이 행렬에 포함되지 않는다.
- 실제 UI 배율이 헤더와 카드 격자에 다르게 적용되는 경우, `ObservedGrid`를 실제 획득 단계에서 공급해야 한다.
- 이 문서의 검사는 합성 기하 테스트다. 실제 화면 공유의 다른 해상도 확인은 비공개 기록 재실행으로 하며 그 측정 메모는 `fixtures/local/notes/`에 둔다.

## 4. 재현

```sh
node --import tsx --test tests/layout-geometry.test.ts
node --import tsx --test tests/detector-candidate.test.ts
```

## 5. 다음

- 이름+원화 융합 신원 해석
- 각성·장수 필드 증거 분리
- 관측 격자를 실제 획득 단계에서 공급하는 연결
