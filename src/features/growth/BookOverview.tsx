import { useMemo, useState } from 'react';
import { currentBookProgress } from './optimizer';
import type { GrowthMaster, OwnedCard } from './optimizer';
import { collectionStatText, displayStats } from './stat-display';
import TextField from '@mui/material/TextField';

const percent = (value: number) => `${(value / 100).toFixed(2)}%`;

export function BookOverview({ master, cards, target, onTargetChange }: {
  master: GrowthMaster; cards: OwnedCard[]; target: string; onTargetChange: (id: string) => void;
}) {
  const progress = useMemo(() => currentBookProgress(master, cards), [master, cards]);
  const stats = displayStats(master, progress.stats);
  const [filter, setFilter] = useState<'all' | 'incomplete' | 'unknown'>('all');
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState('');
  const names = useMemo(() => new Map(master.cards.map(c => [c.id, c.name])), [master]);
  const stat = target.startsWith('stat:') ? target.slice(5) : null;
  const books = progress.books.filter(b => stat ? b.collectionEffects.some(e => e.stats.some(s => s.stat === stat)) : b.effects.some(e => e.target === target));
  const visible = books.filter(b => (filter === 'all' || (filter === 'unknown' ? b.unreadable.length > 0 :
    stat ? b.collectionEffects.some(e => e.active !== true && e.stats.some(s => s.stat === stat)) :
    b.effects.some(e => e.target === target && e.active !== true))) &&
    (!query.trim() || b.name.includes(query.trim()) || b.cardIds.some(id => names.get(id)?.includes(query.trim()))))
    .sort((a, b) => a.name.localeCompare(b.name, 'ko', { numeric: true }) || a.id.localeCompare(b.id, 'en', { numeric: true }));
  const selected = visible.find(b => b.id === selectedId) ?? visible[0];
  const unknown = progress.books.filter(b => b.unreadable.length > 0).length;
  return <section className="book-overview" aria-label="현재 도감 현황">
    <div className="book-heading"><h3>수집된 도감 효과 <span>({progress.activeEffects} / {progress.totalEffects})</span></h3></div>
    <div className="book-layout">
      <div className="book-browser">
        <div className="book-controls">
          <TextField select size="small" value={target} onChange={e => onTargetChange(e.target.value)} slotProps={{ select: { native: true }, htmlInput: { 'aria-label': '도감 효과 구분' } }}>
            <optgroup label="수집 능력치">{stats.map(s => <option key={s.id} value={`stat:${s.id}`}>{s.name}</option>)}</optgroup>
            <optgroup label="계열 피해량">{progress.targets.map(t => <option key={t.id} value={t.id}>{t.name} 계열</option>)}</optgroup>
          </TextField>
          <TextField select size="small" value={filter} onChange={e => setFilter(e.target.value as typeof filter)} slotProps={{ select: { native: true }, htmlInput: { 'aria-label': '도감 효과 수집' } }}>
            <option value="all">효과 수집 - 전체</option><option value="incomplete">미완성</option><option value="unknown">확인 필요</option>
          </TextField>
          <TextField size="small" type="search" slotProps={{ htmlInput: { 'aria-label': '도감 또는 카드 이름 검색' } }} placeholder="세트 이름 또는 카드 이름" value={query} onChange={e => setQuery(e.target.value)} />
        </div>
        <div className="book-selection" role="group" aria-label="도감 목록">
          {visible.map(b => <button key={b.id} type="button" aria-pressed={selected?.id === b.id} onClick={() => setSelectedId(b.id)}>
            <span>{b.name}</span><small>{b.confirmedCards} / {b.cardIds.length}{b.unreadable.length ? ' · 확인 필요' : b.unregistered.length ? ' · 미완성' : ''}</small>
          </button>)}
          {!visible.length && <p className="book-context">해당하는 도감이 없습니다.</p>}
        </div>
        {selected && <section className="book-detail" aria-label="선택한 도감 수집 효과">
          <div className="book-detail-title"><h4>{selected.name}</h4><span>{selected.sum === null ? `확인된 각성 합: ${selected.confirmedSum} · ${selected.unreadable.length ? '확인 필요' : '미완성'}` : `각성 단계 합: ${selected.sum}`}</span></div>
          <p className="book-members">{selected.cardIds.map(id => names.get(id) ?? id).join(' · ')}</p>
          <h5>도감 수집 효과</h5>
          <ul className="book-effect-lines">
            {selected.collectionEffects.map((e, i) => <li key={`collection-${i}`} className={e.active ? 'is-active' : 'is-inactive'}>
              카드 {e.requiredCount}장 수집 : {collectionStatText(master, e.stats)}
              <span className="book-sr-only">{e.active ? ' 달성' : selected.unreadable.length ? ' 확인 필요' : ' 미달성'}</span>
            </li>)}
            {selected.effects.map((e, i) => <li key={i} className={e.active === true ? 'is-active' : 'is-inactive'}>
              카드 {e.requiredCount}장 수집{e.threshold ? ` (각성단계 합계 ${e.threshold})` : ''}: {master.targets.find(t => t.id === e.target)?.name} 계열 피해량 증가 +{percent(e.value)}
              <span className="book-sr-only">{e.active === null && selected.unreadable.length ? ' 확인 필요' : e.active ? ' 달성' : ' 미달성'}</span>
            </li>)}
          </ul>
          {!!selected.unregistered.length && <p className="book-missing">미등록: {selected.unregistered.join(', ')}</p>}
          {!!selected.unreadable.length && <p className="book-missing">확인할 카드: {selected.unreadable.join(', ')}</p>}
        </section>}
      </div>
      <aside className="book-cumulative" aria-label="누적 도감 효과">
        <h3>누적 도감 효과</h3><h4>수집 효과 <small>현재 / 최대</small></h4>
        <ul className="book-effect-totals">
          {stats.filter(s => s.maximum > 0).map(s => <li key={s.id} title={s.unknownBooks ? `${s.unknownBooks}개 도감 확인 필요 · 확인된 효과만 합산` : undefined}>
            <button type="button" className={stat === s.id ? 'is-selected' : ''} aria-pressed={stat === s.id} onClick={() => onTargetChange(`stat:${s.id}`)}>
            <span>{s.name}</span><span>{s.grouped ? '각 ' : ''}+{s.current.toLocaleString()}{s.current === s.maximum && !s.unknownBooks ? <small className="book-effect-max"> (최대)</small> : <small> / {s.maximum.toLocaleString()}</small>}</span>
            </button>
          </li>)}
          {progress.targets.filter(t => t.maximum > 0).map(t => <li key={t.id}>
            <button type="button" className={target === t.id ? 'is-selected' : ''} aria-pressed={target === t.id} onClick={() => onTargetChange(t.id)}
              title={t.unknownBooks ? `${t.unknownBooks}개 도감 확인 필요 · 확인된 효과만 합산` : '관련 도감 보기'}>
              <span>{t.name} 계열 피해량</span><span>{percent(t.current)}{t.current === t.maximum && !t.unknownBooks ? <small className="book-effect-max"> (최대)</small> : <small> / {percent(t.maximum)}</small>}</span>
            </button>
          </li>)}
        </ul>
        {progress.activeEffects === 0 && <p className="book-context">현재 목록에서 확인된 수집 효과가 없습니다.</p>}
      </aside>
    </div>
    {unknown > 0 && <p className="book-context">{unknown}개 도감 확인 필요 · 확인된 효과만 표시</p>}
  </section>;
}
