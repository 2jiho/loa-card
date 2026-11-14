# 개발과 검증

## 재현 가능한 기본 환경

Node.js 22, npm, Git을 사용한다. `npm ci`는 lockfile의 버전을 설치한다. `.env`, 서비스 키, 게임 설치는 필요 없다. Python과 로컬 게임 DB는 선택적인 데이터 재생성에만 필요하다.

```sh
npm ci
npm run lint
npm test
npm run build
npm run preview
```

`predev`/`prebuild`가 라이선스 고지와 OCR 자산을 준비한다. OpenCV 실행 파일도 설치된 npm 패키지에서 `public/ocr/opencv.js`로 복사하므로 준비 단계를 생략한 직접 Vite 실행은 피한다. 최초 준비는 GitHub/Hugging Face 공개 모델 다운로드를 사용하고 고정된 리비전·SHA-256을 확인한다. `work/ocr`, `work/paddle`, `work/paddle-v6` 캐시와 `public/ocr`는 삭제 후 다시 만들 수 있다. 네트워크 차단이나 해시 불일치는 준비 오류이며 무결성 검사를 끄지 않는다.

코드·테스트는 OS 독립적인 상대 경로를 사용한다. 테스트는 `tests/*.test.ts`, 최소 회귀 입력은 `tests/fixtures/`에 있다. 실제 영상/전체 화면은 없어도 실행된다. CI의 Check와 Pages 배포도 lint → test → build 순서다.

`npm run test:status`는 같은 기본 테스트의 실패한 TODO·통과한 TODO·건너뛴 사례를 따로 표시한다. 기본 테스트나 CI의 종료 코드를 바꾸지는 않으며, 테스트 유형 분류나 실제 인식 정확도 검증을 대신하지 않는다.

기본 테스트의 초록 결과는 서로 다른 범위를 합친 것이다. `tests/*.test.ts`에는 실제 제품 로직의 단위·통합 검사와 합성 입력 검사가 함께 있으며, `work/` 아래 실험용 테스트는 포함되지 않는다. `occlusion-debt-boundary.test.ts`는 현재 위험을 드러내는 특성화 검사다. 통과가 자동 종료의 안전성을 뜻하지 않는다. 재사용한 수집 그룹만으로 미식별 항목이 해소될 수 있음을 기록한다. 정책을 고칠 때는 이 검사의 기대와 안전 조건을 함께 갱신한다.

비공개 입력이 필요한 검사는 세 개다. 환경 변수가 없으면 건너뛰므로 실행 결과의 skip을 확인한다.

| 환경 변수 | 검사 |
|---|---|
| `LOACARD_OLD_REPLAY_REPORT` | `tests/corpus-evidence-cli.test.ts`: 이전 버전 실행 보고서의 inventory 체크포인트 불일치를 숨기지 않는지 |
| `LOACARD_VIDEO5_POLICY_REPORT` | `tests/video5-unknown-source-local.test.ts`: 고정 해시의 이전 보고서에서 서로 다른 미식별 출처를 보존하는지 |
| `LOACARD_ASSISTANT_PLUS_ONE_CASE` | `tests/private-plus-one-visual.test.ts`: 비공개 크롭의 +1 장수가 +1 또는 미판독으로 남는지 |

마지막 검사의 장수 라벨은 사용자의 독립 확인이 아니다. 보조자의 육안 추정이다. 이 검사는 `work/`의 비공개 검증 스크립트도 필요하다.

