import { useEffect, useRef, useState } from 'react';
import { formatScanTime, readingEstimate } from './read-progress';
import type { ReadSample, ScanWorkPhase } from './read-progress';

export function ScanReadProgress({completed,expected,collected=0,phase='capture',recoveryPercent,startedAt}:{
  completed:number;expected:number|null;collected?:number;phase?:ScanWorkPhase;recoveryPercent?:number;startedAt:number;
}) {
  const [now, setNow] = useState(() => performance.now());
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
  const label=`판독 완료 ${completed.toLocaleString('ko-KR')} / ${total?.toLocaleString('ko-KR') ?? '—'}종`;
  const percent = total === null ? null : Math.min(100, Math.floor(completed / total * 100));
  const remaining = total === null ? null : Math.max(0,total-completed);
  const stage = {capture:'화면 수집 · 판독',reading:'남은 카드 판독',recovery:'저장된 화면 재검사',verifying:'최종 수량·필드 검증',cleanup:'임시 기록 정리'}[phase];
  return <div className="scan-read-progress">
    <div className="scan-read-heading"><span>{label}</span>{percent !== null && <b>{percent}%</b>}</div>
    {total!==null ? <progress aria-label="카드 판독 진행" aria-valuetext={label} max={total} value={Math.min(completed,total)} />
      : <small>보관함 수량 확인 중</small>}
    <div className="scan-read-heading"><span>{stage}</span>{remaining !== null && remaining > 0 && <span>남은 판독 {remaining}종</span>}</div>
    {phase==='recovery' && recoveryPercent !== undefined && <small>기록 검사 {Math.floor(Math.max(0,Math.min(100,recoveryPercent)))}% · 카드 판독률과 별개</small>}
    <small aria-live="off">경과 {formatScanTime((now-startedAt)/1000)}{phase==='reading' && estimate ? ` · 남은 판독 약 ${formatScanTime(estimate.low)}–${formatScanTime(estimate.high)} (추가 검증 제외)` : ''}</small>
    {remaining===0 && <small>카드 판독은 끝났어요. 검증·정리가 끝나면 스캔이 완료됩니다.</small>}
    {phase==='reading' && remaining!==0 && !estimate && <small>재시도 시간에 따라 달라져 남은 시간을 계산 중이에요.</small>}
  </div>;
}
