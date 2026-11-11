# GOAL — 카드 인식 엔진 완성 (전체 목표 미완료)

## 전체 목표

모든 테스트 입력(영상·사진)과 실제 화면 공유에서 카드의 이름·각성(0~5)·추가 장수(0~15)를 확인한다. 단, 판독이 어려운 카드(툴팁·커서 가림, 이름 판독 불가·모호, 카드 뒷면)는 값을 추정하지 않고 `인식 필요`로 결과에 남기고 종료할 수 있다. 이 경우 전체 판독으로 주장하지 않는다. 다음을 모두 만족할 때만 전체 목표 달성으로 본다.

- 각 입력에서 `cards=expected`, `names=expected`, `read=expected` (인식 필요로 명시한 슬롯·카드는 해당 수량에서 제외하고 별도 목록으로 남긴다)
- 모든 카드의 `review`가 비어 있고 `countReliable === true`
- 미식별 입력·미해결 관측·처리하지 못한 화면·입력 근거 손실이 모두 0 (판독이 어려워 `인식 필요`로 명시한 항목은 미해결이 아니라 별도 목록으로 남기고 값을 추정하지 않는다)
- `unresolvedObservations = 0` (인식 필요 칸은 별도 목록이며 unresolved로 세지 않는다)
- 실제 화면 공유에서는 `completionReasons`가 빈 배열이고 긍정 완료 영수증이 발행됨
- 2분 자동 중지·커서 제외·다른 해상도에서도 동일하게 동작함

입력 프레임처리 완료, 카드 종류 일치, 구현 단계 완료, 한 사례의 397/397은 전체 목표 달성이 아니다.

## 현재 검증 범위 — 전체 미완료

| 입력/조건 | 현재 상태 |
|---|---|
| **video-7** | 구조 확정 기준 재실행: **cards 397 / names 397 / read 397 / reviews 0 / unidentified 0 / unresolved 0** (중복 진단 2). 오프라인 입력이라 `completed=false`, `completionReasons=['최종 스캔 검증 미완료']`. `work/video7-cdp-result.json` (350B). 2026-11-06 현재 headless 환경에서는 **396/397·3201013 `원화 복원 확인` 1건**이 재현되며, 완화 규칙 on/off A/B가 동일해 규칙 회귀는 아니다. |
| **video-6** | **2026-11-07 최종 재실행: cards 394 / names 394 / read 394 / reviews 0 / unidentified 0 / unresolved 0** (중복 진단 8). 최종 이름 중복 재판독으로 `칠흑의 숭배자 킬리네사`(3201027, 이미 수집) 관측 1건을 중복으로 분류했다. 오프라인 입력이라 `completed=false`. `work/video6-fastduplicate.json` |
| video-1 | **2026-11-08 live discard: cards 384 / names 384 / read 384 / reviews 0 / unresolved 0 / discarded 62.** 스캐너 finalization이 남은 미식별 62건을 `discardedObservations`로 이동했고 UI는 `인식이 필요한 화면`으로 표시한다. 입력 근거 손실은 별도 경고로 유지. `work/video1-live-discard2.json` |
| video-2 | **2026-11-08 live discard: cards 384 / names 384 / read 384 / reviews 0 / unresolved 0 / discarded 5(카드 뒷면·전환).** 자동 빈칸 판정은 안전하지 않아 값 추정 없이 인식 필요로 이동했다. `work/video2-live-discard.json` |
| video-3 | **2026-11-08 live targeted discard: cards 383 / 384 / names 383 / read 383 / reviews 0 / unresolved 0 / discarded 66 + 인식 필요 1칸(3200121 툴팁, pinned).** 원본 11.4초 1행 8열을 pinned recognition-needed로 live 상태에 주입했고, final duplicate classification이 383+1=384로 동작해 report와 live가 **66+1로 일치**한다. 값은 추정하지 않는다. `work/video3-live-target6.json`, `work/video3-all-discarded.json` |
| video-4 | **2026-11-07 최신 실행: cards 384 / names 384 / read 384 / reviews 0 / unidentified 0 / unresolved 0** (중복 진단 20). 이전 1건은 중복/전환 관측으로 해소됐다. `work/video4-latest.json` |
| video-5 | **2026-11-07 최종 실행: cards 385 / names 385 / read 385 / reviews 0 / unidentified 0 / unresolved 0** (중복 진단 14). **보관함 385종 전부 수집·판독 완료.** 남아 있던 4건(사이카 3·악몽의 게헤나 1)은 최종 이름 중복 재판독으로 중복 분류했다. `work/video5-fastduplicate.json` |
| screenshots-1 | **현재 엔진 실행: cards 384 / names 384 / read 383 / reviews 1(베스칼 장수, 관측 1회·`숫자 획 부족`·unconfirmed) / unidentified 0 / unresolved 0** — `work/screenshots1-cdp-result.json` (8798B) + 라벨 후보 크롭 40장 `work/label-candidates/d49e0e31/` |
| screenshots-2 | 게이트 수정 후 재실행: **cards 384 / names 384 / read 383 / reviews 1(베스칼 장수, 관측 1회·숫자 획 부족·unconfirmed) / unidentified 0 / unresolved 0** — `work/screenshots2-cdp-result.json` (59849B, sha256 `d149b77e87cff7d81f3565fcd75c4f66650fae1975ab442a5451a12212a44fe6`). 38종 라벨 대 `compare --values-only` → 114필드 중 베스칼 장수 1건만 불일치(라벨 0 vs 엔진 null, exit 2 — 단독 unclear 관측의 0 확정 거부, 설계상 동작, `work/compare-shots2-38cards.json` 22476B, 입력 봉투 `work/shots2-actual.json`). screenshots-1과 동일 패턴이라 단독 관측 unclear는 0으로 확정하지 않음 |
| beskal-count-visible 등 사진 | 단일 사진 실행: **cards 40 / names 40 / read 39 / reviews 1(베스칼 장수, 단독 unclear 관측·미확정 유지) / unidentified 0** — `work/beskal-count-visible-cdp-result.json` (14427B, sha256 `7de4c7021194c677534d9df383f6870ce926bf0301fd8b66726a734782c87c46`). `357종 부족`·expected 397은 1페이지만 담은 사진 입력의 모드 차이다. 사람 라벨 미등록이라 값 대조는 아직 없음 |
| 실제 Chrome/Edge 화면 공유 | 긍정 완료 영수증·CSV 활성화 미확인 |
| 2분 자동 중지 | 실제 공유에서 미확인 |
| 커서 제외 | 지원 브라우저에서 미확인 |
| 다른 해상도·UI 배율 | 고정 그리드 재보정·재검증 필요 |
| 카드 구조 마스크 | `docs/card-image-structure.md` 감사 완료. 이름 테두리 제외·하단 28px 후보는 미적용 상태로 되돌림 |

