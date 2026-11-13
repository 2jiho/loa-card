import {ScanReadCount} from '../features/card-scanner/ui/ScanReadProgress';
import type {ScanMonitorStore} from '../features/card-scanner/ui/scan-monitor-store';
import type {ScannerState} from '../features/card-scanner/orchestration/scanner';

/** Presentational scan totals shown on non-card workspace tabs. */
export function ScannerSummary(props: {
  state?: ScannerState | null;
  cardsLength: number;
  match: boolean;
  review: number;
  inputWarnings: boolean;
  knownReviewCards: number;
  nameIssueCount: number;
  scanMonitorStore: ScanMonitorStore;
  busy: boolean;
}) {
  const {state, cardsLength, match, review, inputWarnings, knownReviewCards,
    nameIssueCount, scanMonitorStore, busy} = props;
  return <section className="summary-grid" aria-label="스캔 요약">
    <div className="summary-card"><span>{state?.currentRunRead !== undefined ? '판독 확인' : '수집한 카드'}</span><strong><ScanReadCount completed={state?.currentRunRead ?? cardsLength} expected={state?.expected ?? null} store={busy ? scanMonitorStore : undefined} /></strong>
      {state?.expected != null && <p className={match && !review && !inputWarnings ? 'verified' : 'muted'}>{state?.currentRunRead !== undefined && `수집 ${cardsLength}종 · `}{match ? '수량 일치' : `${Math.abs(state.expected - cardsLength)}종 차이`}</p>}</div>
    {knownReviewCards > 0 && <div className="summary-card"><span>카드 값·보유 확인</span><strong className="needs-review">{knownReviewCards}<small>종</small></strong></div>}
    {nameIssueCount > 0 && <div className="summary-card"><span>미식별 화면 입력</span><strong className="needs-review">{nameIssueCount}<small>건</small></strong></div>}
    <div className="summary-card"><span>{state?.growthPointsEstimated ? '보유 경험치 (예상)' : '보유 경험치'}</span><strong>{state?.growthPoints?.current.toLocaleString('ko-KR') ?? '—'}</strong></div>
  </section>;
}