`screen-portrait-regression.json`은 회귀 자료다. 이전 이름의 `holdout`은 독립 검증을 암시해 변경했다. 2026-11-04 확인 시 카드가 있는 384행 중 373행은 매칭 영역의 200바이트가 같은 카드의 화면 참조와 완전히 같았다. 별도 스크린샷일 수 있지만 독립 픽셀 정확도 평가로 사용하지 않으며, 이름별 모든 라벨의 독립 정답도 증명하지 않는다. 해당 테스트는 식별된 카드가 다른 ID로 잘못 나오지 않는지와 최소 375건 식별을 확인하므로 미식별을 허용한다. 숫자 인식의 `counter-samples.json`도 숫자 atlas 생성에 사용한 영상과 같은 출처의 수동 라벨 부분집합이다. atlas 생성기는 수동 라벨이 없는 표본에는 기존 판독 결과를 사용하므로 모든 템플릿이 수동 검증된 것은 아니다. 별도 실제 촬영과 독립적으로 확인한 필드 정답을 대상으로 하지 않은 결과는 실제 인식률이나 전체 카드 검증으로 보고하지 않는다.

화면 참조와 회귀 fixture의 같은 ID별 특징 픽셀 중복은 `node scripts/audit-portrait-fixtures.mjs`로 확인한다. 대상 파일 SHA-256과 겹침 수를 출력하며, 참조나 스크린샷이 바뀌어도 과거 373건을 정답으로 강제하지 않는다. 이 비교는 라벨이 옳은지 검사하지 않는다.

`count-occlusion-pipeline`은 가림 전 판독 결과로 샘플을 나누고 가림 후 변화를 검사한다. 가림 전 결과의 정답이나 실제 양수 카드 전체에서의 오판독률을 검증하지 않는다. `count-confidence`의 서로 다른 관측 ID도 서로 다른 실제 프레임이라는 증거가 아니다. 독립 평가에는 별도 입력과 사람이 원본을 확인한 필드별 라벨이 필요하다.

`counter-contrast`는 원본 표본의 값과 밝기 변형에서 다른 숫자를 확정하지 않는지만 검사한다. 밝기 변형 결과는 미판독도 허용하므로 변형된 모든 숫자를 읽는다는 뜻이 아니다.

`portrait-matcher`의 일부 유사도 소수점 값은 구현 변화 감지용 스냅샷이다. 점수 계산을 의도적으로 바꾸면 안전한 후보 판정과 독립 실화면 결과를 확인한 뒤 숫자 기대값도 재검토한다. 기존 값과 다르다는 것만으로 오인식이라고 결론 내리지 않는다.

테스트 결과는 근거에 맞게 해석한다. `border-alignment-equivalence`와 획득 경로 비교는 이전 구현과의 동등성 검사이므로 두 경로에 공통된 오류를 찾지 못한다. 스크롤 구간 진단의 합성 기록 재생은 직렬화와 불일치 감지 검사이며, 실제 위치나 화면 표시의 정답 검증이 아니다. 알려진 가림 오판독을 재현하는 `count-pattern-runtime`의 TODO는 아직 해결되지 않았으므로 `npm test` 종료 코드가 0이어도 해당 실패를 해결한 것으로 해석하지 않는다. 출처가 불분명한 과거 라벨은 회귀 목적으로만 유지하고 실제 정확도 평가에는 독립 입력과 필드별 확인 근거를 별도로 연결한다.

`count-textured-occlusion`은 추가 장수 양수 표본을 합성 무늬로 가려 0으로 확정하지 않는지 검사한다. 이 표본은 숫자 패턴 구축 입력과 겹치고 가림은 합성이므로 독립적인 실제 정확도 지표가 아니다. 더 높은 대비의 불투명 무늬가 0으로 확정되는 알려진 반례는 숫자 영역과 실제 카드 크롭을 이용한 전체 시각 판독 경로의 TODO로 각각 남아 있다. 카드 크롭 검사는 원래 양수 여부도 기존 판독 결과로 선택하므로 독립적인 사람 정답은 아니다. 회귀 통과를 모든 툴팁·커서 가림 해결로 해석하지 않는다.

이 합성 표본에서 가려진 숫자가 임의의 양수로 확정되는 경우도 차단하도록 값과 실제 패턴 근거를 함께 검사한다. `count-confidence`의 아이콘 없음 테스트는 전달받은 판정에 대한 신뢰도 계약만 검사하며 이미지가 실제로 가려지지 않았음을 증명하지 않는다. `counter-evidence`의 크롭 변형 간 일치도 같은 입력에서 유래할 수 있어 서로 다른 물리적 관측을 뜻하지 않는다. 5각 0장 합성 검사는 게임 규칙과 단축 경로만 다루며 각성·가림 인식이 올바른지 증명하지 않는다.


