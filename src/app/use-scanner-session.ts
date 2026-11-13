import {useEffect, useRef, useState} from 'react';
import {createScanMonitorStore} from '../features/card-scanner/ui/scan-monitor-store';
import type {ScanMonitorInput, ScanMonitorState} from '../features/card-scanner/ui/scan-monitor-store';
import type {MonitorLatencyProbe} from '../shared/monitor-latency';
import {monotonicNow} from '../features/card-scanner/capture/monotonic-clock';
import {scanDeadline, scanInputState, scanStatusMessage} from '../features/card-scanner/session/scan-deadline';
import {createPreparedSlot} from '../features/card-scanner/acquisition/prepared-slot';
import {createPreparationFeedback} from '../features/card-scanner/ui/preparation-feedback';
import {prepareScanner} from '../features/card-scanner/session/scanner-preparation';
import type {PreparedScanner} from '../features/card-scanner/session/scanner-preparation';
import {NORMAL_SCANNER_NAME_CONFIGURATION} from '../features/card-scanner/session/scanner-name-configuration';

/** Owns the in-memory monitor store and the dev-only presentation probe.
 * Capture, OCR and completion are not owned by this hook. */
export function useScanMonitorSession() {
  const [store] = useState(() => createScanMonitorStore({notifyIntervalMs: 100}));
  const probe = useRef<MonitorLatencyProbe<ScanMonitorState> | null>(null);
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    let cancelled = false;
    void import('../shared/monitor-latency').then(({createMonitorLatencyProbe}) => {
      if (!cancelled) probe.current = createMonitorLatencyProbe<ScanMonitorState>();
    }).catch(() => { probe.current = null; });
    return () => { cancelled = true; };
  }, []);
  const publish = (input: ScanMonitorInput) => {
    store.publish(input);
    if (import.meta.env.DEV) probe.current?.notify(store.getSnapshot());
  };
  return {store, probe, publish};
}

/** The 2-minute input deadline and its display. `firstInputAt`/`lastInputAt`
 * stay owned by the caller; this hook only derives time-based state. */
export function useScannerClock(options: {
  sharing: boolean;
  firstInputAt: number | null;
  lastInputAt: number | null;
  lastProgressAt: number | null;
  holdIdle?: {current:boolean};
  onTimeout: () => void;
}) {
  const {sharing, firstInputAt, lastInputAt, lastProgressAt, holdIdle, onTimeout} = options;
  const [clockNow, setClockNow] = useState(0);
  const [scanTimedOut, setScanTimedOut] = useState(false);
  const [deadline, setDeadline] = useState(() => scanDeadline({firstInputAtMs: firstInputAt,lastProgressAtMs: lastProgressAt, nowMs: 0}));
  const [inputState, setInputState] = useState(() => scanInputState({lastInputAtMs: lastInputAt, nowMs: 0}));
  const timedOutRef = useRef(false), timedOutStopped = useRef(false);
  const firstInputRef = useRef(firstInputAt), lastProgressRef = useRef(lastProgressAt);
  const lastInputRef = useRef(lastInputAt);
  const timeoutRef = useRef(onTimeout);
  const hiddenAtRef = useRef<number | null>(null);
  useEffect(() => { timeoutRef.current = onTimeout; }, [onTimeout]);
  useEffect(() => { firstInputRef.current = firstInputAt; }, [firstInputAt]);
  useEffect(() => { lastProgressRef.current = lastProgressAt; }, [lastProgressAt]);
  useEffect(() => { lastInputRef.current = lastInputAt; }, [lastInputAt]);
  useEffect(() => {
    if (!sharing) { hiddenAtRef.current = null; return; }
    let active = true;
    const publishDeadline = (now: number) => {
      if (!active) return;
      const current = scanDeadline({firstInputAtMs: firstInputRef.current,lastProgressAtMs: lastProgressRef.current, nowMs: now});
      setDeadline(current.state === 'exceeded' && current.reason === 'idle' && holdIdle?.current
        ? {...current, state: 'warning' as const} : current);
      setInputState(scanInputState({lastInputAtMs: lastInputRef.current, nowMs: now}));
      if (current.state === 'exceeded' && !timedOutRef.current &&
          !(current.reason === 'idle' && holdIdle?.current)) {
        timedOutRef.current = true;
        setScanTimedOut(true);
      }
    };
    const visibility = () => {
      const now = monotonicNow();
      if (document.visibilityState === 'hidden') { hiddenAtRef.current = now; return; }
      if (hiddenAtRef.current === null) return;
      // Switching to another window must not charge hidden time to the scan.
      // Shift the anchors so the same active elapsed/idle window is retained.
      const hiddenMs = Math.max(0, now - hiddenAtRef.current);
      hiddenAtRef.current = null;
      if (firstInputRef.current !== null) firstInputRef.current += hiddenMs;
      if (lastProgressRef.current !== null) lastProgressRef.current += hiddenMs;
      if (lastInputRef.current !== null) lastInputRef.current += hiddenMs;
      setClockNow(now); publishDeadline(now);
    };
    document.addEventListener('visibilitychange', visibility);
    if (document.visibilityState === 'hidden') hiddenAtRef.current = monotonicNow();
    const timer = setInterval(() => {
      if (document.visibilityState === 'hidden') return;
      const now = monotonicNow();
      setClockNow(now); publishDeadline(now);
    }, 1000);
    return () => {
      active = false;
      clearInterval(timer);
      document.removeEventListener('visibilitychange', visibility);
      hiddenAtRef.current = null;
    };
  }, [sharing, holdIdle]);
  useEffect(() => {
    if (!scanTimedOut || timedOutStopped.current) return;
    timedOutStopped.current = true;
    timeoutRef.current();
  }, [scanTimedOut]);
  const deadlineText = scanStatusMessage({deadline, inputState: inputState.state, idleMs: inputState.idleMs, timedOut: scanTimedOut});
  const resetTimeout = () => {
    timedOutRef.current = false;
    timedOutStopped.current = false;
    setScanTimedOut(false);
    setDeadline(scanDeadline({firstInputAtMs: null,lastProgressAtMs: null, nowMs: 0}));
    setInputState(scanInputState({lastInputAtMs: null, nowMs: 0}));
  };
  const syncClock = () => {
    const now = monotonicNow();
    setClockNow(now);
    const current = scanDeadline({firstInputAtMs: firstInputRef.current,lastProgressAtMs: lastProgressRef.current, nowMs: now});
    setDeadline(current.state === 'exceeded' && current.reason === 'idle' && holdIdle?.current
      ? {...current, state: 'warning' as const} : current);
    setInputState(scanInputState({lastInputAtMs: lastInputRef.current, nowMs: now}));
  };
  return {clockNow, scanTimedOut, deadline, inputState, deadlineText, resetTimeout, syncClock};
}

