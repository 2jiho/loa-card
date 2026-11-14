import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { formatScanTime, readingEstimate } from './read-progress';
import type { ReadSample, ScanWorkPhase } from './read-progress';
import type { ScanMonitorStore } from './scan-monitor-store';
import type {AutoCompletionDiagnostic, AutoCompletionGate} from '../session/auto-completion-diagnostics';
import {actionableGate,observeInputWait,scanReadDetail} from './scan-read-detail';
import {LIVE_OBSTRUCTION_MESSAGE} from '../session/live-obstruction-hint';
import {useLiveObstructionHint} from './use-live-obstruction-hint';

type ReadCountsProps = {completed:number;expected:number|null;store?:ScanMonitorStore};
const subscribeToNothing = () => () => {};
const emptySnapshot = () => undefined;

function useReadCounts({completed,expected,store}:ReadCountsProps) {
  // Scroll-only snapshots do not need to redraw counters or progress estimates.
  const getCompleted=useCallback(()=>store?.getSnapshot()?.currentRunRead,[store]);
  const getExpected=useCallback(()=>store?.getSnapshot()?.expected,[store]);
  const subscribe=store?.subscribe??subscribeToNothing;
  const liveCompleted=useSyncExternalStore(subscribe,getCompleted,emptySnapshot);
  const liveExpected=useSyncExternalStore(subscribe,getExpected,emptySnapshot);
  return {completed:liveCompleted??completed,expected:liveExpected===undefined?expected:liveExpected};
}

/** Keeps the small count current without rerendering the inventory page. */
export function ScanReadCount({inline=false,...props}:ReadCountsProps & {inline?:boolean}) {
  const {completed,expected}=useReadCounts(props);
  const total=expected?.toLocaleString('ko-KR')??'—';
  return <>{completed.toLocaleString('ko-KR')}{inline?` / ${total}종`:<small> / {total}종</small>}</>;
}

