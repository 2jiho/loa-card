import type {ScannedCard} from './features/card-scanner/recognition/recognizer';
import type {ScannerState} from './features/card-scanner/orchestration/scanner';
import {parseCsvExperience} from './domain/inventory-csv';

export {inventoryCsv, inventoryCsvIssues, parseCsvExperience, parseInventoryCsv} from './domain/inventory-csv';
export type {CsvCatalogCard, CsvInventoryCard} from './domain/inventory-csv';

/** Scanner-state adapter for an imported CSV. The pure parser lives in domain. */
export function csvInventoryState(cards: ScannedCard[], experience: string): ScannerState {
  const current = parseCsvExperience(experience);
  return {
    status: 'CSV 불러오기 완료',
    percent: 100,
    sampled: 0,
    stable: 0,
    expected: null,
    capacity: null,
    cards,
    located: false,
    unreadable: 0,
    queued: 0,
    droppedFrames: 0,
    unidentified: [],
    growthPoints: current === null ? null : {current, maximum: null},
  };
}
