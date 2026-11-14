import {useEffect, useState, useSyncExternalStore} from 'react';
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
import {scanDeadline, scanInputState} from '../features/card-scanner/session/scan-deadline';
import type {ScanMonitorStore} from '../features/card-scanner/ui/scan-monitor-store';
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
  /** The list on screen before an incomplete scan replaced it can be shown again. */
  replacedAvailable: boolean;
  onRestoreReplaced: () => void;
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
}

function LiveRowPosition({store,sharing}:{store:ScanMonitorStore;sharing:boolean}) {
  const top=useSyncExternalStore(
    store.subscribe,
    () => { const row=store.getSnapshot()?.map?.currentRow; return row==null ? undefined : row+1; },
    () => undefined,
  );
  const rows=useSyncExternalStore(store.subscribe,()=>store.getSnapshot()?.map?.totalRows,()=>undefined);
  const visible=useSyncExternalStore(store.subscribe,()=>store.getSnapshot()?.map?.visibleRows,()=>undefined);
  if(!sharing)return null;
  // Kept while the position is unknown for a moment, so the lines below do not jump. Not announced:
  // it changes with every scroll.
  return <p className="scan-live-position" aria-live="off">{Number.isInteger(top) ? `지금 화면: ${top}~${Math.min(rows ?? 55, top!+(visible ?? 4)-1)}번째 줄쯤` : '지금 화면 위치를 찾는 중'}</p>;
}

/** The names collected, from every snapshot (the page itself takes a new state once a second while sharing). */
function LiveCollected({store}:{store:ScanMonitorStore}) {
  const names=useSyncExternalStore(store.subscribe,()=>store.getSnapshot()?.currentRunNames,()=>undefined);
  const expected=useSyncExternalStore(store.subscribe,()=>store.getSnapshot()?.expected,()=>undefined);
  return <p aria-live="off">{expected != null ? `이름 확인 ${(names ?? 0).toLocaleString('ko-KR')} / ${expected.toLocaleString('ko-KR')}종 · 모든 카드를 읽으면 공유가 자동으로 끝나요` : '보관함 수량을 읽는 중'}</p>;
}