현재 `npm test` **3,800건 · 3,796 pass · 0 fail · 4 skipped**는 **엔진 회귀 증거**이며, 어떤 영상·사진의 완전 판독도 뜻하지 않는다. video-7·video-6 이전 수치는 구조 확정 전 결과라 인용하지 않는다.

## video-7에서 확인된 결과 (2026-11-05)

production `runScanner` video-7, headless Chrome CDP 실행:

| 항목 | 결과 |
|---|---:|
| 카드 종류 | **397/397** |
| 이름 | **397/397** |
| 각성·장수 완전 확인 | **397/397** |
| 리뷰 카드 | **0** |
| 미식별 입력 | **0** |
| 미해결 관측 | **0** |
| 중복 관측 진단 | 2 |
| 상태 | `입력 처리 완료 · 표시 수량 일치` |

오프라인 video 입력은 `liveScreen`이 아니므로 긍정 완료 영수증이 발행되지 않아 `completed=false`, `completionReasons=['최종 스캔 검증 미완료']`로 남는다. 이는 인식 미완료가 아니라 입력 모드 차이다. 실제 화면 공유에서는 헤더·최신 필드·입력 종료 조건을 만족하면 영수증이 발행된다.

증거:

- `work/video7-runtime-complete-397.json` · **2,011B** · sha256 `9e15f96b3fb77c401c79c6bdab32e0d875fd273128fc6bc4ea58c7a697494f9e`
- `work/video7-cdp-result.json` · 350B · sha256 `7c247fad85ad513566e150f3ff2ba022ed699112ab5484115c598f7634661fb7`

## 397/397을 막던 4종 — 해결 내용

| 카드 | 이전 | 해결 근거 |
|---|---|---|
| `3201009` 구스토 | `+1`이 보이지만 trailing-glyph veto | 강한 단일 숫자 후보(`candidate=1`, score .497, gap .130) + PP-OCRv6 두 엔진의 `+1` 일치(99.4%·99.1%)로 장수 1 확정 |
| `3201018` 도철을 다루는 웨이 | 최신 관측 `null` | 저장된 **여러 관측 preview**를 다시 읽어 `iconPresent:false`인 0장 증거를 찾아 확정 |
| `3201013` 라제니스를 이끄는 니나브 | 구조 복원 ID만 있고 장수 `null` | canonical-row 두 프레임(71·73) 캐시 + 저장 preview 재판독으로 0장 확정 |
| `3200813` 베스칼 | flat-cover veto | 7개 관측 + flat 아이콘 영역·텍스처 숫자 영역이 모두 빈 preview에서 `stablePreviewEmptyCandidate`로 0장 확정 |

공통 원칙:

- 저장 preview 재판독은 **새 관측을 추가하지 않는다**. 같은 캡처의 다른 원본을 다시 읽는 것이다.
- 0장은 `iconPresent:false` 또는 다중 관측 flat-icon empty 조건을 만족할 때만 인정한다.
- 텍스처가 있는 숫자 영역·긍정 아이콘·낮은 차순위 격차는 계속 0을 거부한다.

## 미식별 8→9건 정리

- 최종 미식별은 0이다.
- 남은 2건은 이미 수집된 카드 ID와 강한 matcher gates로 일치해 **중복 관측**으로 분류했다.
- 중복은 `unidentified` 배열에서 제거하고 `duplicateUnidentifiedObservations` 진단 수로 보존한다. 완료 계산에서는 `resolvedUnidentifiedObservations`만큼 ledger 하한에서 차감한다.
- 새 카드와 경쟁 ID·약한 gates는 중복으로 분류하지 않는다.

## 구현된 개선

1. **trailing glyph + OCR**: 강한 단일 숫자 후보와 두 OCR 판독이 일치하면 artwork 획을 이유로 한 veto를 해소한다. 낮은 gap/약한 후보는 계속 거부한다(`count-confidence.ts`, `count-corroboration.ts`, `recognizer.ts`).
2. **다중 preview 재판독**: 저장된 관측 preview를 stable 우선으로 최대 8개 재검사해 명시적 0장 증거를 찾는다. 카드 이미지도 확정 preview로 교체한다(`scanner.ts`).
3. **flat-icon zero**: 평평한 아이콘 영역 + 텍스처 숫자 영역에서 `stablePreviewEmptyCandidate`를 허용한다. 관측 1회부터 반영하고 이후 관측으로 갱신한다(`emptyCounterProof`, `count-pattern.ts`). 처음에는 다중 관측(3회 이상)을 요구했다.
4. **canonical-row 캐시**: 같은 group/slot의 이전 canonical gray를 보관해 두 번째 관측이 첫 관측과 독립 2프레임으로 일치할 수 있게 했다(`scanner.ts`).
5. **최종 구조 복원**: 2프레임 구조 복원 + preview 필드 판독이 모두 성공하면 누락 카드를 최종 목록에 추가한다. 필드를 읽지 못하면 추가하지 않는다.
6. **중복 관측 완료 계산**: 이미 수집된 카드와 강하게 일치하는 미식별은 `duplicateUnidentifiedObservations`로 보존하고, 해결된 수만큼 미해결 하한에서 차감한다.
7. **필드 전용 부족 문구**: `N종 부족`은 카드 종류·이름 누락에만 사용하고, 이름은 모두 확인됐지만 각성·장수가 남으면 `N종 각성·장수 확인 필요`로 표시한다(`negative-completion.ts`).
8. **고주파 cover veto**: achromatic 1px checkerboard/dither가 counter 영역을 덮고 median neighbor difference ≥38이면 0장 후보를 거부한다. 단일 프레임·다중 프레임 모두 적용하며, 기존 TODO 2건을 정식 회귀 테스트로 승격했다.

## 불변 조건

