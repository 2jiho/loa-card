import {useSyncExternalStore} from 'react';
import Button from '@mui/material/Button';
import TextField from '@mui/material/TextField';
import ScreenShareOutlined from '@mui/icons-material/ScreenShareOutlined';
import StopCircleOutlined from '@mui/icons-material/StopCircleOutlined';
import FileDownloadOutlined from '@mui/icons-material/FileDownloadOutlined';
import FileUploadOutlined from '@mui/icons-material/FileUploadOutlined';
import RestartAltOutlined from '@mui/icons-material/RestartAltOutlined';
import {ScanConveyor} from '../features/card-scanner/ui/ScanConveyor';
import {ScanMonitor} from '../features/card-scanner/ui/ScanMonitor';
import {ScanReadProgress} from '../features/card-scanner/ui/ScanReadProgress';
import {DevPreviewLatency} from './DevPreviewLatency';
import {scanDeadline, scanInputState} from '../features/card-scanner/session/scan-deadline';
import type {ScanMonitorState, ScanMonitorStore} from '../features/card-scanner/ui/scan-monitor-store';
import type {MonitorLatencyProbe} from '../shared/monitor-latency';
import type {ScannedCard} from '../features/card-scanner/recognition/recognizer';
import type {ScannerState} from '../features/card-scanner/orchestration/scanner';

type CsvIssue = {id: string; name: string; reason: string};
type CsvPending = {name: string; cards: ScannedCard[]} | null;

export interface ScannerWorkspaceProps {
  sharing: boolean;
  onStopSharing: () => void;
  onShare: () => void;
  sharePicking: boolean;
  busy: boolean;
  engineSettling: boolean;
  preparationSettling: boolean;
  preparationCleanupUncertain: boolean;
  engineCleanupUncertain: boolean;
  csvReading: boolean;
  backupReady: boolean;
  catalogLength: number;
  preparationState: 'loading' | 'ready' | 'error';
  onAbort: () => void;
  controller: {current: AbortController | null};
  onResetRequest: () => void;
  onResetCancel: () => void;
  onResetConfirm: () => void;
  resetPending: boolean;
  onSaveCsv: () => void;
  onCsvFile: (file: File) => void;
  cardsLength: number;
  scanIncomplete: boolean;
  csvReviewCount: number;
  csvIssues: CsvIssue[];
  state?: ScannerState | null;
  scanIncompleteReasons: string[];
  progressRestored: boolean;
  savedBackupAvailable: boolean;
  onRestoreBackup: () => void;
  preparationMessage: string;
  onRetryPreparation: () => void;
  csvPending: CsvPending;
  csvExperience: string;
  csvExperienceError: string;
  onCsvExperience: (value: string) => void;
  onCsvCancel: () => void;
  onCsvApply: () => void;
  error: string;
  stopped: boolean;
  review: number;
  inputWarnings: boolean;
  statusTitle: string;
  statusDescription: string;
  scanTimedOut: boolean;
  inputState: ReturnType<typeof scanInputState>;
  deadline: ReturnType<typeof scanDeadline>;
  deadlineText: string;
  cursorMode: 'unknown' | 'excluded' | 'included' | 'unsupported';
  engineReady: boolean;
  scanMonitorStore: ScanMonitorStore;
  workPhase: string;
  scanStartedAt: number;
  video: {current: HTMLVideoElement | null};
  ready: boolean;
  onReady: () => void;
  onVideoError: () => void;
  monitorLatency: {current: MonitorLatencyProbe<ScanMonitorState> | null};
}

function LiveRowPosition({store,sharing}:{store:ScanMonitorStore;sharing:boolean}) {
  const top=useSyncExternalStore(
    store.subscribe,
    () => { const row=store.getSnapshot()?.map?.currentRow; return row==null ? undefined : row+1; },
    () => undefined,
  );
  if(!sharing||!Number.isInteger(top))return null;
  return <p className="scan-live-position">현재 화면 약 {top}–{Math.min(55, top!+3)}행 보는 중</p>;
}

/** Card-scan controls and live progress. Scan lifecycle, capture and final
 * results remain owned by App; this component only renders and forwards. */
