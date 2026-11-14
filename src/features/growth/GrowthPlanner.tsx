import { useEffect, useMemo, useRef, useState } from 'react';
import type { ScannedCard } from '../card-scanner/public';
import type { GrowthMaster, GrowthComparisonRequest, GrowthComparison, OwnedCard } from './optimizer';
import { growthInput } from './live-results';
import { BookOverview } from './BookOverview';
import { CollectionCandidates } from './CollectionCandidates';
import { StatCollection } from './StatCollection';
import type { GrowthSequenceStep } from './growth-sequence';
import { runGrowthWorker } from './worker-calculation';
import {loadGrowthMaster} from '../../data/catalog';
import './growth.css';

export function GrowthPlanner({ cards: observations, growthPoints, onComplete, busy = false, complete = true }: {
  cards: ScannedCard[]; growthPoints?: number; onComplete: (master: GrowthMaster, step: GrowthSequenceStep) => void;
  busy?: boolean; complete?: boolean;
}) {
  const [master, setMaster] = useState<GrowthMaster | null>(null);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const cards = useMemo(() => growthInput(observations, master?.cards ?? [], complete), [observations, master, complete]);
  const xp = growthPoints !== undefined && Number.isSafeInteger(growthPoints) && growthPoints >= 0 ? growthPoints : null;
  const [target, setTarget] = useState('stat:3');
  const selectedStat = target.startsWith('stat:') ? target.slice(5) : null;
  const [calculationAttempt, setCalculationAttempt] = useState(0);
  const [completed, setCompleted] = useState<{
    cards: OwnedCard[]; master: GrowthMaster; xp: number; target: string; attempt: number;
    result?: GrowthComparison; error?: string;
  } | null>(null);
  const [lastResult,setLastResult]=useState<{master:GrowthMaster;target:string;result:GrowthComparison}|null>(null);
  const [loadError, setLoadError] = useState('');
  const current = completed?.cards === cards && completed.master === master && completed.xp === xp &&
    completed.target === target && completed.attempt === calculationAttempt ? completed : null;
  const canCalculate = !!master && !selectedStat && cards.length > 0 && xp !== null;
  const previous = lastResult?.master === master && lastResult.target === target ? lastResult.result : null;
  const result = canCalculate ? current?.result ?? previous : null;
  const running = canCalculate && !current;
  const error = loadError || (!selectedStat ? current?.error : '') || '';
  const latest = useRef({ cards, xp });
  useEffect(() => { latest.current = { cards, xp }; }, [cards, xp]);
  useEffect(() => {
    const abort = new AbortController();
    void loadGrowthMaster(abort.signal)
      .then(setMaster).catch(e => { if (!abort.signal.aborted) setLoadError(String(e.message)); });
    return () => abort.abort();
  }, [loadAttempt]);
  useEffect(() => {
    if (!master || selectedStat) return;
    let cancelled = false, worker: Worker | null = null, cancelWorker:(()=>void)|undefined;
    let processed: typeof latest.current | undefined;
    // One calculation at a time. Continuous scan updates replace the pending input,
    // never terminate useful in-flight work or build an unbounded worker queue.
    const calculate = () => {
      const input = latest.current;
      if (cancelled || worker || processed === input || !input.cards.length || input.xp === null) return;
      processed = input;
      const { cards, xp } = input;
      const finish = (data: { result?: GrowthComparison; error?: string }) => {
        if (cancelled) return;
        worker = null;cancelWorker=undefined;
        if(data.result)setLastResult({master,target,result:data.result});
        setCompleted({ cards, master, xp, target, attempt: calculationAttempt, ...data });
      };
      try {
        const request: GrowthComparisonRequest = { master,
          cards: cards.map(({ id, awakening, extraCopies, review, countReliable }) => ({ id, awakening, extraCopies, review, countReliable })),
          xp, target };
        worker = new Worker(new URL('./optimizer.worker.ts', import.meta.url), { type: 'module' });
        cancelWorker=runGrowthWorker(worker,request,finish);
      } catch (e) { finish({ error: e instanceof Error ? e.message : '계산을 시작하지 못했어요.' }); }
    };
    const initial = setTimeout(calculate, 300);
    const timer = setInterval(calculate, 1000);
    return () => { cancelled = true; clearTimeout(initial); clearInterval(timer); cancelWorker?.(); };
  }, [master, target, selectedStat, calculationAttempt]);
  const targetName = master?.targets.find(t => t.id === target)?.name ?? '악마';
  return <section className="panel growth-planner" aria-label="도감작 성장 계산">
    <div className="growth-heading"><h2>도감작</h2><details className="growth-help"><summary>계산 기준</summary>
      <p>지금 카드 목록으로 계산해요. 전에 달성했다가 지금 목록에 없는 카드는 계산에 넣지 않아요.</p>
      {selectedStat ? <p>카드 1종을 새로 등록할 때 오르는 효과가 큰 순서예요. 카드 등록만 하면 되고 경험치는 들지 않아요. 순서에 나온 조합들의 효과를 서로 더한 값은 아니에요.</p> : <>
        <p>도감마다 다음 효과까지 경험치당 효과를 비교해요. 효과 하나를 달성하면 남은 단계를 다시 비교해요. 지금 자원으로 모자란 단계는 건너뛰고, 금색으로 표시된 단계에만 자원을 써요.</p>
        <p>실링은 충분하다고 보고 계산해요. 카드에 이미 넣은 경험치는 비용에서 빼지 않아서, 실제보다 조금 많게 나올 수 있어요. 카드를 새로 구하는 비용과, 못 읽은 카드가 있는 도감은 계산에 넣지 않아요.</p>
        <p>비교하는 경우의 수에 한도가 있어서, 가장 적은 비용이라고 보장하지는 않아요.</p>
      </>}
    </details></div>
    {master && <BookOverview master={master} cards={cards} target={target} onTargetChange={setTarget} />}
    {selectedStat && master ? <StatCollection master={master} cards={cards} stat={selectedStat} /> : <>
    <h3 className="growth-plan-title">{targetName} 피해량 · 성장 효율</h3>
    {xp === null && <p className="growth-assumption" role="status">보유 경험치를 아직 몰라요. 카드 성장 탭을 스캔하면 채워져요.</p>}
    </>}
    {error && <p role="alert" className="error">{error}{!master && <button onClick={() => { setLoadError(''); setLoadAttempt(n => n + 1); }}>다시 불러오기</button>}
      {current?.error && !selectedStat && <button onClick={() => setCalculationAttempt(n => n + 1)}>다시 계산</button>}</p>}
    {running && <p role="status" className="growth-working"><span className="growth-spinner" />성장 순서 계산 중</p>}
    {result && <div className="growth-result">
      {!current?.result&&<p className="growth-assumption">이전 계산 결과 · {current?.error?'다시 계산해 주세요.':'현재 목록으로 다시 확인 중'}</p>}
      <CollectionCandidates candidates={result.collectionCandidates} targetName={targetName} disabled={busy || !current?.result} onComplete={step => onComplete(master!, step)} />
    </div>}
  </section>;
}
