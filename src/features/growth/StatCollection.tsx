import { useMemo } from 'react';
import type { GrowthMaster, OwnedCard } from './optimizer';
import { statCollectionPlans } from './stat-collection';
import { cardRarityClass } from '../../card-rarity';
import { primaryStatLabel, primaryStatsAreGrouped } from './stat-display';

export function StatCollection({ master, cards, stat }: { master: GrowthMaster; cards: OwnedCard[]; stat: string }) {
  const plan = useMemo(() => statCollectionPlans(master, cards, stat), [master, cards, stat]);
  if (!plan.stat) return null;
  const { current, maximum } = plan.stat;
  const grouped = stat === '3' && primaryStatsAreGrouped(master);
  const name = grouped ? primaryStatLabel : plan.stat.name;
  const each = grouped ? '각 ' : '';
  return <section className="stat-collection" aria-label={`${name} 수집 계획`}>
    <div className="growth-heading"><h3>{name} 수집 계획</h3><span>현재 {each}+{current} / 최대 {each}+{maximum}{current === maximum ? ' (최대)' : ''}</span></div>
    <p className="book-context">수집 효율순 · 경험치 불필요 · 조합별 효과는 합산하지 않음</p>
    {plan.candidates.map((c, i) => <details className="growth-step" key={c.key}>
      <summary><span className="growth-step-number">{i + 1}</span>
        <span className="growth-step-title"><b>{c.books[0].name}{c.books.length > 1 ? ` 외 ${c.books.length - 1}개 도감` : ''}</b><small>추가 수집 {c.cards.length}종 · 각 1장</small></span>
        <span className="growth-step-gain"><b>{name} {each}+{c.gain}</b><small>1종당 {each}+{c.efficiency.toLocaleString('ko-KR', { maximumFractionDigits: 2 })}</small></span>
      </summary>
      <div className="growth-step-body"><h4>필요한 카드</h4><ul className="stat-needed-cards">{c.cards.map(card => <li key={card.id} className={cardRarityClass(card.rarity)}>{card.name}<span>1장</span></li>)}</ul>
        <ul className="growth-step-effects">{c.books.map(b => <li key={b.id}><b>{b.name}</b><span>{name} {each}+{b.gain}</span></li>)}</ul>
        <p className="growth-collection-note">등록 후 {name} {each}+{current} → {each}+{current + c.gain}</p>
      </div>
    </details>)}
    {!plan.candidates.length && <p className="growth-empty">{current === maximum ? '최대 효과 달성' : '수집 조합 미확인 · 확인할 카드를 다시 스캔해 주세요.'}</p>}
    {!!plan.excluded.length && <details className="growth-details"><summary>판독 확인으로 제외한 도감 {plan.excluded.length}개</summary><p>{plan.excluded.join(' · ')}</p></details>}
    {plan.limited && <p className="book-context">후보가 많아 도감 효과당 최대 512개 조합을 비교했습니다.</p>}
  </section>;
}