`star-samples.json`의 각성 라벨은 기존 육안 확인 기록이지만 공개 fixture만으로 원본 촬영 시점과 확인자를 확인할 수 없다. 파일이 다르다는 이유만으로 독립 표본이라 부르지 않는다. 사람 확인 라벨은 질문에 포함된 카드 이름을 사용자가 별도로 확인했는지와 각 필드를 직접 확인했는지를 구분한다. 같은 답변을 여러 사례에 연결하더라도 독립 확인 횟수는 늘어나지 않는다.

`node --import tsx scripts/audit-withheld-cards.mjs`는 카탈로그에서 정답 하나를 제외해 그림만으로 다른 카드를 오인식하는지 조사한다. 2026-11-04 기준 `솔 그랑데`와 `지휘관 솔`의 동일 원화 경계에서 두 건이 발견돼 종료 코드 1을 반환한다. 이는 카탈로그에 두 카드가 모두 있는 현재 사용 사례의 오인식 건수가 아니라, 향후 카드가 누락되었을 때의 위험이다. 일반 `npm test`에 포함되지 않으며 미해결 위험을 숨기기 위해 실패를 통과로 바꾸지 않는다.

## 디렉터리

| 위치 | 역할 |
|---|---|
| `src/App.tsx`, `src/ui/` | 목록 상태, 화면 공유/CSV, 탐색·테마 |
| `src/features/card-scanner/` | 획득, OCR/필드 판독, Worker, 병합, 완료, 백업 |
| `src/features/growth/` | 도감·성장 계산과 계산 Worker |
| `src/features/raid/` | 세트 성장·피해 비교 |
| `src/features/merchants/` | 지역별 수집 상태 |
| `public/scanner/`, `public/growth/`, `public/raid/` | 커밋된 런타임 자료 |
| `public/ocr/`, `public/licenses/` | dev/build에서 생성하는 자산·고지 |
| `dev/` | dev 서버 전용 검사 페이지 |
| `scripts/` | 준비·감사·선택적 데이터 생성 도구 |
| `fixtures/local/`, `work/` | 개인 입력·캐시·검증 결과, Git/배포 제외 |

## 창 검출의 동일 픽셀 비교

선택한 영상 프레임을 무손실 PNG로 추출해 창 검출 전후의 결과와 단계를 비교할 수 있다. Python과 PATH에서 실행 가능한 `ffmpeg`, `ffprobe`가 추가로 필요하다. 출력 폴더는 기존 기록을 덮어쓰지 않도록 새로 만들어야 한다.

```sh
python scripts/prepare-detector-bench.py --output work/detector-bench-frames-v1 --source sample path/to/video.mp4 0,4,8,12
```

`--source 이름 영상경로 프레임번호`를 반복해 여러 원본을 지정할 수 있다. 번호는 0부터 시작하며 중복 없이 오름차순으로 지정한다. manifest는 입력 영상의 해시, 추출 프레임 번호·표시 시각·PNG 해시와 도구 버전을 보존한다. 추출 실패 시 manifest가 생성되지 않으며, 부분 폴더를 결과로 사용하지 않는다. 원본과 PNG는 `work/` 등 비공개 위치에 보관한다.

개발 서버의 `/dev/detector-bench.html`은 위 폴더에서 입력을 읽고 페이지와 검출 Worker의 픽셀 해시 및 결과를 비교한다. **결과 저장**으로 별도 보고서를 보관한다. 이 검사는 디코딩된 영상 프레임의 검출 비교이며, 이전 화면 공유의 정확한 픽셀이나 OCR 정답·실시간 처리량을 증명하지 않는다. 타이밍은 브라우저·부하·실행 순서의 영향을 받으므로 반복 비교와 실제 공유 검증이 따로 필요하다.

