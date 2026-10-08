import type { CsvCatalogCard } from './inventory-csv';

type InventoryEvidence = {
  status: string;
  expected: number | null;
  cards: { id: string; review: string[] }[];
  unidentified?: unknown[];
  autoStopped?: boolean;
  currentRunNames?: number;
};

/** A missing row is unowned only in a complete scan or an explicitly imported CSV. */
export function unownedInventory(catalog: readonly CsvCatalogCard[], state: InventoryEvidence | null, busy: boolean): CsvCatalogCard[] | null {
  if (!catalog.length || !state || busy || state.status === '스캔 중지') return null;
  const catalogIds = new Set(catalog.map(card => card.id));
  const owned = new Set(state.cards.map(card => card.id));
  if (state.cards.some(card => !catalogIds.has(card.id))) return null;
  if (owned.size !== state.cards.length || state.cards.some(card => card.review.some(reason => reason.includes('이름') || reason.includes('식별') || reason.includes('사전') || reason.includes('그림 보조')))) return null;
  // Auto-stop separately rechecks the header and every current-run identity.
  // Noisy duplicate crops can remain in diagnostics after that proof succeeds.
  const confirmedCapture = state.autoStopped && state.currentRunNames === state.expected;
  if (state.status !== 'CSV 불러오기 완료' && (state.expected === null || state.expected !== owned.size ||
      (!!state.unidentified?.length && !confirmedCapture))) return null;
  return catalog.filter(card => !owned.has(card.id)).sort((a, b) => a.name.localeCompare(b.name, 'ko', { numeric: true }));
}
