import Button from '@mui/material/Button';
import {useEffect,useMemo,useRef,useState} from "react";
import {ScanQuickStart} from './ui/UsageGuide';
import {AppShell} from './app/AppShell';
import {InventoryWorkspace} from './app/InventoryWorkspace';
import {ScannerSummary} from './app/ScannerSummary';
import {ScannerWorkspace} from './app/ScannerWorkspace';
import {useScanMonitorSession,useScannerClock,useScannerPreparation} from './app/use-scanner-session';
import {closeWindowShare,openWindowShare,stopShareStream} from './app/share-commands';
import {runScanLifecycle} from './app/scan-lifecycle';
import {createShareAttemptGuard} from './features/card-scanner/capture/share-stream-owner';
import {deferredPanel} from './ui/DeferredPanel';
import {ScanReadCount} from './features/card-scanner/ui/ScanReadProgress';
import {scanHasInputWarnings} from './features/card-scanner/session/scan-monitor-outcome';
import {previewFinalizationStatus} from './features/card-scanner/ui/preview-finalization-status';
import {monotonicNow} from './features/card-scanner/capture/monotonic-clock';
import {ScanAttention} from './features/card-scanner/ui/ScanAttention';
import {knownReviewCardCount} from './features/card-scanner/ui/review-display';
import type {ScannerState} from "./features/card-scanner/orchestration/scanner";
import type {ScannedCard} from "./features/card-scanner/recognition/recognizer";
import "./App.css";
import {useLiveResults} from './features/use-live-results';
import {loadCardCatalog} from './data/catalog';
import {completeGrowth,undoGrowth} from './features/growth/complete-growth';
import type {GrowthMaster} from './features/growth/optimizer';
import type {GrowthSequenceStep} from './features/growth/growth-sequence';
import {merchantCardIssues} from './features/merchants/merchant-progress';
import {inventoryCsv,inventoryCsvIssues,parseInventoryCsv,parseCsvExperience,csvInventoryState} from './inventory-csv';
import type {CsvCatalogCard} from './inventory-csv';
import {unownedInventory} from './inventory-unowned';
import {loadScanBackup,saveScanBackup,clearScanBackup,LegacyBackupChoice} from "./features/card-scanner/persistence/scan-backup";
import {clearScanProgress,loadScanProgress,saveScanProgress} from "./features/card-scanner/persistence/progress-backup";
const MerchantAlerts = deferredPanel(async () => ({default:(await import('./features/merchants/MerchantAlerts')).MerchantAlerts}));
const GrowthPlanner = deferredPanel(async () => ({default:(await import('./features/growth/GrowthPlanner')).GrowthPlanner}));
const RaidCards = deferredPanel(async () => ({default:(await import('./features/raid/RaidCards')).RaidCards}));

