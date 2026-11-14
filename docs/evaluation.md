# 스캐너 평가 계약

- 작성일: 2026-11-08
- 코드: `src/features/card-scanner/evaluation/`, `scripts/evaluate-run.mjs`
- 목적: “읽을 수 있는데 놓침”과 “원래 읽을 수 없음”을 분리한다.

## 1. 원칙

1. 사람 라벨만 정답이다. 스캐너 출력·이전 결과·수량 일치는 정답이 아니다.
2. 필드별로 평가한다. 이름은 읽혔지만 장수가 가려진 경우를 이름 실패로 세지 않는다.
3. `known`만 분모에 넣는다. `unreadable`은 분모에서 제외하되 사유와 함께 남긴다.
4. `unknown`은 “아직 라벨링하지 않음”이며, 하나라도 있으면 평가는 미완료다.
5. `falseConfirm`은 커버리지보다 우선한다. 잘못 확정한 값이 하나라도 있으면 실패다.
6. `null`은 관측된 0이 아니다. 결과가 `null`이면 읽을 수 있는 값은 `readableButMissed`다.

## 2. 라벨 스키마 v2

```json
{
  "kind": "loacard-human-label",
  "version": 2,
  "status": "human-confirmed",
  "scope": "partial",
  "caseId": "...",
  "fieldScope": ["name", "awakening", "extraCopies"],
  "inputs": [{"index": 0, "sha256": "...", "bytes": 0}],
  "confirmation": {
    "authority": "human-user",
    "recordedAt": "2026-11-08T00:00:00.000Z",
    "question": "...",
    "answer": "...",
    "wording": "verbatim"
  },
  "cards": [
    {
      "id": "3200003",
      "fields": {
        "name": {"status": "known", "value": "국왕 실리안", "evidence": {"inputIndex": 0, "frame": 12}},
        "awakening": {"status": "known", "value": 5, "evidence": {"inputIndex": 0, "frame": 12}},
        "extraCopies": {"status": "unreadable", "reason": "툴팁 가림"}
      }
    }
  ]
}
```

### 필드 상태

| 상태 | 의미 | 평가 |
|---|---|---|
| `known` | 사람이 값을 읽었고 확정함 | 분모 포함 |
| `unreadable` | 모든 프레임에서 가려졌거나 읽을 수 없음 | 분모 제외, 사유 필수 |
| `unknown` | 아직 라벨링하지 않음 | 평가 미완료 |

### fieldScope

- `fieldScope`는 이 라벨이 책임지는 필드를 명시한다.
- v2 라벨에서 `fieldScope`를 생략하면 세 필드를 모두 요구한다.
- v1 라벨은 카드에 실제로 존재하는 필드만으로 `fieldScope`를 추론한다.
  - 예: `extraCopies`만 있는 v1 라벨 → `fieldScope: ["extraCopies"]`
- `fieldScope` 밖의 필드는 평가에서 제외하며, `unknown`으로 세지 않는다.

### 값 범위

- 이름: 비어 있지 않은 문자열
- 각성: 정수 0~5
- 추가 장수: 정수 0~15
- `unreadable`에는 `value`를 넣을 수 없고 `reason`이 필요하다.
- 같은 카드 ID가 두 번 나오면 파일 전체를 거부한다.

## 3. 지표

| 지표 | 정의 |
|---|---|
| `readable` | `known` 필드 수 |
| `exact` | 결과가 라벨 값과 정확히 같은 수 |
| `missed` | `known`인데 결과가 없거나 `null`인 수 |
| `unreadable` | `unreadable` 필드 수 |
| `unknown` | `unknown` 필드 수 |
| `falseConfirm` | 라벨과 다른 값을 확정했거나, `unreadable`인데 값을 확정한 수 |
| `readableButMissed` | 모든 필드의 `missed` 합 |
| `review` | 결과 카드 중 `review`가 비어 있지 않은 수 |
| `readableReview` | 라벨에서 `known` 필드가 있는데 결과에 `review`가 남은 카드 수 |
| `unlabeledResultCards` | 라벨에 없는 결과 카드 ID |
| `missingResultCards` | 라벨에 있지만 결과에 없는 카드 ID |

### 판정

| verdict | 조건 |
|---|---|
| `pass` | 미완료 0, 오확정 0, `readableButMissed` 0, `readableReview` 0, full scope의 라벨 없는 카드 0 |
| `fail` | 위 조건 중 하나 이상 위반 |
| `incomplete` | `fieldScope` 안에 `unknown`이 있음 |

`partial` scope에서 라벨에 없는 결과 카드는 실패가 아니라 `unlabeledResultCards`로만 보고한다.

## 4. CLI

```sh
node --import tsx scripts/evaluate-run.mjs \
  <label.json> <run-result.json> [--out work/evaluation/report.json]
```

- 라벨은 v1·v2 모두 읽는다. v1은 메모리에서 v2로 정규화하며 원본 파일은 수정하지 않는다.
- 결과는 `allCards[]` 또는 `cards[]` 배열이 필요하다. 숫자 `cards`만 있는 리포트는 거부한다.
- 리포트에는 라벨·결과의 SHA-256, 입력 수, 카드 수, 필드별 지표, 판정 사유가 들어간다.
- 종료 코드:
  - `0`: pass
  - `2`: fail
  - `3`: incomplete
  - `1`: 입력 오류

## 5. 기준선 기록

기준선은 비공개 코퍼스 사례(사진 묶음·영상)의 결과 JSON과 사람 라벨을 대조한 값이다. 입력이 Git에 없으므로 날짜별 기준선 표는 사례 옆의 `fixtures/local/notes/`에 둔다. 기준선을 읽을 때는 다음을 지킨다.

- **부분 라벨** 기준이다. 라벨이 있는 카드만 분모에 들어간다. 한 필드만 라벨링한 사례는 `fieldScope`로 그 필드만 평가한다.
- `unlabeledResultCards`는 partial scope에서 실패로 세지 않는다. 전체 판독 완료 증거가 아니다.
- `readableButMissed`(예: 라벨 0, 결과 `null`)는 오확정이 아니다. 오확정은 `falseConfirm`으로 따로 본다.
- 기존 결과 JSON과 라벨을 대조한 기준선은 코퍼스 전체를 다시 실행한 결과가 아니다.

## 6. 한계

- 라벨이 없는 카드는 평가 분모에 들어가지 않는다.
- `unreadable` 판정은 사람이 프레임을 보고 결정해야 한다. 엔진 실패를 `unreadable`로 승격하지 않는다.
- `falseConfirm`은 라벨 카드 ID가 결과에 존재할 때의 값 비교다. ID 자체를 잘못 확정한 경우는 `missingResultCards`·`unlabeledResultCards`로 드러나지만, 두 카드의 동일성 추적은 별도 검증이 필요하다.
- `review` 수는 결과 카드 기준이며, 라벨에 없는 카드의 리뷰는 `readableReview`에 들어가지 않는다.
- 이 평가는 인식 알고리즘의 성능 자체를 바꾸지 않는다. Step 5의 인식 변경은 이 계약으로 전후를 비교한다.

## 7. 케이스 추가

1. 입력의 사람 라벨을 v2로 작성한다.
2. `fieldScope`에 실제로 확인한 필드만 넣는다.
3. `node --import tsx scripts/evaluate-run.mjs <label> <run> --out <report>`를 실행한다.
4. `falseConfirm`이 0인지, `readableButMissed`가 어떤 카드·필드인지 확인한다.
5. 라벨 파일과 리포트 해시를 함께 보관한다. 프로그램 출력을 라벨로 승격하지 않는다.
