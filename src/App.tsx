import Button from '@mui/material/Button';
import TextField from '@mui/material/TextField';
import InputAdornment from '@mui/material/InputAdornment';
import ToggleButton from '@mui/material/ToggleButton';
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup';
import ScreenShareOutlined from '@mui/icons-material/ScreenShareOutlined';
import StopCircleOutlined from '@mui/icons-material/StopCircleOutlined';
import FileDownloadOutlined from '@mui/icons-material/FileDownloadOutlined';
import FileUploadOutlined from '@mui/icons-material/FileUploadOutlined';
import RestartAltOutlined from '@mui/icons-material/RestartAltOutlined';
import SearchOutlined from '@mui/icons-material/SearchOutlined';
import HelpOutline from '@mui/icons-material/HelpOutlined';
import GitHub from '@mui/icons-material/GitHub';
import IconButton from '@mui/material/IconButton';
import Tooltip from '@mui/material/Tooltip';
import { ScanQuickStart, UsageGuide } from './ui/UsageGuide';
import { ThemeToggle } from './ui/AppTheme';
import { WorkspaceNavigation } from './ui/WorkspaceNavigation';
import { memo, startTransition, useEffect, useMemo, useRef, useState } from "react";
import { createLatestPublisher } from './latest-publisher';
import { runScanner } from "./features/card-scanner/scanner";
import { prepareScanner } from './features/card-scanner/scanner-preparation';
import type { PreparedScanner } from './features/card-scanner/scanner-preparation';
import { createPreparedSlot } from './features/card-scanner/prepared-slot';
import { createPreparationFeedback } from './features/card-scanner/preparation-feedback';
import { ScanReadProgress } from './features/card-scanner/ScanReadProgress';
import { scrollGuidance } from './features/card-scanner/scroll-guidance';
import type { ScannerState } from "./features/card-scanner/scanner";
import type { ScannedCard } from "./features/card-scanner/recognizer";
import "./App.css";
import { CardThumbnail } from "./CardThumbnail";
import { CardName } from './CardName';
import { MerchantAlerts } from './features/merchants/MerchantAlerts';
import { GrowthPlanner } from './features/growth/GrowthPlanner';
import { RaidCards } from './features/raid/RaidCards';
import { completeGrowth, undoGrowth } from './features/growth/complete-growth';
import type { GrowthMaster } from './features/growth/optimizer';
import type { GrowthSequenceStep } from './features/growth/growth-sequence';
import { merchantCardIssues } from './features/merchants/merchant-progress';
import {cardRarityClass} from './card-rarity';
import {inventoryCsv,parseInventoryCsv,parseCsvExperience,csvInventoryState} from './inventory-csv';
import type {CsvCatalogCard} from './inventory-csv';
import { unownedInventory } from './inventory-unowned';
import { loadScanBackup, saveScanBackup, clearScanBackup, LegacyBackupChoice } from "./features/card-scanner/scan-backup";
const CARDS_PER_PAGE = 40;
function reviewMessage(reasons: string[]) {
  return [
    ...new Set(
      reasons.map((reason) =>
        reason.includes("사전") ||
        reason.includes("그림 보조") ||
        reason === "카드 식별 확인"
          ? "이름 확인"
          : reason,
      ),
    ),
  ].join(" · ");
}

type CardTileProps = {card:ScannedCard;rarity?:number;artwork?:string};

// Preserve each untouched tile while live progress and other cards change.
const CardTile = memo(function CardTile({card,rarity,artwork}:CardTileProps) {
  return <div className={`inventory-card ${card.review.length?'has-issue':''}`} data-identity-source={card.identitySource}>
    <CardThumbnail src={card.image || (artwork ? `${import.meta.env.BASE_URL}scanner/artwork/${artwork}` : '')} alt={card.name} width={80} height={120} />
    <CardName name={card.name} rarity={rarity} />
    <div className="tile-counts">
      <span title={card.maxAwakening===0?'성장·각성이 없는 카드':'각성 단계'} aria-label={`${card.name} 각성 ${card.awakening??'미판독'}`}><b>{card.awakening??'?'}</b><small>각</small></span>
      <span title="추가 보유 장수" aria-label={`${card.name} 추가 장수 ${card.extraCopies??'미판독'}`}><b>{card.extraCopies??'?'}</b><small>장</small></span>
    </div>
    {card.review.length>0 && <span className="tile-issue" title="화면 공유를 시작하고 이 카드를 다시 보여 주세요.">{reviewMessage(card.review)}</span>}
  </div>;
});

function UnownedCardTile({card}:{card:CsvCatalogCard}) {
  return <div className="inventory-card is-unowned">
    <CardThumbnail src={card.artwork ? `${import.meta.env.BASE_URL}scanner/artwork/${card.artwork}` : ''} alt={card.name} width={80} height={120} />
    <CardName name={card.name} rarity={card.rarity} />
    <span className="tile-unowned-label">미등록</span>
  </div>;
}

