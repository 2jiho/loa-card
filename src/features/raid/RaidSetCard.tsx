import { CardName } from '../../CardName';
import { ELEMENTS, effectText } from './raid-progress';
import type { RaidMaster, RaidProgress, RaidSet } from './raid-progress';

export function RaidSetCard({ set, master, progress, xp }: {
  set: RaidSet; master: RaidMaster; progress: RaidProgress; xp?: number;
}) {
  const selected = new Set(progress.selected.map(m => m.card.id));
  const resistanceKeys = ['stat:95', 'stat:96', 'stat:97', 'stat:99', 'stat:100', 'stat:101', 'stat:102'];
  const mainEffects = progress.effects.filter(effect => !resistanceKeys.includes(effect.key));
  const plan = progress.plan;
  const xpKnown = xp !== undefined && Number.isSafeInteger(xp) && xp >= 0;
  const canGrow = !!plan && plan.missing === 0 && xpKnown && plan.xp <= xp;
  return <article id={`raid-set-${set.id}`} className={`raid-set${progress.selected.length === set.slots && progress.total >= set.slots * 5 ? ' raid-set-max' : ''}`}>
    <header><div><span className={`raid-element raid-element-${set.element}`}>{set.element === 'general' ? '범용' : `${ELEMENTS[set.element]}속성`}</span>
      <span className="raid-role">{set.role === 'dealer' ? '딜러' : '서포터'}</span>
      <h3>{set.alias}</h3>{!set.alias.includes(set.name) && <p>{set.name}</p>}</div>
      <div className="raid-total"><strong>{progress.total}<small> / {set.slots * 5}각</small></strong><span>{progress.unknown ? '확인된 카드 기준' : `${progress.selected.length} / ${set.slots}장 구성`}</span></div>
    </header>
    <div className="raid-thresholds" aria-label="각성 효과 달성 단계">{progress.thresholds.map(threshold => {
      const active = progress.active.some(stage => stage.awakening === threshold);
      return <span key={threshold} className={active ? 'is-active' : ''} title={set.stages.filter(s => s.awakening === threshold).flatMap(s => s.effects.map(effectText)).join('\n')}>
        {active ? '✓ ' : ''}{threshold}각<span className="raid-sr-only"> {active ? '달성' : '미달성'}</span></span>;
    })}</div>
    <div className="raid-potential"><span>현재 <b>{progress.total}각</b></span><span>→</span><span>보유 카드 성장 <b>{progress.growth.total}각</b>{progress.growth.uncertain ? ' 이상 · 확인된 카드 기준' : ''}</span></div>
    {progress.growth.plan && progress.growth.plan.xp > 0 && <p className="raid-potential-xp">필요 경험치 {progress.growth.plan.xp.toLocaleString()}{xpKnown && progress.growth.plan.xp > xp ? ' · 경험치 부족' : ''}</p>}
    <div className="raid-current">{mainEffects.length ? mainEffects.map(effect => <p key={effect.key}>{effectText(effect)}</p>) :
      <p className="raid-muted">{progress.selected.length < 6 ? '6장 구성이 필요해요' : '각성 효과 미달성'}</p>}</div>
    <ul className="raid-members">{progress.members.map(member => <li key={member.card.id} className={selected.has(member.card.id) ? 'is-selected' : 'is-unselected'}>
      <CardName name={member.card.name} rarity={member.card.rarity} />
      <span>{member.status === 'known' ? `${member.awakening}각${selected.has(member.card.id) ? '' : ' · 대체'}` : member.status === 'missing' ? '미등록' : '미확인'}</span>
    </li>)}</ul>
    {progress.next !== null && <div className={`raid-next${canGrow ? ' can-grow' : ''}`}>
      <strong>다음 {progress.next}각</strong><span>{!plan ? '카드 정보 확인 후 계산' : plan.missing > 0 ? `추가 ${plan.missing}장 필요` : canGrow ? '지금 성장 가능' : xpKnown ? '경험치 부족' : '카드 준비 완료 · 경험치 미확인'}</span>
    </div>}
    <details className="raid-details"><summary>효과{progress.next !== null ? ' · 성장 카드' : ''} 보기</summary>
      <ul>{set.stages.map((stage, i) => <li key={i} className={progress.active.includes(stage) ? 'is-active' : ''}>
        <b>{stage.count}장{stage.awakening ? ` · ${stage.awakening}각` : ''}</b>
        <span>{stage.effects.map(effectText).join(' / ')}</span>
      </li>)}</ul>
      {plan && <div className="raid-growth"><h4>{progress.next}각까지 · 경험치 {plan.xp.toLocaleString()}</h4>
        {plan.selected.filter(choice => choice.to > choice.from || choice.register).map(choice => {
          const card = master.cards.find(c => c.id === choice.id)!;
          return <p key={choice.id}><span>{card.name} <b>{choice.register ? '등록' : `${choice.from}각`} → {choice.to}각</b></span>
            <span>{choice.missing ? `${choice.missing}장 부족` : '보유 카드 사용'}</span></p>;
        })}
        {plan.selected.some(choice => !selected.has(choice.id)) && <p className="raid-muted">이 단계에서는 위 성장 카드로 6장 구성이 바뀔 수 있어요.</p>}
      </div>}
      {progress.growth.plan && progress.growth.total > progress.total && progress.growth.total !== progress.next && <div className="raid-growth">
        <h4>보유 카드로 최대 {progress.growth.total}각 · 경험치 {progress.growth.plan.xp.toLocaleString()}</h4>
        {progress.growth.plan.selected.filter(choice => choice.to > choice.from).map(choice => <p key={choice.id}>
          <span>{master.cards.find(c => c.id === choice.id)!.name}</span><b>{choice.from} → {choice.to}각</b>
        </p>)}
      </div>}
    </details>
  </article>;
}
