import type {Dispatch, SetStateAction} from 'react';
import {runScanner} from '../features/card-scanner/orchestration/scanner';
import type {ScannerState} from '../features/card-scanner/orchestration/scanner';
import type {ScannedCard} from '../features/card-scanner/recognition/recognizer';
import {createLatestPublisher} from '../latest-publisher';
import {createScannerFeedback} from '../features/card-scanner/ui/scanner-feedback';
import {feedbackProbeEnabled} from '../features/card-scanner/ui/feedback-probe-setting';
import type {ScanMonitorInput, ScanMonitorStore} from '../features/card-scanner/ui/scan-monitor-store';
import {carryUnattributedFieldReviews,unattributedFieldReviewCount} from '../features/card-scanner/session/current-scan-fields';
import {clearScanProgress, saveScanProgress} from '../features/card-scanner/persistence/progress-backup';
import {takeMatchingPreparedScanner} from '../features/card-scanner/session/matching-scanner-preparation';
import {NORMAL_SCANNER_NAME_CONFIGURATION} from '../features/card-scanner/session/scanner-name-configuration';
import {completionReasons} from '../features/card-scanner/session/positive-completion';
import type {PreparedScanner} from '../features/card-scanner/session/scanner-preparation';
import {scanStateAfterIncomplete} from './scan-state-fallback';

export interface ScanLifecycleDeps {
  inventory: {current: ScannedCard[]};
  state: ScannerState | null;
  preparation: {current: {take(): PreparedScanner | undefined} | null};
  controller: {current: AbortController | null};
  video: {current: HTMLVideoElement | null};
  stream: {current: MediaStream | null};
  scanMonitorStore: ScanMonitorStore;
  clearScanIncomplete: () => void;
  markScanIncomplete: (reasons: string[]) => void;
  noteScanProgress: (next: ScannerState) => void;
  publishMonitor: (input: ScanMonitorInput) => void;
  beginEngineWork: () => () => void;
  setProgressRestored: Dispatch<SetStateAction<boolean>>;
  setPreparationState: Dispatch<SetStateAction<'loading' | 'ready' | 'error'>>;
  setBusy: Dispatch<SetStateAction<boolean>>;
  setResultView: Dispatch<SetStateAction<'cards' | 'merchants' | 'growth' | 'raid'>>;
  setInventoryFilter: Dispatch<SetStateAction<'owned' | 'unowned'>>;
  setPage: Dispatch<SetStateAction<number>>;
  setEngineReady: Dispatch<SetStateAction<boolean>>;
  engineReadyRef: {current: boolean};
  setEngineCleanupUncertain: Dispatch<SetStateAction<boolean>>;
  setResetPending: Dispatch<SetStateAction<boolean>>;
  setCsvPending: Dispatch<SetStateAction<{name: string; cards: ScannedCard[]} | null>>;
  setError: Dispatch<SetStateAction<string>>;
  setActionError: Dispatch<SetStateAction<string>>;
  setState: Dispatch<SetStateAction<ScannerState | null>>;
  setSharing: Dispatch<SetStateAction<boolean>>;
  setScanStartedAt: Dispatch<SetStateAction<number>>;
}

/**
 * One scan run from claim to finalization. This owns scanner invocation and
 * completion bookkeeping, but not capture acquisition or the React shell.
 */
