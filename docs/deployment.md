# 정적 배포

## GitHub Pages

1. 저장소 Settings → Pages의 Source를 GitHub Actions로 설정한다.
2. 아래 절차로 버전을 갱신하고 `v0.1.0` 형식의 태그를 푸시한다. **Deploy GitHub Pages**가 자동 실행된다.
3. 워크플로는 Node 22, `npm ci`, lint/test/build를 실행하고 `dist`만 배포한다.
4. 배포 job이 출력한 URL을 사용한다. 프로젝트 Pages의 base는 `/<저장소 이름>/`이다.
5. 배포 파일 검증까지 성공하면 해당 태그의 GitHub Release를 자동 생성한다. HTTPS 사이트에서 모델/Worker/라이선스 링크, CSV, 화면 공유 시작·중지·완료를 확인한다.

Check와 Pages는 Ubuntu 24.04 / Node.js 22에서 실행한다. 액션 자체는 Node.js 24 런타임을 사용하는 공식 버전을 커밋 SHA로 고정했다. 버전 설명은 각 `uses` 옆 주석을 따른다. 업데이트할 때 공식 릴리스와 SHA를 함께 검토한다. 일반 검증에는 `contents: read`만 부여하고, Pages는 배포에 필요한 `pages: write`, `id-token: write`를 사용한다. Release 생성 job에만 `contents: write`를 부여한다. 일반 브랜치 푸시는 Check만 실행하며 배포하지 않는다.

## 버전과 릴리스

`package.json`과 lockfile의 버전을 기준으로 `v0.1.0`부터 관리한다. `0.x` 기간에는 버그 수정은 patch(`0.1.1`), 기능 추가·호환성 변경은 minor(`0.2.0`)를 올린다. 저장 형식이나 사용법의 호환성 변경은 반드시 변경 내역에 적는다. 카드 데이터 기준일과 스캔 기록 형식 버전은 앱 버전과 별개다.

1. 깨끗한 `main`에서 `npm version patch --no-git-tag-version` 또는 `npm version minor --no-git-tag-version`을 실행한다.
2. `CHANGELOG.md`에 `## vX.Y.Z - YYYY-MM-DD` 항목과 사용자에게 필요한 변경 내역을 작성한다.
3. lint/test/build와 관련 검증을 마친 뒤 버전·변경 내역을 커밋한다.
4. 아래처럼 **실제 버전**의 annotated tag를 만들고 브랜치와 태그를 함께 푸시한다.

```sh
git tag -a v0.1.0 -m "LoaCard v0.1.0"
git push --atomic origin main v0.1.0
```

태그, package.json, lockfile 버전과 변경 내역이 일치하고 `main` 이력에 포함된 커밋이어야 배포된다. 검증 실패 시 배포를 중단한다. 배포된 파일의 해시 검증까지 통과해야 Release가 생성된다. 이미 생성된 Release는 재실행 시 수정하지 않는다. 발표한 태그는 옮기거나 덮어쓰지 않는다.

GitHub `github-pages` environment의 배포 정책에는 `main` branch와 `v*` tag를 허용해야 한다. 실패한 릴리스는 Actions에서 같은 실행을 재시도한다. 특정 기존 태그 재배포는 `gh workflow run pages.yml --ref v0.1.0`처럼 실행할 수 있다. 브랜치를 선택한 수동 실행은 거부한다. 이전 버전으로 되돌릴 때도 검증된 기존 태그를 선택하며 그 이후 새 버전으로 수정한다.

배포 자동화는 [GitHub의 태그 push 이벤트](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#push)와 [GitHub CLI Release 생성](https://cli.github.com/manual/gh_release_create)을 사용한다.

두 워크플로 모두 빌드 후 `npm run audit:distribution`으로 고지 원문이 없는 의존성의 실제 번들 포함 여부를 검사한다. 이 검사는 게임 자료의 배포 권리를 판단하지 않는다.

로컬에서 같은 하위 경로를 검사하는 PowerShell 예:

```powershell
$env:PAGES_BASE_PATH = '/loa-card/'
npm run build
npm run preview
# 미리보기 종료 후
Remove-Item Env:PAGES_BASE_PATH
```

사용자 지정 도메인이나 `사용자.github.io` 루트 사이트는 워크플로의 base를 `/`로 변경한다. 빌드 시 결정된 base와 실제 호스팅 경로가 같아야 한다. `dist` 전체를 배포하며 `public/ocr` 자산을 임의로 빼지 않는다. 현재 WASM은 단일 스레드 설정이며 별도 COOP/COEP 격리 헤더를 전제하지 않는다.

화면 공유는 HTTPS 또는 localhost에서 검사한다. 브라우저/OS의 공유 대상 선택은 사용자가 직접 수행한다. Pages URL이 바뀌면 브라우저 저장소도 별개이므로 목록을 CSV로 옮긴다.

## 배포 검증

- 빈 폴더에 저장소를 clone하고 README의 설치·lint·test·build 명령을 실행한다. OCR 모델은 준비 스크립트가 고정 버전과 해시를 검증한다.
- 배포된 주소에서 모델·Worker·WASM과 라이선스 링크가 정상적으로 열리는지 확인한다.
- 화면 공유의 시작·종료·판독 완료, CSV 입출력, 도감작·레이드 카드 화면을 확인한다.
- `THIRD_PARTY_NOTICES.md`와 생성된 라이선스 원문 누락 보고서를 확인한다. 게임 유래 자료는 해당 권리자의 배포 조건을 따른다.

일반 빌드 성공은 외부 자료의 배포 허가를 뜻하지 않는다. [권리 검토](legal-review.md)의 미확인 자료를 검토한 후 배포 범위를 결정한다. 필수 자료를 제외하거나 대체하면 빌드와 인식·계산 테스트를 다시 실행한다.

공개 전과 실제 배포 후 확인 항목은 [출시 점검](release-checklist.md)에 구분한다.

## 자동 파일 검증

빌드는 `site-manifest.json`에 dist 전체 파일의 크기와 SHA-256을 만든다. `npm run verify:site -- --local`은 임시 HTTP 서버에서 모든 파일의 응답·내용·JS/WASM/JSON MIME과 index의 base 경로를 검사한다. Pages base로 빌드한 경우 같은 `PAGES_BASE_PATH`를 검사에도 지정한다.

`npm run verify:site -- https://HOST/REPOSITORY/`로 실제 배포를 검사한다. 로컬 dist가 있으면 같은 manifest인지도 확인한다. Pages 워크플로는 build job의 manifest 해시를 deploy job에 전달해 이전 배포를 새 배포로 오인하지 않도록 하고, 배포 직후 전체 파일을 검사한다. 테스트는 파일을 실제로 내려받으므로 배포 크기만큼 트래픽이 발생한다. 검사 성공이 브라우저의 OS 공유 선택, 실제 게임 판독 또는 배포 권리 확인을 대체하지 않는다.
