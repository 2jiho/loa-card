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
import {loadRaidMaster} from '../../data/catalog';

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
    void loadRaidMaster(abort.signal)
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
    <div className="raid-context"><span>{bonus === 0 ? '취약 없음 · 속성 추가 피해 없음' : `${ELEMENTS[element]}속성 ${bonus === 15 ? '매우 취약' : '취약'} · 해당 속성 공격 피해 +${bonus}%`}{role === 'support' ? ' · 카드 효과로 표시' : ' · 가장 좋은 서포터 카드를 함께 쓴다고 계산'}</span>
    <Button color="inherit" startIcon={<TuneOutlined />} aria-haspopup="dialog" aria-expanded={!!settingsAnchor} onClick={event => setSettingsAnchor(event.currentTarget)}>비교 설정</Button>
    <Popover open={!!settingsAnchor} anchorEl={settingsAnchor} onClose={() => setSettingsAnchor(null)} anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }} transformOrigin={{ vertical: 'top', horizontal: 'right' }}
      slotProps={{ paper: { role: 'dialog', 'aria-label': '비교 설정', sx: { width: 440, maxWidth: 'calc(100vw - 32px)', maxHeight: '65dvh', mt: 1, border: '1px solid var(--line)' } } }}>
      <div className="raid-settings-panel">
      {role === 'dealer' && <TextField label="카드 제외 추가 피해 (%)" type="number" size="small" fullWidth value={additional} slotProps={{ htmlInput: { min: 0, max: 1000, step: 1 } }} onChange={e => setAdditional(Math.max(0, Math.min(1000, Number(e.target.value) || 0)))} />}
      <p>가진 카드 중 각성 합이 가장 높은 6장으로 계산해요. 게임에서 실제로 장착한 카드는 읽지 않아요.</p>
      <p>성장은 새로 구할 카드가 가장 적은 조합을 고르고, 그중 경험치가 가장 적게 드는 조합을 골라요. 세트마다 따로 계산하고, 카드에 이미 넣은 경험치는 비용에서 빼지 않아요.</p>
      <p>무속성 스킬을 쓴다고 보고 카드 효과와 속성 취약을 비교해요. 세우라제처럼 조건이 붙는 조합은 뺐어요. 스킬 자체의 속성, 다른 속성 피해 보너스, 방어 효과는 순위에 넣지 않아요.</p>
      <p>서포터는 파티 딜러의 공격 속성에 맞춰 골라 주세요. 세트끼리는 피해 증가 수치만 비교하고, 공격력·마나·무력화 효과는 순위에 더하지 않아요.</p>
      <p>{role === 'support' ? '큰 숫자는 카드의 원래 효과예요. 실효율은 취약이 이미 적용된 상태에서 서포터 카드가 더해 주는 비율이고, 추천 순서는 실효율로 정해요.' : '딜러 세트마다 가장 잘 맞는 서포터 30각 세트를 함께 쓴다고 보고 계산해요. 내 서포터 카드는 계산에 쓰지 않아요. 무속성 공격에 두 카드를 모두 쓰지 않았을 때와 비교해, 취약과 두 카드 효과를 더한 값을 비교해요. 속성이 바뀌기 전에는 범용 서포터 세트를 쓴다고 봐요.'} 속성 서포터 효과는 취약과 더하고, 너계다의 범용 효과는 따로 적용해요. <a href="https://www.inven.co.kr/board/lostark/4821/101866" target="_blank" rel="noreferrer">실측 자료</a>로 추정한 값이고 공식 계산식이 아니에요.</p>
      <p>데이터 {master?.version ?? '불러오는 중'}</p>
      </div>
    </Popover></div>
    {!complete && <p className="raid-muted">스캔을 끝까지 마치기 전이라 일부 카드는 아직 몰라요.</p>}
    {error ? <p role="alert">{error} <button onClick={() => { setError(''); setAttempt(n => n + 1); }}>다시 불러오기</button></p> :
      !master ? <p role="status">카드 세트 불러오는 중</p> :
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
