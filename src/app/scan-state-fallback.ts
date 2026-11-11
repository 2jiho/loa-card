import type {ScannerState} from '../features/card-scanner/orchestration/scanner';

/** Keep a visible list when an interrupted run never produced a final state. */
export function scanStateAfterIncomplete(
  finalState: ScannerState | undefined, previousState: ScannerState | null,
): ScannerState | null {
  return finalState ?? previousState ?? null;
}
