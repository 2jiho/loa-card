import Button from '@mui/material/Button';
import { useEffect, useMemo, useRef, useState } from "react";
import { ScanQuickStart } from './ui/UsageGuide';
import {AppShell} from './app/AppShell';
import {InventoryWorkspace} from './app/InventoryWorkspace';
import {ScannerSummary} from './app/ScannerSummary';
import {ScannerWorkspace} from './app/ScannerWorkspace';
import {useScanMonitorSession, useScannerClock, useScannerPreparation} from './app/use-scanner-session';
import {closeWindowShare, openWindowShare, stopShareStream} from './app/share-commands';
import {runScanLifecycle} from './app/scan-lifecycle';
import {createShareAttemptGuard} from './features/card-scanner/capture/share-stream-owner';
import { PartialArchivePanel } from './PartialArchivePanel';
import type { PartialSnapshot } from './features/card-scanner/persistence/partial-store';
import { LIVE_INPUT_LOSS_MESSAGE } from './features/card-scanner/session/input-loss-evidence';
import { HEADER_CONFLICT_WARNING } from './features/card-scanner/session/completion-header-snapshot';
import {deferredPanel} from './ui/DeferredPanel';
import {takeMatchingPreparedScanner} from './features/card-scanner/session/matching-scanner-preparation';
import { createPreparedSlot } from './features/card-scanner/acquisition/prepared-slot';
import { ScanReadCount } from './features/card-scanner/ui/ScanReadProgress';
import { scanHasInputWarnings } from './features/card-scanner/session/scan-monitor-outcome';
import { duplicateRescueObservationCount } from './features/card-scanner/acquisition/fixed-grid-rescue';
import { previewFinalizationStatus } from './features/card-scanner/ui/preview-finalization-status';
import { scrollGuidance } from './features/card-scanner/ui/scroll-guidance';
import {monotonicNow} from './features/card-scanner/capture/monotonic-clock';
import {ScanAttention} from './features/card-scanner/ui/ScanAttention';
import {unattributedFieldReviewCount} from './features/card-scanner/session/current-scan-fields';
import {knownReviewCardCount} from './features/card-scanner/ui/review-display';
import type {ExactRecorder} from './features/card-scanner/reproduction/exact-recording';
import {defaultDetailedRecording} from './features/card-scanner/ui/recording-ui-policy';
import type { ScannerState } from "./features/card-scanner/orchestration/scanner";
import type { ScannedCard } from "./features/card-scanner/recognition/recognizer";
import "./App.css";
import { useLiveResults } from './features/use-live-results';
import {loadCardCatalog} from './data/catalog';
import { completeGrowth, undoGrowth } from './features/growth/complete-growth';
import type { GrowthMaster } from './features/growth/optimizer';
import type { GrowthSequenceStep } from './features/growth/growth-sequence';
import { merchantCardIssues } from './features/merchants/merchant-progress';
import {inventoryCsv,inventoryCsvIssues,parseInventoryCsv,parseCsvExperience,csvInventoryState} from './inventory-csv';
import type {CsvCatalogCard} from './inventory-csv';
import { unownedInventory } from './inventory-unowned';
import { loadScanBackup, saveScanBackup, clearScanBackup, LegacyBackupChoice } from "./features/card-scanner/persistence/scan-backup";
import { clearScanProgress, loadScanProgress, saveScanProgress } from "./features/card-scanner/persistence/progress-backup";
const MerchantAlerts = deferredPanel(async () => ({default:(await import('./features/merchants/MerchantAlerts')).MerchantAlerts}));
const GrowthPlanner = deferredPanel(async () => ({default:(await import('./features/growth/GrowthPlanner')).GrowthPlanner}));
const RaidCards = deferredPanel(async () => ({default:(await import('./features/raid/RaidCards')).RaidCards}));
const ScanReplayDialog = deferredPanel(async () => ({default:(await import('./features/card-scanner/ui/ScanReplayDialog')).ScanReplayDialog}));

