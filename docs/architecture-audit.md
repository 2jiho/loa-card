# 구조 감사

- 생성: 2026-11-08T04:36:11.069Z
- 파일: 1074
- 전체 크기: 7.55 MB
- 이 문서는 감사 결과이며 의존 규칙 강제는 Step 3에서 추가한다.
- 경로는 저장소 상대 경로만 사용한다.

## 레이어별 규모

| 레이어 | 파일 | 크기 |
|---|---|---|
| tests | 495 | 3.76 MB |
| dev | 126 | 1014.0 KB |
| scanner:session | 92 | 486.4 KB |
| scanner:reproduction | 51 | 478.0 KB |
| scanner:acquisition | 55 | 417.9 KB |
| scanner:recognition | 53 | 282.8 KB |
| scripts | 54 | 279.1 KB |
| scanner:orchestration | 1 | 259.0 KB |
| scanner:ui | 36 | 186.0 KB |
| scanner:capture | 32 | 173.0 KB |
| src:other | 17 | 67.4 KB |
| app | 9 | 53.3 KB |
| domain | 11 | 48.0 KB |
| scanner:persistence | 6 | 39.7 KB |
| feature:growth | 16 | 33.6 KB |
| feature:raid | 5 | 20.0 KB |
| scanner:evaluation | 4 | 17.6 KB |
| feature:merchants | 5 | 14.2 KB |
| shared | 4 | 7.6 KB |
| data | 1 | 2.6 KB |
| scanner:public | 1 | 446 B |

## 큰 파일 20개

| 파일 | 크기 | 레이어 |
|---|---|---|
| src/features/card-scanner/orchestration/scanner.ts | 259.0 KB | scanner:orchestration |
| dev/scanner.ts | 98.5 KB | dev |
| src/features/card-scanner/session/inventory-evidence.ts | 60.4 KB | scanner:session |
| tests/canonical-capture.test.ts | 59.9 KB | tests |
| src/features/card-scanner/reproduction/scan-reproduction.ts | 58.7 KB | scanner:reproduction |
| tests/acquisition-measured-raster.test.ts | 55.6 KB | tests |
| src/features/card-scanner/reproduction/reproduction-session-store.ts | 53.6 KB | scanner:reproduction |
| tests/scan-corpus.test.ts | 48.7 KB | tests |
| dev/run-state-trace.ts | 47.5 KB | dev |
| tests/run-state-trace.test.ts | 47.4 KB | tests |
| tests/name-reader-continuation.test.ts | 46.3 KB | tests |
| tests/scan-grid.test.ts | 43.8 KB | tests |
| src/features/card-scanner/recognition/name-reader.ts | 42.9 KB | scanner:recognition |
| src/App.tsx | 39.9 KB | src:other |
| tests/inventory-evidence.test.ts | 39.7 KB | tests |
| tests/source-preparation.test.ts | 39.3 KB | tests |
| scripts/scan-corpus-core.mjs | 35.3 KB | scripts |
| tests/live-capture-pipeline.test.ts | 35.3 KB | tests |
| src/features/card-scanner/reproduction/canonical-capture.ts | 35.1 KB | scanner:reproduction |
| src/features/card-scanner/reproduction/exact-recording-codec.ts | 32.1 KB | scanner:reproduction |

## 런타임 순환 의존

- 발견: 0
- 없음

## 타입 전용 순환

- 발견: 0
- 없음

## 기능 간 의존

- 발견: 0
- 없음

## 스캐너 내부 의존

- 발견: 399
- src/features/card-scanner/acquisition/acquisition-client.ts → src/features/card-scanner/reproduction/recording-frame-integrity.ts
- src/features/card-scanner/acquisition/acquisition-worker.ts → src/features/card-scanner/reproduction/recording-frame-integrity.ts
- src/features/card-scanner/acquisition/candidate-queue.ts → src/features/card-scanner/session/inventory-evidence.ts
- src/features/card-scanner/acquisition/capture-quality.ts → src/features/card-scanner/recognition/name-visibility.ts
- src/features/card-scanner/acquisition/card-acquisition.ts → src/features/card-scanner/recognition/name-pattern.ts
- src/features/card-scanner/acquisition/card-acquisition.ts → src/features/card-scanner/session/grid-scroll-probe.ts
- src/features/card-scanner/acquisition/card-label.ts → src/features/card-scanner/recognition/name-pattern.ts
- src/features/card-scanner/acquisition/card-tile-fields.ts → src/features/card-scanner/recognition/recognizer-types.ts
- src/features/card-scanner/acquisition/card-tile-fields.ts → src/features/card-scanner/session/current-scan-fields.ts
- src/features/card-scanner/acquisition/card-tile-image.ts → src/features/card-scanner/recognition/recognizer-types.ts
- src/features/card-scanner/acquisition/card-tile-image.ts → src/features/card-scanner/session/current-scan-fields.ts
- src/features/card-scanner/acquisition/decoded-rgba-client.ts → src/features/card-scanner/reproduction/exact-recording-codec.ts
- src/features/card-scanner/acquisition/decoded-rgba-worker.ts → src/features/card-scanner/reproduction/exact-recording-codec.ts
- src/features/card-scanner/acquisition/field-diagnostic-images.ts → src/features/card-scanner/session/inventory-evidence.ts
- src/features/card-scanner/acquisition/input-acquisition-evidence.ts → src/features/card-scanner/capture/live-capture-pipeline.ts
- src/features/card-scanner/acquisition/input-acquisition-evidence.ts → src/features/card-scanner/reproduction/live-input-decision-replay.ts
- src/features/card-scanner/acquisition/native-yuv-recipe.ts → src/features/card-scanner/reproduction/recording-frame-integrity.ts
- src/features/card-scanner/acquisition/prepared-crop-proof-client.ts → src/features/card-scanner/reproduction/recording-frame-integrity.ts
- src/features/card-scanner/acquisition/prepared-crop-proof.ts → src/features/card-scanner/reproduction/recording-frame-integrity.ts
- src/features/card-scanner/acquisition/prepared-decoded-frames.ts → src/features/card-scanner/capture/input-source.ts

## 외부 패키지

| 패키지 | import 수 |
|---|---|
| @mui/material | 52 |
| react | 45 |
| fake-indexeddb | 25 |
| @mui/icons-material | 21 |
| react-dom | 21 |
| mediabunny | 9 |
| vite | 5 |
| @noble/hashes | 3 |
| ffmpeg-static | 3 |
| esbuild | 2 |
| @techstark/opencv-js | 1 |
| tesseract.js | 1 |
| onnxruntime-web | 1 |
| lz4-lite | 1 |
| lz4-wasm | 1 |
| motion | 1 |
| tsx | 1 |
| typescript | 1 |
| marked | 1 |

## 해석하지 못한 상대 import

| 확장자 | 수 |
|---|---|
| .css | 17 |
| .json | 2 |
| .config | 1 |

## 한계

- import 그래프는 정적 분석이며, 런타임 동적 문자열 import와 Worker 메시지 결합은 포함하지 않는다.
- 상대 import가 아닌 경로 별칭·가상 모듈은 별도 규칙이 필요하다.
- 코퍼스 재실행 결과가 아니며, 인식 정확도를 뜻하지 않는다.