/** Scanner engine preparation. The caller still owns the scan abort controller
 * and passes `onCleanupUncertain` so an unverifiable disposal aborts the run. */
export function useScannerPreparation(options: {
  busy: boolean;
  engineSettling: boolean;
  onCleanupUncertain: () => void;
}) {
  const {busy, engineSettling, onCleanupUncertain} = options;
  const preparation = useRef<ReturnType<typeof createPreparedSlot<PreparedScanner>> | null>(null);
  const [preparationState, setPreparationState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [preparationMessage, setPreparationMessage] = useState('');
  const [preparationAttempt, setPreparationAttempt] = useState(0);
  const preparationCleanupUncertainRef = useRef(false);
  const [preparationCleanupUncertain, setPreparationCleanupUncertain] = useState(false);
  const pendingPreparationCleanups = useRef(0);
  const [preparationSettling, setPreparationSettling] = useState(false);
  const onUncertainRef = useRef(onCleanupUncertain);
  useEffect(() => { onUncertainRef.current = onCleanupUncertain; }, [onCleanupUncertain]);
  function markPreparationCleanupUncertain() {
    preparationCleanupUncertainRef.current = true;
    setPreparationCleanupUncertain(true);
    setPreparationState('error');
    setPreparationMessage('인식 엔진 준비 자원 종료를 확인하지 못해 새 스캔을 잠갔습니다.');
    onUncertainRef.current();
  }
  function trackPreparationSettlement(settled: Promise<unknown>) {
    pendingPreparationCleanups.current++;
    setPreparationSettling(true);
    void settled.then(() => {}, () => {}).finally(() => {
      pendingPreparationCleanups.current--;
      setPreparationSettling(pendingPreparationCleanups.current > 0);
    });
  }
  useEffect(() => {
    if (busy || engineSettling || preparationSettling || pendingPreparationCleanups.current > 0 || preparationCleanupUncertainRef.current) return;
    let active = true;
    let slot: ReturnType<typeof createPreparedSlot<PreparedScanner>> | undefined;
    const feedback = createPreparationFeedback(message => {
      if (active) setPreparationMessage(message);
    });
    const timer = window.setTimeout(() => {
      if (!active || pendingPreparationCleanups.current > 0 || preparationCleanupUncertainRef.current) return;
      setPreparationState('loading');
      setPreparationMessage('');
      slot = createPreparedSlot(signal => prepareScanner(feedback.update, signal, NORMAL_SCANNER_NAME_CONFIGURATION,
        {onCleanupUncertain: markPreparationCleanupUncertain}), {onCleanupError: markPreparationCleanupUncertain});
      preparation.current = slot;
      void slot.ready.then(() => {
        feedback.dispose();
        if (active && !preparationCleanupUncertainRef.current) {
          setPreparationState('ready'); setPreparationMessage('스캔 준비 완료');
        }
      }).catch(error => {
        feedback.dispose();
        if (active && !preparationCleanupUncertainRef.current) {
          setPreparationState('error');
          setPreparationMessage(error instanceof Error ? error.message : '인식 엔진 준비 실패');
        }
      });
    }, 100);
    return () => {
      active = false;
      feedback.dispose();
      window.clearTimeout(timer);
      if (preparation.current === slot) preparation.current = null;
      if (slot) {
        let disposal: void | Promise<void> = undefined;
        try { disposal = slot.dispose(); } catch { markPreparationCleanupUncertain(); }
        trackPreparationSettlement(Promise.allSettled([slot.ready, Promise.resolve(disposal)]));
      }
    };
  }, [busy, engineSettling, preparationSettling, preparationCleanupUncertain, preparationAttempt]);
  return {
    preparation, preparationState, setPreparationState, preparationMessage, setPreparationMessage,
    preparationAttempt, setPreparationAttempt, preparationCleanupUncertainRef,
    preparationCleanupUncertain, pendingPreparationCleanups, preparationSettling,
    markPreparationCleanupUncertain, trackPreparationSettlement,
  };
}
