import type {Dispatch, SetStateAction} from 'react';
import {runScanner} from '../features/card-scanner/orchestration/scanner';
import type {ScannerState} from '../features/card-scanner/orchestration/scanner';
import type {ScannedCard} from '../features/card-scanner/recognition/recognizer';
import {toPartialSnapshot} from '../partial-snapshot';
import type {PartialSnapshot} from '../features/card-scanner/persistence/partial-store';
import {createLatestPublisher} from '../latest-publisher';
import {createScannerFeedback} from '../features/card-scanner/ui/scanner-feedback';
import {feedbackProbeEnabled} from '../features/card-scanner/ui/feedback-probe-setting';
import type {ScanMonitorInput, ScanMonitorStore} from '../features/card-scanner/ui/scan-monitor-store';
import {trackSourceVersion} from '../features/card-scanner/session/source-version-evidence';
import {carryUnattributedFieldReviews,unattributedFieldReviewCount} from '../features/card-scanner/session/current-scan-fields';
import {beginReproduction} from '../features/card-scanner/reproduction/scan-reproduction';
import {watchRecordingReadiness} from '../features/card-scanner/reproduction/recording-readiness';
import {detailedRecordingResult} from '../features/card-scanner/ui/recording-ui-policy';
import {clearScanProgress, saveScanProgress} from '../features/card-scanner/persistence/progress-backup';
import {takeMatchingPreparedScanner} from '../features/card-scanner/session/matching-scanner-preparation';
import {NORMAL_SCANNER_NAME_CONFIGURATION} from '../features/card-scanner/session/scanner-name-configuration';
import {completionReasons} from '../features/card-scanner/session/positive-completion';
import type {PreparedScanner} from '../features/card-scanner/session/scanner-preparation';
import type {ExactRecorder} from '../features/card-scanner/reproduction/exact-recording';
import {scanStateAfterIncomplete} from './scan-state-fallback';

export interface ScanLifecycleDeps {
  inventory: {current: ScannedCard[]};
  state: ScannerState | null;
  preparation: {current: {take(): PreparedScanner | undefined} | null};
  exactPreparation: {current: {take(): ExactRecorder | undefined} | null};
  diagnosticRun: {current: number};
  archiveAbort: {current: AbortController | null};
  archiveStatusSession: {current: {id: string; message: string} | null};
  controller: {current: AbortController | null};
  video: {current: HTMLVideoElement | null};
  stream: {current: MediaStream | null};
  scanMonitorStore: ScanMonitorStore;
  recordingEnabled: boolean;
  catalogVersion: string;
  clearScanIncomplete: () => void;
  markScanIncomplete: (reasons: string[]) => void;
  noteScanProgress: (next: ScannerState) => void;
  publishMonitor: (input: ScanMonitorInput) => void;
  beginEngineWork: () => () => void;
  setProgressRestored: Dispatch<SetStateAction<boolean>>;
  setRecordingReady: Dispatch<SetStateAction<boolean>>;
  setRecordingSaving: Dispatch<SetStateAction<boolean>>;
  setRecordingStatus: Dispatch<SetStateAction<string>>;
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
  setPartialSnapshot: Dispatch<SetStateAction<PartialSnapshot | null>>;
  setPartialSnapshotError: Dispatch<SetStateAction<boolean>>;
}

/**
 * One scan run from claim to finalization. This owns scanner invocation and
 * completion bookkeeping, but not capture acquisition or the React shell.
 */