다른 입력을 보존하려면 `work/` 바로 아래 새 폴더를 출력 위치로 지정하고 페이지 주소에 `?dataset=폴더이름`을 붙인다. 폴더 이름에는 영문·숫자·밑줄·하이픈만 사용할 수 있다.

## 스캔 재실행 검사

스캐너 변경은 비공개 화면 공유 기록(`fixtures/local/recordings/`)을 다시 실행해 확인한다. 개발 서버(`npm run dev`)에서 앱으로 화면을 공유하면 카드 창이 보인 구간이 이 폴더에 자동 기록된다(`?record=all`이면 공유 전체). 기록 형식과 보고서 항목은 [화면 공유 기록](dev-recording.md)을 따른다.

```sh
node scripts/run-recording-replay.mjs --id <기록 id>                  # rowlive
node scripts/run-recording-replay.mjs --id <기록 id> --mode realtime
```

개발 서버가 먼저 떠 있어야 한다. 한 개발 서버에서 재실행을 동시에 두 개 돌리지 않는다.

- `rowlive`(기본): 줄 중심 스캔을 직접 실행하고 진행 창이 보여 준 상태(`monitorTimeline`)를 보고서에 남긴다.
- `realtime`: 앱과 같은 스캔(`runScanner` → 줄 중심 스캔)을 기록의 원래 속도로 실행한다. 앱처럼 판독기를 먼저 준비해 넘긴다. 공유 종료 시점과 최종 결과를 함께 남긴다.
- 같은 페이지(`/dev/recording.html`)의 `rowread`·`rowlight`·`rows`·`lean`·`artfail`·`gridfit`·`cardmap`은 측정 도구이며 스캔 결과가 아니다.
- 이전 방식(`sequential`, `realtime-detailed`, `realtime-batch`, `skip:` 등)은 v0.3.0에서 제거했다. 페이지가 거부한다.
- 실행 속도는 이 PC의 부하에 따라 달라진다. 같은 기록을 여러 번 실행해 공유 종료 시점과 최종 결과를 따로 비교하고, 한 번의 결과를 실시간 보장으로 보고하지 않는다.

`scripts/run-recording-replay.mjs`의 옵션:

| 옵션 | 뜻 |
|---|---|
| `--id <id>` | 재실행할 기록. 여러 번 주면 차례로 실행한다. 없으면 사용법을 출력하고 끝난다. |
| `--mode <방식>` | 위 방식 중 하나. 기본 `rowlive`. |
| `--port <번호>` | 개발 서버 포트. 기본 5173. |
| `--query "<이름=값&…>"` | 재실행 페이지 주소에 덧붙일 매개변수(아래 표). |
| `--until <초>` | `realtime`에서 기록 시각 이 초 뒤에 공유를 끝낸다. 보고서에 `subsetOf`로 남는다. |
| `--log <파일>` | 브라우저 콘솔·오류 출력을 파일에 남긴다. |
| `--cpuprofile <파일>` | `realtime`의 공유 구간 CPU 프로파일. 메인 스레드와 워커별 파일을 남긴다. `--id` 하나에만 쓴다. |
| `--json` | 결과를 한 줄 JSON으로 출력한다. |
| `--timeout <초>` | 보고서를 기다리는 최대 시간. 기본 600. |
| `--browser <경로>` 또는 `CHROME_PATH` | 헤드리스로 띄울 Chrome·Edge. 없으면 흔한 설치 경로를 찾는다. |

`/dev/recording.html`이 읽는 주소 매개변수(스크립트는 `autorun`·`mode`·`until`·`profile`을 직접 붙인다):