function App() {
  const [guideOpen, setGuideOpen] = useState(false);
  const video = useRef<HTMLVideoElement>(null);
  const stream = useRef<MediaStream | null>(null);
  const controller = useRef<AbortController | null>(null);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const preparation = useRef<ReturnType<typeof createPreparedSlot<PreparedScanner>> | null>(null);
  const [preparationState, setPreparationState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [preparationMessage, setPreparationMessage] = useState('');
  const [preparationAttempt, setPreparationAttempt] = useState(0);
  useEffect(() => {
    if (busy) return;
    let active = true;
    let slot: ReturnType<typeof createPreparedSlot<PreparedScanner>> | undefined;
    const feedback = createPreparationFeedback(message => {
      if (active) setPreparationMessage(message);
    });
    // Allow the first page paint, and avoid duplicate work in StrictMode.
    const timer = window.setTimeout(() => {
      setPreparationState('loading');
      setPreparationMessage('');
      slot = createPreparedSlot(signal => prepareScanner(feedback.update, signal));
      preparation.current = slot;
      void slot.ready.then(() => {
        feedback.dispose();
        if (active) { setPreparationState('ready'); setPreparationMessage('스캔 준비 완료'); }
      }).catch(error => {
        feedback.dispose();
        if (active) {
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
      void slot?.dispose();
    };
  }, [busy, preparationAttempt]);
  const [engineReady, setEngineReady] = useState(false);
  const [scanStartedAt, setScanStartedAt] = useState(0);
  const engineReadyRef = useRef(false);
  const [sharing, setSharing] = useState(false);
  const [error, setError] = useState("");
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
  const [inventoryFilter, setInventoryFilter] = useState<'owned'|'review'|'unowned'>('owned');
  const onlyReview = inventoryFilter === 'review';
  const onlyUnowned = inventoryFilter === 'unowned';
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
    void loadScanBackup().then(saved => {
      if (cancelled) return;
      savedState.current = saved ?? null;
      if (saved) { inventory.current = saved.cards; setState(saved); }
      setBackupStatus(saved ? '브라우저에 저장됨' : '브라우저에 자동 저장');
    }).catch(e => { if (!cancelled) { setBackupStatus('브라우저 저장 확인 필요'); if (e instanceof LegacyBackupChoice) setLegacyChoices(e.choices); setBackupError(e instanceof Error ? e.message : '목록 복원 실패'); } })
      .finally(() => { if (!cancelled) setBackupReady(true); });
    return () => { cancelled = true; };
  }, []);
  useEffect(() => {
    if (!backupReady || !state || busy || error || state.status === '스캔 중지' || state === savedState.current) return;
    let cancelled = false;
    setBackupStatus('브라우저에 저장 중');
    void saveScanBackup(state).then(() => {
      savedState.current = state;
      if (!cancelled) { setBackupStatus('브라우저에 저장됨'); setBackupError(''); }
    }).catch(e => { if (!cancelled) { setBackupStatus('저장되지 않음'); setBackupError(e instanceof Error ? e.message : '저장 실패 · CSV로 보관해 주세요.'); } });
    return () => { cancelled = true; };
  }, [state, busy, error, backupReady, backupAttempt]);
  async function restoreBackup(legacyKey?: string) {
    setBackupReady(false);
    try {
      const saved = await loadScanBackup(legacyKey);
      savedState.current = saved ?? null;
      inventory.current = saved?.cards ?? [];
      setState(saved ?? null); setError(''); setBackupError(''); setLegacyChoices([]);
      setBackupStatus(saved ? '브라우저에 저장됨' : '브라우저에 자동 저장');
    } catch (e) { if (e instanceof LegacyBackupChoice) setLegacyChoices(e.choices); setBackupError(e instanceof Error ? e.message : '목록 복원 실패'); }
    finally { setBackupReady(true); }
  }
  async function resetInventory() {
    setBackupReady(false);
    try {
      await clearScanBackup();
      release(); inventory.current=[]; savedState.current=null; setState(null);
      setQuery(''); setInventoryFilter('owned'); setPage(1); setResetPending(false); setError(''); setBackupError('');
      setBackupStatus('브라우저에 자동 저장');
    } catch (e) { setBackupError(e instanceof Error ? e.message : '목록 초기화 실패'); }
    finally { setBackupReady(true); }
  }
  useEffect(() => {
    const abort = new AbortController();
    void fetch(`${import.meta.env.BASE_URL}scanner/cards.json`, { signal: abort.signal })
      .then(r => { if (!r.ok) throw new Error(`카드 사전 로드 실패 (${r.status})`); return r.json(); })
      .then(data => { if (!Array.isArray(data.cards) || !data.cards.length) throw new Error('카드 사전 형식 오류'); setCatalog(data.cards); setCatalogVersion(data.version ?? ''); })
      .catch(e => { if (!abort.signal.aborted) setCatalogError(e instanceof Error ? e.message : '카드 사전 로드 실패'); });
    return () => abort.abort();
  }, [catalogAttempt]);
  function release() {
    controller.current?.abort();
    controller.current = null;
    setBusy(false);
    stream.current?.getTracks().forEach((t) => t.stop());
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
      controller.current?.abort();
      stream.current?.getTracks().forEach((t) => t.stop());
    },
    [],
  );
  async function start() {
    const prepared = preparation.current?.take();
    setPreparationState('loading');
    controller.current?.abort();
    const abort = new AbortController();
    controller.current = abort;
    setBusy(true);
    setResultView('cards');setInventoryFilter('owned');setPage(1);
    setEngineReady(false); engineReadyRef.current = false;
    setResetPending(false);
    setCsvPending(null);
    setError("");
    setState(null);
    const presentation = createLatestPublisher<ScannerState>((next) => {
      if (controller.current !== abort) return;
      startTransition(() => setState(next));
    }, 200);
    abort.signal.addEventListener("abort", () => presentation.flush(), { once: true });
    try {
      await runScanner(
        video.current!,
        "screen",
        abort.signal,
        (next) => {
          if (controller.current === abort) {
            if(next.autoStopped)setSharing(false);
            inventory.current = next.cards;
            presentation.publish(next);
          }
        },
        inventory.current,
        () => { if (controller.current === abort) { setScanStartedAt(performance.now()); engineReadyRef.current = true; setEngineReady(true); } },
        "all",
        undefined,
        false,
        {},
        prepared,
      );
      presentation.flush();
    } catch (e) {
      presentation.flush();
      if (controller.current === abort) {
        if (abort.signal.aborted || (e instanceof DOMException && e.name === "AbortError"))
          setState((s) => (s ? { ...s, status: "스캔 중지" } : s));
        else setError(e instanceof Error ? e.message : "스캔 실패");
        stream.current?.getTracks().forEach(track => track.stop());
        stream.current = null;
        setSharing(false);
      }
    } finally {
      presentation.cancel();
      if (controller.current === abort) {
        controller.current = null;
        setBusy(false);
      }
    }
  }
  function stopSharing() {
    if (!engineReadyRef.current) controller.current?.abort();
    stream.current?.getTracks().forEach((t) => t.stop());
    setSharing(false);
  }
  async function share() {
    let next: MediaStream | undefined;
    try {
      next = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: { ideal: 60, max: 60 } },
        audio: false,
      });
      release();
      stream.current = next;
      setSharing(true);
      video.current!.srcObject = next;
      next.getVideoTracks()[0].addEventListener("ended", () => {
        if (stream.current === next) { setSharing(false); if (!engineReadyRef.current) controller.current?.abort(); }
      });
      await video.current!.play();
      setReady(true);
      void start();
    } catch (e) {
      next?.getTracks().forEach((t) => t.stop());
      if (next && stream.current === next) release();
      setError(e instanceof Error ? e.message : "화면 공유 실패");
    }
  }
  async function readCsv(file:File) {
    setCsvReading(true);setCsvPending(null);setCsvExperience('');setError('');setResetPending(false);
    try {
      if(file.size>1_048_576)throw new Error('CSV 파일은 1MB 이내로 선택해 주세요.');
      const source=new TextDecoder('utf-8',{fatal:true}).decode(await file.arrayBuffer());
      setCsvPending({name:file.name,cards:parseInventoryCsv(source,catalog)});
    } catch(error) {
      setError(error instanceof TypeError?'UTF-8 형식의 CSV를 선택해 주세요.':error instanceof Error?error.message:'CSV를 읽지 못했습니다.');
    } finally {setCsvReading(false);}
  }
  function applyCsv() {
    if(!csvPending||busy||csvExperienceError)return;
    const imported=csvPending.cards;
    const next=csvInventoryState(imported,csvExperience);
    release();inventory.current=imported;
    setState(next);
    setCsvPending(null);setQuery('');setInventoryFilter('owned');setPage(1);setResultView('cards');setError('');
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
      setError('');
    } catch (e) { setError(e instanceof Error ? e.message : '성장을 반영하지 못했습니다.'); }
  }
  function undoLastGrowth() {
    if (busy || !state || inventory.current !== state.cards) return;
    const next = undoGrowth(state);
    inventory.current = next.cards;
    setState(next);
    setError('');
  }
  const cards = state?.cards ?? [];
  const merchantIssues = busy ? [] : merchantCardIssues(cards);
  const missingCards = merchantIssues.filter(card=>card.missing);
  const uncertainIds = new Set(merchantIssues.filter(card=>!card.missing).map(card=>card.id));
  const displayCards = cards.map(card=>uncertainIds.has(card.id)&&!card.review.length ? {...card,review:['각성·장수 확인']} : card);
  const reviewCards = displayCards.filter((c) => c.review.length > 0);
  const review = reviewCards.length + missingCards.length;
  const nameIssues = state?.expected === cards.length && !reviewCards.some(card => card.review.includes("이름 확인"))
    ? [] : state?.unidentified ?? [];
  const filteredMissing = missingCards.filter(card=>card.name.includes(query));
  const filtered = displayCards.filter(
    (c) => (!onlyReview || c.review.length > 0) && c.name.includes(query),
  ).sort((a,b)=>a.name.localeCompare(b.name,'ko',{numeric:true}));
  const unowned = useMemo(()=>unownedInventory(catalog,state,busy||!!error),[catalog,state,busy,error]);
  const filteredUnowned = (unowned ?? []).filter(card=>card.name.includes(query));
  const visibleCount = onlyUnowned ? filteredUnowned.length : filtered.length;
  const match = state?.expected !== null && state?.expected === cards.length;
  const stopped = state?.status === "스캔 중지";
  const resultsReady=!busy&&!csvReading&&!stopped&&!error&&cards.length>0;
  const activeView=resultsReady?resultView:'cards';
  const pageCount=Math.max(1,Math.ceil(visibleCount/CARDS_PER_PAGE));
  const currentPage=Math.min(page,pageCount);
  const pageCards=filtered.slice((currentPage-1)*CARDS_PER_PAGE,currentPage*CARDS_PER_PAGE);
  const pageUnowned=filteredUnowned.slice((currentPage-1)*CARDS_PER_PAGE,currentPage*CARDS_PER_PAGE);
  const pageCardCount=onlyUnowned?pageUnowned.length:pageCards.length;
  const showReview=()=>{setResultView('cards');setInventoryFilter('review');setQuery('');setPage(1);};
  const changePage=(next:number)=>{setPage(next);document.getElementById('card-results')?.scrollIntoView({block:'start'});};
  const scrollNotice = scrollGuidance({gaps:state?.scrollGaps?.length ?? 0,busy,
    expected:state?.expected ?? null,collected:state?.currentRunNames ?? cards.length,
    autoStopped:state?.autoStopped,recoverySkipped:state?.recoverySkipped});
  const finalizing = busy && state?.recoverySkipped;
  const workPhase = sharing ? 'capture' : state?.workPhase ?? 'reading';
  const statusTitle = error ? "입력을 확인해 주세요" : busy && !engineReady ? "스캔 준비 중" : sharing ? "화면 공유 중" : busy && workPhase==='cleanup' ? "스캔을 마무리하고 있어요" : busy && workPhase==='verifying' ? "판독 결과를 검증하고 있어요" : busy && workPhase==='recovery' ? "저장된 화면을 다시 확인하고 있어요" : finalizing ? "카드 검증 완료" : busy ? "카드를 읽고 있어요" : stopped ? "스캔 중지됨" : state?.autoStopped ? "전체 카드 수집 완료" : state?.status === "CSV 불러오기 완료" ? "CSV 불러오기 완료" : cards.length ? "카드 목록 준비됨" : "화면을 공유해 시작하세요";
  const statusDescription = busy && !engineReady ? `${state?.status ?? "화면 검출 모듈 준비 중"} · 준비가 끝나면 스크롤해 주세요.`
    : sharing ? (state?.located ? "성장 탭을 천천히 스크롤해 주세요. 읽은 카드는 아래에 쌓입니다." : "카드 보관함의 성장 탭을 찾고 있어요. 카드 화면을 보여 주세요.")
    : busy && workPhase==='cleanup' ? "판독 작업을 종료하고 임시 기록을 정리하고 있습니다."
    : busy && workPhase==='verifying' ? "보관함 수량과 카드별 판독 근거를 대조하고 있습니다."
    : busy && workPhase==='recovery' ? "빠뜨리거나 가려진 카드가 있는지 저장된 화면을 재검사하고 있습니다."
    : finalizing ? "모든 카드의 이름·각성·장수 확인을 마쳤어요. 임시 화면을 정리하고 있습니다."
    : state?.autoStopped&&!busy ? "전체 카드 이름과 보관함 수량이 확인되어 화면 공유를 자동으로 종료했어요. 판독 결과는 아래 목록에서 확인하세요."
    : state?.autoStopped&&busy ? "전체 카드 화면을 확보해 공유를 종료했어요. 저장한 이미지로 남은 장수·각성을 확인하고 있습니다."
    : busy ? "공유는 종료됐어요. 수집한 화면에서 남은 카드를 확인하고 있습니다."
    : cards.length ? "같은 보관함을 다시 공유하면 기존 목록에 추가로 반영합니다."
    : "로스트아크 카드 보관함의 성장 탭을 열어 주세요.";
  const scanSummary = (
    <section className="summary-grid" aria-label="스캔 요약">
        <div className="summary-card"><span>수집한 카드</span><strong>{cards.length}<small> / {state?.expected ?? "—"}종</small></strong>
          {state?.expected != null && <p className={match ? "verified" : "muted"}>{match ? "수량 일치" : `${Math.abs(state.expected - cards.length)}종 차이`}</p>}</div>
        {(review > 0 || nameIssues.length > 0) && <div className="summary-card"><span>확인할 카드</span><strong className="needs-review">{review > 0 ? <>{review}<small>종</small></> : <>미식별<small>{nameIssues.length}건</small></>}</strong>
          {review > 0 && nameIssues.length > 0 && <p>미식별 화면 {nameIssues.length}건</p>}</div>}
        <div className="summary-card"><span>{state?.growthPointsEstimated ? '보유 경험치 (예상)' : '보유 경험치'}</span><strong>{state?.growthPoints?.current.toLocaleString('ko-KR') ?? "—"}</strong></div>
      </section>
  );
  return (
    <div className="app-shell">
      <header className="app-header">
        <a className="brand" href={import.meta.env.BASE_URL} aria-label="LoaCard 메인으로" onClick={event => {
          if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
          event.preventDefault();
          setResultView('cards');setInventoryFilter('owned');setQuery('');setPage(1);
          window.scrollTo({ top: 0, behavior: 'instant' });
        }}><span className="brand-icon" aria-hidden="true">
          <svg width="28" height="30" viewBox="0 0 28 30" fill="none">
            <rect x="3.5" y="3.5" width="16" height="22" rx="3" transform="rotate(-10 11.5 14.5)" fill="currentColor" fillOpacity=".08" stroke="currentColor" strokeOpacity=".45" />
            <rect x="8" y="5" width="16" height="22" rx="3" fill="#25251f" stroke="currentColor" strokeWidth="1.4" />
            <path d="m16 10 3.5 5-3.5 5-3.5-5 3.5-5Z" fill="currentColor" fillOpacity=".22" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
            <path d="M11 8h2m6 16h2" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
          </svg>
        </span>LoaCard</a>
        <div className="header-tools"><span className={`local-status ${busy||csvReading?'is-active':''}`} role="status" title="카드 인식은 현재 브라우저에서 실행됩니다.">
          {busy||csvReading ? <span className="scan-spinner" aria-hidden="true" /> : <span className="status-dot" aria-hidden="true" />}
          {csvReading ? 'CSV 확인 중' : busy ? engineReady ? '브라우저에서 분석 중' : '분석 준비 중' : '로컬 처리'}
        </span><Button color="inherit" startIcon={<HelpOutline />} onClick={() => setGuideOpen(true)}>사용법</Button>
        <Tooltip title="GitHub 저장소 (새 탭)"><IconButton component="a" href="https://github.com/2jiho/loa-card" target="_blank" rel="noopener noreferrer" aria-label="GitHub 저장소 (새 탭)"><GitHub fontSize="small" /></IconButton></Tooltip><ThemeToggle />
        </div>
      </header>
      <div className="app-layout">
      <WorkspaceNavigation value={activeView} onChange={setResultView} ready={resultsReady} count={cards.length}
        hint={busy ? '판독 완료 후 모든 메뉴를 사용할 수 있어요.' : review > 0 || nameIssues.length > 0 ? '강조된 카드를 다시 보여 주세요.' : !cards.length ? '스캔하거나 CSV를 불러오면 시작할 수 있어요.' : undefined} />
      <main className="workspace">
      {activeView!=='cards' && scanSummary}
      {!!state?.growthHistory?.length && <div className="growth-completion-notice" role="status">
        <span>{state.growthHistory.at(-1)!.label} · 성장 반영됨 <small>경험치는 다음 스캔에서 갱신</small></span>
        <button className="text-button" disabled={busy} onClick={undoLastGrowth}>성장 실행 취소</button>
      </div>}
      <section id="panel-cards" role="tabpanel" aria-labelledby="view-cards" hidden={activeView!=='cards'}>
      {backupReady && !cards.length && !busy && !sharing && !csvReading && <ScanQuickStart onHelp={() => setGuideOpen(true)} />}
      <section className="scanner panel" aria-label="카드 스캔">
        <div className="scanner-main">
          <h1>카드 스캔</h1>
          <div className="toolbar">
            {sharing ? <Button variant="contained" startIcon={<StopCircleOutlined />} onClick={stopSharing}>화면 공유 종료</Button>
              : <Button variant="contained" startIcon={<ScreenShareOutlined />} disabled={busy || csvReading || !backupReady || !catalog.length || preparationState!=='ready'} onClick={() => void share()}>{!busy && preparationState==='loading' ? '스캔 준비 중' : '화면 공유 시작'}</Button>}
            <Button color="inherit" startIcon={<RestartAltOutlined />} disabled={busy || !backupReady || !cards.length} aria-expanded={resetPending} onClick={() => {setResetPending(!resetPending);setCsvPending(null);}}>목록 초기화</Button>
            <Button variant="outlined" startIcon={<FileDownloadOutlined />} disabled={busy || !cards.length} title="전체 카드의 이름·각수·카드수 저장 · 행이 있으면 보유" onClick={()=>downloadInventory(new Blob([inventoryCsv(cards)],{type:'text/csv;charset=utf-8'}),'loacard-cards.csv')}>CSV 저장</Button>
            <Button component="label" role={undefined} tabIndex={-1} variant="outlined" startIcon={<FileUploadOutlined />} disabled={busy||csvReading||!backupReady||!catalog.length} sx={{ '&:focus-within': { outline: '2px solid var(--accent)', outlineOffset: 2 } }}>
              {csvReading?'CSV 읽는 중…':'CSV 불러오기'}
              <input className="visually-hidden" aria-label="CSV 불러오기" type="file" accept=".csv,text/csv" disabled={busy||csvReading||!backupReady||!catalog.length}
                onChange={event=>{const file=event.target.files?.[0];event.target.value='';if(file)void readCsv(file);}} />
            </Button>
            {busy && !sharing && <button className="text-button" onClick={() => controller.current?.abort()}>스캔 중지</button>}
          </div>
          {!busy && <div role="status" className="scan-preparation">
            {preparationState==='loading' && preparationMessage && <span className="scan-spinner" aria-hidden="true" />}
            <span>{preparationMessage}</span>
            {preparationState==='error' && <Button size="small" onClick={() => setPreparationAttempt(value => value + 1)}>준비 다시 시도</Button>}
          </div>}
          {csvPending && <div className="import-confirm" role="group" aria-label="CSV 불러오기 확인">
            <div><strong>{csvPending.name} · {csvPending.cards.length}종</strong>
              <p>{cards.length ? `현재 ${cards.length}종 목록을 이 파일의 목록으로 교체합니다.` : '파일에 있는 카드를 목록에 불러옵니다.'} 기존 목록은 CSV로 저장할 수 있습니다.</p>
              <TextField className="csv-experience" label="보유 카드 경험치 (선택)" size="small" value={csvExperience}
                onChange={event=>setCsvExperience(event.target.value)} placeholder="예: 1,234,567"
                error={!!csvExperienceError} helperText={csvExperienceError||'비워 두면 경험치 미확인으로 불러옵니다.'}
                slotProps={{htmlInput:{inputMode:'numeric',maxLength:32}}} />
            </div>
            <button className="text-button" onClick={()=>setCsvPending(null)}>취소</button>
            <button className="secondary" disabled={busy||!!csvExperienceError} onClick={applyCsv}>불러오기</button>
          </div>}
          {resetPending && <div className="reset-confirm" role="group" aria-label="목록 초기화 확인"><span>현재 카드 목록을 비우고 새로 시작할까요?</span>
            <button className="secondary" onClick={() => setResetPending(false)}>취소</button>
            <button disabled={busy || !backupReady} onClick={() => void resetInventory()}>목록 비우기</button>
          </div>}
          <div className={`scan-progress ${busy ? "processing" : ""}`} role="status" aria-live="polite">
            <strong>{busy ? <span className="scan-spinner" aria-hidden="true" />
              : !error && !stopped && cards.length ? <span className="scan-complete" aria-hidden="true">✓</span>
              : <span className={`status-dot ${sharing ? "active" : ""}`} aria-hidden="true" />}{statusTitle}</strong>
            {(busy || stopped || error || !cards.length) && <p>{statusDescription}</p>}
            {busy && engineReady && <ScanReadProgress completed={state?.currentRunRead ?? 0} expected={state?.expected ?? null}
              collected={state?.currentRunNames ?? 0} phase={workPhase} recoveryPercent={state?.recoveryPercent} startedAt={scanStartedAt} />}
            {sharing && state?.expected != null && <p>화면 수집 {state.currentRunNames ?? 0} / {state.expected}종 · 수집 완료 시 자동 종료</p>}
            {sharing && (state?.livePerformance?.lagMs ?? 0) > 1500 && (state?.queued ?? 0) > 0 &&
              <p className="warning">카드 목록이 따라올 때까지 잠시 스크롤을 멈춰 주세요.</p>}
          </div>
        </div>
        <figure className="source-preview">
          <div className="video-wrap">
            <video ref={video} muted playsInline
              onLoadedData={() => setReady(true)}
              onError={() => setError("공유 화면을 표시할 수 없습니다.")} />
            {!ready && <div className="preview-placeholder"><span aria-hidden="true">▣</span>공유 화면 미리보기</div>}
          </div>
          <figcaption><span className={`status-dot ${sharing ? "active" : ""}`} />{sharing ? "화면 공유 연결됨" : ready ? "화면 공유 종료" : "공유 대기"}</figcaption>
        </figure>
      </section>
      {catalogError && <p className="error" role="alert">{catalogError} <button className="text-button" onClick={() => { setCatalogError(''); setCatalogAttempt(n => n + 1); }}>다시 시도</button></p>}
      {legacyChoices.length > 0 && <div className="notice" role="group" aria-label="이전 백업 선택">{legacyChoices.map((item, i) => <Button key={item.key} disabled={!backupReady || busy} onClick={() => void restoreBackup(item.key)} title={item.names}>백업 {i + 1} · {item.count}종 · 경험치 {item.xp?.toLocaleString('ko-KR') ?? '미확인'}</Button>)}</div>}
      {backupError && <div className="notice" role="alert"><p>{backupError}</p>{!!state && <button className="text-button" disabled={busy || !backupReady} onClick={() => setBackupAttempt(n => n + 1)}>저장 다시 시도</button>}<button className="text-button" disabled={busy || !backupReady} onClick={() => void restoreBackup()}>현재 목록 대신 저장 목록 불러오기</button><span> · 현재 목록은 먼저 CSV로 보관해 주세요.</span></div>}
      {error && <p className="error" role="alert">{error}<button className="text-button" onClick={() => setError("")}>닫기</button></p>}
      {state?.captureWarning && <p className="notice" role="alert">{state.captureWarning}</p>}
      {!!state?.droppedFrames && <p className="notice" role="alert">일부 화면을 처리하지 못했습니다. 빠르게 지나간 구간을 다시 공유해 주세요.</p>}
      {scanSummary}
      {scrollNotice && !!state?.scrollGaps?.length && <section className="notice" aria-label={scrollNotice==='collecting'?'수집 구간 참고':'다시 보여줄 스크롤 구간'}>
        <strong>{scrollNotice==='collecting'?'빠르게 지나간 구간이 있어요':'지나간 구간을 한 번 더 보여 주세요'}</strong>
        <p>{scrollNotice==='collecting'?'판독 후 누락 여부를 확인합니다.':
          `이번 입력에서 전체 카드 이름을 확인하지 못했어요. 스크롤바 ${state.scrollGaps.slice(0,4).map(gap=>`${Math.round(gap.from*100)}~${Math.round(gap.to*100)}%`).join(' · ')}${state.scrollGaps.length>4 ? ` 외 ${state.scrollGaps.length-4}구간` : ''} 부근을 다시 보여 주세요.`}</p>
      </section>}
      <section className="panel results" aria-label="내 카드 목록">
        <h2 id="card-results" className="inventory-heading">내 카드</h2>
        <div className="list-toolbar">
          <ToggleButtonGroup className="inventory-filters" value={inventoryFilter} exclusive size="small" aria-label="카드 목록 필터"
            onChange={(_, value) => { if(value) { setInventoryFilter(value); setPage(1); } }}>
            <ToggleButton value="owned">등록 <span>{cards.length}</span></ToggleButton>
            <ToggleButton value="unowned" disabled={unowned===null}>미등록 <span>{unowned?.length ?? '—'}</span></ToggleButton>
            <ToggleButton value="review">확인 필요 <span>{review}{nameIssues.length ? ` · 미식별 ${nameIssues.length}` : ''}</span></ToggleButton>
          </ToggleButtonGroup>
          <TextField className="inventory-search" size="small" type="search" placeholder="카드 이름 검색" value={query}
            onChange={e=>{setQuery(e.target.value);setPage(1);}}
            slotProps={{ htmlInput: { 'aria-label': '카드 이름 검색' }, input: { startAdornment: <InputAdornment position="start"><SearchOutlined fontSize="small" /></InputAdornment> } }} />
        </div>
        {onlyUnowned && <p className="inventory-filter-note">{unowned===null?'전체 스캔 후 확인 가능':'현재 보관함 목록에 없는 카드'}</p>}
        {!onlyUnowned && !!nameIssues.length && <details className="unidentified" open={onlyReview || undefined}>
          <summary>이름을 확인하지 못한 카드 화면 · {nameIssues.length}건</summary>
          <p>카드 이름이 선명하게 보이도록 다시 보여 주세요.</p>
          <div className="rescan-cards">{nameIssues.map((item,i)=><figure key={i}>
            <CardThumbnail src={item.image} alt={`미식별 카드 ${i+1}`} width={60} height={90} />
            <figcaption>{item.pending ? "판독 대기" : "이름 확인 필요"}</figcaption>
          </figure>)}</div>
        </details>}
        {!onlyUnowned && !!filteredMissing.length && <section className="unidentified" aria-label="목록에 없는 카드 확인">
          <strong>보유 여부를 확인하지 못한 카드 · {filteredMissing.length}종</strong>
          <p>목록에 없는 떠돌이 상인 카드입니다. 보유 중이면 다시 보여 주세요.</p>
          <ul>{filteredMissing.map(card=><li key={card.id}><span className={cardRarityClass(rarityById.get(card.id))}>{card.name}</span> · 보유 여부 미확인</li>)}</ul>
        </section>}
        <div className="inventory-grid" aria-label="카드 그리드">
          {onlyUnowned ? pageUnowned.map(card=><UnownedCardTile key={card.id} card={card} />) : pageCards.map(card=><CardTile key={card.id} card={card} rarity={rarityById.get(card.id)} artwork={artworkById.get(card.id)} />)}
          {pageCardCount > 0 && Array.from({length:CARDS_PER_PAGE-pageCardCount},(_,index)=><div key={`empty-${index}`} className={`inventory-card inventory-card-empty${onlyUnowned?' is-unowned':''}`} aria-hidden="true">
            {!onlyUnowned && <span className="card-thumbnail" />}
            <span className="tile-name">&nbsp;</span>
            <span className="tile-counts"><span><b>&nbsp;</b><small>&nbsp;</small></span></span>
          </div>)}
        </div>
        {onlyUnowned && unowned!==null && !filteredUnowned.length && <div className="empty-list"><strong>{query?'검색 결과가 없어요':'모든 카드가 등록되어 있어요'}</strong></div>}
        {!onlyUnowned && !filtered.length && !filteredMissing.length && !nameIssues.length && <div className="empty-list"><strong>{!cards.length ? "아직 수집한 카드가 없어요" : onlyReview && !query ? "확인이 필요한 카드가 없어요" : "검색 결과가 없어요"}</strong>
          <p>{!cards.length ? "화면을 공유하면 카드가 여기에 표시됩니다." : "전체 목록을 보거나 다른 이름으로 검색해 주세요."}</p></div>}
        {!!visibleCount&&<nav className="pagination" aria-label="카드 목록 페이지">
          <span>{(currentPage-1)*CARDS_PER_PAGE+1}–{Math.min(currentPage*CARDS_PER_PAGE,visibleCount)} / {visibleCount}종</span>
          <div><button className="secondary" disabled={currentPage===1} onClick={()=>changePage(currentPage-1)}>이전</button>
            <span aria-live="polite">{currentPage} / {pageCount}</span>
            <button className="secondary" disabled={currentPage===pageCount} onClick={()=>changePage(currentPage+1)}>다음</button></div>
        </nav>}
        {!!cards.length && <div className="inventory-meta">
          <span>게임 정렬 <b>{state?.sort ? `${{ name:"이름",default:"기본",rarity:"등급",owned:"보유",awakening:"각성 단계" }[state.sort.kind]}${state.sort.direction === "desc" ? " 역순" : state.sort.direction === "asc" ? " 순" : ""}` : "—"}</b></span>
          <span>보관함 용량 <b>{state?.capacity ?? "—"}</b></span></div>}
      </section>
      </section>
      <section id="panel-merchants" role="tabpanel" aria-labelledby="view-merchants" hidden={activeView!=='merchants'}>{activeView==='merchants' && <MerchantAlerts cards={cards} busy={busy} rarityById={rarityById} onReview={showReview} />}</section>
      <section id="panel-growth" role="tabpanel" aria-labelledby="view-growth" hidden={activeView!=='growth'}>{activeView==='growth' && <GrowthPlanner cards={cards} growthPoints={state?.growthPoints?.current} onComplete={markGrowthComplete} />}</section>
      <section id="panel-raid" role="tabpanel" aria-labelledby="view-raid" hidden={activeView!=='raid'}>{activeView==='raid' && <RaidCards cards={cards} complete={unowned!==null} xp={state?.growthPoints?.current} />}</section>
      <footer className="app-footer">
        <div className="footer-links"><span>LoaCard · 무료·비상업 팬 도구</span><a href={`${import.meta.env.BASE_URL}licenses/index.html`} target="_blank" rel="noopener noreferrer">라이선스 및 권리 안내</a></div>
        <p>스마일게이트의 공식 서비스가 아니며 제휴·보증을 받지 않습니다.<br />로스트아크 이미지·게임 데이터의 권리는 스마일게이트 등 각 권리자에게 있습니다.</p>
        <p role="status">{backupStatus} · 별도 보관은 CSV 저장</p>
        {catalogVersion && <p>카드 데이터 {catalogVersion.replace("client-", "")} 기준</p>}
      </footer>
      </main></div>
      <UsageGuide open={guideOpen} onClose={() => setGuideOpen(false)} />
    </div>
  );
}
export default App;