function App() {
  const [guideOpen, setGuideOpen] = useState(false);
  const video = useRef<HTMLVideoElement>(null);
  const stream = useRef<MediaStream | null>(null);
  const shareAttempt=useRef(createShareAttemptGuard());
  const [sharePicking,setSharePicking]=useState(false);
  const controller = useRef<AbortController | null>(null);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const {store:scanMonitorStore,publish:publishMonitor}=useScanMonitorSession();
  const pendingEngines=useRef(0);
  const [engineSettling,setEngineSettling]=useState(false);
  const [engineCleanupUncertain,setEngineCleanupUncertain]=useState(false);
  const [scanIncomplete,setScanIncomplete]=useState(false);
  const scanIncompleteRef=useRef(false);
  const [scanIncompleteReasons,setScanIncompleteReasons]=useState<string[]>([]);
  const [progressRestored,setProgressRestored]=useState(false);
  const [savedBackupAvailable,setSavedBackupAvailable]=useState(false);
  function markScanIncomplete(reasons:string[]){scanIncompleteRef.current=true;setScanIncomplete(true);setScanIncompleteReasons(reasons);}
  function clearScanIncomplete(){scanIncompleteRef.current=false;setScanIncomplete(false);setScanIncompleteReasons([]);}
  function beginEngineWork(){
    pendingEngines.current++;setEngineSettling(true);let released=false;
    return()=>{if(released)return;released=true;pendingEngines.current--;setEngineSettling(pendingEngines.current>0);};
  }
  const {preparation,preparationState,setPreparationState,preparationMessage,
    setPreparationAttempt,preparationCleanupUncertainRef,preparationCleanupUncertain,
    pendingPreparationCleanups,preparationSettling}=
    useScannerPreparation({busy,engineSettling,onCleanupUncertain:()=>controller.current?.abort()});
  const [engineReady, setEngineReady] = useState(false);
  const [scanStartedAt, setScanStartedAt] = useState(0);
  const engineReadyRef = useRef(false);
  const [sharing, setSharing] = useState(false);
  const [cursorMode,setCursorMode]=useState<'unknown'|'excluded'|'included'|'unsupported'>('unknown');
  const [firstInputAt,setFirstInputAt]=useState<number|null>(null);
  const [lastInputAt,setLastInputAt]=useState<number|null>(null);
  const [lastProgressAt,setLastProgressAt]=useState<number|null>(null);
  const holdIdleRef=useRef(false);
  const inputProgress=useRef({sampled:0,read:0,names:0,percent:0,phase:''});
  const {scanTimedOut,deadline,inputState,deadlineText,resetTimeout,syncClock}=useScannerClock({
    sharing,firstInputAt,lastInputAt,lastProgressAt,holdIdle:holdIdleRef,onTimeout:stopSharing,
  });
  const resetScanDeadline=()=>{
    setFirstInputAt(null);setLastInputAt(null);setLastProgressAt(null);holdIdleRef.current=false;
    inputProgress.current={sampled:0,read:0,names:0,percent:0,phase:''};resetTimeout();
  };
  const noteScanProgress=(next:ScannerState)=>{
    const now=monotonicNow(),previous=inputProgress.current;
    const sampled=next.sampled??0,read=next.currentRunRead??0,names=next.currentRunNames??0;
    const percent=next.percent??0,phase=next.workPhase??'';
    const active=(next.queued??0)>0||(next.activeReadings??0)>0;
    holdIdleRef.current=next.cards.some(card=>card.review.length>0);
    if(sampled>0||read>0||names>0)setFirstInputAt(current=>current??now);
    if(sampled>previous.sampled||read>previous.read||names>previous.names)setLastInputAt(now);
    if(active||sampled>previous.sampled||read>previous.read||names>previous.names||
      percent>previous.percent||phase!==previous.phase)
      setLastProgressAt(now);
    inputProgress.current={sampled,read,names,percent,phase};
  };
  const [error, setError] = useState("");
  const [actionError, setActionError] = useState('');
  const [backupReady, setBackupReady] = useState(false);
  const [backupStatus, setBackupStatus] = useState('목록 불러오는 중');
  const [backupError, setBackupError] = useState('');
  const [backupAttempt, setBackupAttempt] = useState(0);
  const [legacyChoices, setLegacyChoices] = useState<LegacyBackupChoice['choices']>([]);
  const savedState = useRef<ScannerState | null>(null);
  /** The list on screen before a scan that ended incomplete replaced it. */
  const [replacedState, setReplacedState] = useState<ScannerState | null>(null);
  const backupReadyRef = useRef(false);
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
  useEffect(() => { backupReadyRef.current = backupReady; }, [backupReady]);
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
      // Not while the saved list is being loaded, cleared or replaced (a reset would come back).
      if (!backupReadyRef.current || !current || !current.cards.length) return;
      const incomplete = busyRef.current || scanIncompleteRef.current ||
        current.interrupted !== undefined || current.status === '스캔 중지';
      if (incomplete) void saveScanProgress(current).catch(() => {});
      else if (current !== savedState.current)
        // A completed list saved now replaces any interrupted-scan checkpoint, so a reload shows it.
        void saveScanBackup(current).then(() => { savedState.current = current; return clearScanProgress(); }).catch(() => {});
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
      setReplacedState(null); resetScanDeadline();
      setBackupStatus('카드 목록은 이 브라우저에 자동 저장됩니다.');
    } catch (e) { if (e instanceof LegacyBackupChoice) setLegacyChoices(e.choices); setBackupError(e instanceof Error ? e.message : '목록 복원 실패'); }
    finally { setBackupReady(true); }
  }
  async function resetInventory() {
    setBackupReady(false);
    try {
      await clearScanBackup();
      await clearScanProgress().catch(()=>{});
      release(); inventory.current=[]; savedState.current=null; setState(null);clearScanIncomplete();setReplacedState(null);setProgressRestored(false);setSavedBackupAvailable(false);resetScanDeadline();scanMonitorStore.clear();
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
  async function start() {
    await runScanLifecycle({
      inventory, state, preparation, controller, video, stream, scanMonitorStore,
      clearScanIncomplete, markScanIncomplete, noteScanProgress, publishMonitor,
      beginEngineWork, setProgressRestored,
      setPreparationState, setBusy, setResultView, setInventoryFilter, setPage, setEngineReady,
      engineReadyRef, setEngineCleanupUncertain, setResetPending, setCsvPending, setError,
      setActionError, setState, setSharing, setScanStartedAt, setReplacedState,
    });
  }
  /** Back to the list a scan that ended incomplete replaced on screen (the saved list was never changed). */
  function restoreReplaced() {
    if (!replacedState || busy) return;
    inventory.current = replacedState.cards; scanMonitorStore.clear();
    clearScanIncomplete(); setProgressRestored(false); resetScanDeadline();
    setState(replacedState); setReplacedState(null); setError(''); setActionError('');
  }

  function stopSharing() {
    closeWindowShare({guard:shareAttempt.current, controller, engineReady:engineReadyRef, stream, setSharing});
  }
  async function share() {
    if(busy || pendingEngines.current>0 || pendingPreparationCleanups.current>0 || preparationCleanupUncertainRef.current || csvReading || !backupReady || !catalog.length ||
      preparationState!=='ready' || shareAttempt.current.picking())return;
    // The scan reads the share track off the main thread (MediaStreamTrackProcessor, a transferable
    // stream): say so before the picker opens, not after.
    if (typeof (globalThis as {MediaStreamTrackProcessor?:unknown}).MediaStreamTrackProcessor !== 'function') {
      setActionError('이 브라우저에서는 카드 스캔을 할 수 없습니다. Chrome 또는 Edge 최신 버전을 사용해 주세요.');return;
    }
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
    setReplacedState(null);resetScanDeadline();
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
      downloadInventory(new Blob([inventoryCsv(cards)],{type:'text/csv;charset=utf-8'}),'loacard-cards.csv');
    }
    catch(e){setActionError(e instanceof Error?e.message:'CSV 저장 실패');}
  }
  const liveResults = useLiveResults(cards, state?.growthPoints?.current, busy);
  const unowned = useMemo(()=>unownedInventory(catalog,state,busy||!!error||scanIncomplete),[catalog,state,busy,error,scanIncomplete]);
  const csvIssues = useMemo(()=>inventoryCsvIssues(state?.cards??[]),[state?.cards]);
  const merchantIssues = busy || unowned === null ? [] : merchantCardIssues(cards, true);
  const missingCards = merchantIssues.filter(card=>card.missing);
  const uncertainIds = new Set(merchantIssues.filter(card=>!card.missing).map(card=>card.id));
  // While the scan runs, a card whose values are not confirmed yet is progress, not something to
  // check: it is usually confirmed a moment later, and the counts and the list map already show it.
  // Showing it made the review notices and the card tiles' review lines appear and vanish during
  // every scan. Values not read yet still show as '?'; the saved list keeps every review reason.
  const displayCards = busy ? cards.map(card=>card.review.length ? {...card,review:[]} : card)
    : cards.map(card=>uncertainIds.has(card.id)&&!card.review.length ? {...card,review:['각성·장수 확인']} : card);
  const reviewCards = displayCards.filter((c) => c.review.length > 0);
  const knownReviewCards = knownReviewCardCount(reviewCards,missingCards);
  const review = reviewCards.length + missingCards.length;
  const csvReviewCount = csvIssues.length;
  const nameIssues = (state?.unidentified ?? []).filter(item=>!item.pending);
  const inputWarnings=scanHasInputWarnings(state);
  const knownInputWarnings=nameIssues.length>0||(state?.unresolvedObservations??0)>0||(state?.droppedFrames??0)>0;
  const match = state?.expected !== null && state?.expected === cards.length;
  const stopped = state?.status === "스캔 중지" || !!state?.interrupted;
  const resultsReady=!csvReading&&!stopped&&!error&&!scanIncomplete&&cards.length>0;
  const activeView=resultsReady?resultView:'cards';
  const showReview=()=>{setResultView('cards');requestAnimationFrame(()=>document.getElementById('scan-attention')?.scrollIntoView({block:'start'}));};
  const workPhase = sharing ? 'capture' : state?.workPhase ?? 'reading';
  const previewStatus=previewFinalizationStatus({busy,sharing,engineReady,stopped,error,status:state?.status,phase:workPhase});
  // The primary status must explain why the share button is disabled. Before
  // this, an empty list said "share to start" while the button said "preparing"
  // and could not be pressed.
  const shareReadiness = sharePicking ? {title:'공유 창 선택 중',description:'공유할 로스트아크 창을 선택해 주세요.'}
    : preparationCleanupUncertain || engineCleanupUncertain ? {title:'엔진 정리 확인 필요',description:'이전 인식 엔진 종료를 확인하지 못해 새 스캔을 잠갔습니다. 페이지를 새로고침해 주세요.'}
    : !backupReady ? {title:'목록 불러오는 중',description:'저장된 카드 목록을 확인하고 있습니다. 끝나면 화면을 공유해 주세요.'}
    : catalogError ? {title:'카드 사전 불러오기 실패',description:'카드 이름 기준을 불러오지 못했습니다. 다시 시도를 눌러 주세요.'}
    : !catalog.length ? {title:'카드 사전 준비 중',description:'카드 이름 기준을 불러오는 중입니다.'}
    : preparationState === 'error' ? {title:'스캔 준비 실패',description:'인식 엔진을 준비하지 못했습니다. 준비 다시 시도를 눌러 주세요.'}
    : preparationState === 'loading' ? {title:'스캔 준비 중',description:'이름·장수 인식 엔진을 준비하고 있습니다. 끝나면 화면 공유 시작을 눌러 주세요.'}
    : preparationSettling || engineSettling ? {title:'이전 준비 정리 중',description:'이전 인식 엔진을 정리하고 있습니다. 잠시만 기다려 주세요.'}
    : csvReading ? {title:'CSV 확인 중',description:'CSV 파일을 확인하고 있습니다.'}
    : null;
  const readinessStatus = !busy && !sharing && !error && !stopped && !scanIncomplete &&
    (sharePicking || csvReading || !cards.length) ? shareReadiness : null;
  const statusTitle = scanTimedOut ? "스캔 시간 초과" : state?.interrupted === "stalled" ? "스캔 미완료" : error ? "입력을 확인해 주세요" : busy && !engineReady ? "스캔 준비 중" : sharing ? "화면 공유 중" : previewStatus ? previewStatus.title : busy && workPhase==='cleanup' ? "스캔을 마무리하고 있어요" : busy && workPhase==='verifying' ? "판독 결과를 검증하고 있어요" : busy ? "카드를 읽고 있어요" : stopped ? "스캔 중지됨" : scanIncomplete ? "스캔 미완료" : readinessStatus ? readinessStatus.title : review > 0 ? "확인할 카드가 남아 있어요" : inputWarnings ? knownInputWarnings ? "확인할 입력이 남아 있어요" : "카드 목록 준비됨" : state?.autoStopped ? "전체 카드 수집 완료" : state?.status === "CSV 불러오기 완료" ? "CSV 불러오기 완료" : cards.length ? "카드 목록 준비됨" : "화면을 공유해 시작하세요";
  const statusDescription = scanTimedOut ? "스캔 진행이 일정 시간 없어 중지했습니다. 카드가 충분히 보이도록 다시 스캔해 주세요."
    : error ? error
    : busy && !engineReady ? `${state?.status ?? "화면 검출 모듈 준비 중"} · 준비가 끝나면 스크롤해 주세요.`
    : sharing ? (state?.located ? "성장 탭을 천천히 스크롤해 주세요. 읽은 카드는 아래에 쌓입니다. 공유를 종료해도 수집된 카드 판독은 계속됩니다." : "카드 보관함의 성장 탭을 찾고 있어요. 카드 화면을 보여 주세요.")
    : previewStatus ? previewStatus.description
    : readinessStatus ? readinessStatus.description
    : busy && workPhase==='cleanup' ? "판독 작업을 종료하고 임시 기록을 정리하고 있습니다."
    : busy && workPhase==='verifying' ? "보관함 수량과 카드별 판독 근거를 대조하고 있습니다."
    : !busy && scanIncomplete ? "최종 판독을 확인하지 못했습니다. 카드 성장 탭을 다시 보여 주세요."
    : state?.autoStopped&&!busy ? "전체 카드의 이름·각성·장수와 보관함 수량이 확인되어 화면 공유를 종료했어요."
    : state?.autoStopped&&busy ? "전체 카드 화면을 확보해 공유를 종료했어요. 저장한 이미지로 남은 장수·각성을 확인하고 있습니다."
    : busy ? "공유는 종료됐어요. 수집한 화면에서 남은 카드를 확인하고 있습니다."
    : cards.length ? "다시 스캔하면 목록을 처음부터 읽고, 끝까지 확인되면 이 목록을 새 결과로 바꿉니다."
    : "로스트아크 카드 보관함의 성장 탭을 열어 주세요.";
  const scanSummary = <ScannerSummary state={state} cardsLength={cards.length} match={match} review={review}
    inputWarnings={inputWarnings} knownReviewCards={knownReviewCards}
    nameIssueCount={nameIssues.length}
    scanMonitorStore={scanMonitorStore} busy={busy} />;
  return (
    <AppShell activeView={activeView} onViewChange={setResultView}
      onBrandClick={()=>{setResultView('cards');setInventoryFilter('owned');setQuery('');setPage(1);}}
      resultsReady={resultsReady} cardCount={cards.length}
      navHint={busy ? '읽은 카드부터 각 메뉴에 반영합니다.' : review > 0 || nameIssues.length > 0 ? '강조된 카드를 다시 보여 주세요.' : !cards.length ? '스캔하거나 CSV를 불러오면 시작할 수 있어요.' : undefined}
      busy={busy} csvReading={csvReading} engineReady={engineReady} backupStatus={backupStatus} catalogVersion={catalogVersion}
      guideOpen={guideOpen} onGuideOpen={()=>setGuideOpen(true)} onGuideClose={()=>setGuideOpen(false)}>
      {actionError && <p className="error" role="alert">{actionError}<button className="text-button" onClick={() => setActionError('')}>닫기</button></p>}
      {busy && activeView!=='cards' && <div className="notice" role="status">
        <span className="scan-spinner" aria-hidden="true" /> 스캔 중 · <ScanReadCount completed={state?.currentRunRead ?? 0} expected={state?.expected ?? null} store={scanMonitorStore} inline/> 판독 · 결과 갱신 중
        <p>지금까지 읽은 카드 기준입니다. 스캔이 끝까지 확인되기 전에는 읽지 못한 카드를 미등록으로 보지 않습니다.</p>
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
        sharePicking={sharePicking} busy={busy}
        engineSettling={engineSettling} preparationSettling={preparationSettling}
        preparationCleanupUncertain={preparationCleanupUncertain} engineCleanupUncertain={engineCleanupUncertain}
        csvReading={csvReading} backupReady={backupReady} catalogLength={catalog.length}
        preparationState={preparationState}
        onAbort={()=>controller.current?.abort()} controller={controller}
        onResetRequest={()=>{setResetPending(!resetPending);setCsvPending(null);}}
        onResetCancel={()=>setResetPending(false)} onResetConfirm={()=>void resetInventory()} resetPending={resetPending}
        onSaveCsv={saveCsv} onCsvFile={file=>void readCsv(file)}
        cardsLength={cards.length} scanIncomplete={scanIncomplete} csvReviewCount={csvReviewCount}
        csvIssues={csvIssues} state={state}
        scanIncompleteReasons={scanIncompleteReasons} progressRestored={progressRestored}
        savedBackupAvailable={savedBackupAvailable} onRestoreBackup={()=>void restoreBackup()}
        replacedAvailable={!!replacedState} onRestoreReplaced={restoreReplaced}
        preparationMessage={preparationMessage} onRetryPreparation={()=>setPreparationAttempt(value=>value+1)}
        csvPending={csvPending} csvExperience={csvExperience} csvExperienceError={csvExperienceError}
        onCsvExperience={setCsvExperience} onCsvCancel={()=>setCsvPending(null)} onCsvApply={applyCsv}
        error={error} stopped={stopped} review={review} inputWarnings={inputWarnings}
        statusTitle={statusTitle} statusDescription={statusDescription}
        scanTimedOut={scanTimedOut} inputState={inputState} deadline={deadline} deadlineText={deadlineText}
        cursorMode={cursorMode} engineReady={engineReady} scanMonitorStore={scanMonitorStore}
        workPhase={workPhase} scanStartedAt={scanStartedAt}
        video={video} ready={ready} onReady={()=>setReady(true)}
        onVideoError={()=>setError("공유 화면을 표시할 수 없습니다.")}
      />
      {catalogError && <p className="error" role="alert">{catalogError} <button className="text-button" onClick={() => { setCatalogError(''); setCatalogAttempt(n => n + 1); }}>다시 시도</button></p>}
      {legacyChoices.length > 0 && <div className="notice" role="group" aria-label="이전 백업 선택">{legacyChoices.map((item, i) => <Button key={item.key} disabled={!backupReady || busy} onClick={() => void restoreBackup(item.key)} title={item.names}>백업 {i + 1} · {item.count}종 · 경험치 {item.xp?.toLocaleString('ko-KR') ?? '미확인'}</Button>)}</div>}
      {backupError && <div className="notice" role="alert"><p>{backupError}</p>{!!state && <button className="text-button" disabled={busy || !backupReady} onClick={() => setBackupAttempt(n => n + 1)}>저장 다시 시도</button>}<button className="text-button" disabled={busy || !backupReady} onClick={() => void restoreBackup()}>현재 목록 대신 저장 목록 불러오기</button><span> · 현재 목록은 먼저 CSV로 보관해 주세요.</span></div>}
      {error && <p className="error" role="alert">{error}<button className="text-button" onClick={() => setError("")}>닫기</button></p>}
      {state?.resolutionNotice && <p className="notice" role="status">{state.resolutionNotice}</p>}
      {busy && state?.processingWarning && <p className="notice" role="status">{state.processingWarning}</p>}
      {!!state?.droppedFrames && <p className="notice" role="alert">일부 화면을 처리하지 못했습니다. 화면 공유를 종료한 뒤 처음부터 다시 스캔해 주세요.</p>}
      {!busy && !state?.droppedFrames && (state?.unresolvedObservations??0)>0 && nameIssues.length===0 && <p className="notice" role="alert">연결되지 않은 화면 입력이 남아 있습니다. 새로 스캔해 확인해 주세요.</p>}
      {scanSummary}
      <ScanAttention cards={reviewCards} unknown={sharing || busy ? nameIssues : []} discarded={!sharing && !busy ? nameIssues : []} missing={missingCards} artworkById={artworkById} guidance={state?.listGuidance}
        sharing={sharing} busy={busy} queued={state?.queued} activeReadings={state?.activeReadings}/>
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