| 매개변수 | 방식 | 뜻 |
|---|---|---|
| `autorun=<id>` | 모두 | 페이지를 열자마자 그 기록을 실행한다. |
| `mode=<방식>` | 모두 | 실행 방식. |
| `until=<초>` | `realtime` | 기록 시각 이 초 뒤에 공유를 끝낸다. |
| `profile` | `realtime` | 공유 구간을 `console.profile`로 감싼다(`--cpuprofile`용). |
| `prepared=0` | `realtime` | 판독기를 미리 준비해 넘기지 않고 스캔이 직접 불러온다. |
| `peek=<이름,…>` | `realtime` | 그 카드들을 보고서의 `countReview`에 넣는다. |
| `names=0` | `rowlive` | 이름 판독을 끈다. `rowread`에서는 `names=1`일 때만 켠다. |
| `inline=1` | `rowlive` | 이름 판독을 프레임 루프 안에서 한다(기본은 옆 차선). |
| `place=0` | `rowlive` | 옆 차선에서 이름 붙인 카드를 목록 표에 놓지 않는다. |
| `evidence=0` | `rowlive` | 스캐너의 수락·병합을 거치지 않는다. |
| `zero=0`·`end`·`diagnose` | `rowlive` | 0장 확인: 끔, 공유가 끝난 뒤에만, 진단 기록을 붙여 실행. |
| `trace=<카드 id,…>` | `rowlive` | 그 카드의 받아들인 크롭과 장수 판독을 보고서에 남긴다. |
| `queue=<수>` | `rowlive` | 기다리는 프레임 줄의 길이(기본 12). |
| `readers=<수>` | `rowlive` | 시각 판독 워커 수(기본 2). |
| `hold=<초>` | `rowlive`, `rowread` | 이름을 못 붙인 자리의 이름 판독 보류 시간. |
| `source=video`·`main`·`held` | `rowlive` | 비교용 프레임 경로: video 콜백, 메인 스레드에서 트랙 읽기, 복사하지 않은 프레임. |
| `serial=1` | `rowlive` | 한 프레임을 다 읽은 뒤 다음 프레임을 받는다(비교용). |
| `soft=1` | `rowlive` | 프레임 캔버스를 메인 메모리에 둔다(비교용). |
| `warm=0` | `rowlive` | 공유 전 이름 판독기 예열을 끈다. |
| `handover=<수>` | `rowlight` | 측정 도구의 넘김 기준. |
| `lanes=<수>` | `lean` | 측정 도구의 판독 레인 수(기본 2). |

앱과 다른 개발 페이지의 플래그:

| 위치 | 매개변수 | 뜻 |
|---|---|---|
| 앱(개발 서버) | `?record=all` | 화면 공유 전체를 기록한다(기본은 카드 창이 보인 구간). |
| 앱·재실행 | `?refine=0` | 이름 판독 차선의 정밀 원화 대조를 끈다(비교용). |
| `/dev/row-share.html` | `?rec=0` | 이 페이지의 공유를 기록하지 않는다. |
| `/dev/row-share.html` | `?source=main`·`held` | `rowlive`의 `source`와 같은 비교용 프레임 경로. |

스캔 순서를 바꾼 경우는 기존 기록에서 파생 기록을 만들어 확인한다. 실제로 그렇게 공유한 기록이 아니며, meta의 note에 출처가 남는다.

```sh
node --import tsx scripts/derive-recording.mjs <기록 id> <새 id> reverse          # 아래에서 위로
node --import tsx scripts/derive-recording.mjs <기록 id> <새 id> middle=<프레임>  # 중간에서 시작해 끝까지, 다시 처음까지
```

진행 창의 문제(지도 지연·깜빡임·흔들림·종료 상태 불일치)는 `rowlive` 보고서로 자동 검사한다.

```sh
node scripts/check-monitor-timeline.mjs <기록 id> [run 파일]
```

