import ToggleButton from '@mui/material/ToggleButton';
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup';
import TextField from '@mui/material/TextField';
import InputAdornment from '@mui/material/InputAdornment';
import SearchOutlined from '@mui/icons-material/SearchOutlined';
import {CardTile} from '../CardTile';
import {CardThumbnail} from '../CardThumbnail';
import {CardName} from '../CardName';
import {CARDS_PER_PAGE, useInventoryView} from './use-inventory-view';
import type {ScannedCard} from '../features/card-scanner/recognition/recognizer';
import type {ScannerState} from '../features/card-scanner/orchestration/scanner';
import type {CsvCatalogCard} from '../inventory-csv';

export type InventoryFilter = 'owned' | 'unowned';

function UnownedCardTile({card}: {card: CsvCatalogCard}) {
  return <div className="inventory-card is-unowned">
    <CardThumbnail src={card.artwork ? `${import.meta.env.BASE_URL}scanner/artwork/${card.artwork}` : ''} alt={card.name} width={80} height={120} />
    <CardName name={card.name} rarity={card.rarity} />
    <span className="tile-unowned-label">미등록</span>
  </div>;
}

/** Presentational inventory list. Search, filter and page ownership stay in App. */
export function InventoryWorkspace(props: {
  cards: ScannedCard[];
  unowned: CsvCatalogCard[] | null;
  query: string;
  onQueryChange: (value: string) => void;
  inventoryFilter: InventoryFilter;
  onFilterChange: (value: InventoryFilter) => void;
  page: number;
  onPageChange: (page: number) => void;
  state?: ScannerState | null;
  rarityById: ReadonlyMap<string, number>;
  artworkById: ReadonlyMap<string, string | undefined>;
}) {
  const {cards, unowned, query, onQueryChange, inventoryFilter, onFilterChange, page, onPageChange, state, rarityById, artworkById} = props;
  const onlyUnowned = inventoryFilter === 'unowned';
  const {filtered, filteredUnowned, visibleCount, pageCount, currentPage, pageCards, pageUnowned, pageCardCount} =
    useInventoryView({cards, unowned, query, page, onlyUnowned});
  const changePage = (next: number) => {
    onPageChange(next);
    document.getElementById('card-results')?.scrollIntoView({block: 'start'});
  };
  return <section className="panel results" aria-label="내 카드 목록">
    <h2 id="card-results" className="inventory-heading">내 카드</h2>
    <div className="list-toolbar">
      <ToggleButtonGroup className="inventory-filters" value={inventoryFilter} exclusive size="small" aria-label="카드 목록 필터"
        onChange={(_, value) => { if (value) { onFilterChange(value); onPageChange(1); } }}>
        <ToggleButton value="owned">등록 <span>{cards.length}</span></ToggleButton>
        <ToggleButton value="unowned" disabled={unowned === null}>미등록 <span>{unowned?.length ?? '—'}</span></ToggleButton>
      </ToggleButtonGroup>
      <TextField className="inventory-search" size="small" type="search" placeholder="카드 이름 검색" value={query}
        onChange={event => { onQueryChange(event.target.value); onPageChange(1); }}
        slotProps={{htmlInput: {'aria-label': '카드 이름 검색'}, input: {startAdornment: <InputAdornment position="start"><SearchOutlined fontSize="small" /></InputAdornment>}}} />
    </div>
    {onlyUnowned && <p className="inventory-filter-note">{unowned === null ? '스캔을 끝까지 마치면 볼 수 있어요' : '이번에 스캔한 보관함 목록에 없는 카드예요'}</p>}
    <div className="inventory-grid" aria-label="카드 그리드">
      {onlyUnowned ? pageUnowned.map(card => <UnownedCardTile key={card.id} card={card} />)
        : pageCards.map(card => <CardTile key={card.id} card={card} rarity={rarityById.get(card.id)} artwork={artworkById.get(card.id)} />)}
      {pageCardCount > 0 && Array.from({length: CARDS_PER_PAGE - pageCardCount}, (_, index) => <div key={`empty-${index}`} className={`inventory-card inventory-card-empty${onlyUnowned ? ' is-unowned' : ''}`} aria-hidden="true">
        {!onlyUnowned && <span className="card-thumbnail" />}
        <span className="tile-name">&nbsp;</span>
        <span className="tile-counts"><span><b>&nbsp;</b><small>&nbsp;</small></span></span>
      </div>)}
    </div>
    {onlyUnowned && unowned !== null && !filteredUnowned.length && <div className="empty-list"><strong>{query ? '검색 결과가 없어요' : '모든 카드가 등록되어 있어요'}</strong></div>}
    {!onlyUnowned && !filtered.length && <div className="empty-list"><strong>{!cards.length ? '아직 읽은 카드가 없어요' : '검색 결과가 없어요'}</strong>
      <p>{!cards.length ? '화면을 공유하면 읽은 카드가 여기에 나와요.' : '전체 목록을 보거나 다른 이름으로 검색해 주세요.'}</p></div>}
    {!!visibleCount && <nav className="pagination" aria-label="카드 목록 페이지">
      <span>{(currentPage - 1) * CARDS_PER_PAGE + 1}~{Math.min(currentPage * CARDS_PER_PAGE, visibleCount)} / {visibleCount}종</span>
      <div><button className="secondary" disabled={currentPage === 1} onClick={() => changePage(currentPage - 1)}>이전</button>
        <span aria-live="polite">{currentPage} / {pageCount}</span>
        <button className="secondary" disabled={currentPage === pageCount} onClick={() => changePage(currentPage + 1)}>다음</button></div>
    </nav>}
    {!!cards.length && <div className="inventory-meta">
      <span>게임 정렬 <b>{state?.sort ? `${{name: '이름', default: '기본', rarity: '등급', owned: '보유', awakening: '각성 단계'}[state.sort.kind]}${state.sort.direction === 'desc' ? ' 역순' : state.sort.direction === 'asc' ? ' 순' : ''}` : '—'}</b></span>
      <span>보관함 용량 <b>{state?.capacity ?? '—'}</b></span></div>}
  </section>;
}
