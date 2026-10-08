import { useEffect, useMemo, useRef, useState } from 'react';
import { ELEMENTS, raidProgress } from './raid-progress';
import type { Element, RaidMaster, RaidOwned } from './raid-progress';
import { RaidRecommendations } from './RaidRecommendations';
import { isAlternativeRaidSet } from './raid-ranking';
import { RaidSetCard } from './RaidSetCard';
import './raid.css';
import ToggleButton from '@mui/material/ToggleButton';
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup';
import Button from '@mui/material/Button';
import Popover from '@mui/material/Popover';
import TextField from '@mui/material/TextField';
import TuneOutlined from '@mui/icons-material/TuneOutlined';

export function RaidCards({ cards, complete, xp }: { cards: RaidOwned[]; complete: boolean; xp?: number }) {
  const [master, setMaster] = useState<RaidMaster | null>(null);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const [role, setRole] = useState<'dealer' | 'support'>('dealer');
  const [element, setElement] = useState<Element>('holy');
  const [bonus, setBonus] = useState(10);
  const [additional, setAdditional] = useState(0);
  const [focused, setFocused] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [settingsAnchor, setSettingsAnchor] = useState<HTMLButtonElement | null>(null);
  useEffect(() => {
    const abort = new AbortController();
    void fetch(`${import.meta.env.BASE_URL}raid/master.json`, { signal: abort.signal })
      .then(r => { if (!r.ok) throw new Error('레이드 카드 데이터를 불러오지 못했습니다.'); return r.json(); })
      .then(setMaster).catch(e => { if (!abort.signal.aborted) setError(e.message); });
    return () => abort.abort();
  }, [attempt]);
  const progressById = useMemo(() => new Map(master?.sets.map(set => [set.id, raidProgress(set, master, cards, complete)]) ?? []), [master, cards, complete]);
  const sets = master?.sets.filter(set => set.role === role && !isAlternativeRaidSet(set)) ?? [];
  const orderedSets = Object.keys(ELEMENTS).flatMap(key => sets.filter(set => set.element === key));
  const recommended = sets.find(set => set.element === element)?.id;
  const selectedSet = sets.find(set => set.id === (focused ?? recommended)) ?? sets[0];
  useEffect(() => {
    const list = listRef.current;
    const button = list?.querySelector<HTMLButtonElement>('[aria-pressed="true"]');
    if (list && button && (button.offsetTop < list.scrollTop || button.offsetTop + button.offsetHeight > list.scrollTop + list.clientHeight)) {
      list.scrollTop = Math.max(0, button.offsetTop - (list.clientHeight - button.offsetHeight) / 2);
    }
  }, [selectedSet?.id]);
  return <section className="panel raid-cards" aria-label="레이드 카드 세트">
    <div className="raid-heading"><h2>레이드 카드</h2>
      <ToggleButtonGroup value={role} exclusive size="small" aria-label="역할" onChange={(_, value) => { if(value) { setRole(value); setFocused(null); } }}>
        <ToggleButton value="dealer">딜러</ToggleButton><ToggleButton value="support">서포터</ToggleButton>
      </ToggleButtonGroup>
    </div>
    <div className="raid-elements" role="group" aria-label={role === 'support' ? '파티 공격 속성' : '보스 취약 속성'}>
      {Object.entries(ELEMENTS).filter(([value]) => value !== 'general').map(([value, label]) => <button key={value} aria-pressed={element === value}
        className={`raid-element-${value}`} onClick={() => { setElement(value as Element); setFocused(null); }}>
        <span className="raid-element-mark" aria-hidden="true">{label}</span><span>{label}속성</span></button>)}
    </div>
    <div className="raid-weakness"><span>{role === 'support' ? '공격 속성에 대한 취약' : '보스 취약'}</span>
      <ToggleButtonGroup value={bonus} exclusive size="small" aria-label="취약 정도" onChange={(_, value) => { if(value !== null) { setBonus(value); setFocused(null); } }}>
        <ToggleButton value={0}>없음</ToggleButton><ToggleButton value={10}>취약 10%</ToggleButton><ToggleButton value={15}>매우 취약 15%</ToggleButton>
      </ToggleButtonGroup>
    </div>
    <div className="raid-context"><span>{bonus === 0 ? '취약 없음 · 속성에 따른 추가 피해 없음' : `${ELEMENTS[element]}속성 ${bonus === 15 ? '매우 취약' : '취약'} · 해당 속성 공격 피해 +${bonus}%`}{role === 'support' ? ' · 카드 효과 기준 표시' : ' · 최상위 서포터 카드 가정'}</span>
    <Button color="inherit" startIcon={<TuneOutlined />} aria-haspopup="dialog" aria-expanded={!!settingsAnchor} onClick={event => setSettingsAnchor(event.currentTarget)}>비교 설정</Button>
    <Popover open={!!settingsAnchor} anchorEl={settingsAnchor} onClose={() => setSettingsAnchor(null)} anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }} transformOrigin={{ vertical: 'top', horizontal: 'right' }}
      slotProps={{ paper: { role: 'dialog', 'aria-label': '비교 설정', sx: { width: 440, maxWidth: 'calc(100vw - 32px)', maxHeight: '65dvh', mt: 1, border: '1px solid var(--line)' } } }}>
      <div className="raid-settings-panel">
      {role === 'dealer' && <TextField label="카드 제외 추가 피해 (%)" type="number" size="small" fullWidth value={additional} slotProps={{ htmlInput: { min: 0, max: 1000, step: 1 } }} onChange={e => setAdditional(Math.max(0, Math.min(1000, Number(e.target.value) || 0)))} />}
      <p>보유 카드 중 각성 합이 가장 높은 6장 기준입니다. 실제 게임의 장착 상태는 읽지 않습니다.</p>
      <p>성장은 추가로 구할 카드 수가 가장 적은 조합, 그중 경험치가 적은 조합입니다. 각 세트를 독립 계산하며 이미 투입한 경험치는 차감하지 않습니다.</p>
      <p>무속성 스킬 기준으로 카드 효과와 속성 취약을 비교합니다. 세우라제 등 조건부 조합은 제외합니다. 스킬 고유 속성·다른 속성 피해 보너스·방어 효과는 순위에 반영하지 않습니다.</p>
      <p>서포터는 파티 딜러의 공격 속성에 맞춰 선택하세요. 세트 간 피해 증가 수치만 비교하며 공격력·마나·무력화 효과는 순위에 합산하지 않습니다.</p>
      <p>{role === 'support' ? '큰 수치는 카드 원래 효과이며, 실효율은 취약이 적용된 상태에서 서포터 카드가 더하는 증가율입니다. 추천 순서는 실효율로 비교합니다.' : '각 딜러 세트에 가장 유리한 서포터 30각 세트를 가정합니다. 내 서포터 카드 보유량은 적용하지 않으며, 무속성·양쪽 카드 미사용 대비 취약과 두 카드의 합산 효과를 비교합니다. 속성 전환 전에는 범용 서포터 세트를 가정합니다.'} 속성 서포터 효과는 취약과 합산하고, 너계다의 범용 효과는 별도로 적용합니다. <a href="https://www.inven.co.kr/board/lostark/4821/101866" target="_blank" rel="noreferrer">실측 자료</a> 기반 추정이며 공식 산식은 아닙니다.</p>
      <p>데이터 {master?.version ?? '불러오는 중'}</p>
      </div>
    </Popover></div>
    {!complete && <p className="raid-muted">미확인 카드는 전체 스캔 후 확인할 수 있어요.</p>}
    {error ? <p role="alert">{error} <button onClick={() => { setError(''); setAttempt(n => n + 1); }}>다시 불러오기</button></p> :
      !master ? <p role="status">카드 세트 불러오는 중…</p> :
        <><RaidRecommendations prepared={progressById} master={master} cards={cards} complete={complete} role={role} element={element} bonus={bonus} additional={additional} xp={xp} onSelect={setFocused} />
        <div className="raid-list-heading"><h3>세트별 각성 <span>{sets.length}</span></h3><small>현재 → 성장 가능</small></div>
        <div className="raid-browser"><div className="raid-set-list">
          <div className="raid-set-options" ref={listRef} role="group" aria-label="세트 상세 선택">{orderedSets.map(set => {
            const p = progressById.get(set.id)!;
            return <button key={set.id} aria-pressed={selectedSet?.id === set.id} onClick={() => setFocused(set.id)} title={set.alias.includes(set.name) ? set.alias : `${set.alias}(${set.name})`}>
              <span className={`raid-list-element raid-element-${set.element}`}>{ELEMENTS[set.element]}</span>
              <span className="raid-list-name">{set.alias}</span>
              <span className="raid-list-count"><span>{p.total}</span><i>→</i><b>{p.growth.total}</b><small>각{p.growth.uncertain ? '+' : ''}</small></span>
            </button>;
          })}</div></div>
          {selectedSet && <RaidSetCard key={selectedSet.id} set={selectedSet} master={master} progress={progressById.get(selectedSet.id)!} xp={xp} />}
        </div></>}
  </section>;
}