배치 변화와 넘침은 `/dev/monitor-timeline.html?id=<기록 id>&run=<run 파일>&width=340`에서 기록된 상태를 앱의 진행 창 컴포넌트로 다시 그려 측정한다. `&fill=1`은 별도 진행 창(창 높이를 채우는 배치), `&at=<번호>`는 한 상태만 그린다. 검사 항목과 한계는 [화면 공유 기록](dev-recording.md#진행-창-자동-점검)에 있다.

v0.3.0에서 이전 프레임 단위 스캐너 루프와 앱의 "스캔 진단"(진단 기록·입력 재현)을 제거했다. 그 루프 전용이던 개발 페이지(`/dev/scanner.html` 등)와 실험 기록 설명도 함께 지웠으며, 지난 내용은 Git 이력에 남아 있다.

## 입력 코퍼스

사람이 제공한 영상·사진은 원본을 바꾸지 않고 `fixtures/local/corpus/`(Git·배포 제외)에 등록한다. 입력 종류와 파일 내용·순서·반복으로 사례를 식별하므로 이름만 바꾼 같은 입력은 다시 저장하지 않는다. 등록할 때 촬영 시각·완전성·baseline·정답은 미확인으로 남긴다.

```sh
npm run corpus -- add path/to/recording.mp4 --name fast-scroll --kind video
npm run corpus -- add path/to/first.png path/to/second.png --name screenshots --kind images
npm run corpus -- list
npm run corpus -- verify          # 원본 바이트·순서의 무결성(인식 정확도 검사가 아님)
```

등록한 영상·사진을 지금 스캐너로 실행하려면 기록 형식으로 바꾼다(`scripts/import-video-recording.mjs`). 그다음은 화면 공유 기록과 같이 재실행·점검한다. 방법과 한계는 [화면 공유 기록](dev-recording.md#사람이-만든-영상스크린샷을-기록으로-바꾸기)에 있다.

사람이 확인한 일부 카드의 값은 사람 확인 라벨로 따로 둔다. 라벨은 사례 ID·입력 SHA·확인 문맥과 답변·확인한 카드 필드를 기록한다. 생략은 미제공, `{status:'unknown'}`은 명시적 미확인, `{status:'known',value:0}`은 확인한 0이다.

```sh
npm run corpus -- import-human <case-id> work/human-label.json --operator-confirmed
npm run corpus -- list-human <case-id>
npm run corpus -- verify-human <label-sha256>
npm run corpus -- quarantine-human <label-sha256> --reason "검토 이유"
node scripts/compare-labels.mjs <기록 id> [run 파일]     # 가져온 기록의 재실행 결과와 비교
```

- 라벨은 `fixtures/local/corpus/human-labels/`에 내용 해시로 추가하며 사례 manifest·baseline을 고치지 않는다. `--operator-confirmed`는 작업자의 명시적 주장이지 정답의 증명이 아니다.
- 확인 범위나 카드 연결이 잘못된 라벨은 `quarantine-human`으로 격리한다. 원본은 보존되고 비교에 쓰지 않는다.
- 부분 라벨의 통과를 전체 인식률로 해석하지 않는다. 프로그램 결과(baseline)를 라벨(expected)로 자동 승격하지 않는다.
- AI 비전 모델로 만든 후보는 사람이 확인하기 전까지 라벨이 아니다.

이전 버전의 앱 진단 파일(`.loareplay`, `.loaraw`)을 검증하는 명령(`verify-raw`, `verify-selection`, `compare`, `compare-human`, `record-run`, `replay-state`, `scripts/verify-replay-input.ts`)도 남아 있다. 그 파일을 지금 스캐너로 다시 실행하는 경로는 없고, 이 명령들은 그 시절 보고서 형식만 읽는다. 새 검증 입력은 개발 서버의 화면 공유 기록이나 위의 가져온 기록으로 남긴다.

새 입력 등록 → 수정 전 결과 → 원인 재현 → 수정 → 회귀 묶음 재실행(`node scripts/run-regression.mjs`, [화면 공유 기록](dev-recording.md#회귀-묶음))을 기본 개발 순서로 쓴다. 기록·재현·비교의 계약은 [입력 기록과 재현 설계](scanner-session-design.md)를 따른다.

## 변경에 따른 확인

- 인식: 정상/잘림/가림/저대비/0장과 최신 관측 충돌을 검사한다. 성능을 위해 확정 조건만 낮추지 않는다.
- 성능: 빈 목록 시작, 입력 길이·해상도·프레임률·장치/브라우저, 첫 결과, 공유 종료 때 확인 수, 최종 확인 수, 누락/추가/필드 차이, 보완 프레임 수를 기록한다.
- 계산: 공유 카드·중간 단계·자원 차감·미확인 입력과 마스터 참조 무결성을 검사한다.
- UI: 밝은/어두운 모드, 데스크톱/좁은 화면, 키보드 탭 이동, 스캔 중 탭 전환, CSV 잘못된 입력과 백업 복원을 확인한다.
- 자산 경로: `/`뿐 아니라 `PAGES_BASE_PATH=/loa-card/`로 빌드해 Worker·WASM·모델·고지 링크가 열리는지 확인한다.

단위 테스트 통과, 전체 영상의 수량 일치, 모든 필드의 수동 정답 일치는 서로 다른 검증이다. 공유 후 보완된 최종 결과를 실시간 결과로 보고하지 않는다.

검사 요약의 `review`는 식별된 카드 중 필드 확인이 필요한 카드 수, `unidentified`는 카드 ID에 연결되지 않은 최종 실패 관측 수다. 같은 카드의 중복 관측일 수 있으므로 두 값을 더해 누락 카드 수로 계산하지 않는다. `unreadable`은 판독 도중 발생한 각성 미판독의 누적 횟수이며 최종 미해결 수가 아니다. 수량 일치만으로 실패 관측을 삭제하지 않는다.

## 회귀 검사

주요 경계 조건은 다음 테스트에 유지한다. 로직을 바꾸면 해당 검사를 먼저 실행하고 전체 `npm test`, lint, build를 확인한다.

| 경로 | 검사 대상 |
|---|---|
| `tests/count-pattern-runtime.test.ts`, `tests/count-confidence.test.ts` | 실제 크롭의 양수·0장, 아이콘만 가린 숫자, 미확인과 0의 구분 |
| `tests/row-scanner-state.test.ts` | 줄 중심 스캔의 완료 조건, 상태 문구, 완료 뒤 남은 미식별 칸 처리 |
| `tests/list-guidance.test.ts`, `tests/list-guidance-map.test.ts` | 다시 볼 줄 안내, 목록 지도(빈칸·잠긴 칸, 본 줄, 강조 보류) |
| `tests/unknown-lifecycle.test.ts`, `tests/observation-history.test.ts` | 최신 실패 경고의 전이, 동일 캡처 재시도의 중복 근거 |
| `tests/capture-quality.test.ts`, `tests/scan-grid.test.ts` | 대표 특징 교체, 늦은 결과와 현재 화면 분리 |
| `tests/scan-backup.test.ts` | 최소 목록 백업·과거 형식·revision 충돌·저장소 시간 초과·재시도 |
| `tests/derived-recording.test.ts` | 파생 기록의 프레임 순서와 시간 간격 |

예를 들어 안내 변경은 `node --import tsx --test tests/list-guidance.test.ts tests/list-guidance-map.test.ts`로 확인한다. 성능 비교는 같은 기록·빈 시작 목록을 사용한다. 공유 종료 시각과 최종 판독 종료를 구분하고, 입력을 강제 종료해서 자동 종료 성능으로 보고하지 않는다.

개인 입력이 없는 새 환경의 검증은 추적 파일만 있는 별도 디렉터리에서 `npm ci`, lint, test, Pages base build와 `npm run audit:distribution`을 수행한다. 빌드 자산의 경로·MIME·manifest 해시와 개발 화면/개인 자료의 배포 제외 여부도 확인한다. 해시를 검사하는 외부 고지·OCR 문자표는 `.gitattributes`의 줄바꿈 변환 제외를 유지한다. 특정 시점의 테스트 개수나 단일 사진 성공을 현재 전체 카드 정확도로 일반화하지 않는다.