/** True once `value` has held for `ms`: a notice about one passing frame would appear and vanish. */
function useLasting(value:boolean,ms:number):boolean {
  const [lasted,setLasted]=useState(false);
  useEffect(()=>{
    if(!value)return;
    const timer=window.setTimeout(()=>setLasted(true),ms);
    return ()=>{window.clearTimeout(timer);setLasted(false);};
  },[value,ms]);
  return value&&lasted;
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
  // The card window is missed for single frames while scrolling fast or under a tooltip. Before it
  // was first found, the status line already says the card screen is being looked for.
  const windowLost = useLasting((p.busy || p.sharing) && p.engineReady && (state?.stable ?? 0) > 0 && !gridCurrent, 1500);
  const reviewNames = (state?.cards ?? []).filter(card => card.review.length > 0).map(card => card.name);
  const resultCompleted = state?.currentRunRead ?? 0;
  const resultExpected = state?.expected ?? null;
  const resultCollected = state?.currentRunNames ?? state?.cards.length ?? 0;
  const resultReview = state?.cards?.filter(card => card.review.length > 0).length ?? 0;
  const resultMissing = resultExpected == null ? null : Math.max(0, resultExpected - resultCollected);
  // Keep the disabled share button's label aligned with the primary status.
  // Previously it said "화면 공유 시작" while the status said "목록 불러오는 중".
  const shareBlockedLabel = p.sharePicking ? '공유 창 선택 중'
    : p.preparationCleanupUncertain || p.engineCleanupUncertain ? '새로고침이 필요해요'
    : p.busy ? '스캔하는 중'
    : !p.backupReady ? '목록 불러오는 중'
    : !p.catalogLength ? '카드 자료 불러오는 중'
    : p.preparationState === 'error' ? '스캔 준비 실패'
    : p.preparationState === 'loading' ? '스캔 준비 중'
    : p.engineSettling || p.preparationSettling ? '이전 스캔 정리 중'
    : p.csvReading ? 'CSV 읽는 중'
    : '화면 공유 시작';
  return <section className="scanner panel" aria-label="카드 스캔">
    <div className="scanner-main">
      <h1>카드 스캔</h1>
      <div className="toolbar">
        {p.sharing ? <Button variant="contained" startIcon={<StopCircleOutlined />} onClick={p.onStopSharing}>화면 공유 종료</Button>
          : <Button variant="contained" startIcon={<ScreenShareOutlined />} disabled={p.sharePicking || p.busy || p.engineSettling || p.preparationSettling || p.preparationCleanupUncertain || p.engineCleanupUncertain || p.csvReading || !p.backupReady || !p.catalogLength || p.preparationState !== 'ready'} onClick={() => p.onShare()}>{shareBlockedLabel}</Button>}
        <Button color="inherit" startIcon={<RestartAltOutlined />} disabled={p.sharePicking || p.sharing || p.busy || !p.backupReady || !p.cardsLength} aria-expanded={p.resetPending} onClick={p.onResetRequest}>목록 초기화</Button>
        <Button variant="outlined" startIcon={<FileDownloadOutlined />} disabled={p.sharePicking || p.sharing || p.busy || p.scanIncomplete || !p.cardsLength || p.csvReviewCount > 0} title={p.scanIncomplete ? '스캔을 끝까지 마쳐야 저장할 수 있어요.' : p.csvIssues.length ? `이름·각성·장수를 못 읽은 카드 ${p.csvIssues.length}종이 있어 저장할 수 없어요.` : '카드마다 이름, 각수(각성 단계), 카드수(추가 장수)를 저장해요. 파일에 있는 카드는 등록된 카드로 봐요.'} onClick={p.onSaveCsv}>CSV 저장</Button>
        <Button component="label" role={undefined} tabIndex={-1} variant="outlined" startIcon={<FileUploadOutlined />} disabled={p.sharePicking || p.sharing || p.busy || p.csvReading || !p.backupReady || !p.catalogLength} sx={{'&:focus-within': {outline: '2px solid var(--accent)', outlineOffset: 2}}}>
          {p.csvReading ? 'CSV 읽는 중' : 'CSV 불러오기'}
          <input className="visually-hidden" aria-label="CSV 불러오기" type="file" accept=".csv,text/csv" disabled={p.sharePicking || p.sharing || p.busy || p.csvReading || !p.backupReady || !p.catalogLength}
            onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; if (file) p.onCsvFile(file); }} />
        </Button>
        {p.busy && !p.sharing && <Button variant="outlined" color="inherit" startIcon={<StopCircleOutlined />} onClick={p.onAbort}>스캔 중지</Button>}
      </div>
      {!p.busy && p.scanIncomplete && <div className="notice" role="status">
        <p><strong>스캔을 끝까지 마치지 못했어요.</strong> {p.scanIncompleteReasons.slice(0, 2).join(' ')} 전에 저장한 목록은 그대로예요.</p>
        {state && <p>{p.progressRestored ? '되살린 목록은 스캔이 끝나지 않은 것이라 CSV로 저장할 수 없어요. 다시 스캔하면 처음부터 새로 읽어요.' : '이번 결과는 끝까지 확인하지 못해 CSV로 저장할 수 없어요. 다시 스캔하면 처음부터 새로 읽어요.'}</p>}
        {p.replacedAvailable ? <button className="text-button" onClick={p.onRestoreReplaced}>이전 목록으로 돌아가기</button>
          : p.progressRestored && p.savedBackupAvailable && <button className="text-button" onClick={p.onRestoreBackup}>저장된 목록으로 돌아가기</button>}
      </div>}
      {!p.busy && p.csvReviewCount > 0 && <small className="muted">{`이름·각성·장수를 못 읽은 카드가 ${p.csvIssues.length}종 있어 CSV로 저장할 수 없어요. 다시 스캔해 주세요.`}</small>}
      {!p.busy && (p.preparationState !== 'ready' || !p.cardsLength || p.preparationSettling || p.engineSettling) && <div role="status" className="scan-preparation">
        {p.preparationState === 'loading' && p.preparationMessage && <span className="scan-spinner" aria-hidden="true" />}
        <span>{p.preparationMessage}</span>
        {p.preparationState === 'error' && !p.preparationCleanupUncertain && <Button size="small" disabled={p.preparationSettling} onClick={p.onRetryPreparation}>준비 다시 시도</Button>}
        {p.preparationSettling && !p.preparationCleanupUncertain && <span>이전 스캔을 정리하고 있어요.</span>}
        {p.engineSettling && !p.busy && <span>{p.engineCleanupUncertain ? '이전 스캔이 깔끔하게 끝나지 않았어요. 페이지를 새로고침해 주세요.' : '이전 스캔이 끝나기를 기다리고 있어요.'}</span>}
      </div>}
      {p.csvPending && <div className="import-confirm" role="group" aria-label="CSV 불러오기 확인">
        <div><strong>{p.csvPending.name} · {p.csvPending.cards.length}종</strong>
          <p>{p.cardsLength ? `지금 목록(${p.cardsLength.toLocaleString('ko-KR')}종)을 이 파일의 목록으로 바꿔요. 지금 목록이 필요하면 취소하고 먼저 'CSV 저장'을 해 두세요.` : '파일에 있는 카드를 목록으로 불러와요.'}</p>
          <TextField className="csv-experience" label="보유 카드 경험치 (선택)" size="small" value={p.csvExperience}
            onChange={event => p.onCsvExperience(event.target.value)} placeholder="예: 1,234,567"
            error={!!p.csvExperienceError} helperText={p.csvExperienceError || "비워 두면 경험치를 '미확인'으로 둬요."}
            slotProps={{htmlInput: {inputMode: 'numeric', maxLength: 32}}} />
        </div>
        <button className="text-button" onClick={p.onCsvCancel}>취소</button>
        <button className="secondary" disabled={p.busy || !!p.csvExperienceError} onClick={p.onCsvApply}>불러오기</button>
      </div>}
      {p.resetPending && <div className="reset-confirm" role="group" aria-label="목록 초기화 확인"><span>지금 카드 목록을 비우고 새로 시작할까요?</span>
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
        {p.sharing && p.cursorMode === 'included' && <p className="scan-cursor-note">마우스 커서가 공유 화면에 함께 찍히고 있어요. 커서를 카드 밖(스크롤바 위나 게임 창 밖)으로 옮겨 주세요.</p>}
        {windowLost && <p className="notice">지금 화면에서 카드 목록을 찾지 못했어요. 아래 숫자는 카드 목록이 마지막으로 보였을 때 기준이에요.</p>}
        {!p.busy && reviewNames.length > 0 && <p className="notice">값을 못 읽은 카드 {reviewNames.length}종: {reviewNames.slice(0, 6).join(', ')}{reviewNames.length > 6 ? ` 외 ${reviewNames.length - 6}종` : ''}</p>}
        {p.busy && p.engineReady && <ScanReadProgress store={p.scanMonitorStore} completed={state?.currentRunRead ?? 0} expected={state?.expected ?? null}
          collected={state?.currentRunNames ?? 0}
          phase={p.workPhase as 'capture' | 'reading' | 'recovery' | 'verifying' | 'cleanup'} startedAt={p.scanStartedAt}
          autoCompletionEnabled={p.sharing}
          queued={state?.queued} activeReadings={state?.activeReadings} stale={windowLost} />}
        {p.sharing && <LiveCollected store={p.scanMonitorStore} />}
      </div>
      {!p.busy && state && (resultExpected != null || resultCompleted > 0) && <div className="scan-result-summary" role="status" aria-label="현재 목록 요약">
        <span className="scan-result-summary-title">현재 목록</span>
        <span>읽기 완료 <b>{resultCompleted.toLocaleString('ko-KR')}</b>{resultExpected != null ? ` / ${resultExpected.toLocaleString('ko-KR')}종` : ''}</span>
        <span>이름 확인 <b>{resultCollected.toLocaleString('ko-KR')}</b>{resultExpected != null ? ` / ${resultExpected.toLocaleString('ko-KR')}종` : ''}</span>
        {resultMissing !== null && resultMissing > 0 && <span className="is-review">이름을 못 읽은 카드 <b>{resultMissing.toLocaleString('ko-KR')}</b>종</span>}
        {resultReview > 0 && <span className="is-review">값을 못 읽은 카드 <b>{resultReview.toLocaleString('ko-KR')}</b>종</span>}
      </div>}
    </div>
    <figure className="source-preview">
      <div className="video-wrap">
        <video ref={videoRef} muted playsInline
          onLoadedData={p.onReady}
          onError={p.onVideoError} />
        {!p.ready && <div className="preview-placeholder"><span aria-hidden="true">▣</span>공유 화면 미리보기</div>}
      </div>
      <figcaption><span className={`status-dot ${p.sharing ? 'active' : ''}`} />{p.sharing ? '화면 공유 중' : p.ready ? '화면 공유 끝남' : '공유 전'}</figcaption>
    </figure>
    <ScanMonitor state={state ?? null} store={p.scanMonitorStore} busy={p.busy} sharing={p.sharing} engineReady={p.engineReady} onStop={p.onStopSharing} />
    {p.busy && p.engineReady && <ScanConveyor items={state?.activity ?? []} queued={state?.queued ?? 0} reading={(state?.activeReadings ?? 0) > 0} />}
  </section>;
}
