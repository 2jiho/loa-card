import {useMemo} from 'react';

export const CARDS_PER_PAGE = 40;

export interface InventoryCardLike {
  id: string;
  name: string;
}

/** Pure list projection for the inventory workspace. It preserves the existing
 * name search, Korean numeric ordering and 40-card paging. */
export function useInventoryView<T extends InventoryCardLike, U extends InventoryCardLike>(options: {
  cards: readonly T[];
  unowned: readonly U[] | null;
  query: string;
  page: number;
  onlyUnowned: boolean;
}) {
  const {cards, unowned, query, page, onlyUnowned} = options;
  const filtered = useMemo(
    () => [...cards].filter(card => card.name.includes(query))
      .sort((a, b) => a.name.localeCompare(b.name, 'ko', {numeric: true})),
    [cards, query],
  );
  const filteredUnowned = useMemo(
    () => (unowned ?? []).filter(card => card.name.includes(query)),
    [unowned, query],
  );
  const visibleCount = onlyUnowned ? filteredUnowned.length : filtered.length;
  const pageCount = Math.max(1, Math.ceil(visibleCount / CARDS_PER_PAGE));
  const currentPage = Math.min(page, pageCount);
  const pageCards = filtered.slice((currentPage - 1) * CARDS_PER_PAGE, currentPage * CARDS_PER_PAGE);
  const pageUnowned = filteredUnowned.slice((currentPage - 1) * CARDS_PER_PAGE, currentPage * CARDS_PER_PAGE);
  const pageCardCount = onlyUnowned ? pageUnowned.length : pageCards.length;
  return {filtered, filteredUnowned, visibleCount, pageCount, currentPage, pageCards, pageUnowned, pageCardCount};
}