export async function runScanLifecycle(deps: ScanLifecycleDeps): Promise<void> {
  const {
    inventory, state, preparation, exactPreparation, diagnosticRun, archiveAbort,
    archiveStatusSession, controller, video, stream, scanMonitorStore, recordingEnabled,
    catalogVersion, clearScanIncomplete, markScanIncomplete, noteScanProgress, publishMonitor,
    beginEngineWork, setProgressRestored, setRecordingReady, setRecordingSaving, setRecordingStatus,
    setPreparationState, setBusy, setResultView, setInventoryFilter, setPage, setEngineReady,
    engineReadyRef, setEngineCleanupUncertain, setResetPending, setCsvPending, setError,
    setActionError, setState, setSharing, setScanStartedAt, setPartialSnapshot, setPartialSnapshotError,
  } = deps;

  // A failed run must not become the seed of the next run or overwrite the
  // independently saved last confirmed inventory. Keep the previous visible
  // state while the new engine starts so the card list does not blank out.
  const baseline = structuredClone(inventory.current);
  const previousState = state;
  clearScanIncomplete();
  setProgressRestored(false);
  void clearScanProgress().catch(() => {});
  archiveAbort.current?.abort();
  let unattributedFields = unattributedFieldReviewCount(state);
  const preparedCandidate = preparation.current?.take();
  const exact = recordingEnabled ? exactPreparation.current?.take() : undefined;
  const thisDiagnosticRun = ++diagnosticRun.current;
  archiveStatusSession.current = null;
  setRecordingReady(false);
  setRecordingSaving(false);
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
  let recording: ReturnType<typeof beginReproduction> | undefined;
  let recordingIssue = false;
  let finalState: ScannerState | undefined;
  let completed = false;
  let lastPartialCapture = -Infinity;
  const rememberPartial = (result: ScannerState) => {
    if (!import.meta.env.DEV || controller.current !== abort || !result.cards.length) return;
    try {
      const snapshot = toPartialSnapshot(result);
      setPartialSnapshot(previous => diagnosticRun.current === thisDiagnosticRun ? snapshot : previous);
      setPartialSnapshotError(false);
    } catch { setPartialSnapshotError(true); }
  };
  let scannerStarted = false;
  let sourceVersion: ReturnType<typeof trackSourceVersion> | undefined;
  try {
    if (import.meta.env.DEV) {
      sourceVersion = trackSourceVersion(async () => {
        const response = await fetch('/__corpus/environment', {cache: 'no-store', signal: AbortSignal.timeout(2000)});
        if (!response.ok) throw Error('Source snapshot unavailable');
        return response.json();
      }, invalidate => {
        const hot = import.meta.hot;
        hot?.on('vite:beforeUpdate', invalidate);
        hot?.on('vite:beforeFullReload', invalidate);
        return () => {
          hot?.off('vite:beforeUpdate', invalidate);
          hot?.off('vite:beforeFullReload', invalidate);
        };
      });
    }
  } catch { /* Source diagnostics must never prevent scanning. */ }
  const engineSettled = beginEngineWork();
  try {
    const prepared = await takeMatchingPreparedScanner(() => preparedCandidate, NORMAL_SCANNER_NAME_CONFIGURATION);
    try {
      recording = beginReproduction(inventory.current, {browser: navigator.userAgent, catalog: catalogVersion, build: import.meta.env.VITE_BUILD_REVISION ?? 'local'},
        {record: recordingEnabled, exact, nameConfiguration: NORMAL_SCANNER_NAME_CONFIGURATION,
          protectForArchive: import.meta.env.DEV && recordingEnabled,
          onRecordingIssue: () => {
            recordingIssue = true;
            if (controller.current === abort && diagnosticRun.current === thisDiagnosticRun)
              setRecordingStatus('진단 기록 일부가 누락될 수 있습니다. 카드 스캔은 계속됩니다.');
          },
          ...(sourceVersion ? {sourceVersion: () => sourceVersion.finish()} : {}),
          ...(feedbackProbe ? {feedbackReceipts: () => feedbackProbe.stats()} : {})});
      if (!recordingIssue) setRecordingStatus(recordingEnabled ? '진단 입력 기록 준비 중' : '');
      watchRecordingReadiness(recording.ready, () => controller.current === abort && diagnosticRun.current === thisDiagnosticRun,
        () => {
          if (!recordingIssue) setRecordingStatus(recordingEnabled
            ? (exact ? '진단용 입력 기록 중' : '무손실 기록 준비 실패 · 영상 또는 진단 요약만 남을 수 있습니다.')
            : '');
        },
        () => setRecordingStatus('진단 기록을 저장할 수 없습니다. 카드 스캔은 계속됩니다.'));
    } catch {
      void exact?.dispose();
      setRecordingStatus('진단 기록을 준비하지 못했습니다. 카드 스캔은 계속합니다.');
    }
    scannerStarted = true;
    sourceVersion?.scannerStarted();
    await runScanner(
      video.current!,
      'screen',
      abort.signal,
      (result) => {
        if (controller.current === abort) {
          unattributedFields = carryUnattributedFieldReviews(unattributedFields, result);
          const next = unattributedFields ? {...result, unattributedFieldReviews: unattributedFields} : result;
          publishMonitor(next);
          if (next.autoStopped) setSharing(false);
          inventory.current = next.cards;
          finalState = next;
          if (import.meta.env.DEV && performance.now() - lastPartialCapture >= 2000) {
            lastPartialCapture = performance.now();
            rememberPartial(next);
          }
          presentation.publish(next);
        }
      },
      inventory.current,
      () => {
        if (controller.current === abort) {
          setScanStartedAt(performance.now());
          engineReadyRef.current = true;
          setEngineReady(true);
        }
      },
      'all',
      undefined,
      false,
      {...recording?.options, nameConfiguration: NORMAL_SCANNER_NAME_CONFIGURATION, onInternalSettled: engineSettled,
        onInternalCleanupUncertain: () => setEngineCleanupUncertain(true), feedbackProbe,
        onAutoCompletion: diagnostic => {
          if (controller.current === abort) scanMonitorStore.publishAutoCompletion(diagnostic);
        },
        onLiveObstructionHint: hint => {
          if (controller.current === abort && !abort.signal.aborted) scanMonitorStore.publishLiveObstructionHint(hint);
        }},
      prepared,
      feedback => { if (controller.current === abort) publishMonitor(feedback); },
    );
    presentation.flush();
    if (controller.current === abort) {
      const reasons = finalState ? completionReasons(finalState) : ['스캔 결과 미확인'];
      if (reasons.length) {
        inventory.current = baseline;
        markScanIncomplete(reasons);
        const shown = scanStateAfterIncomplete(finalState, previousState);
        if (finalState) rememberPartial(finalState);
        if (shown) setState(shown);
      } else completed = true;
    }
  } catch (e) {
    presentation.flush();
    if (controller.current === abort) {
      inventory.current = baseline;
      markScanIncomplete(['스캔 중단']);
      if (finalState) rememberPartial(finalState);
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
    sourceVersion?.scannerStopped();
    if (!recording && sourceVersion) void sourceVersion.finish().catch(() => {});
    if (!scannerStarted) { engineSettled(); void exact?.dispose(); }
    presentation.cancel();
    if (controller.current === abort) {
      controller.current = null;
      setBusy(false);
      // Keep the completed state as a recoverable checkpoint until the backup
      // save succeeds. Clearing it here raced a tab close and could lose the
      // only copy of a just-finished scan. The backup save clears it later.
      if (!completed && finalState) void saveScanProgress(finalState).catch(() => {});
    }
    // Result use and inventory autosave resume immediately. Diagnostic I/O
    // has its own status and cannot hold the scanner in its busy state.
    if (recording) {
      const finishedRecording = recording;
      if (diagnosticRun.current === thisDiagnosticRun) {
        setRecordingSaving(true);
        setRecordingStatus(recordingEnabled ? '진단 기록 저장 중 · 카드 목록은 사용할 수 있습니다.' : '');
      }
      void finishedRecording.finish(finalState, completed).then(file => {
        const message = detailedRecordingResult(recordingEnabled, file);
        if (diagnosticRun.current === thisDiagnosticRun) setRecordingStatus(message);
        // The idle-only archive effect resumes this protected session after
        // finalization and also retries interrupted earlier sessions.
        if (import.meta.env.DEV && recordingEnabled && diagnosticRun.current === thisDiagnosticRun)
          archiveStatusSession.current = {id: finishedRecording.id, message};
      }).catch(e => {
        if (diagnosticRun.current === thisDiagnosticRun)
          setRecordingStatus(e instanceof Error ? e.message : '진단 기록 저장 실패');
      }).finally(() => {
        if (diagnosticRun.current === thisDiagnosticRun) setRecordingSaving(false);
      });
    }
  }
}
