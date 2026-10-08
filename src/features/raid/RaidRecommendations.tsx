import { useMemo } from 'react';
import { ELEMENTS } from './raid-progress';
import type { Element, RaidMaster, RaidOwned, RaidProgress } from './raid-progress';
import { isAlternativeRaidSet, raidRecommendationChoices, rankRaidSets } from './raid-ranking';
import type { RaidComparison } from './raid-ranking';

const displayedBoost = (choice: RaidComparison) => choice.set.role === 'support' ? choice.cardBoost : choice.boost;
const percent = (value: number) => (Math.round((value * 100 + 1e-9) * 100) / 100).toFixed(2);

function ComparisonBasis({ choice }: { choice: RaidComparison }) {
  return choice.set.role === 'support'
    ? <small>취약 반영 실효율 약 {percent(choice.boost)}%</small>
    : choice.support && <small>{choice.support.set.alias} 30각 가정 · 취약·서포터 카드 포함</small>;
}

function Choice({ choices, preferred, unavailable, grow, xp, onSelect }: { choices: RaidComparison[]; preferred?: RaidComparison; unavailable?: string; grow: boolean; xp?: number; onSelect: (id: string) => void }) {
  const { primary, alternatives } = raidRecommendationChoices(choices, preferred);
  const best = primary[0];
  const explanation = alternatives.length > 0 && <section className="raid-alternative-note" aria-label="더 효율적인 대체 세트">
    <h4>{unavailable ? '대신 사용할 세트' : grow ? '성장 후 더 좋은 세트' : '지금 더 좋은 세트'}</h4>
    {alternatives.map(choice => <div key={choice.set.id}>
      <strong>{choice.set.alias} {choice.total}각</strong><span>{choice.set.role === 'support' ? '카드 효과' : '피해 증가'} +{percent(displayedBoost(choice))}%</span>
      <ComparisonBasis choice={choice} />
      <small>{unavailable ? '속성 세트가 준비되기 전 사용할 수 있어요.' : best ? `${best.set.alias}보다 실효율 약 +${percent(choice.boost - best.boost)}%p` : '주요 세트의 피해 증가 효과를 달성하기 전 사용할 수 있어요.'}
        {choice.uncertain ? ' · 확인된 카드 기준' : ''}</small>
      {grow && choice.xp > 0 && <small>필요 경험치 {choice.xp.toLocaleString()} · {xp === undefined ? '보유 경험치 미확인' : choice.xp > xp ? '경험치 부족' : '지금 성장 가능'}</small>}
    </div>)}
  </section>;
  if (!best) return <div className="raid-choice is-empty"><span className="raid-choice-label">{grow ? '보유 카드로 성장 후' : '지금 사용할 세트'}</span><strong>주요 세트의 효과 미달성</strong><small>아래에서 세트별 부족한 카드를 확인하세요.</small>{explanation}</div>;
  const ties = primary.filter(choice => Math.abs(choice.boost - best.boost) < 1e-9);
  return <div className={`raid-choice ${grow ? 'is-growth' : 'is-current'}`}>
    <span className="raid-choice-label">{preferred ? `${ELEMENTS[best.set.element]}속성 세트 · ${grow ? '보유 카드로 성장 후' : '현재'}` : grow ? '보유 카드로 성장 후' : '지금 사용할 세트'}</span>
    <button className="raid-choice-main" onClick={() => onSelect(best.set.id)} title={ties.map(c => `${c.set.name} ${c.total}각`).join('\n')}>
      <span><strong>{best.set.alias}</strong><b>{best.total}각</b></span><span className="raid-choice-gain">+{percent(displayedBoost(best))}<small>%</small></span>
    </button>
    {!unavailable && <ComparisonBasis choice={best} />}
    <div className="raid-choice-meta"><span>{unavailable ?? (grow && best.xp > 0 ? `경험치 ${best.xp.toLocaleString()}` : grow ? '추가 성장 불필요' : '현재 각성 효과')}{best.uncertain ? ' · 확인된 카드 기준' : ''}</span>
      {grow && best.xp > 0 && <span className={xp === undefined ? '' : best.xp > xp ? 'needs-xp' : 'ready'}>{xp === undefined ? '경험치 미확인' : best.xp > xp ? '경험치 부족' : '지금 성장 가능'}</span>}</div>
    {ties.length > 1 && <small>같은 효과의 세트 {ties.length - 1}개 더 있음</small>}
    {grow && !unavailable && best.maximum > best.total && <small>최대 {best.maximum}각 가능 · 다음 효과 미달</small>}
    {explanation}
  </div>;
}

export function RaidRecommendations({ master, cards, complete, role, element, bonus, additional, xp, onSelect, prepared }: {
  master: RaidMaster; cards: RaidOwned[]; complete: boolean; role: 'dealer' | 'support'; element: Element;
  bonus: number; additional: number; xp?: number; onSelect: (id: string) => void;
  prepared: Map<string, RaidProgress>;
}) {
  const choices = useMemo(() => ({ current: rankRaidSets(master, cards, complete, role, element, false, bonus, additional, prepared),
    growth: rankRaidSets(master, cards, complete, role, element, true, bonus, additional, prepared) }), [master, cards, complete, role, element, bonus, additional, prepared]);
  const matchingSet = master.sets.find(set => set.role === role && set.element === element && !isAlternativeRaidSet(set));
  const matchingProgress = matchingSet && prepared.get(matchingSet.id)!;
  const matchingChoice = (ranked: RaidComparison[], grow: boolean) => matchingSet && matchingProgress ? ranked.find(choice => choice.set.id === matchingSet.id) ?? {
    set: matchingSet, total: grow ? matchingProgress.growth.total : matchingProgress.total, maximum: matchingProgress.growth.total,
    boost: 0, cardBoost: 0, xp: 0, uncertain: matchingProgress.unknown || (grow && matchingProgress.growth.uncertain),
  } : undefined;
  const current = matchingChoice(choices.current, false);
  const growth = matchingChoice(choices.growth, true);
  const unavailable = (choice?: RaidComparison) => choice?.boost === 0 && matchingProgress ? matchingProgress.selected.length < choice.set.slots
    ? `구성 카드 ${choice.set.slots - matchingProgress.selected.length}종 ${matchingProgress.unknown ? '미확인' : '미등록'}` : '피해 증가 효과 미달성' : undefined;
  return <div className="raid-recommendations" aria-label={`${ELEMENTS[element]}속성 추천`}>
    <Choice choices={choices.current} preferred={current} unavailable={unavailable(current)} grow={false} onSelect={onSelect} />
    <Choice choices={choices.growth} preferred={growth} unavailable={unavailable(growth)} grow xp={xp} onSelect={onSelect} />
  </div>;
}
