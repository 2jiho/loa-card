# 라이선스와 외부 자산

LoaCard 작성 코드와 문서는 [MIT](LICENSE)로 제공한다. 아래 외부 코드·모델·게임 유래 자료에는 해당 권리자의 조건이 적용되며 프로젝트 MIT로 재허가하지 않는다.

## 소프트웨어와 모델

| 구성 | 라이선스 | 출처 |
|---|---|---|
| React / React DOM | MIT | https://github.com/facebook/react |
| MUI / 아이콘 | MIT | https://github.com/mui/material-ui |
| Google Material Icons 원본 SVG | Apache-2.0 | https://github.com/google/material-design-icons |
| Emotion | MIT | https://github.com/emotion-js/emotion |
| Mediabunny | MPL-2.0 | https://github.com/Vanilagy/mediabunny |
| ONNX Runtime Web | MIT | https://github.com/microsoft/onnxruntime |
| OpenCV.js / 배포 패키지 | Apache-2.0 | https://github.com/TechStark/opencv-js |
| PaddleOCR 모델 | Apache-2.0 | https://github.com/PaddlePaddle/PaddleOCR |
| Tesseract.js / Core / 언어 데이터 | Apache-2.0 | https://github.com/naptha/tesseract.js |

정확한 npm 버전과 무결성 값은 `package-lock.json`, 모델 리비전·SHA-256은 `scripts/prepare-ocr-assets.mjs`가 기준이다. `public/scanner/NOTICE.txt`와 그 디렉터리의 라이선스 원문을 보존한다.

`npm run notices`와 dev/build 준비 단계는 설치된 production 의존성의 버전·라이선스·원문 고지를 `public/licenses/`로 생성한다. 의존성 전체를 포함하므로 실제 번들에 포함되지 않는 항목도 있을 수 있다. 누락된 원문은 `inventory.json`의 `missingLicenseText`에 기록한다. 이 목록은 법률 검토나 배포 권리 확인을 대신하지 않는다.

Mediabunny는 수정하지 않은 npm 패키지를 사용한다. 빌드에 사용한 패키지의 `src/`, `package.json`, `LICENSE`를 `licenses/mediabunny-source/`에 함께 배포한다. 해당 소스는 MPL-2.0이다. 배포 페이지의 **라이선스** 링크에서 라이선스 원문과 소스 파일 목록을 확인할 수 있다. 수정하거나 다른 버전을 사용하면 실제 배포 버전의 소스를 함께 갱신해야 한다.

현재 `guid-typescript@1.0.9`, `tr46@0.0.3` npm 패키지는 각각 ISC/MIT를 선언하지만 라이선스 원문을 포함하지 않는다. 생성 보고서가 이를 별도로 표시한다. 공개 배포 전 실제 배포 포함 여부와 원문 확보 여부를 검토한다. ONNX Runtime의 원문은 저장소에 보관한 `public/scanner/LICENSE-ONNX-Runtime.txt`로 보완한다.

2026-10-08 웹 빌드의 앱·Worker 모듈과 사용 중인 ONNX WASM/Tesseract 워커의 source map에서는 위 두 패키지가 발견되지 않았다. 이 결과는 현재 브라우저 배포 경로에 한정하며, 해당 패키지 자체의 라이선스 원문 누락을 해결한 것은 아니다. Node 경로 또는 다른 ONNX 백엔드를 배포하면 다시 검사한다.

`licenses/third-party/manifest.json`은 사전 빌드된 워커/WASM과 모델의 추가 고지 원문·출처·SHA-256을 관리한다. `npm run notices`가 파일과 관련 패키지 버전을 검증하고 `public/licenses/supplemental/` 및 원문 모음에 포함한다. Tesseract 워커의 `buffer`, `base64-js`, `ieee754`는 상위 패키지 lockfile과 npm 무결성, source map의 소스 일치로 확인했다. `worker.min.js.LICENSE.txt`도 워커와 함께 배포한다.

ONNX Runtime의 버전별 전체 ThirdPartyNotices, Tesseract core의 고정 submodule 고지, OpenCV 빌드 정보에 나온 protobuf/zlib/flatbuffers 고지와 tessdata 모델 원문을 보존한다. 상위 프로젝트의 전체 고지는 웹 빌드에 포함되지 않은 구성도 다루므로 전체 바이너리 구성표(SBOM)와 동일하지 않다. Tesseract core includes software based in part on the work of the Independent JPEG Group. Google Material Icons는 MUI가 SVG 컴포넌트로 변환한 아이콘이며 Google 원본의 Apache-2.0과 MUI 패키지 MIT를 구분한다.

## 게임과 데이터

Lost Ark의 카드 원화·게임 UI·명칭 및 관련 게임 자산의 권리는 Smilegate RPG 등 원권리자에게 있다. LoaCard는 비공식 도구다. 출처 표시는 재배포 허가를 뜻하지 않는다.

다음 자료는 이미지가 JSON/base64/특징 벡터로 변환되어 있어도 자동으로 프로젝트 MIT 대상이 되지 않는다.

- `public/scanner/growth-tab.png`, `header-anchor.png`: 게임 UI 일부.
- `public/scanner/cards.json`, `artwork-details.json`, `screen-artwork-details.json`, `counter-patterns.json`, `stars.json`: 카드 메타데이터 및 원화·UI에서 유래한 인식 자료.
- `public/growth/master.json`, `public/raid/master.json`, `src/features/merchants/merchants.json`: 게임 데이터 기반 마스터.
- `tests/fixtures/`: 게임 화면에서 자른 픽셀, 이름 마스크, 특징과 수동 라벨. 일부 JSON에서 이미지를 복원할 수 있다. 별도의 합성 테스트 자료도 있지만 실제 화면에서 얻은 표본의 권리가 바뀌는 것은 아니다.

카드 이름·등급·성장 가능 여부는 클라이언트 SeasonCard/GameMsg로 검증한다. 원화 특징 388종과 `public/scanner/artwork/*.webp`는 클라이언트 atlas에서 생성한다. 나머지 카드에 외부 사이트 그림을 대체값으로 남기지 않는다. 기존 게임 화면 기반 보조 자료는 유지한다. 원화의 이름 연결 과정에서는 과거 [Lost Ark Codex](https://lostarkcodex.com/kr/cards/)·[인벤 카드 DB](https://lostark.inven.co.kr/dataninfo/card/) 그림과의 시각적 대응을 참고했으며 이 이력을 공식 UV 대응표로 표현하지 않는다. `artwork-provenance.json`과 scanner NOTICE에 출처와 해시를 보존한다. 표시용 이미지가 추가되어 게임 원화도 웹 배포에 포함된다.

게임 원본 DB·폰트·아카이브·사용자 전체 영상은 커밋하지 않는다. 운영 방침상 개별 사전 문의는 진행하지 않고 기능에 필요한 가공 자료와 권리 고지를 유지한다. 이 선택과 고지는 배포 허가를 확인했다는 뜻이 아니다. 권리 요청이나 정책 변경으로 자료를 제외·대체하면 빌드와 인식·계산 검증을 다시 실행한다.

공식 UGC 규약은 애플리케이션을 포함한 비상업적 창작·무료 공유의 근거를 제공하지만, 추출 DB 및 외부 사이트 자료 전체를 MIT로 재배포하도록 허락한 것으로 해석하지 않는다. 확인한 조항, 배포 범위와 미해결 사항은 [권리 검토](docs/legal-review.md)에 기록한다.