export function ScannerWorkspace(props: ScannerWorkspaceProps) {
  // The video ref is handed to the element, never read during render.
  const {video: videoRef, ...p} = props;
  const state = p.state;
  // Subscribe to the one display fact the whole panel needs (whether the latest frame shows the
  // card window). Subscribing to the full monitor snapshot re-rendered every control.
  const gridCurrent = useSyncExternalStore(
    p.scanMonitorStore.subscribe,
    () => p.scanMonitorStore.getSnapshot()?.located ?? state?.located ?? false,
    () => false,
  );
  const reviewNames = (state?.cards ?? []).filter(card => card.review.length > 0).map(card => card.name);
  const resultCompleted = state?.currentRunRead ?? 0;
  const resultExpected = state?.expected ?? null;
  const resultCollected = state?.currentRunNames ?? state?.cards.length ?? 0;
  const resultReview = state?.cards?.filter(card => card.review.length > 0).length ?? 0;
  const resultMissing = resultExpected == null ? null : Math.max(0, resultExpected - resultCollected);
  // Keep the disabled share button's label aligned with the primary status.
  // Previously it said "화면 공유 시작" while the status said "목록 불러오는 중".
  const shareBlockedLabel = p.sharePicking ? '공유 창 선택 중'
    : p.preparationCleanupUncertain || p.engineCleanupUncertain ? '엔진 정리 확인 필요'
    : p.busy ? '스캔 처리 중'
    : !p.backupReady ? '목록 불러오는 중'
    : !p.catalogLength ? '카드 사전 준비 중'
    : p.preparationState === 'error' ? '스캔 준비 실패'
    : p.preparationState === 'loading' ? '스캔 준비 중'
    : p.engineSettling || p.preparationSettling ? '이전 준비 정리 중'
    : p.csvReading ? 'CSV 확인 중'
    : '화면 공유 시작';
  return <section className="scanner panel" aria-label="카드 스캔">
    <div className="scanner-main">
      <h1>카드 스캔</h1>
      <div className="toolbar">
        {p.sharing ? <Button variant="contained" startIcon={<StopCircleOutlined />} onClick={p.onStopSharing}>화면 공유 종료</Button>
          : <Button variant="contained" startIcon={<ScreenShareOutlined />} disabled={p.sharePicking || p.busy || p.engineSettling || p.preparationSettling || p.preparationCleanupUncertain || p.engineCleanupUncertain || p.csvReading || !p.backupReady || !p.catalogLength || p.preparationState !== 'ready'} onClick={() => p.onShare()}>{shareBlockedLabel}</Button>}
        <Button color="inherit" startIcon={<RestartAltOutlined />} disabled={p.sharePicking || p.sharing || p.busy || !p.backupReady || !p.cardsLength} aria-expanded={p.resetPending} onClick={p.onResetRequest}>목록 초기화</Button>
        <Button variant="outlined" startIcon={<FileDownloadOutlined />} disabled={p.sharePicking || p.sharing || p.busy || p.scanIncomplete || !p.cardsLength || p.csvReviewCount > 0} title={p.scanIncomplete ? '스캔이 완료되어야 저장할 수 있습니다.' : p.csvIssues.length ? `${p.csvIssues.length}종의 이름·각성·장수 확인 후 저장할 수 있습니다.` : '전체 카드의 이름·각수·카드수 저장 · 행이 있으면 보유'} onClick={p.onSaveCsv}>CSV 저장</Button>
        <Button component="label" role={undefined} tabIndex={-1} variant="outlined" startIcon={<FileUploadOutlined />} disabled={p.sharePicking || p.sharing || p.busy || p.csvReading || !p.backupReady || !p.catalogLength} sx={{'&:focus-within': {outline: '2px solid var(--accent)', outlineOffset: 2}}}>
          {p.csvReading ? 'CSV 읽는 중…' : 'CSV 불러오기'}
          <input className="visually-hidden" aria-label="CSV 불러오기" type="file" accept=".csv,text/csv" disabled={p.sharePicking || p.sharing || p.busy || p.csvReading || !p.backupReady || !p.catalogLength}
            onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; if (file) p.onCsvFile(file); }} />
        </Button>
        {p.busy && !p.sharing && <Button variant="outlined" color="inherit" startIcon={<StopCircleOutlined />} onClick={p.onAbort}>스캔 중지</Button>}
      </div>
      {!p.busy && p.scanIncomplete && <div className="notice" role="status">
        <p>스캔 미완료 · {p.scanIncompleteReasons.join(' · ')} · 기존 저장 목록은 변경하지 않았습니다.</p>
        {state && <p>{p.progressRestored ? '복원한 진행 기록은 판독이 끝나지 않아 CSV로 저장할 수 없습니다. 새 스캔은 이 카드 목록에서 이어집니다.' : '현재 결과는 확인이 끝나지 않아 CSV로 저장할 수 없습니다.'}</p>}
        {p.progressRestored && p.savedBackupAvailable && <button className="text-button" onClick={p.onRestoreBackup}>저장된 목록으로 돌아가기</button>}
      </div>}
      {!p.busy && p.csvReviewCount > 0 && <small className="muted">{`확인할 카드 ${p.csvIssues.length}종을 다시 읽으면 CSV로 저장할 수 있습니다.`}</small>}
      {!p.busy && (p.preparationState !== 'ready' || !p.cardsLength || p.preparationSettling || p.engineSettling) && <div role="status" className="scan-preparation">
        {p.preparationState === 'loading' && p.preparationMessage && <span className="scan-spinner" aria-hidden="true" />}
        <span>{p.preparationMessage}</span>
        {p.preparationState === 'error' && !p.preparationCleanupUncertain && <Button size="small" disabled={p.preparationSettling} onClick={p.onRetryPreparation}>준비 다시 시도</Button>}
        {p.preparationSettling && !p.preparationCleanupUncertain && <span role="status">이전 준비 작업을 정리하고 있습니다.</span>}
        {p.engineSettling && !p.busy && <span role="status">{p.engineCleanupUncertain ? '인식 엔진 종료를 확인하지 못해 새 스캔을 잠갔습니다.' : '이전 인식 엔진 종료를 기다리고 있습니다.'}</span>}
      </div>}
      {p.csvPending && <div className="import-confirm" role="group" aria-label="CSV 불러오기 확인">
        <div><strong>{p.csvPending.name} · {p.csvPending.cards.length}종</strong>
          <p>{p.cardsLength ? `현재 ${p.cardsLength}종 목록을 이 파일의 목록으로 교체합니다.` : '파일에 있는 카드를 목록에 불러옵니다.'} 기존 목록은 CSV로 저장할 수 있습니다.</p>
          <TextField className="csv-experience" label="보유 카드 경험치 (선택)" size="small" value={p.csvExperience}
            onChange={event => p.onCsvExperience(event.target.value)} placeholder="예: 1,234,567"
            error={!!p.csvExperienceError} helperText={p.csvExperienceError || '비워 두면 경험치 미확인으로 불러옵니다.'}
            slotProps={{htmlInput: {inputMode: 'numeric', maxLength: 32}}} />
        </div>
        <button className="text-button" onClick={p.onCsvCancel}>취소</button>
        <button className="secondary" disabled={p.busy || !!p.csvExperienceError} onClick={p.onCsvApply}>불러오기</button>
      </div>}
      {p.resetPending && <div className="reset-confirm" role="group" aria-label="목록 초기화 확인"><span>현재 카드 목록을 비우고 새로 시작할까요?</span>
        <button className="secondary" onClick={p.onResetCancel}>취소</button>
        <button disabled={p.busy || !p.backupReady} onClick={p.onResetConfirm}>목록 비우기</button>
      </div>}
      <div className={`scan-progress ${p.busy ? 'processing' : ''}`} role="status" aria-live="polite">
        <strong>{p.busy ? <span className="scan-spinner" aria-hidden="true" />
          : !p.error && !p.stopped && !p.scanIncomplete && !p.review && !p.inputWarnings && p.cardsLength ? <span className="scan-complete" aria-hidden="true">✓</span>
            : <span className={`status-dot ${p.sharing ? 'active' : ''}`} aria-hidden="true" />}{p.statusTitle}</strong>
        {(p.busy || p.stopped || p.error || p.scanIncomplete || !p.cardsLength) && <p>{p.statusDescription}</p>}
        <LiveRowPosition store={p.scanMonitorStore} sharing={p.sharing} />
        {(p.sharing || p.scanTimedOut) && <p className="scan-deadline" data-state={p.scanTimedOut ? 'exceeded' : p.inputState.state === 'stalled' ? 'stalled' : p.deadline.state}>{p.deadlineText}</p>}
        {p.sharing && p.cursorMode === 'included' && <p className="scan-cursor-note">브라우저가 마우스 커서를 화면에 포함하고 있습니다. 게임 창 밖으로 마우스를 이동해 주세요.</p>}
        {(p.busy || p.sharing) && p.engineReady && (state?.sampled ?? 0) > 0 && !gridCurrent && <p className="notice">현재 화면에서 카드 영역을 찾지 못했습니다. 표시된 수치는 마지막으로 확인된 프레임 기준입니다.</p>}
        {reviewNames.length > 0 && <p className="notice">확인 필요 {reviewNames.length}장: {reviewNames.slice(0, 6).join(', ')}</p>}
        {p.busy && p.engineReady && <ScanReadProgress store={p.scanMonitorStore} completed={state?.currentRunRead ?? 0} expected={state?.expected ?? null}
          collected={state?.currentRunNames ?? 0} review={state?.cards?.filter(card => card.review.length > 0).length ?? 0}
          phase={p.workPhase as 'capture' | 'reading' | 'recovery' | 'verifying' | 'cleanup'} startedAt={p.scanStartedAt}
          autoCompletionEnabled={p.sharing}
          queued={state?.queued} activeReadings={state?.activeReadings} stale={!gridCurrent} />}
        {p.sharing && <p>{state?.expected != null ? `화면 수집 ${state?.currentRunNames ?? 0} / ${state.expected}종 · 수집 완료 시 자동 종료` : '보관함 수량 확인 중'}</p>}
      </div>
      {!p.busy && state && (resultExpected != null || resultCompleted > 0) && <div className="scan-result-summary" role="status" aria-label="현재 목록 판독 상태">
        <span className="scan-result-summary-title">현재 목록</span>
        <span>판독 완료 <b>{resultCompleted.toLocaleString('ko-KR')}</b>{resultExpected != null ? ` / ${resultExpected.toLocaleString('ko-KR')}종` : ''}</span>
        <span>수집 이름 <b>{resultCollected.toLocaleString('ko-KR')}</b>{resultExpected != null ? ` / ${resultExpected.toLocaleString('ko-KR')}종` : ''}</span>
        {resultMissing !== null && resultMissing > 0 && <span className="is-review">이름 미확인 <b>{resultMissing.toLocaleString('ko-KR')}</b>종</span>}
        {resultReview > 0 && <span className="is-review">확인 필요 <b>{resultReview.toLocaleString('ko-KR')}</b>종</span>}
      </div>}
    </div>
    <figure className="source-preview">
      <div className="video-wrap">
        <video ref={videoRef} muted playsInline
          onLoadedData={p.onReady}
          onError={p.onVideoError} />
        {!p.ready && <div className="preview-placeholder"><span aria-hidden="true">▣</span>공유 화면 미리보기</div>}
      </div>
      <figcaption><span className={`status-dot ${p.sharing ? 'active' : ''}`} />{p.sharing ? '화면 공유 연결됨' : p.ready ? '화면 공유 종료' : '공유 대기'}</figcaption>
    </figure>
    {import.meta.env.DEV && <DevPreviewLatency store={p.scanMonitorStore} probe={p.monitorLatency} />}
    <ScanMonitor state={state ?? null} store={p.scanMonitorStore} busy={p.busy} sharing={p.sharing} engineReady={p.engineReady} onStop={p.onStopSharing} />
    {p.busy && p.engineReady && <ScanConveyor items={state?.activity ?? []} queued={state?.queued ?? 0} reading={(state?.activeReadings ?? 0) > 0} />}
  </section>;
}
