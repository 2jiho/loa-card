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
    <div className="summary-card"><span>{state?.currentRunRead !== undefined ? '읽기 완료' : '목록의 카드'}</span><strong><ScanReadCount completed={state?.currentRunRead ?? cardsLength} expected={state?.expected ?? null} store={busy ? scanMonitorStore : undefined} /></strong>
      {state?.expected != null && <p className={match && !review && !inputWarnings ? 'verified' : 'muted'}>{state?.currentRunRead !== undefined && `목록 ${cardsLength}종 · `}{match ? '보관함 수량과 같음' : `보관함 수량과 ${Math.abs(state.expected - cardsLength)}종 차이`}</p>}</div>
    {knownReviewCards > 0 && <div className="summary-card"><span>값을 못 읽은 카드</span><strong className="needs-review">{knownReviewCards}<small>종</small></strong></div>}
    {nameIssueCount > 0 && <div className="summary-card"><span>알아보지 못한 화면</span><strong className="needs-review">{nameIssueCount}<small>개</small></strong></div>}
    <div className="summary-card"><span>{state?.growthPointsEstimated ? '보유 경험치 (예상)' : '보유 경험치'}</span><strong>{state?.growthPoints?.current.toLocaleString('ko-KR') ?? '—'}</strong></div>
  </section>;
}
