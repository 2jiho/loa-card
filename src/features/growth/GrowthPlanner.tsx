import { useEffect, useState } from 'react';
import type { ScannedCard } from '../card-scanner/recognizer';
import type { GrowthMaster, GrowthComparisonRequest, GrowthComparison } from './optimizer';
import { BookOverview } from './BookOverview';
import { CollectionCandidates } from './CollectionCandidates';
import { StatCollection } from './StatCollection';
import type { GrowthSequenceStep } from './growth-sequence';
import './growth.css';

export function GrowthPlanner({ cards, growthPoints, onComplete }: {
  cards: ScannedCard[]; growthPoints?: number; onComplete: (master: GrowthMaster, step: GrowthSequenceStep) => void;
}) {
  const [master, setMaster] = useState<GrowthMaster | null>(null);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const xp = growthPoints !== undefined && Number.isSafeInteger(growthPoints) && growthPoints >= 0 ? growthPoints : null;
  const [target, setTarget] = useState('stat:3');
  const selectedStat = target.startsWith('stat:') ? target.slice(5) : null;
  const [calculationAttempt, setCalculationAttempt] = useState(0);
  const [completed, setCompleted] = useState<{
    cards: ScannedCard[]; master: GrowthMaster; xp: number; target: string; attempt: number;
    result?: GrowthComparison; error?: string;
  } | null>(null);
  const [loadError, setLoadError] = useState('');
  const current = completed?.cards === cards && completed.master === master && completed.xp === xp &&
    completed.target === target && completed.attempt === calculationAttempt ? completed : null;
  const canCalculate = !!master && !selectedStat && cards.length > 0 && xp !== null;
  const result = canCalculate ? current?.result : null;
  const running = canCalculate && !current;
  const error = loadError || (!selectedStat ? current?.error : '') || '';
  useEffect(() => {
    const abort = new AbortController();
    void fetch(`${import.meta.env.BASE_URL}growth/master.json`, { signal: abort.signal })
      .then(r => { if (!r.ok) throw new Error('도감 데이터를 불러오지 못했습니다.'); return r.json(); })
      .then(setMaster).catch(e => { if (!abort.signal.aborted) setLoadError(String(e.message)); });
    return () => abort.abort();
  }, [loadAttempt]);
  useEffect(() => {
    if (!master || selectedStat || !cards.length || xp === null) return;
    let cancelled = false, worker: Worker | null = null;
    const finish = (data: { result?: GrowthComparison; error?: string }) => {
      if (cancelled) return;
      worker?.terminate();
      setCompleted({ cards, master, xp, target, attempt: calculationAttempt, ...data });
    };
    // Coalesce rapid target/scan updates; cancel queued and in-flight work.
    const timer = setTimeout(() => {
      try {
        const request: GrowthComparisonRequest = { master,
          cards: cards.map(({ id, awakening, extraCopies, review, countReliable }) => ({ id, awakening, extraCopies, review, countReliable })),
          xp, target };
        worker = new Worker(new URL('./optimizer.worker.ts', import.meta.url), { type: 'module' });
        worker.onmessage = (message: MessageEvent<{ result?: GrowthComparison; error?: string }>) =>
          finish(message.data.result ? { result: message.data.result } : { error: message.data.error ?? '성장 계산에 실패했습니다.' });
        worker.onerror = () => finish({ error: '계산을 완료하지 못했습니다. 다시 시도해 주세요.' });
        worker.postMessage(request);
      } catch (e) { finish({ error: e instanceof Error ? e.message : '계산을 시작하지 못했습니다.' }); }
    }, 300);
    return () => { cancelled = true; clearTimeout(timer); worker?.terminate(); };
  }, [master, cards, xp, target, selectedStat, calculationAttempt]);
  const targetName = master?.targets.find(t => t.id === target)?.name ?? '악마';
  return <section className="panel growth-planner" aria-label="도감작 성장 계산">
    <div className="growth-heading"><h2>도감작</h2><details className="growth-help"><summary>계산 기준</summary>
      <p>현재 카드 목록 기준입니다. 삭제한 카드의 과거 달성 이력은 반영하지 않습니다.</p>
      {selectedStat ? <p>수집 1종당 효과가 큰 조합순입니다. 카드 등록만 필요하며, 조합별 효과는 합산하지 않습니다.</p> : <>
        <p>각 도감의 다음 효과까지 경험치당 효율을 비교합니다. 중간 효과 달성 후 남은 단계를 다시 비교하며, 부족한 단계는 건너뛰고 금색 단계에만 자원을 사용합니다.</p>
        <p>실링은 무제한이며 카드에 이미 투입한 경험치는 제외하지 않습니다. 획득 비용과 미판독 도감은 계산에서 제외합니다.</p>
        <p>후보 탐색에 제한이 있어 전체 최소 비용을 보장하지 않습니다.</p>
      </>}
    </details></div>
    {master && <BookOverview master={master} cards={cards} target={target} onTargetChange={setTarget} />}
    {selectedStat && master ? <StatCollection master={master} cards={cards} stat={selectedStat} /> : <>
    <h3 className="growth-plan-title">{targetName} 피해량 · 성장 효율</h3>
    {xp === null && <p className="growth-assumption" role="status">경험치 미확인 · 성장 탭을 스캔해 주세요.</p>}
    </>}
    {error && <p role="alert" className="error">{error}{!master && <button onClick={() => { setLoadError(''); setLoadAttempt(n => n + 1); }}>다시 불러오기</button>}
      {current?.error && !selectedStat && <button onClick={() => setCalculationAttempt(n => n + 1)}>다시 계산</button>}</p>}
    {running && <p role="status" className="growth-working"><span className="growth-spinner" />성장 순서 계산 중…</p>}
    {result && <div className="growth-result">
      <CollectionCandidates candidates={result.collectionCandidates} targetName={targetName} onComplete={step => onComplete(master!, step)} />
    </div>}
  </section>;
}