function App() {
  const [guideOpen, setGuideOpen] = useState(false);
  const video = useRef<HTMLVideoElement>(null);
  const stream = useRef<MediaStream | null>(null);
  const shareAttempt=useRef(createShareAttemptGuard());
  const [sharePicking,setSharePicking]=useState(false);
  const controller = useRef<AbortController | null>(null);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const {store:scanMonitorStore,probe:monitorLatency,publish:publishMonitor}=useScanMonitorSession();
  const [replayOpen,setReplayOpen]=useState(false);
  const [replayBusy,setReplayBusy]=useState(false);
  const pendingEngines=useRef(0);
  const [engineSettling,setEngineSettling]=useState(false);
  const [engineCleanupUncertain,setEngineCleanupUncertain]=useState(false);
  const [scanIncomplete,setScanIncomplete]=useState(false);
  const scanIncompleteRef=useRef(false);
  const [scanIncompleteReasons,setScanIncompleteReasons]=useState<string[]>([]);
  const [progressRestored,setProgressRestored]=useState(false);
  const [savedBackupAvailable,setSavedBackupAvailable]=useState(false);
  const [partialSnapshot,setPartialSnapshot]=useState<PartialSnapshot|null>(null);
  const [partialSnapshotError,setPartialSnapshotError]=useState(false);
  function markScanIncomplete(reasons:string[]){scanIncompleteRef.current=true;setScanIncomplete(true);setScanIncompleteReasons(reasons);}
  function clearScanIncomplete(){scanIncompleteRef.current=false;setScanIncomplete(false);setScanIncompleteReasons([]);}
  function beginEngineWork(){
    pendingEngines.current++;setEngineSettling(true);let released=false;
    return()=>{if(released)return;released=true;pendingEngines.current--;setEngineSettling(pendingEngines.current>0);};
  }
  const [recordingStatus,setRecordingStatus]=useState('');
  const [recordingEnabled,setRecordingEnabled]=useState(()=>defaultDetailedRecording(import.meta.env.DEV));
  const [recordingSaving,setRecordingSaving]=useState(false);
  const [recordingPreparation,setRecordingPreparation]=useState('');
  const [recordingReady,setRecordingReady]=useState(false);
  const [recordingUnavailable,setRecordingUnavailable]=useState(false);
  const exactPreparation=useRef<ReturnType<typeof createPreparedSlot<ExactRecorder>>|null>(null);
  const diagnosticRun=useRef(0);
  const archiveStatusSession=useRef<{id:string;message:string}|null>(null);
  const archiveAbort=useRef<AbortController|null>(null);
  useEffect(()=>{
    if(!recordingEnabled||busy||replayBusy)return;
    let active=true;
    queueMicrotask(()=>{if(active){setRecordingReady(false);setRecordingUnavailable(false);setRecordingPreparation('상세 입력 기록 준비 중…');}});
    const slot=createPreparedSlot(async signal=>{
      const {createExactRecording}=await import('./features/card-scanner/reproduction/exact-recording');
      signal.throwIfAborted();
      return createExactRecording();
    });
    exactPreparation.current=slot;
    void slot.ready.then(()=>{if(active){setRecordingReady(true);setRecordingPreparation('상세 입력 기록 준비 완료');}})
      .catch(()=>{if(active){setRecordingReady(false);setRecordingUnavailable(true);setRecordingPreparation('무손실 기록을 준비하지 못했습니다. 스캔은 계속할 수 있으며 영상 또는 진단 요약만 남을 수 있습니다.');}});
    return()=>{active=false;if(exactPreparation.current===slot)exactPreparation.current=null;void slot.dispose();};
  },[recordingEnabled,busy,replayBusy]);
  const {preparation,preparationState,setPreparationState,preparationMessage,
    setPreparationAttempt,preparationCleanupUncertainRef,preparationCleanupUncertain,
    pendingPreparationCleanups,preparationSettling}=
    useScannerPreparation({busy,replayBusy,engineSettling,onCleanupUncertain:()=>controller.current?.abort()});
  const [engineReady, setEngineReady] = useState(false);
  const [scanStartedAt, setScanStartedAt] = useState(0);
  const engineReadyRef = useRef(false);
  const [sharing, setSharing] = useState(false);
  const [cursorMode,setCursorMode]=useState<'unknown'|'excluded'|'included'|'unsupported'>('unknown');
  const [firstInputAt,setFirstInputAt]=useState<number|null>(null);
  const [lastInputAt,setLastInputAt]=useState<number|null>(null);
  const [lastProgressAt,setLastProgressAt]=useState<number|null>(null);
  const holdIdleRef=useRef(false);
  const inputProgress=useRef({sampled:0,read:0,names:0,recoveryFrames:0,percent:0,phase:''});
  const {scanTimedOut,deadline,inputState,deadlineText,resetTimeout,syncClock}=useScannerClock({
    sharing,firstInputAt,lastInputAt,lastProgressAt,holdIdle:holdIdleRef,onTimeout:stopSharing,
  });
  const resetScanDeadline=()=>{
    setFirstInputAt(null);setLastInputAt(null);setLastProgressAt(null);holdIdleRef.current=false;
    inputProgress.current={sampled:0,read:0,names:0,recoveryFrames:0,percent:0,phase:''};resetTimeout();
  };
  const noteScanProgress=(next:ScannerState)=>{
    const now=monotonicNow(),previous=inputProgress.current;
    const sampled=next.sampled??0,read=next.currentRunRead??0,names=next.currentRunNames??0;
    const recoveryFrames=next.recoveryFrames??0,percent=next.percent??0,phase=next.workPhase??'';
    const active=(next.queued??0)>0||(next.activeReadings??0)>0;
    holdIdleRef.current=next.cards.some(card=>card.review.length>0);
    if(sampled>0||read>0||names>0)setFirstInputAt(current=>current??now);
    if(sampled>previous.sampled||read>previous.read||names>previous.names)setLastInputAt(now);
    if(active||sampled>previous.sampled||read>previous.read||names>previous.names||
      recoveryFrames>previous.recoveryFrames||percent>previous.percent||phase!==previous.phase)
      setLastProgressAt(now);
    inputProgress.current={sampled,read,names,recoveryFrames,percent,phase};
  };
  const [error, setError] = useState("");
  const [actionError, setActionError] = useState('');
  const [backupReady, setBackupReady] = useState(false);
  const [backupStatus, setBackupStatus] = useState('목록 불러오는 중');
  const [backupError, setBackupError] = useState('');
  const [backupAttempt, setBackupAttempt] = useState(0);
  const [legacyChoices, setLegacyChoices] = useState<LegacyBackupChoice['choices']>([]);
  const savedState = useRef<ScannerState | null>(null);
  const [catalogError, setCatalogError] = useState('');
  const [catalogVersion, setCatalogVersion] = useState('');
  const [catalogAttempt, setCatalogAttempt] = useState(0);
  const [state, setState] = useState<ScannerState | null>(null);
  const [query, setQuery] = useState("");
  const [inventoryFilter, setInventoryFilter] = useState<'owned'|'unowned'>('owned');
  const [resultView,setResultView]=useState<'cards'|'merchants'|'growth'|'raid'>('cards');
  const [page,setPage]=useState(1);
  const [resetPending, setResetPending] = useState(false);
  const [csvPending,setCsvPending]=useState<{name:string;cards:ScannedCard[]}|null>(null);
  const [csvReading,setCsvReading]=useState(false);
  const [csvExperience,setCsvExperience]=useState('');
  const csvExperienceError=useMemo(()=>{
    try {parseCsvExperience(csvExperience);return '';}
    catch(e) {return e instanceof Error?e.message:'경험치를 확인해 주세요.';}
  },[csvExperience]);
  const inventory = useRef<ScannedCard[]>([]);
  const [catalog, setCatalog] = useState<CsvCatalogCard[]>([]);
  const rarityById=useMemo(()=>new Map(catalog.map(card=>[card.id,card.rarity])),[catalog]);
  const artworkById=useMemo(()=>new Map(catalog.map(card=>[card.id,card.artwork])),[catalog]);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      let saved: ScannerState | null = null;
      try { saved = (await loadScanBackup()) ?? null; }
      catch (e) {
        if (cancelled) return;
        setBackupStatus('브라우저 저장 확인 필요');
        if (e instanceof LegacyBackupChoice) setLegacyChoices(e.choices);
        setBackupError(e instanceof Error ? e.message : '목록 복원 실패');
      }
      let progress: Awaited<ReturnType<typeof loadScanProgress>>;
      try { progress = await loadScanProgress(); }
      catch { if (!cancelled) setBackupError('이전 진행 기록을 복원하지 못했습니다. 저장된 카드 목록은 그대로입니다.'); }
      if (cancelled) return;
      savedState.current = saved;
      setSavedBackupAvailable(!!saved);
      if (progress) {
        // A checkpoint is normally an interrupted session, never the completed
        // backup. A completed state with a receipt is restored as complete so
        // closing the tab after completion does not turn it into a failure.
        inventory.current = progress.state.cards;
        setState(progress.state);
        if (progress.state.completionReceipt) {
          clearScanIncomplete();
          setProgressRestored(false);
          setBackupStatus('완료된 스캔 결과를 복원했습니다.');
        } else {
          markScanIncomplete(['이전 스캔이 진행 중 종료되어 진행 기록을 복원했습니다']);
          setProgressRestored(true);
          setBackupStatus('진행 중이던 스캔을 복원했습니다. 이전 저장 목록은 변경하지 않았습니다.');
        }
      } else if (saved) {
        inventory.current = saved.cards;
        setState(saved);
        setBackupStatus('카드 목록은 이 브라우저에 자동 저장됩니다.');
      } else {
        setBackupStatus('카드 목록은 이 브라우저에 자동 저장됩니다.');
      }
      setBackupReady(true);
    })();
    return () => { cancelled = true; };
  }, []);
  const scanStateRef = useRef<ScannerState | null>(null);
  const busyRef = useRef(false);
  useEffect(() => { scanStateRef.current = state; }, [state]);
  useEffect(() => { busyRef.current = busy; }, [busy]);
  useEffect(() => {
    if (!busy) return;
    let cancelled = false, lastSave = 0;
    const checkpoint = () => {
      const current = scanStateRef.current;
      if (cancelled || !current || !current.cards.length) return;
      const now = Date.now();
      if (now - lastSave < 1_800) return;
      lastSave = now;
      void saveScanProgress(current).catch(() => {/* next checkpoint retries */});
    };
    const onVisibility = () => { if (document.visibilityState === 'hidden') { lastSave = 0; checkpoint(); } };
    const onPageHide = () => { lastSave = 0; checkpoint(); };
    const timer = window.setInterval(checkpoint, 2_000);
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pagehide', onPageHide);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pagehide', onPageHide);
    };
  }, [busy]);
  // Closing the tab can happen after busy becomes false but before the next
  // autosave tick. Keep the last visible scan result recoverable.
  useEffect(() => {
    const save = () => {
      const current = scanStateRef.current;
      if (!current || !current.cards.length) return;
      const incomplete = busyRef.current || scanIncompleteRef.current ||
        current.interrupted !== undefined || current.status === '스캔 중지';
      if (incomplete) void saveScanProgress(current).catch(() => {});
      else void saveScanBackup(current).catch(() => {});
    };
    const onVisibility = () => { if (document.visibilityState === 'hidden') save(); };
    window.addEventListener('pagehide', save);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('pagehide', save);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, []);
  useEffect(() => {
    if (!backupReady || !state || busy || error || scanIncompleteRef.current || state.status === '스캔 중지' || state === savedState.current) return;
    let cancelled = false;
    setBackupStatus('브라우저에 저장 중');
    void saveScanBackup(state).then(() => {
      savedState.current = state;
      setSavedBackupAvailable(true);
      // The completed list is now durable; the interrupted-scan checkpoint can
      // be released without losing the only copy of the cards.
      void clearScanProgress().catch(() => {});
      if (!cancelled) { setBackupStatus('카드 목록은 이 브라우저에 자동 저장됩니다.'); setBackupError(''); }
    }).catch(e => { if (!cancelled) { setBackupStatus('저장되지 않음'); setBackupError(e instanceof Error ? e.message : '저장 실패 · CSV로 보관해 주세요.'); } });
    return () => { cancelled = true; };
  }, [state, busy, error, backupReady, backupAttempt, scanIncomplete]);
  async function restoreBackup(legacyKey?: string) {
    setBackupReady(false);
    try {
      const saved = await loadScanBackup(legacyKey);
      savedState.current = saved ?? null;
      setSavedBackupAvailable(!!saved);
      inventory.current = saved?.cards ?? [];clearScanIncomplete();setProgressRestored(false);
      scanMonitorStore.clear();
      void clearScanProgress().catch(()=>{});
      setState(saved ?? null); setError(''); setActionError(''); setBackupError(''); setLegacyChoices([]);
      setBackupStatus('카드 목록은 이 브라우저에 자동 저장됩니다.');
    } catch (e) { if (e instanceof LegacyBackupChoice) setLegacyChoices(e.choices); setBackupError(e instanceof Error ? e.message : '목록 복원 실패'); }
    finally { setBackupReady(true); }
  }
  async function resetInventory() {
    setBackupReady(false);
    try {
      await clearScanBackup();
      await clearScanProgress().catch(()=>{});
      release(); inventory.current=[]; savedState.current=null; setState(null);clearScanIncomplete();setProgressRestored(false);setSavedBackupAvailable(false);resetScanDeadline();scanMonitorStore.clear();
      setQuery(''); setInventoryFilter('owned'); setPage(1); setResetPending(false); setError(''); setActionError(''); setBackupError('');
      setBackupStatus('카드 목록은 이 브라우저에 자동 저장됩니다.');
    } catch (e) { setBackupError(e instanceof Error ? e.message : '목록 초기화 실패'); }
    finally { setBackupReady(true); }
  }
  useEffect(() => {
    const abort = new AbortController();
    void loadCardCatalog(abort.signal)
      .then(({cards, version}) => { setCatalog(cards); setCatalogVersion(version); })
      .catch(e => { if (!abort.signal.aborted) setCatalogError(e instanceof Error ? e.message : '카드 사전 로드 실패'); });
    return () => abort.abort();
  }, [catalogAttempt]);
  function release() {
    shareAttempt.current.invalidate();
    // Keep the last monitor snapshot for review after sharing stops. A new
    // scan/import/reset clears it explicitly, so stale live data is not reused.
    scanMonitorStore.setFeedback(undefined);
    controller.current?.abort();
    controller.current = null;
    setBusy(false);
    stopShareStream(stream.current);
    stream.current = null;
    const v = video.current;
    if (v) {
      v.pause();
      v.srcObject = null;
      v.removeAttribute("src");
      v.load();
    }
    setReady(false);
    setSharing(false);
  }
  useEffect(
    () => () => {
      shareAttempt.current.invalidate();
      controller.current?.abort();
      stopShareStream(stream.current);
    },
    [],
  );
  useEffect(()=>{
    if(!import.meta.env.DEV||!recordingEnabled||busy||replayBusy||engineSettling||recordingSaving)return;
    const abort=new AbortController();
    archiveAbort.current=abort;
    let retry:ReturnType<typeof setTimeout>|undefined;
    const run=async()=>{
      let failed=false;
      try{
        const {archivePendingReplaySessions}=await import('./features/card-scanner/reproduction/dev-replay-archive');
        await archivePendingReplaySessions(abort.signal,event=>{
          if(abort.signal.aborted)return;
          if(event.state==='failed'||event.state==='waiting')failed=true;
          const current=archiveStatusSession.current;
          if(current?.id===event.id){
            const suffix=event.state==='saving'?'로컬 검증 사례 저장 중':event.state==='waiting'?'기록 봉인 대기 중 · 브라우저 기록 보호 중':event.state==='unavailable'?'재현할 입력 없음 · 브라우저 진단 보호 중':event.state==='stored'?
              event.storage==='raw'?'원시 기록 보관됨 · 재현 파일 없음 · 브라우저 기록 보호 중':event.storage==='raw-and-replay'?`원시 기록과 재현 파일 보관됨 · ${event.coverage==='partial'?'부분 기록':'재현 범위 미확인'} · 브라우저 기록 보호 중`:event.coverage==='declared-complete'?'로컬 검증 사례 보관됨':'로컬에 부분·미확인 기록 보관됨 · 브라우저 기록 보호 중'
              :'로컬 검증 사례 저장 실패 · 브라우저 기록 보호 중';
            setRecordingStatus(`${current.message} · ${suffix}`);
          }else if(!current&&(event.state==='failed'||event.state==='unavailable'))
            setRecordingStatus(event.state==='failed'?'이전 재현 기록의 로컬 보관 실패 · 브라우저 기록 보호 중':'이전 재현 기록에 입력이 없어 진단만 보호 중');
        });
      }catch{
        if(!abort.signal.aborted){failed=true;setRecordingStatus('로컬 검증 사례 보관을 확인하지 못했습니다.');}
      }
      if(failed&&!abort.signal.aborted)retry=setTimeout(()=>void run(),60_000);
    };
    void run();
    return()=>{abort.abort();clearTimeout(retry);if(archiveAbort.current===abort)archiveAbort.current=null;};
  },[recordingEnabled,busy,replayBusy,engineSettling,recordingSaving]);
  async function start() {
    await runScanLifecycle({
      inventory, state, preparation, exactPreparation, diagnosticRun, archiveAbort,
      archiveStatusSession, controller, video, stream, scanMonitorStore, recordingEnabled,
      catalogVersion, clearScanIncomplete, markScanIncomplete, noteScanProgress, publishMonitor,
      beginEngineWork, setProgressRestored, setRecordingReady, setRecordingSaving, setRecordingStatus,
      setPreparationState, setBusy, setResultView, setInventoryFilter, setPage, setEngineReady,
      engineReadyRef, setEngineCleanupUncertain, setResetPending, setCsvPending, setError,
      setActionError, setState, setSharing, setScanStartedAt, setPartialSnapshot, setPartialSnapshotError,
    });
  }

  function stopSharing() {
    closeWindowShare({guard:shareAttempt.current, controller, engineReady:engineReadyRef, stream, setSharing});
  }
  async function share() {
    if(busy || replayBusy || pendingEngines.current>0 || pendingPreparationCleanups.current>0 || preparationCleanupUncertainRef.current || csvReading || !backupReady || !catalog.length ||
      preparationState!=='ready' || (recordingEnabled&&!recordingReady&&!recordingUnavailable) || shareAttempt.current.picking())return;
    release();
    resetScanDeadline();
    syncClock();
    await openWindowShare({
      guard:shareAttempt.current, stream, controller, engineReady:engineReadyRef, video,
      preparationUncertain:()=>preparationCleanupUncertainRef.current||pendingPreparationCleanups.current>0,
      setSharePicking, setSharing, setCursorMode, setReady, setActionError,
      onStart:()=>void start(),
    });
  }

  async function readCsv(file:File) {
    setCsvReading(true);setCsvPending(null);setCsvExperience('');setActionError('');setResetPending(false);
    try {
      if(file.size>1_048_576)throw new Error('CSV 파일은 1MB 이내로 선택해 주세요.');
      const source=new TextDecoder('utf-8',{fatal:true}).decode(await file.arrayBuffer());
      setCsvPending({name:file.name,cards:parseInventoryCsv(source,catalog)});
    } catch(error) {
      setActionError(error instanceof TypeError?'UTF-8 형식의 CSV를 선택해 주세요.':error instanceof Error?error.message:'CSV를 읽지 못했습니다.');
    } finally {setCsvReading(false);}
  }
  function applyCsv() {
    if(!csvPending||busy||csvExperienceError)return;
    const imported=csvPending.cards;
    const next=csvInventoryState(imported,csvExperience);
    release();scanMonitorStore.clear();inventory.current=imported;clearScanIncomplete();setProgressRestored(false);void clearScanProgress().catch(()=>{});
    setState(next);
    setCsvPending(null);setQuery('');setInventoryFilter('owned');setPage(1);setResultView('cards');setError('');setActionError('');
  }
  function downloadInventory(blob:Blob,filename:string) {
    const object = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = object;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(object), 60000);
  }
  function markGrowthComplete(master: GrowthMaster, step: GrowthSequenceStep) {
    if (busy || !state || inventory.current !== state.cards) return;
    try {
      const next = completeGrowth(state, master, step);
      inventory.current = next.cards;
      setState(next);
      setActionError('');
    } catch (e) { setActionError(e instanceof Error ? e.message : '성장을 반영하지 못했습니다.'); }
  }
  function undoLastGrowth() {
    if (busy || !state || inventory.current !== state.cards) return;
    const next = undoGrowth(state);
    inventory.current = next.cards;
    setState(next);
    setActionError('');
  }
  const cards = state?.cards ?? [];
  function saveCsv(){
    try{
      if(unattributedFieldReviewCount(state))throw new Error('최신 판독이 확인되지 않은 입력이 있습니다. 카드 성장 탭을 다시 스캔한 뒤 저장해 주세요.');
      downloadInventory(new Blob([inventoryCsv(cards)],{type:'text/csv;charset=utf-8'}),'loacard-cards.csv');
    }
    catch(e){setActionError(e instanceof Error?e.message:'CSV 저장 실패');}
  }
  const unattributedReview = unattributedFieldReviewCount(state);
  const liveResults = useLiveResults(cards, state?.growthPoints?.current, busy);
  const unowned = useMemo(()=>unownedInventory(catalog,state,busy||!!error||scanIncomplete),[catalog,state,busy,error,scanIncomplete]);
  const csvIssues = useMemo(()=>inventoryCsvIssues(state?.cards??[]),[state?.cards]);
  const merchantIssues = busy || unowned === null ? [] : merchantCardIssues(cards, true);
  const missingCards = merchantIssues.filter(card=>card.missing);
  const uncertainIds = new Set(merchantIssues.filter(card=>!card.missing).map(card=>card.id));
  const displayCards = cards.map(card=>uncertainIds.has(card.id)&&!card.review.length ? {...card,review:['각성·장수 확인']} : card);
  const reviewCards = displayCards.filter((c) => c.review.length > 0);
  const knownReviewCards = knownReviewCardCount(reviewCards,missingCards);
  const review = Math.max(reviewCards.length,unattributedReview) + missingCards.length;
  const csvReviewCount = Math.max(csvIssues.length,unattributedReview);
  const nameIssues = (state?.unidentified ?? []).filter(item=>!item.pending);
  const duplicateInputs=useMemo(()=>duplicateRescueObservationCount(
    state?.fixedRowRescue?.records??[],new Set((state?.cards??[]).map(card=>card.id)),1),
    [state?.fixedRowRescue?.records,state?.cards]);
  const duplicateObservations=state?.duplicateUnidentifiedObservations??0;
  const inputWarnings=scanHasInputWarnings(state);
  const knownInputWarnings=nameIssues.length>0||(state?.unresolvedObservations??0)>0||(state?.droppedFrames??0)>0;
  const match = state?.expected !== null && state?.expected === cards.length;
  const stopped = state?.status === "스캔 중지" || !!state?.interrupted;
  const resultsReady=!csvReading&&!stopped&&!error&&!scanIncomplete&&cards.length>0&&!unattributedReview;
  const activeView=resultsReady?resultView:'cards';
  const showReview=()=>{setResultView('cards');requestAnimationFrame(()=>document.getElementById(unattributedReview?'unattributed-attention':'scan-attention')?.scrollIntoView({block:'start'}));};
  const scrollNotice = scrollGuidance({gaps:(state?.scrollGaps?.length ?? 0)||(state?.scrollCoverageUncertain?1:0),busy,
    expected:state?.expected ?? null,collected:state?.currentRunNames ?? cards.length,
    autoStopped:state?.autoStopped,recoverySkipped:state?.recoverySkipped});
  const finalizing = busy && state?.recoverySkipped;
  const workPhase = sharing ? 'capture' : state?.workPhase ?? 'reading';
  const previewStatus=previewFinalizationStatus({busy,sharing,engineReady,stopped,error,status:state?.status,phase:workPhase});
  // The primary status must explain why the share button is disabled. Before
  // this, an empty list said "share to start" while the button said "preparing"
  // and could not be pressed.
  const shareReadiness = sharePicking ? {title:'공유 창 선택 중',description:'공유할 로스트아크 창을 선택해 주세요.'}
    : preparationCleanupUncertain || engineCleanupUncertain ? {title:'엔진 정리 확인 필요',description:'이전 인식 엔진 종료를 확인하지 못해 새 스캔을 잠갔습니다. 페이지를 새로고침해 주세요.'}
    : replayBusy ? {title:'재현 기록 처리 중',description:'저장된 재현 기록을 처리하고 있습니다.'}
    : !backupReady ? {title:'목록 불러오는 중',description:'저장된 카드 목록을 확인하고 있습니다. 끝나면 화면을 공유해 주세요.'}
    : catalogError ? {title:'카드 사전 불러오기 실패',description:'카드 이름 기준을 불러오지 못했습니다. 다시 시도를 눌러 주세요.'}
    : !catalog.length ? {title:'카드 사전 준비 중',description:'카드 이름 기준을 불러오는 중입니다.'}
    : preparationState === 'error' ? {title:'스캔 준비 실패',description:'인식 엔진을 준비하지 못했습니다. 준비 다시 시도를 눌러 주세요.'}
    : preparationState === 'loading' ? {title:'스캔 준비 중',description:'이름·장수 인식 엔진을 준비하고 있습니다. 끝나면 화면 공유 시작을 눌러 주세요.'}
    : preparationSettling || engineSettling ? {title:'이전 준비 정리 중',description:'이전 인식 엔진을 정리하고 있습니다. 잠시만 기다려 주세요.'}
    : csvReading ? {title:'CSV 확인 중',description:'CSV 파일을 확인하고 있습니다.'}
    : recordingEnabled && !recordingReady && !recordingUnavailable ? {title:'진단 기록 준비 중',description:'진단 기록을 준비하고 있습니다. 끝나면 화면을 공유해 주세요.'}
    : null;
  const readinessStatus = !busy && !sharing && !error && !stopped && !scanIncomplete &&
    (sharePicking || csvReading || replayBusy || !cards.length) ? shareReadiness : null;
  const statusTitle = scanTimedOut ? "스캔 시간 초과" : state?.interrupted === "stalled" ? "스캔 미완료" : error ? "입력을 확인해 주세요" : busy && !engineReady ? "스캔 준비 중" : sharing ? "화면 공유 중" : previewStatus ? previewStatus.title : busy && workPhase==='cleanup' ? "스캔을 마무리하고 있어요" : busy && workPhase==='verifying' ? "판독 결과를 검증하고 있어요" : busy && workPhase==='recovery' ? "저장된 화면을 다시 확인하고 있어요" : finalizing ? "카드 검증 완료" : busy ? "카드를 읽고 있어요" : stopped ? "스캔 중지됨" : scanIncomplete ? "스캔 미완료" : readinessStatus ? readinessStatus.title : review > 0 ? "확인할 카드가 남아 있어요" : inputWarnings ? knownInputWarnings ? "확인할 입력이 남아 있어요" : "카드 목록 준비됨" : state?.autoStopped ? "전체 카드 수집 완료" : state?.status === "CSV 불러오기 완료" ? "CSV 불러오기 완료" : cards.length ? "카드 목록 준비됨" : "화면을 공유해 시작하세요";
  const statusDescription = scanTimedOut ? "스캔 진행이 일정 시간 없어 중지했습니다. 카드가 충분히 보이도록 다시 스캔해 주세요."
    : error ? error
    : busy && !engineReady ? `${state?.status ?? "화면 검출 모듈 준비 중"} · 준비가 끝나면 스크롤해 주세요.`
    : sharing ? (state?.located ? "성장 탭을 천천히 스크롤해 주세요. 읽은 카드는 아래에 쌓입니다. 공유를 종료해도 수집된 카드 판독은 계속됩니다." : "카드 보관함의 성장 탭을 찾고 있어요. 카드 화면을 보여 주세요.")
    : previewStatus ? previewStatus.description
    : readinessStatus ? readinessStatus.description
    : busy && workPhase==='cleanup' ? "판독 작업을 종료하고 임시 기록을 정리하고 있습니다."
    : busy && workPhase==='verifying' ? "보관함 수량과 카드별 판독 근거를 대조하고 있습니다."
    : busy && workPhase==='recovery' ? "빠뜨리거나 가려진 카드가 있는지 저장된 화면을 재검사하고 있습니다."
    : finalizing ? "모든 카드의 이름·각성·장수 확인을 마쳤어요. 임시 화면을 정리하고 있습니다."
    : !busy && scanIncomplete ? "최종 판독을 확인하지 못했습니다. 카드 성장 탭을 다시 보여 주세요."
    : state?.autoStopped&&!busy ? "전체 카드의 이름·각성·장수와 보관함 수량이 확인되어 화면 공유를 종료했어요."
    : state?.autoStopped&&busy ? "전체 카드 화면을 확보해 공유를 종료했어요. 저장한 이미지로 남은 장수·각성을 확인하고 있습니다."
    : busy ? "공유는 종료됐어요. 수집한 화면에서 남은 카드를 확인하고 있습니다."
    : cards.length ? "같은 보관함을 다시 공유하면 기존 목록에 추가로 반영합니다."
    : "로스트아크 카드 보관함의 성장 탭을 열어 주세요.";
  const scanSummary = <ScannerSummary state={state} cardsLength={cards.length} match={match} review={review}
    inputWarnings={inputWarnings} knownReviewCards={knownReviewCards} unattributedReview={unattributedReview}
    nameIssueCount={nameIssues.length} duplicateInputs={duplicateInputs}
    scanMonitorStore={scanMonitorStore} busy={busy} />;
  return (
    <AppShell activeView={activeView} onViewChange={setResultView}
      onBrandClick={()=>{setResultView('cards');setInventoryFilter('owned');setQuery('');setPage(1);}}
      resultsReady={resultsReady} cardCount={cards.length}
      navHint={unattributedReview ? '최신 판독 확인이 필요합니다. 카드 성장 탭을 다시 공유해 주세요.' : busy ? '읽은 카드부터 각 메뉴에 반영합니다.' : review > 0 || nameIssues.length > 0 ? '강조된 카드를 다시 보여 주세요.' : !cards.length ? '스캔하거나 CSV를 불러오면 시작할 수 있어요.' : undefined}
      busy={busy} csvReading={csvReading} engineReady={engineReady} backupStatus={backupStatus} catalogVersion={catalogVersion}
      guideOpen={guideOpen} onGuideOpen={()=>setGuideOpen(true)} onGuideClose={()=>setGuideOpen(false)}
      diagnosticsDisabled={busy||csvReading} onDiagnostics={()=>{setGuideOpen(false);setReplayOpen(true);}}>
      {actionError && <p className="error" role="alert">{actionError}<button className="text-button" onClick={() => setActionError('')}>닫기</button></p>}
      {busy && activeView!=='cards' && <div className="notice" role="status">
        <span className="scan-spinner" aria-hidden="true" /> 스캔 중 · <ScanReadCount completed={state?.currentRunRead ?? 0} expected={state?.expected ?? null} store={scanMonitorStore} inline/> 판독 · 결과 갱신 중
        <p>현재까지 확인한 목록 기준입니다. 재스캔은 기존 목록을 갱신하며, 미스캔 카드는 미등록으로 확정하지 않습니다.</p>
        <button className="text-button" onClick={()=>setResultView('cards')}>스캔 진행 보기</button>
      </div>}
      {activeView!=='cards' && scanSummary}
      {!!state?.growthHistory?.length && <div className="growth-completion-notice" role="status">
        <span>{state.growthHistory.at(-1)!.label} · 성장 반영됨 <small>경험치는 다음 스캔에서 갱신</small></span>
        <button className="text-button" disabled={busy} onClick={undoLastGrowth}>성장 실행 취소</button>
      </div>}
      <section id="panel-cards" role="tabpanel" aria-labelledby="view-cards" hidden={activeView!=='cards'}>
      {backupReady && !cards.length && !busy && !sharing && !csvReading && <ScanQuickStart onHelp={() => setGuideOpen(true)} />}
      <ScannerWorkspace
        sharing={sharing} onStopSharing={stopSharing} onShare={()=>void share()}
        sharePicking={sharePicking} busy={busy} replayBusy={replayBusy}
        engineSettling={engineSettling} preparationSettling={preparationSettling}
        preparationCleanupUncertain={preparationCleanupUncertain} engineCleanupUncertain={engineCleanupUncertain}
        csvReading={csvReading} backupReady={backupReady} catalogLength={catalog.length}
        preparationState={preparationState} recordingEnabled={recordingEnabled}
        recordingReady={recordingReady} recordingUnavailable={recordingUnavailable}
        recordingPreparation={recordingPreparation} recordingStatus={recordingStatus}
        onAbort={()=>controller.current?.abort()} controller={controller}
        onResetRequest={()=>{setResetPending(!resetPending);setCsvPending(null);}}
        onResetCancel={()=>setResetPending(false)} onResetConfirm={()=>void resetInventory()} resetPending={resetPending}
        onSaveCsv={saveCsv} onCsvFile={file=>void readCsv(file)}
        cardsLength={cards.length} scanIncomplete={scanIncomplete} csvReviewCount={csvReviewCount}
        unattributedReview={unattributedReview} csvIssues={csvIssues} state={state}
        scanIncompleteReasons={scanIncompleteReasons} progressRestored={progressRestored}
        savedBackupAvailable={savedBackupAvailable} onRestoreBackup={()=>void restoreBackup()}
        preparationMessage={preparationMessage} onRetryPreparation={()=>setPreparationAttempt(value=>value+1)}
        csvPending={csvPending} csvExperience={csvExperience} csvExperienceError={csvExperienceError}
        onCsvExperience={setCsvExperience} onCsvCancel={()=>setCsvPending(null)} onCsvApply={applyCsv}
        error={error} stopped={stopped} review={review} inputWarnings={inputWarnings}
        statusTitle={statusTitle} statusDescription={statusDescription}
        scanTimedOut={scanTimedOut} inputState={inputState} deadline={deadline} deadlineText={deadlineText}
        cursorMode={cursorMode} engineReady={engineReady} scanMonitorStore={scanMonitorStore}
        workPhase={workPhase} scanStartedAt={scanStartedAt}
        video={video} ready={ready} onReady={()=>setReady(true)}
        onVideoError={()=>setError("공유 화면을 표시할 수 없습니다.")} monitorLatency={monitorLatency}
      />
      {replayOpen&&<ScanReplayDialog open onClose={()=>setReplayOpen(false)} onBusy={setReplayBusy} beginEngineWork={beginEngineWork} onEngineCleanupUncertain={()=>setEngineCleanupUncertain(true)} engineBusy={engineSettling||preparationSettling||preparationCleanupUncertain} takePrepared={configuration=>{
        setPreparationState('loading');return takeMatchingPreparedScanner(()=>preparation.current?.take(),configuration);
      }}
        recordingEnabled={recordingEnabled} onRecordingChange={enabled=>{setRecordingEnabled(enabled);setRecordingReady(false);}}
        recordingBusy={busy||recordingSaving} recordingPreparation={busy?'현재 화면을 기록하고 있습니다.':recordingSaving?'이전 진단 기록 저장 중':recordingEnabled?recordingPreparation:undefined}/>}
      {import.meta.env.DEV&&<PartialArchivePanel snapshot={partialSnapshot}/>}
      {import.meta.env.DEV&&partialSnapshotError&&<p className="notice" role="alert">부분 기록을 준비하지 못했습니다. 현재 스캔 결과는 이 탭에만 남습니다.</p>}
      {catalogError && <p className="error" role="alert">{catalogError} <button className="text-button" onClick={() => { setCatalogError(''); setCatalogAttempt(n => n + 1); }}>다시 시도</button></p>}
      {legacyChoices.length > 0 && <div className="notice" role="group" aria-label="이전 백업 선택">{legacyChoices.map((item, i) => <Button key={item.key} disabled={!backupReady || busy} onClick={() => void restoreBackup(item.key)} title={item.names}>백업 {i + 1} · {item.count}종 · 경험치 {item.xp?.toLocaleString('ko-KR') ?? '미확인'}</Button>)}</div>}
      {backupError && <div className="notice" role="alert"><p>{backupError}</p>{!!state && <button className="text-button" disabled={busy || !backupReady} onClick={() => setBackupAttempt(n => n + 1)}>저장 다시 시도</button>}<button className="text-button" disabled={busy || !backupReady} onClick={() => void restoreBackup()}>현재 목록 대신 저장 목록 불러오기</button><span> · 현재 목록은 먼저 CSV로 보관해 주세요.</span></div>}
      {error && <p className="error" role="alert">{error}<button className="text-button" onClick={() => setError("")}>닫기</button></p>}
      {state?.captureWarning && <p className="notice" role="alert">{state.captureWarning}</p>}
      {state?.headerConflict && <p className="notice" role="alert">{HEADER_CONFLICT_WARNING}</p>}
      {busy && state?.processingWarning && <p className="notice" role="status">{state.processingWarning}</p>}
      {!!state?.droppedFrames && state.captureWarning!==LIVE_INPUT_LOSS_MESSAGE && <p className="notice" role="alert">일부 화면을 처리하지 못했습니다. 화면 공유를 종료한 뒤 처음부터 다시 스캔해 주세요.</p>}
      {!busy && !state?.droppedFrames && (state?.unresolvedObservations??0)>0 && nameIssues.length===0 && <p className="notice" role="alert">연결되지 않은 화면 입력이 남아 있습니다. 새로 스캔해 확인해 주세요.</p>}
      {scanSummary}
      {duplicateObservations>0&&<p className="muted">같은 카드 중복 관측 {duplicateObservations}건은 카드 수에 더하지 않았습니다.</p>}
      {unattributedReview>0&&<section id="unattributed-attention" className="notice" role="alert">
        <strong>{state?.unresolvedFieldChanges ? '확인할 화면 관측이 남아 있습니다.' : '이전 목록의 최신 각성·장수 확인이 필요합니다.'}</strong>
        <p>저장된 판독 근거만으로는 해당 카드를 특정할 수 없습니다. 전체 목록을 다시 공유해 주세요. 확인 전에는 CSV 저장과 계산 메뉴를 사용할 수 없습니다.</p>
      </section>}
      <ScanAttention cards={reviewCards} unknown={sharing || busy ? nameIssues : []} discarded={state?.discardedObservations ?? (!sharing && !busy ? nameIssues : [])} missing={missingCards} artworkById={artworkById} pendingFields={state?.pendingFields ?? []} evidenceLost={state?.unknownEvidenceLost===true} recognitionNeeded={state?.recognitionNeeded ?? []}
        sharing={sharing} busy={busy} queued={state?.queued} activeReadings={state?.activeReadings}/>
      {scrollNotice && <section className="notice" aria-label={scrollNotice==='collecting'?'수집 구간 참고':'다시 보여줄 스크롤 구간'}>
        <strong>{!state?.scrollGaps?.length?'지나간 구간 확인':scrollNotice==='collecting'?'빠르게 지나간 구간이 있어요':'지나간 구간을 한 번 더 보여 주세요'}</strong>
        <p>{!state?.scrollGaps?.length?'스크롤 위치를 일시적으로 확인하지 못해 이전 구간을 다시 살펴봐야 할 수 있어요.':scrollNotice==='collecting'?'판독 후 누락 여부를 확인합니다.':
          `이번 입력에서 전체 카드 이름을 확인하지 못했어요. 스크롤바 ${state.scrollGaps.slice(0,4).map(gap=>`${Math.round(gap.from*100)}~${Math.round(gap.to*100)}%`).join(' · ')}${state.scrollGaps.length>4 ? ` 외 ${state.scrollGaps.length-4}구간` : ''} 부근을 다시 보여 주세요.`}</p>
      </section>}
      <InventoryWorkspace cards={displayCards} unowned={unowned} query={query} onQueryChange={setQuery}
        inventoryFilter={inventoryFilter} onFilterChange={setInventoryFilter} page={page} onPageChange={setPage}
        state={state} rarityById={rarityById} artworkById={artworkById} />
      </section>
      <section id="panel-merchants" role="tabpanel" aria-labelledby="view-merchants" hidden={activeView!=='merchants'}>{activeView==='merchants' && <MerchantAlerts cards={liveResults.cards} busy={busy} complete={unowned!==null} rarityById={rarityById} onReview={showReview} />}</section>
      <section id="panel-growth" role="tabpanel" aria-labelledby="view-growth" hidden={activeView!=='growth'}>{activeView==='growth' && <GrowthPlanner cards={liveResults.cards} growthPoints={liveResults.xp} busy={busy} complete={unowned!==null} onComplete={markGrowthComplete} />}</section>
      <section id="panel-raid" role="tabpanel" aria-labelledby="view-raid" hidden={activeView!=='raid'}>{activeView==='raid' && <RaidCards cards={liveResults.cards} complete={unowned!==null} xp={liveResults.xp} />}</section>
    </AppShell>
  );
}
export default App;
