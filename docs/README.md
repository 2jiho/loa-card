# 문서 안내

이 저장소의 코드·커밋된 마스터·테스트와 아래 문서로 개발 환경과 검증 절차를 구성한다.

| 작업 | 문서 |
|---|---|
| 처음 실행하거나 수정 | [README](../README.md), [AGENTS](../AGENTS.md), [개발·검증](development.md) |
| 스캐너 인식·성능 | [스캐너 구조](scanner-pipeline.md) |
| 인식 평가·정답셋 | [평가 계약](evaluation.md) |
| 기하 정규화·다해상도 홀드아웃 | [기하 홀드아웃](geometry-holdout.md) |
| 이름+원화 신원 융합 | [이름+원화 융합](identity-fusion.md) |
| 장수 0장 증거·필드 평가 | [장수 필드 증거](field-evidence.md) |
| Scanner session 분해 | [session 분해](session-decomposition.md) |
| Scanner 물리 분할 | [물리 분할](physical-split.md) |
| 프로그램 구조·의존 규칙 | [프로그램 구조](architecture.md), [마이그레이션](architecture-migration.md) |
| App 분해 | [App 분해](app-decomposition.md) |
| 입력 누적·재현 구조 전환 | [입력 기록과 재현 설계](scanner-session-design.md), [입력 코퍼스 사용](development.md#입력-코퍼스) |
| 프레임·이름 근거 분석 | [프레임 진단 설계](frame-name-evidence-design.md) |
| 자동 종료 입력 공백 분석 | [자동 종료 입력 분석](auto-stop-input-analysis.md) |
| 재시도 원장 실험 | [재시도 입장 원장 재생](retry-receipt-replay.md) |
| UI·테마 | [UI 설계](ui-design.md) |
| 도감 계산 | [성장 계산](growth-optimizer.md) |
| 레이드 비교 | [레이드 계산](raid-cards.md) |
| 지역별 카드 | [떠돌이 상인](merchant-alerts.md) |
| 게임 데이터·모델 갱신 | [데이터 유지보수](data-maintenance.md) |
| 기존 선택의 이유·한계 | [설계 결정](decisions.md) |
| 정적 배포 | [배포 안내](deployment.md) |
| 공개·배포 전후 점검 | [출시 점검](release-checklist.md) |
| 소스·자산의 권리 | [외부 고지](../THIRD_PARTY_NOTICES.md), [권리 검토](legal-review.md) |

과거의 실험 수치와 폐기한 UI 설명은 현재 동작에 섞지 않는다. 새 검증은 입력·시작 목록·환경·종료 시점·최종 결과를 구분해서 기록한다. 원본 영상과 개인 실행 결과를 공개 저장소에 넣지 않는다.