export async function runScanLifecycle(deps: ScanLifecycleDeps): Promise<void> {
  const {
    inventory, state, preparation, controller, video, stream, scanMonitorStore,
    clearScanIncomplete, markScanIncomplete, noteScanProgress, publishMonitor,
    beginEngineWork, setProgressRestored, setPreparationState, setBusy, setResultView, setInventoryFilter,
    setPage, setEngineReady, engineReadyRef, setEngineCleanupUncertain, setResetPending, setCsvPending, setError,
    setActionError, setState, setSharing, setScanStartedAt,
  } = deps;

  // A failed run must not become the seed of the next run or overwrite the
  // independently saved last confirmed inventory. Keep the previous visible
  // state while the new engine starts so the card list does not blank out.
  const baseline = structuredClone(inventory.current);
  const previousState = state;
  clearScanIncomplete();
  setProgressRestored(false);
  void clearScanProgress().catch(() => {});
  let unattributedFields = unattributedFieldReviewCount(state);
  const preparedCandidate = preparation.current?.take();
  setPreparationState('loading');
  controller.current?.abort();
  const abort = new AbortController();
  controller.current = abort;
  setBusy(true);
  setResultView('cards');
  setInventoryFilter('owned');
  setPage(1);
  setEngineReady(false);
  engineReadyRef.current = false;
  setResetPending(false);
  setCsvPending(null);
  setError('');
  setActionError('');
  scanMonitorStore.clear();
  const feedbackProbe = feedbackProbeEnabled(import.meta.env.DEV, window.location.search)
    ? createScannerFeedback({now: () => performance.now(), signal: abort.signal})
    : undefined;
  scanMonitorStore.setFeedback(feedbackProbe);
  const presentation = createLatestPublisher<ScannerState>((next) => {
    if (controller.current !== abort) return;
    noteScanProgress(next);
    // The live card list is a primary result, not a low-priority preview.
    // A transition here was starved by the 33ms monitor lane, leaving the list
    // at zero for many seconds while the progress counters advanced.
    setState(next);
  }, 200);
  abort.signal.addEventListener('abort', () => presentation.flush(), {once: true});
  let finalState: ScannerState | undefined;
  let completed = false;
  let scannerStarted = false;
  const engineSettled = beginEngineWork();
  try {
    const prepared = await takeMatchingPreparedScanner(() => preparedCandidate, NORMAL_SCANNER_NAME_CONFIGURATION);
    scannerStarted = true;
    await runScanner(
      video.current!,
      abort.signal,
      (result) => {
        if (controller.current === abort) {
          unattributedFields = carryUnattributedFieldReviews(unattributedFields, result);
          const next = unattributedFields ? {...result, unattributedFieldReviews: unattributedFields} : result;
          publishMonitor(next);
          if (next.autoStopped) setSharing(false);
          inventory.current = next.cards;
          finalState = next;
          presentation.publish(next);
        }
      },
      () => {
        if (controller.current === abort) {
          setScanStartedAt(performance.now());
          engineReadyRef.current = true;
          setEngineReady(true);
        }
      },
      {nameConfiguration: NORMAL_SCANNER_NAME_CONFIGURATION, onInternalSettled: engineSettled,
        onInternalCleanupUncertain: () => setEngineCleanupUncertain(true), feedbackProbe},
      prepared,
    );
    presentation.flush();
    if (controller.current === abort) {
      const reasons = finalState ? completionReasons(finalState) : ['스캔 결과 미확인'];
      if (reasons.length) {
        inventory.current = baseline;
        markScanIncomplete(reasons);
        const shown = scanStateAfterIncomplete(finalState, previousState);
        if (shown) setState(shown);
      } else completed = true;
    }
  } catch (e) {
    presentation.flush();
    if (controller.current === abort) {
      inventory.current = baseline;
      markScanIncomplete(['스캔 중단']);
      if (abort.signal.aborted || (e instanceof DOMException && e.name === 'AbortError'))
        setState(s => {
          const base = finalState ?? previousState ?? s;
          return base ? {...base, status: '스캔 중지'} : base;
        });
      else setError(e instanceof Error ? e.message : '스캔 실패');
      try { stream.current?.getTracks().forEach(track => track.stop()); } catch { /* Stream state is unavailable. */ }
      stream.current = null;
      setSharing(false);
    }
  } finally {
    if (!scannerStarted) engineSettled();
    presentation.cancel();
    if (controller.current === abort) {
      controller.current = null;
      setBusy(false);
      // Keep the completed state as a recoverable checkpoint until the backup
      // save succeeds. Clearing it here raced a tab close and could lose the
      // only copy of a just-finished scan. The backup save clears it later.
      if (!completed && finalState) void saveScanProgress(finalState).catch(() => {});
    }
  }
}