- `null`과 명시적 0을 구분한다. 가림·저대비·이동 프레임을 0으로 확정하지 않는다.
- 판독이 어려운 카드(툴팁·커서 가림, 이름 판독 불가·모호, 카드 뒷면)는 값을 추정하지 않고 `인식 필요`로 기록해 종료할 수 있다. 원인 불명이라도 값을 추정하지 않는다.
- 원화 단독 일치는 정답 라벨이 아니다. 이름·등급·원화·차순위 격차를 유지한다.
- 이름은 정확한 전체 이름으로만 확정한다. 부분 문자열 일치(예: 웨이 ⊂ 도철을 다루는 웨이)는 모호성 경쟁자로 취급하고 자동 병합하지 않는다. ID가 다르면 다른 카드다.
- 최신 기준은 처리 완료 시간이 아니라 캡처 시각이다.
- 같은 프레임의 여러 크롭을 독립 반복 관측으로 세지 않는다.
- 공개 fixture 통과를 100% 정확도나 모든 환경 보장으로 표현하지 않는다.
- 비공개 실데이터는 `fixtures/local/corpus/`와 `work/`에만 둔다.
- 커밋·푸시·배포는 별도 요청 시에만 수행한다.

## 검증

- video-7 구조 확정 기준 재실행: **cards 397 / names 397 / read 397 / reviews 0 / unidentified 0 / unresolved 0** (중복 진단 2, `completed=false`는 오프라인 입력 모드 차이다)
- video-6 구조 확정 기준 재실행: **cards 394 / names 394 / read 394 / reviews 0 / unidentified 0 / unresolved 0** (중복 진단 3, `completed=false`는 오프라인 입력 모드 차이다)
- `npm test` → **3,800 tests · 3,796 pass · 0 fail · 0 todo · 4 skipped** (2026-11-08 Step 6.3b finalization orchestrator 추출 후 재확인)
- `npm run lint` → 0
- `npm run build` → 0
- `PAGES_BASE_PATH=/loa-card/ npm run build` → 0, `dist/dev` 없음
- 구조 복원·백업·진행 체크포인트·필드 판독 회귀 테스트 통과
- 이름 테두리 제외·하단 28px 후보는 **코드에 미적용** 상태로 되돌렸고, 관련 14건 구조 테스트가 통과함

## 도메인 의미 확인 (사용자 확인 + 공식 가이드 대조)

- CSV `카드수`는 **등록 1장과 각성에 소모한 카드를 제외한 추가 장수**다.
- 각성 보석 5칸은 **금색 = 각성 수**, **회색 = 5 - 각성 수**다.
- 청록 카드 `+N`은 **카드수(추가 장수)**다.
- 위 의미는 사용자 확인을 받았다. 이후 장수·각성 판독은 이 의미를 기준으로 검증한다.

공식 가이드 대조 (`https://lostark.game.onstove.com/GameGuide/Pages/카드`, 2026-06-24 개정):

- 카드 등급 5개: 일반 < 고급 < 희귀 < 영웅 < 전설. 일반 카드에 5단계 각성 표시.
- 동일 카드 등록은 슬롯 1칸. 각성은 누적된 추가 보유 카드를 소모.
- 각성에 필요한 동일 카드 수 = 목표 단계 수 (1각 1장, 3각 3장). 1→5각 누적 15장 + 원본 1장 = 16장. 최대 초과분은 카드 경험치 포인트로 환산.
- `15 - a(a+1)/2` 공식과 일치 (0각 15, 1각 14, 2각 12, 3각 9, 4각 5, 5각 0).
- 카드 삭제 시 누적분 전체가 경험치로 환산되며 추가 보유분은 미각성 카드로 계산. 재등록은 처음부터 성장, 도감 달성 정보는 유지.
- 경험치 카드는 보관함에 저장되지 않고 성장 포인트로 누적, `[성장]` 탭에서 확인.
- 덱은 최대 6장, 동일 카드 중복 장착 불가.
- 최초 획득 카드는 소지품 우클릭으로 등록해야 보관함에 들어감.

## 남은 작업

