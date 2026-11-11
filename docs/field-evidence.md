# 장수 필드 증거 — 베스칼 0장

- 작성일: 2026-11-08
- 단계: Step 5.3
- 코드: `count-pattern.ts`, `scanner.ts` finalization
- 테스트: `tests/count-pattern-runtime.test.ts`
- 입력: `screenshots-1`(d49e0e31…), `screenshots-2`(4f7e1dab…)

## 1. 재현

기존 `screenshots-1·2` 결과에서 베스칼(`3200813`)은 다음 상태였다.

```json
{
  "id": "3200813",
  "name": "베스칼",
  "awakening": 0,
  "extraCopies": null,
  "review": ["장수 확인", "최신 각성·장수 확인"],
  "countReliable": false,
  "observations": 1,
  "countDiagnostics": {
    "maximum": 15,
    "reason": "숫자 획 부족",
    "readings": [],
    "pattern": {"value": null, "candidate": null, "score": 0, "gap": 0, "reason": "장수 숫자 미검출 또는 불명확"},
    "reliability": "unconfirmed"
  }
}
```

사람 라벨은 **0장**이다. 기존 finalization은 `card.observations >= 3`일 때만 `stablePreviewEmptyCandidate`를 사용했으므로, 관측 1회인 스크린샷은 `null`로 남았다.

## 2. 크롭 증거

`work/label-candidates/d49e0e31/3200813.jpg`, `4f7e1dab/3200813.jpg`를 140×210으로 정규화해 `packCount(..., diagnostic=true)`로 검사했다.

| 항목 | 값 |
|---|---|
| `hasIcon` | `null` |
| `iconColor` | `false` |
| `numericEvidence` | `false` |
| `iconRemnant` | `false` |
| `emptyFields` | `true` |
| `iconFlat` | `true` |
| `digitsFlat` | `false` |
| `highFrequencyCover` | `false` |
| `flatCover` | `true` |
| `stablePreviewEmptyCandidate` | **`true`** |

- 아이콘 영역은 평평하지만 숫자 영역은 평평하지 않다. 즉 **평평한 가림이 아니라 실제 빈 숫자 배경**이다.
- 아이콘 색·잔여 획·숫자 획·고주파 가림이 모두 없다.
- 진단 원본: `work/field-diagnostic-beskal.json`

## 3. 변경

- `count-pattern.ts`에 `singleStillFrameEmptyCandidate(packed, stillImage, observations)` 추가.
  - `stillImage === true`
  - `observations === 1`
  - `stablePreviewEmptyCandidate(packed) === true`
- `scanner.ts` finalization:
  - 기존: `observations >= 3`에서만 빈 장수 후보 허용 (2026-11-11 이후: 정지 이미지가 아닌 일반 입력도 관측 1회부터 허용, `emptyCounterProof`)
  - 변경: **정지 이미지 1회**도 위 조건을 만족하면 0으로 확정
  - 결과: `extraCopies: 0`, `countReliable: true`, `iconPresent: false`, `review`에서 장수·각성 제거
- 동영상은 기존처럼 **3회 이상 관측**을 요구한다. 단일 프레임은 허용하지 않는다.

## 4. 0 대 null 경계 테스트

| 조건 | 결과 |
|---|---|
| 정지 이미지, 관측 1, 빈 장수 증거 | **0 확정** |
| 동영상, 관측 1, 같은 증거 | null 유지 |
| 정지 이미지, 관측 2 | null 유지 |
| `digitsFlat=true`(평평한 숫자 영역) | null 유지 |
| `hasIcon=true`(양수 아이콘) | null 유지 |
| `hasIcon=false`(명시적 빈 아이콘) | 기존 경로로 0 |

## 5. 필드 평가 전후

### screenshots-1 (사람 라벨 40장)

| 필드 | 이전 | 이후 |
|---|---|---|
| 이름 | 40/40 | 40/40 |
| 각성 | 40/40 | 40/40 |
| 장수 | **39/40** | **40/40** |
| `readableButMissed` | 1 | **0** |
| `falseConfirm` | 0 | 0 |
| `review` | 1 | **0** |
| 판정 | fail | **pass** |

- 이전: `work/evaluation/screenshots1.json`
- 이후: `work/evaluation/screenshots1-field-evidence.json`
- 실행: `work/screenshots1-field-evidence.json`

### screenshots-2 (사람 라벨 38장)

| 필드 | 이전 | 이후 |
|---|---|---|
| 이름 | 38/38 | 38/38 |
| 각성 | 38/38 | 38/38 |
| 장수 | **37/38** | **38/38** |
| `readableButMissed` | 1 | **0** |
| `falseConfirm` | 0 | 0 |
| `review` | 1 | **0** |
| 판정 | fail | **pass** |

- 이전: `work/evaluation/screenshots2.json`
- 이후: `work/evaluation/screenshots2-field-evidence.json`
- 실행: `work/screenshots2-field-evidence.json`

## 6. 한계

- 단일 정지 이미지 경로는 **평평한 아이콘 영역 + 평평하지 않은 숫자 영역 + 획/가림 없음**을 모두 요구한다. 텍스처가 있는 가림이 숫자 영역을 덮는 경우까지 완전히 배제하지는 못한다.
- 동영상은 여전히 3회 이상 관측이 필요하다. 실제 화면 공유에서 0장 확정률은 별도 검증이다.
- 라벨은 384장 중 40장·38장만 포함한 부분 라벨이다.
- 실제 화면 공유·다른 해상도 검증은 아직이다.

## 7. 재현

```sh
node --import tsx --test tests/count-pattern-runtime.test.ts
node --import tsx scripts/evaluate-run.mjs \
  work/human-label-40cards.json work/screenshots1-field-evidence-run.json \
  --out work/evaluation/screenshots1-field-evidence.json
node --import tsx scripts/evaluate-run.mjs \
  work/human-label-shots2-38cards.json work/screenshots2-field-evidence-run.json \
  --out work/evaluation/screenshots2-field-evidence.json
```