export function ScanReadProgress({completed:completedProp,expected:expectedProp,store,collected:collectedProp=0,phase='capture',recoveryPercent,startedAt,autoCompletion,autoCompletionEnabled=false,lagging=false,queued:queuedProp,activeReadings:activeProp,stale=false}:ReadCountsProps & {
  collected?:number;phase?:ScanWorkPhase;recoveryPercent?:number;startedAt:number;autoCompletion?:AutoCompletionDiagnostic;autoCompletionEnabled?:boolean;lagging?:boolean;queued?:number;activeReadings?:number;stale?:boolean;
}) {
  const {completed,expected}=useReadCounts({completed:completedProp,expected:expectedProp,store});
  // Subscribe to the diagnostic object, not just the gate string: if input →
  // another gate → input is batched into one render, the new object still
  // resets the guidance timer. The store preserves it during unrelated updates.
  const getDiagnostic=useCallback(()=>store?.getSnapshot()?.autoCompletionDiagnostic,[store]);
  const liveDiagnostic=useSyncExternalStore(store?.subscribe??subscribeToNothing,getDiagnostic,emptySnapshot);
  const getDroppedFrames=useCallback(()=>store?.getSnapshot()?.droppedFrames,[store]);
  const droppedFrames=useSyncExternalStore(store?.subscribe??subscribeToNothing,getDroppedFrames,emptySnapshot);
  const getQueued=useCallback(()=>store?.getSnapshot()?.queued,[store]);
  const getActive=useCallback(()=>store?.getSnapshot()?.activeReadings,[store]);
  const queued=useSyncExternalStore(store?.subscribe??subscribeToNothing,getQueued,emptySnapshot)??queuedProp;
  const active=useSyncExternalStore(store?.subscribe??subscribeToNothing,getActive,emptySnapshot)??activeProp;
  const getCollected=useCallback(()=>store?.getSnapshot()?.currentRunNames,[store]);
  const collected=useSyncExternalStore(store?.subscribe??subscribeToNothing,getCollected,emptySnapshot)??collectedProp;
  const getLiveObstruction=useCallback(()=>store?.getSnapshot()?.liveObstructionHint,[store]);
  const liveObstruction=useSyncExternalStore(store?.subscribe??subscribeToNothing,getLiveObstruction,emptySnapshot);
  const showObstruction=useLiveObstructionHint(liveObstruction,autoCompletionEnabled&&phase==='capture');
  const completionGate=autoCompletionEnabled?(liveDiagnostic?.gate??autoCompletion?.gate):undefined;
  const guidanceObservation=useMemo(()=>({gate:completionGate,diagnostic:liveDiagnostic,startedAt,enabled:autoCompletionEnabled}),[completionGate,liveDiagnostic,startedAt,autoCompletionEnabled]);
  const lagSession=useMemo(()=>({startedAt,enabled:autoCompletionEnabled}),[startedAt,autoCompletionEnabled]);
  const [stableGuidance,setStableGuidance]=useState<{gate:AutoCompletionGate|undefined}>();
  const [inputWaitGuidance,setInputWaitGuidance]=useState<{gate:AutoCompletionGate|undefined}>();
  const [lagHeld,setLagHeld]=useState<{session:typeof lagSession;value:boolean}>();
  useEffect(()=>{
    if(!actionableGate(guidanceObservation.gate))return;
    // Brief transient detector states should not make the instructions flicker.
    // Compare the observation object as well as its gate: A → B → A must wait
    // again even if the first A was previously shown.
    const timer=window.setTimeout(()=>setStableGuidance(guidanceObservation),600);
    return ()=>window.clearTimeout(timer);
  },[guidanceObservation]);
  useEffect(()=>observeInputWait(guidanceObservation.gate,()=>setInputWaitGuidance(guidanceObservation),
    (callback,delayMs)=>{const timer=window.setTimeout(callback,delayMs);return ()=>window.clearTimeout(timer);}),[guidanceObservation]);
  useEffect(()=>{
    const timer=window.setTimeout(()=>setLagHeld({session:lagSession,value:lagging}),lagging?0:2000);
    return ()=>window.clearTimeout(timer);
  },[lagging,lagSession]);
  const [now, setNow] = useState(() => performance.now());
  const [peak,setPeak]=useState(0);
  // oxlint-disable-next-line react/set-state-in-effect -- session-scoped high-water display; reset only when the scan clock changes.
  useEffect(()=>{setPeak(0);},[startedAt]);
  useEffect(()=>{
    if(completed===0){
      // oxlint-disable-next-line react/set-state-in-effect -- reset only when the scan has no confirmed reads.
      setPeak(0);return;
    }
    // oxlint-disable-next-line react/set-state-in-effect -- keep a high-water mark so a latest-field recheck does not look like lost recognition.
    setPeak(value=>Math.max(value,completed));
  },[completed]);
  const recheck=Math.max(0,peak-completed);
  const samples = useRef<ReadSample[]>([]);
  const [estimate, setEstimate] = useState<ReturnType<typeof readingEstimate>>(null);
  const current = useRef({completed,expected,collected,phase});
  useEffect(() => { current.current = {completed,expected,collected,phase}; }, [completed,expected,collected,phase]);
  useEffect(() => {
    samples.current = [];
    const tick = () => {
      const time = performance.now();
      setNow(time);
      const value = current.current;
      if (value.phase !== 'reading') { samples.current = []; setEstimate(null); return; }
      samples.current = [...samples.current.filter(s => time / 1000 - s.time <= 20), {time:time / 1000,completed:value.completed}];
      setEstimate(readingEstimate(samples.current,value.expected,value.collected));
    };
    tick();
    const timer = window.setInterval(tick, 1000);
    return () => window.clearInterval(timer);
  }, [startedAt,phase,expected]);
  const total=expected!==null&&Number.isInteger(expected)&&expected>0?expected:null;
  const label=`${stale?'마지막 판독':'판독 완료'} ${completed.toLocaleString('ko-KR')} / ${total?.toLocaleString('ko-KR') ?? '—'}종`;
  const percent = total === null ? null : Math.min(100, Math.floor(completed / total * 100));
  const remaining = total === null ? null : Math.max(0,total-completed);
  const stage = stale ? '카드 화면 찾는 중' : {capture:'화면 수집 · 판독',reading:'남은 카드 판독',recovery:'저장된 화면 재검사',verifying:'최종 수량·필드 검증',cleanup:'임시 기록 정리'}[phase];
  const inputWaitVisible=inputWaitGuidance===guidanceObservation&&completionGate==='input'&&!(phase==='recovery'&&recoveryPercent!==undefined);
  const validCount=(value:unknown):value is number=>typeof value==='number'&&Number.isSafeInteger(value)&&value>=0;
  const detail=scanReadDetail({phase,recoveryPercent,remaining,gate:completionGate,droppedFrames,
    stableGuidance:stableGuidance===guidanceObservation?stableGuidance.gate:undefined,
    inputWaitGuidance:inputWaitVisible,lagGuidance:autoCompletionEnabled&&(lagging||lagHeld?.session===lagSession&&lagHeld.value),liveObstruction:showObstruction,
    processing:!validCount(queued)||!validCount(active)||queued>0||active>0,queued,estimate});
  const announcedAdvice=detail==='화면을 잠시 멈춰 주세요.'||detail==='판독 대기 중이에요. 화면을 잠시 멈춰 주세요.'||detail==='카드 목록이 따라올 때까지 잠시 스크롤을 멈춰 주세요.'||detail===LIVE_OBSTRUCTION_MESSAGE?detail:'';
  return <div className="scan-read-progress">
    <div className="scan-read-heading"><span>{label}</span>{percent !== null && <b>{percent}%</b>}</div>
    {recheck>0&&<small className="scan-read-peak" title="최신 관측에서 필드가 아직 확인되지 않아 생긴 차이입니다. 이전에 확인된 카드가 목록에서 삭제된 것은 아닙니다.">누적 확인 {peak.toLocaleString('ko-KR')}종 · 최신 재확인 {recheck.toLocaleString('ko-KR')}종</small>}
    {total!==null ? <progress aria-label="카드 판독 진행" aria-valuetext={label} max={total} value={Math.min(completed,total)} />
      : <small>보관함 수량 확인 중</small>}
    <div className="scan-read-heading"><span>{stage}</span>{remaining !== null && remaining > 0 && <span>남은 판독 {remaining}종</span>}</div>
    {/* Shown only while scanning: cards not confirmed yet are progress here, counted for review once the scan ends. */}
    {total !== null && collected < total && <small className="scan-read-breakdown"><span>이름 미확인 {total - collected}종</span></small>}
    <small aria-live="off">경과 {formatScanTime((now-startedAt)/1000)}</small>
    <small className="scan-read-detail" aria-live="off" aria-hidden={!detail}>{detail||'\u00a0'}</small>
    <span className="visually-hidden" role="status" aria-live="polite" aria-atomic="true">{announcedAdvice}</span>
  </div>;
}