0. **카드 이미지 구조 검증**: `docs/card-image-structure.md`의 이름·각성·장수 마스크와 count 의미를 사람 라벨로 확인한다. 이름 테두리 제외·하단 28px 후보는 미적용 유지. 사용자 지적 3건(이름 하강·숫자 축소·보석 우상향)을 84장(필드 4+shots1 40+shots2 40)으로 검증함(`work/mask-candidate-measure.json`): 이름 2px 하강은 최소 마스크 106→154px로 안전 확인(35px 미만 0, 적용은 빈-이름 음성 표본 확보 전까지 보류), 글리프 축소는 19장이 경계 1px内 접촉·최소x=박스경계로 기각(바깥 2px는 dx/dy 탐색 여유), 보석 이동은 판독 무관(하단 박스는 식별키용)으로 불필요. 새 임계값·휴리스틱을 추가하지 않는다.
1. **사람 라벨**: video-7 4종 + screenshots-1 40종 + video-1 4종 + video-3 8종 + screenshots-2 38종 등록됨 — 모두 `import`/`verify` exit 0. sha256 `56c2b47d61ba417fe8f87ad3050cd4dfe50339ae9cf088b8ec5070a15d4c26a8` (구스토 0각+1, 웨이·니나브·베스칼 0각0장; 사용자 위임으로 에이전트 4판정+픽셀 실측 기준 확정, `work/human-label-4cards.json`, screenshots-1 40종 라벨 sha256 `9cbb5c0cedbeb682d84c9dbad526f67c30b79126c243733a1075784ebfdd19ce` (`work/human-label-40cards.json`). `verify` 통과. 값 대조 루프 닫힘: `compare --values-only` 대 video-7 전체 카드 리포트 — **12필드 전부 일치**, verdict `latest-evidence-unsupported`, exit 3 (신선한 근거 주장 아님, `work/compare-human-4cards.json` 6022B). screenshots-2 38종 라벨 sha `7fcaa025e1adaf26cccb5391d5bbecd31b60cf3f4ff0f3edd8b9a49773c24198` (`work/human-label-shots2-38cards.json`). 구 버전(d35cd4, 카스피엘 4각 오기)은 quarantine 처리함. 30~50장 목표는 **96장**으로 충족(4+40+14+38). video-3 리뷰 2종 라벨 sha `6157a9e0f6aabb6020eb79c5fdfed44474d6efd01a5a1514b69113e009571a3e` — `import`/`verify-human` exit 0, 규칙값 2/2 일치(`work/human-label-video3-review2.json`). video-1 4종 라벨 sha `61d1e5ef55d70f5e4e8f1079f12c74b8ee111450af8adf72a3145b4b89c0fa16`, video-3 8종 라벨 sha `66b36cbda079e80d3951ecb6fb580f8c98fc2f302856094e8e0876699cf966b5` — 등록·검증 exit 0, 각 `compare --values-only` 전수 일치(12필드·24필드, exit 3). 불확실·카탈로그-부재 크롭(아네벨 7관측 포함)은 제외. screenshots-1 전체 리포트 대 `compare --values-only` → 120필드 중 **119 일치**, 불일치 1건은 베스칼(라벨 0장 vs 엔진 `null`, exit 2 — 단독 unclear 관측의 0 확정 거부, 설계상 동작, `work/compare-human-40cards.json`).
   - video-3 1종 부족: **3200121 하이비 집행관은 툴팁 가림으로 제외(2026-11-08 사용자 정정).** 2각/+12 동일-상태 추론은 철회했다. 결과는 cards 383/384·names 383·read 383·reviews 0·unidentified 65·인식 필요 1칸(1행 8열)이다. 값은 추정하지 않는다(`work/video3-tooltip-excluded.json`).
2. **사진 입력**: screenshots-1·2 완료. 개별 사진 beskal-count-visible-20261105 실행 완료(40/40/39+베스칼 리뷰 1, 미식별 0, 라벨 미등록). 나머지 개별 사진은 미확인.
3. **video-1~7**: 구조 확정 기준 재실행 완료. 미해결 원인별 재귀 개선안:
   - video-3 리뷰 2종(+12 2종): **해결됨.** 사용자 라벨 12/12를 `work/human-label-video3-review2.json`(sha `6157a9e0f6aabb6020eb79c5fdfed44474d6efd01a5a1514b69113e009571a3e`)로 등록하고, "확정 쌍 존재 + 이후 관측이 값을 바꾸지 않음 + 최신 캡처가 같은 추가 장수를 읽음" 규칙을 구현했다. 규칙값은 **2/2 = 라벨**. video-3 재실행 결과 **카드 383·판독 383·이름 383·리뷰 0·미식별 104**이며, 직전 실행과 전체 카드 값을 비교하면 바뀐 것은 두 카드의 리뷰 제거뿐이다. video-7은 현재 환경에서 396/397·3201013 `원화 복원 확인` 1건이 남지만, 같은 실행에서 규칙을 끈 A/B도 동일해 규칙 회귀가 아니다(`docs/field-proof-gaps.md`).
   - video-1 미식별 97~98 원문 분류(최신 실행 98, 그중 14건은 최종 이름 중복으로 분류): **판독 없음 45(46%)·부분문자열 모호 26(27%)·1자 16·2자 4·3자 이상 5·정확 일치 비모호 1**(신뢰도 47.4%로 하한 50 미달). video-3과 달리 이미지 품질과 이름 모호성이 대부분이고, 1~2자 클러스터 20건은 전처리 실험에서 최대 3건만 회복(모두 중복 카드)이었다. 규칙 변경으로 줄일 규모가 아니며 새 스캔 입력 없이는 개선 여지가 작다(`docs/field-proof-gaps.md`).
   - video-3 1~2자 오차 42건: **lossless 입력으로 재검증 완료**. 원인은 진단 sidecar 한도(`recognitionEntries:32`·1MB)로 105건 중 13건만 보존된 것이었고, dev 전용 `unknownEvidenceImages` 옵션으로 105/105 보존 후 재실험했다. 전처리 5종 결과 완전 일치가 원본 0/42 → 언샤프·스트레치+언샤프 2/42로 **2건만 개선**. 42건 중 2건은 임계값 변경 근거로 부족해 **전처리 채택 보류**, dev 보존 기능만 유지한다(`docs/field-proof-gaps.md`).
   - video-1 1~2자 오차 20건 재OCR 실험 + 교차 확인: `unknownEvidenceImages`로 미식별 97건 lossless를 97/97 보존. 전처리 5종 중 2배 업다운이 3/20 완전 일치(원본 0/20)로 최선이나 1건 악화. video-3(2/42)과 합쳐 신규 완전 일치 **6개 관측**이며, 수집 목록 대조 결과 **6건 전부 이미 수집된 카드**를 가리켰다(그룹당 1관측이라 교차 확증 없음). 수집 카드가 늘지 않아 오독 위험 대비 이득이 작으므로 **전처리 채택하지 않음**(`docs/field-proof-gaps.md`).
   - video-1 입력 근거 손실: 새 스캔이 필요한 입력 자체 문제. 코드로 해소 불가.
   - video-5 1종 부족: **완전 해소(2026-11-07).** cards 385 / names 385 / read 385 / reviews 0 / unidentified 0 / unresolved 0 (중복 14). 4건은 최종 이름 중복 재판독으로 분류했고, 카드 추가·값 변경은 하지 않았다(`docs/field-proof-gaps.md`, `work/video5-finalduplicate.json`).
   - video-4 미식별 1·video-2 미식별 5(전부 중복 진단): 중복 분류는 표시용이며 카드 확정 근거로 쓰지 않는다.
4. **실제 화면 공유**: Chrome/Edge에서 긍정 완료 영수증·CSV 활성화·2분 자동 중지를 확인한다.
5. **커서**: `cursor:'never'` 지원 브라우저에서 실제 설정을 확인한다.
6. **다른 해상도**: 고정 격자 좌표를 재보정하고 video-7급 전체 판독을 재검증한다. 2560×1440 절단 검증됨(2026-11-05, 코드 미변경): 열 전수 오차 1px 이내, 행 635·878 정확·392·1121은 테두리 광택 2px 다듬기. 오버레이 `work/grid-overlay/` 4장으로 육안 확인. 마스크 경계 접촉은 글자 내용 탓이다.
7. **별도 트랙 — `.upk` 언패커**: `EFUI_CARDGAMESEASON2.upk`는 UE3 태그·버전 868이지만 본문이 압축/암호화(엔트로피 7.4~8.0, 평문 이름 0건)라 현재 도구로 못 연다. 인식 목표와 분리한다. 착수 조건은 다른 해상도·UI 배율 지원으로 UI 배치 상수가 필요해질 때, 또는 `.upk` 전용 UI 상태 좌표가 필요해질 때다 (`docs/client-card-rendering.md`). 카드 신원·원화 UV·아틀라스·폰트는 이미 클라이언트에서 확보했고 UI 크롬 좌표는 픽셀 검증으로 대체 중이라 현재 차단 요인이 아니다.

8. **클라이언트 데이터 파이프라인**: `scripts/build-client-data.py`가 `SeasonCard.db` + `IconInfo.loa` + 아틀라스로 카드 신원·원화 좌표·특징을 결정적으로 생성한다. 카탈로그 **420/420종**에 클라이언트 권위 좌표 확보(내부 ID 3종은 `clientId` 조인), 재생성 특징 420종, 배포본 비교 388종 중 **384 완전 일치**, 나머지 4종은 1픽셀 1레벨 차이. 두 번 실행 결과 해시 동일. `docs/data-maintenance.md`, `docs/client-card-rendering.md`.

9. **표시 전용 카드 승격**: 후보 6종을 video-7·2·4·6 반복 관측으로 검증. 자기 상관은 0.906~0.985로 안정적이나 경쟁 카드 마진이 +0.013~+0.073으로 원화 검증기 요구치(0.12 이상) 미달. 경쟁 카드가 특정되어(예: 3201034 vs 3200610) 원화만으로 구분 불가 → **승격하지 않음**(`docs/field-proof-gaps.md`).

10. **가림·판독 불가 카드 인식 필요 표시**: live 스캐너 finalization이 남은 미식별을 `discardedObservations`로 이동하고, UI는 `인식이 필요한 화면` 그룹으로 썸네일·사유를 표시한다. `discardedObservations`는 백업에도 유지한다. video-1 62·video-2 5·video-3 66이 이 경로로 unresolved 0이 됐고, video-3는 3200121 툴팁 슬롯을 pinned recognition-needed로 주입해 report와 live가 66+1로 일치한다. `discarded-observations.ts`, `recognition-needed.ts`, `ScanAttention.tsx`, `scan-backup.ts`.

11. **새 카드·해상도 일반화**: 테스트 영상과 무관한 클라이언트 합성 카드 템플릿 420장으로 이름 판독을 측정했다. 숫자 ID 417장 중 **415장 정확**, 장문 골드 이름 2장(3201017·3202044)은 이름 OCR 실패, 28장은 부분 문자열 모호, 3장은 display-only pseudo ID로 템플릿이 없다. 실패 2장도 원화 자기상관 .987/.989로 원화 경로 보완이 가능하다. 이는 이름 파이프라인이 테스트 영상에만 과적합된 것은 아님을 보여주지만, **2560×1440 외 해상도·UI 배율·새 패치 카탈로그 갱신은 미검증**이다. `dev/name-generalization.ts`, `work/name-generalization.json`.

## 구조·평가 기반 (2026-11-08)

- **Step 1~4 완료**: 테스트 기준선, 필드별 평가 계약, 구조 정책·검사기, domain/data 분리.
- `npm run lint`에 `check:architecture`가 포함된다. 현재 **레이어 위반 0 · 런타임 순환 0 · 기능 간 직접 의존 0 · 타입 전용 경고 5**.
- 평가 계약은 `docs/evaluation.md`, 검사기는 `scripts/check-architecture.mjs`, 정책은 `scripts/architecture-policy.json`.
- Step 4에서 `inventory-csv`·`inventory-unowned`·성장·레이드 순수 계산을 `src/domain/`으로, 카드·도감·레이드 카탈로그 로딩과 스캐너 메인 판독기 자산 로딩을 `src/data/catalog.ts`로 옮겼다. 기존 경로는 re-export로 유지한다.
- 기존 라벨 기준선:
  - screenshots-1·2: 이름·각성·장수 **40/40·38/38**, `readableButMissed 0`, `review 0`, `falseConfirm 0` (베스칼 0장 해소).
  - video-1·video-7·video-3(8종): 부분 라벨 전부 일치, `falseConfirm 0`.
- Step 5.1 완료: `layout-geometry.ts`로 런타임 기하 정규화를 분리하고 720p·1080p·1440p·4K·관측 격자 홀드아웃을 고정했다. video-1 재실행은 **384/384/384, 카드별 값 차이 0, 4장 라벨 pass**였다. 실제 다른 해상도 캡처는 아직 없다(`docs/geometry-holdout.md`).
- Step 5.2 완료: `identity-fusion.ts`로 이름+원화 융합을 분리하고 `recognizer.identify`에 연결했다. 420장 합성 홀드아웃은 **414/417 정확 · 340 원화 확정 · 3 모호 이름 미확정 · 오확정 0**이며, 장문 2장(`3201017`, `3202044`)은 원화로 회복했다. video-1은 384/384/384·카드 값 차이 0으로 유지됐다(`docs/identity-fusion.md`).
- Step 5.3 완료: `singleStillFrameEmptyCandidate`로 정지 이미지 1장의 명시적 빈 장수 증거를 허용하고 `scanner.ts` finalization에 연결했다. screenshots-1은 장수 **39/40 → 40/40**, screenshots-2는 **37/38 → 38/38**로 통과했고, `readableButMissed 0 · review 0 · falseConfirm 0`이다(`docs/field-evidence.md`).
- Step 6.1 완료: `session-finalization.ts`와 `session-duplicate.ts`를 `scanner.ts`에서 분리했다. video-1은 **384/384/384·status 동일·discarded 67·카드 값 차이 0**으로 유지됐다(`docs/session-decomposition.md`).
- Step 6.2 완료: `session-diagnostics.ts`로 최종 카드·미식별·discard·recognition-needed 요약을 분리하고 `createScanDiagnosticSummary`에 연결했다. video-1 결과는 다시 384/384/384·status 동일·discarded 67·카드 값 차이 0이다.
- Step 6.3a 완료: `session-finalize.ts`로 discard·counter·status 변경을 분리했다. video-1은 다시 384/384/384·status 동일·discarded 67·카드 값 차이 0이다(`docs/session-decomposition.md`).
- Step 6.3b 완료: `session-orchestrator.ts`로 finalization 순서를 분리했다. discard → counters → receipt/grid → final status → emit, 실패 시 status·emit 중단. video-1은 384/384/384·status 동일·discarded 67·카드 값 차이 0이다.
- Step 7.1 완료: UI 7개 컴포넌트를 `src/features/card-scanner/ui/`로 이동하고 기존 경로를 named re-export로 유지했다. video-1은 384/384/384·status 동일·discarded 67·카드 값 차이 0, screenshots-1·2는 40/40·38/38·missed 0·review 0이다(`docs/physical-split.md`).
- Step 7.2 완료: capture 6개 파일(`input-source`, `live-frame-clock`, `track-frame-source`, `freeze-live-frame`, `share-stream-owner`, `live-capture-pipeline`)을 `capture/`로 이동했다. 결과는 video-1 384/384/384·카드 값 차이 0, screenshots-1·2 40/40·38/38로 유지됐다.
- Step 7.3 완료: acquisition 6개 파일(`detector`, `card-borders`, `border-integrity`, `card-acquisition`, `capture-quality`, `candidate-queue`)을 `acquisition/`로 이동했다. 결과는 video-1 384/384/384·카드 값 차이 0, screenshots-1·2 40/40·38/38로 유지됐다.
- Step 7.4 완료: recognition 42개 파일(`name-*`, `neural-*`, `portrait-*`, `artwork-verifier`, `count-*`, `star-pattern`, `visual-*`, `ctc-*`, `ocr-*`, `consensus*`, `identity-fusion` 등)을 `recognition/`로 이동했다. Worker URL·JSON 경로를 유지했고, loader hook 테스트의 moduleUrl을 실제 구현 경로로 수정했다. 결과는 video-1 384/384/384·status 동일·discarded 67·카드 값 차이 0, screenshots-1·2 40/40·38/38·missed 0·review 0으로 유지됐다.
- Step 7.5 완료: session 11개 파일(`session-finalization`, `session-finalize`, `session-orchestrator`, `session-duplicate`, `session-diagnostics`, `scan-ledger`, `final-duplicate`, `discarded-observations`, `completion`, `negative-completion`, `positive-completion`)을 `session/`으로 이동했다. 결과는 video-1 384/384/384·status 동일·discarded 67·카드 값 차이 0, screenshots-1·2 40/40·38/38·missed 0·review 0으로 유지됐다.
- Step 7.6 완료: persistence 6개 파일(`scan-backup`, `progress-backup`, `partial-store`, `recording-journal`, `recording-spool`, `archive-journal-mirror`)과 reproduction 16개 파일(`scan-reproduction`, `reproduction-session-store`, `reproduction-coverage`, `reproduction-input`, `exact-recording*`, `canonical-frame-*`, `canonical-raster-replay`, `canonical-source-use`, `canonical-storage-attestation`, `debug-capture`, `debug-bundle`)을 각각 `persistence/`·`reproduction/`으로 이동했다. Worker URL과 dev 재현 로더를 유지·수정했고, 결과는 video-1 384/384/384·status 동일·discarded 67·카드 값 차이 0, screenshots-1·2 40/40·38/38·missed 0·review 0으로 유지됐다.
- Step 7.7 완료: session evidence 5개 파일(`inventory-evidence`, `unknown-lifecycle`, `freshness-evidence`, `observation-history`, `scan-grid`)을 `session/`으로 이동했다. `scripts/analyze-observation-timing.mjs`·`scripts/scan-human-expected.mjs`의 `.ts` import를 실제 구현 경로로 수정했다. 결과는 video-1 384/384/384·status 동일·discarded 67·카드 값 차이 0, screenshots-1·2 40/40·38/38·missed 0·review 0으로 유지됐다.
- Step 7.8 완료: acquisition clients 13개 파일(`acquisition-client`, `acquisition-worker`, `saved-acquisition`, `source-preparation*`, `prepared-*`)을 `acquisition/`으로 이동했다. Worker URL과 테스트·dev entry 경로를 수정했고, 결과는 video-1 384/384/384·status 동일·discarded 67·카드 값 차이 0, screenshots-1·2 40/40·38/38·missed 0·review 0으로 유지됐다.
- Step 7.9 완료: acquisition 잔여 7개 파일(`acquisition-raster`, `acquisition-profile`, `decoded-rgba-client`, `decoded-rgba-worker`, `input-acquisition-evidence`, `latest-acquisition-gate`, `experimental-acquisition-receipts`)을 `acquisition/`으로 이동했다. Worker URL과 `acquisition-raster` 직접 참조를 정리했고, 결과는 video-1 384/384/384·status 동일·discarded 67·카드 값 차이 0, screenshots-1·2 40/40·38/38·missed 0·review 0으로 유지됐다.
- Step 7.10 완료: `canonical-capture`·replay 잔여·`recognizer`·`card-dictionary`·`scan-monitor-store` 등 28개 파일을 reproduction(10)·acquisition(2)·recognition(4)·ui(12)로 이동했다. Worker URL·loader hook·스크립트 `.ts` import를 수정했고, 결과는 video-1 384/384/384·status 동일·discarded 67·카드 값 차이 0, screenshots-1·2 40/40·38/38·missed 0·review 0으로 유지됐다.
- Step 7.11 완료: `scanner.ts`·`scanner-preparation`·`current-scan-fields`·`observation-execution`·`observation-work`·`scan-monitor-outcome`·`scan-grid-command`를 `session/`으로 이동했다. loader hook 테스트 3개와 스크립트 import를 수정했고, 결과는 video-1 384/384/384·status 동일·discarded 67·카드 값 차이 0, screenshots-1·2 40/40·38/38·missed 0·review 0으로 유지됐다.
- Step 7.12 완료: root의 76개 구현 파일을 `session/`(52개: completion·unknown·retry·freshness·live 보조)과 `reproduction/`(24개: recording·native·archive·dev 기록)으로 이동했다. Worker URL·테스트·dev 경로를 수정했고, 결과는 video-1 384/384/384·status 동일·discarded 67·카드 값 차이 0, screenshots-1·2 40/40·38/38·missed 0·review 0으로 유지됐다.
- Step 7.13 완료: root의 93개 구현 파일을 capture(25)·acquisition(27)·recognition(5)·session(17)·ui(19)로 이동했다. **root 실제 구현은 `public.ts` 1개만 남았고, 나머지는 호환 re-export**다. 결과는 video-1 384/384/384·status 동일·discarded 67·카드 값 차이 0, screenshots-1·2 40/40·38/38·missed 0·review 0으로 유지됐다.
- Step 7.14 완료: 호환 re-export shim 323개를 삭제하고 import 1,521개를 실제 구현 경로로 전환했다. dangling import 633개를 복구하고 `scanner.ts`를 `orchestration/`으로 분리했다. **`scanner:other` 0, root 구현은 `public.ts`만** 남았다. 결과는 video-1 384/384/384·status 동일·discarded 67·카드 값 차이 0, screenshots-1·2 40/40·38/38·missed 0·review 0으로 유지됐다.
- Step 8.1 완료: `App.tsx`에서 `AppShell`·`InventoryWorkspace`·`useInventoryView`·`ScannerSummary`를 분리했다. App.tsx는 74,923B → 66,469B.
- Step 8.2 완료: `ScannerWorkspace`·`DevPreviewLatency`를 추가 분리해 App.tsx를 **57,791B**로 줄였다. `ScannerWorkspace`는 공유·CSV·준비·진행·미리보기 UI를 props로만 렌더한다. 결과는 video-1 384/384/384·status 동일·discarded 67·카드 값 차이 0, screenshots-1·2 40/40·38/38·missed 0·review 0으로 유지됐다(`docs/app-decomposition.md`).
- Step 8.3 완료: `use-scanner-session.ts`로 `useScanMonitorSession`(모니터 스토어·개발 probe)과 `useScannerClock`(2분 입력 시계·시간 초과·deadline)을 분리했다. App.tsx는 **56,004B**다.
- Step 8.4 완료: `useScannerPreparation`으로 엔진 준비 슬롯·메시지·정리 불확실·정산 추적을 분리했다. App.tsx는 **52,604B**다. 공유 시작·중지·`start`/정산은 아직 App에 남아 있다. 결과는 video-1·screenshots-1·2에서 동일하다(`docs/app-decomposition.md`).
- Step 8.6 완료: `openWindowShare`/`closeWindowShare`로 공유 선택·재생·epoch fencing·중지 전이를 `share-commands.ts`에, `runScanLifecycle`로 스캔 실행·결과 발행·완료 판정·진행 백업·진단 기록 정산을 `scan-lifecycle.ts`에 분리했다. App.tsx는 **40,824B**다(초기 74,923B 대비 46% 감소). 결과는 video-1 384/384/384·status 동일·discarded 67·카드 값 차이 0, screenshots-1·2 40/40·38/38·missed 0·review 0으로 유지됐다(`docs/app-decomposition.md`).
- Step 8.7 완료: 타입 전용 순환 5개를 제거했다. `recognizer-types.ts`(ScannedCard·CountDiagnostics·NameEvidence), `reference-types.ts`(Reference), `exact-recording-types.ts`(ExactEntry·ExactFrame·ExactEvent)를 분리하고 `FeedbackGridCell`을 receipts로 이동했다. 완료·모니터·watchdog는 `ScannerState` 대신 구조적 타입을 사용한다. `check:architecture`는 **위반 0·경고 0**이다. 결과는 video-1 384/384/384·status 동일·discarded 67·카드 값 차이 0, screenshots-1·2 40/40·38/38·missed 0·review 0으로 유지됐다.
- Step 8.8 완료: 모호한 합성 카드 3장을 현재 인식 경로로 재분석했다. `3200119` 세티노는 이름 `세티도`(81.0%)와 원화 lower .8649/correlation .9231, `3200703` 자크라는 정확한 이름이지만 원화 margin .1599, `3200803` 베히모스는 정확한 이름이지만 원화 lower .8189/correlation .9091로 독립 게이트를 통과하지 못했다. 세 장 모두 `인식 필요` 유지, 임계값 변경 없음. 회귀 테스트와 분석 산출물을 추가했다(`docs/identity-fusion.md`, `work/identity-ambiguous-analysis.json`).
- Step 8.9 완료: 실제 398장 공유에서 1분 39초에 확인 133/398·대기 729·판독 중 2건을 확인했다. fast 레인 2개만 메인 큐를 처리하고 OCR 레인 2개가 유휴였던 병목을 수정해, 재시도가 없고 큐가 `readers × 16` 이상일 때 OCR 레인이 fast 큐를 돕도록 했다. 재시도 우선순위와 임계값은 유지했다. video-1 384/384/384·status 동일·discarded 67·카드 값 차이 0, screenshots-1·2 40/40·38/38·missed 0·review 0 유지. 실제 공유 30초 목표 재측정은 아직이다.
- Step 8.10 완료: 큐 보조 레인이 lane 0의 visual Worker를 공유해 `동시 시각 판독 요청`으로 중간 중단되던 회귀를 수정했다. OCR 보조 레인은 `visual=null`로 reader 내부 경로를 사용한다. visual-client·스캐너 준비·스케줄 테스트 40건 통과, video-1 384/384/384·status 동일·discarded 67·카드 값 차이 0, screenshots-1·2 40/40·38/38·missed 0·review 0 유지. 전체 3,809/3,805 pass, 구조 위반 0·경고 0.
- Step 8.11 완료: 2분 하드 타임아웃을 **30초 무진행 + 5분 하드 캡**으로 바꿨다. 입력·판독·이름 수가 갱신되면 무진행 타이머가 재시작된다. `tests/scan-deadline.test.ts` 4건 통과, 전체 3,809/3,805 pass, lint/build/architecture 0.
- Step 8.12 완료: 실제 웹에서 30초 무진행 타이머가 recovery 중 `currentRunRead` 변화만 기다려 1분 7초에 스캔을 중지시키는 문제를 확인했다. `noteScanProgress`가 `recoveryFrames`·`percent`·`workPhase` 변화와 `queued`/`activeReadings`도 진행으로 계산하도록 했고, `useScannerClock`은 ref로 최신 진행 시각을 읽는다. 하드코딩된 2분 안내 문구도 일반 진행 중지 문구로 수정했다. 전체 3,809/3,805 pass, lint/build/architecture 0.
- Step 8.13 완료: 실시간 진행 UI의 반짝임을 수정했다. `최신/마지막 확인` 기준을 매 프레임 `gridReady`가 아니라 `located`로 바꾸고, `begin()`·`record()` 사이에 사라지는 최근 프레임은 표시 컴포넌트가 마지막 커밋 프레임을 유지한다. 부분 스캔에서 `보유 여부를 확인할 카드` 후보를 전부 나열하던 문제도 완료 목록에서만 표시하도록 수정했다. 전체 3,809/3,805 pass, grid 테스트 61/61, lint/build/architecture 0.
- Step 8.14 완료: 실제 스캔이 268/398에서 멈춘 원인을 앱의 조기 중지로 좁혔다. 30초 무진행 타이머를 **2분 무진행 + 5분 하드 캡**으로 늘리고, 다른 창을 보는 동안 숨김 시간을 두 타이머에서 제외했다. watchdog은 큐·활성 판독이 비어 있는 공유 대기를 `capture`뿐 아니라 `reading`에서도 기다림으로 계산한다. 30초/15초에 사용자의 수동 스캔을 끊던 동작은 배포본에 없던 회귀다. `scan-deadline`·`scan-watchdog` 회귀 테스트를 갱신·추가했고 전체 3,810/3,806 pass, lint/build/architecture 0.
- Step 8.15 완료: UI 상태 우선순위를 바로잡았다. 화면 공유 버튼과 기본 상태 문구가 같은 준비 상태(목록·카드 사전·인식 엔진·진단 기록·CSV·재현)를 사용하도록 통일했고, 준비 중에는 “화면을 공유해 시작하세요” 대신 실제 이유를 표시한다. 스캔 종료 뒤 “스캔 준비 완료”가 “스캔 중지됨”과 함께 남지 않게 했고, 오류 설명·공유 종료 후 입력 타이머 숨김·진행 창 버튼 비활성화도 정리했다. 진행 수 라벨은 `판독 완료/마지막 판독`으로 명확히 했고, 메인 진행 수와 진행 창이 같은 live store를 읽도록 통일했다. 전체 3,810/3,806 pass, lint/build/architecture 0.
- Step 8.16 완료: 실시간 진행창의 준비·수집·확인 필요 표시를 분리했다. 엔진 준비 중에는 “남은 카드를 읽고 있어요”와 빈 판독 대기/최근 화면/지도 대신 “준비 중 · 인식 엔진을 준비하고 있어요”만 표시한다. 진행 중에는 메인 진행 카드와 진행창 모두 `미수집`(보관함 수량 - 수집 이름)과 `확인 필요`(review 카드)를 따로 보여 주어 기존의 “27종 부족”처럼 미수집과 확인 필요를 합치던 표시를 없앴다. 표시용 스냅샷은 카드 배열을 보관하지 않고 집계값만 유지한다. 전체 3,812/3,808 pass, lint/build/architecture 0.
- Step 8.17 완료: 새 스캔 시작과 공유 종료 때 화면이 비거나 사라지지 않도록 상태 수명을 고쳤다. `runScanLifecycle`이 시작 시 `setState(null)`로 목록을 비우지 않고, 스캔이 최종 상태 없이 끝나면 이전 목록을 복원한다. 완료 후에는 `현재 목록 · 판독 완료 / 미수집 / 확인 필요` 요약을 계속 표시해 진행 중·완료·재입력 필요를 구분한다. `scan-monitor-store`는 `begin()`이 40칸과 최근 프레임을 비우는 순간 마지막 커밋 셀/프레임을 유지해 지도가 매 프레임 깜빡이지 않게 한다. 전체 3,814/3,810 pass, lint/build/architecture 0.
- Step 8.18 완료: 동영상 스트림을 메인 앱에 주입해 중간 상태를 직접 샘플링했다. 판독 수·카드 목록·미수집·확인 필요 수는 갱신됐지만, 현재 행 위치가 프레임 경계마다 사라져 지도가 `행 위치 확인 중`으로 돌아가는 문제를 확인했다. 메인 진행 영역에 `현재 화면 약 N–M행 보는 중`을 추가하고, 표시 저장소가 마지막으로 확인한 `liveTop`을 새 위치가 올 때까지 유지하도록 했다. `capturedTop`이 없는 프레임을 현재 위치로 승격하는 추정은 금지한 기존 안전 규칙을 유지했다. 카드 목록이 0에 머물던 원인도 확인했다: `startTransition` 목록 갱신이 33ms 진행창 갱신에 굶어 14초 뒤에야 첫 카드가 보였다. 목록 갱신을 일반 우선순위로 바꾸고, `마지막 촬영 화면`과 전체 `판독 완료`를 별개로 표시했다. 전체 3,815/3,811 pass, lint/build/architecture 0.
- Step 8.19 완료: 동영상 중간 상태를 메인 앱에서 다시 확인했다. 13.6초에 `내 카드 101`, `판독 완료 102 / 384`, `현재 화면 약 13–16행`, `확인 필요 1종`이 같이 표시됐고, 종료 시 `내 카드 384`, `판독 완료 383 / 384`, `현재 화면 약 39–42행`, `확인 필요 1장: 베스칼`이 남았다. 공유 종료 후에도 카드 목록 384장과 `현재 목록 · 판독 완료 / 수집 이름 / 이름 미확인` 요약이 유지됐다. `판독 완료 384/384`와 `미수집 1`이 모순처럼 보이던 표시는 `수집 이름 383/384 · 이름 미확인 1`로 분리했다. 전체 3,815/3,811 pass, lint/build/architecture 0.
- Step 8.20 완료: 스캔 중단 화면에서 376/398을 인식했는데도 지도가 전부 빈칸으로 보이던 문제를 고쳤다. 행 위치 근거가 없으면 빈 55행 지도 대신 `인식한 카드 376종`과 최근 이름 12개, `메인 카드 목록에 남아 있음` 안내를 표시한다. 위치 근거가 있는 경우에만 지도를 유지한다. 앱을 닫을 때의 저장도 보강했다: `pagehide`/`visibilitychange`에서 진행 중이면 진행 기록, 완료면 백업을 저장하고, 완료 백업이 성공한 뒤에만 진행 기록을 지운다. 완료 상태의 진행 기록은 재개 시 완료로 복원한다. 전체 3,815/3,811 pass, lint/build/architecture 0.
- Step 8.21 완료: 실시간 UI 반응성의 주원인을 줄였다. `ScannerWorkspace`가 33ms 진행 저장소 전체를 구독해 스캔 패널 전체를 다시 렌더링하던 구조를 `located`와 행 위치만 구독하는 작은 선택자로 분리했고, 앱의 진행 저장소 알림은 100ms로 합쳤다. 무거운 55행 지도는 기본으로 현재 위치 주변 8행만 표시하고 `전체 지도` 버튼으로 확장하며, 행이 바뀔 때만 렌더링한다. 최근 프레임을 위한 추가 state/effect도 제거하고 store의 마지막 커밋 프레임을 직접 사용한다. 전체 3,815/3,811 pass, lint/build/architecture 0. OCR·검출 자체의 CPU 사용은 별도 측정이 필요하다.
- Step 8.22 완료: 배포본 v0.2.0과의 인식/완료 차이를 좁혔다. 로컬은 `currentCountReliability`로 stable-frame/repeated-pattern 장수 근거를 버리고, 398/398·이름/필드 완료 뒤에도 장착·툴팁 추가 관측 7건을 `미식별`로 남겨 완료를 막았다. 배포본처럼 일반 `countReliability`를 사용하고, 보관함 수량·고유 카드·이름·필드가 모두 확인된 경우 남은 화면 관측을 중복/추가 관측으로 분류해 완료를 막지 않게 했다. 관측은 `duplicateUnidentifiedObservations` 진단으로 보존한다. 전체 3,815/3,811 pass, lint/build/architecture 0. 실제 사용자 화면 공유에서 398/398 complete와 3장 장수 확정은 재확인이 필요하다.
- 다음: 앱 새로고침 후 깨끗한 새 스캔에서 자동 완료·CSV·커서·다른 해상도를 확인한다.
- 이 기준선은 코퍼스 전체 재실행 결과가 아니며, 인식 정확도 100%를 뜻하지 않는다.

## 재현

```sh
npm run dev
# headless Chrome + CDP
node work/cdp-run-video7.mjs
```
