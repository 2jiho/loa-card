import type { GrowthSequenceStep } from './growth-sequence';
import { cardRarityClass } from '../../card-rarity';
import { growthDisplayRows } from './growth-display';

const number = (n: number) => n.toLocaleString('ko-KR');
export function CollectionCandidates({ candidates, targetName, onComplete, disabled = false }: {
  candidates: GrowthSequenceStep[]; targetName: string; onComplete: (step: GrowthSequenceStep) => void; disabled?: boolean;
}) {
  const ready = candidates.filter(c => c.status === 'ready'&&c.available.cards.length>0);
  const lastReady = ready.at(-1);
  const rows = growthDisplayRows(candidates);
  const firstReady = rows.find(row => row.step.status === 'ready'&&row.step.available.cards.length>0)?.step;
  return <section className="growth-collection" aria-label="효율순 성장 계획">
    <h3>효율순 성장 계획 <small>{candidates.length}단계</small></h3>
    <div className="growth-owned-legend">
      <span><i className="is-ready" aria-hidden="true" />지금 달성 가능</span>
      <span><i className="is-xp-needed" aria-hidden="true" />경험치 부족</span>
      <span><i className="is-cards-needed" aria-hidden="true" />카드 부족</span>
    </div>
    <p>다음 효과까지의 효율순 · 금색 단계부터 진행하세요.</p>
    {lastReady && <p className="growth-ready-summary">현재 자원으로 {ready.length}단계 · {targetName} +{(lastReady.available.gained / 100).toFixed(2)}%p · 경험치 {number(lastReady.available.usedXp)} 사용 / {number(lastReady.available.remainingXp)} 남음</p>}
    {rows.map(({ step: c, rank, stages }) => {
      const a = c.available;
      const bundled = stages.length > 1;
      return <div className={`growth-step-row${c.status === 'ready' ? ' has-completion' : ''}`} key={c.key}>
      <details className={`growth-step is-${c.status}`}>
      <summary><span className="growth-step-number">{rank}</span>
        <span className="growth-step-title"><b>{c.books[0]}{c.books.length > 1 ? ` 외 ${c.books.length - 1}개 도감` : ''}</b>
        {bundled && <span className="growth-step-milestones">{stages.length}단계 묶음 · 카드 {a.cards.length}종</span>}
        <span className="growth-step-milestones">{c.milestones.map(m => <span key={m.bookId}>
          {c.milestones.length > 1 ? `${m.name} · ` : ''}각성 합 {m.from} → {m.to}
        </span>)}</span><small>
          {c.status === 'ready' ? a.cards.length?'달성 가능':'앞 성장에 포함' : c.status === 'xp-needed' ? '경험치 부족' : `카드 ${a.missingCopies}장 부족`} · {bundled ? '합계' : '단계'} 경험치 {number(c.xp)}
          {a.xp !== c.xp ? ` · 현재 카드 기준 ${number(a.xp)}` : ''}
        </small>
        <span className="growth-step-upgrades">{a.cards.map(card => <span className="growth-upgrade" key={card.id}>
          <span className={cardRarityClass(card.rarity)}>{card.name}</span>
          <span>{card.absent ? card.to ? `신규 → ${card.to}각` : '신규 등록' : `${card.from}각 → ${card.to}각`}</span>
        </span>)}</span>
        </span>
        <span className="growth-step-gain"><b>{targetName} +{(c.gain / 100).toFixed(2)}%p</b><small>
          {c.efficiency === null ? '경험치 소모 없음' : `${bundled ? '묶음 평균 · ' : ''}1만 경험치당 +${c.efficiency.toLocaleString('ko-KR', { maximumFractionDigits: 4 })}%p`}
        </small></span>
      </summary>
      <div className="growth-step-body">
        {bundled && <ol className="growth-bundle-stages" aria-label="묶음의 효율순 단계">{stages.map(({ step, rank: stageRank }) =>
          <li key={step.key} value={stageRank}>{step.books.join(' · ')} · {step.milestones.map(m => `각성 합 ${m.from} → ${m.to}`).join(' / ')} · +{(step.available.gain / 100).toFixed(2)}%p</li>
        )}</ol>}
        <div className="growth-table-wrap"><table className="growth-table"><caption className="book-sr-only">필요한 성장과 추가 수집 카드</caption>
          <thead><tr><th>카드</th><th>성장</th><th>추가 수집</th><th>경험치</th></tr></thead>
          <tbody>{a.cards.map(card => <tr key={card.id}><th scope="row" className={cardRarityClass(card.rarity)}>{card.name}{card.absent && <small className="growth-absent">목록 없음</small>}</th>
            <td>{card.absent ? '신규 등록' : `${card.from}각`} → {card.to}각</td><td className={card.missing ? 'growth-missing-copies' : ''}>{card.missing ? `${card.missing}장 부족` : '충분'}</td><td>{number(card.xp)}</td></tr>)}</tbody>
        </table></div>
        <p className="growth-collection-note">도감: {c.books.join(' · ')}<br />예상 실링 {number(a.silver)} · 각성에 소모할 카드 {a.copies}장</p>
        {(a.xp !== c.xp || a.gain !== c.gain) && <p className="growth-collection-note">순위 기준 {number(c.xp)} 경험치 · 현재 카드 기준 {number(a.xp)} 경험치 / +{(a.gain / 100).toFixed(2)}%p</p>}
        {a.xpShortfall > 0 && <p className="growth-collection-note">경험치 {number(a.xpShortfall)} 부족</p>}
        <p className="growth-step-total"><span>실행 누적 경험치 {number(a.usedXp)} · 효과 +{(a.gained / 100).toFixed(2)}%p{c.status !== 'ready' ? ' · 이 단계 제외' : ''}</span>
          <span>남은 경험치 {number(a.remainingXp)}</span></p>
        {a.conditional && <p className="growth-collection-note">미등록 가정 · 부족 장수에 등록용 1장 포함</p>}
      </div>
    </details>
    {c.status === 'ready' && a.cards.length>0 && <button className="secondary growth-complete-button" disabled={disabled || c !== firstReady}
      aria-label={`${c.books[0]} 성장 완료`}
      title={c === firstReady ? '게임에서 표시된 카드의 성장을 모두 마친 뒤 눌러 주세요.' : '앞의 금색 단계를 먼저 완료해 주세요.'}
      onClick={() => onComplete(c)}>성장 완료</button>}
    </div>; })}
    {!candidates.length && <p>성장 후보 없음 · 최대 효과 또는 카드 확인 필요</p>}
  </section>;
}
