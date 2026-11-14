/** The state a scan publishes (orchestration/scanner.ts, row-scanner-state.ts). Kept apart from
 * scanner.ts so the scan code it loads can use these types without an import cycle. */
import type {ObservationSource} from '../session/observation-execution';
import type {NameAttempt} from '../recognition/name-diagnostics';
import type {ScanActivityItem} from '../ui/scan-activity';
import type {CardSort} from '../recognition/capture-metadata';
import type {ScannedCard} from '../recognition/recognizer-types';
import type {PortraitDiagnostics} from '../recognition/portrait-diagnostics';
import type {PositiveCompletionReceipt} from '../session/positive-completion';

export type UnidentifiedObservation = { image: string; recognitionImage?:string; time: number; captureOrder?: number; pending: boolean; group?: number; reason?:string; location?:import('../session/scroll-card-location').ScrollCardLocation; source?:ObservationSource; nameAttempts?:readonly NameAttempt[]; portraitDiagnostics?:PortraitDiagnostics|null };
export interface ScannerState {
  /** Current-run proof, emitted only at the final joined evidence boundary. */
  completionReceipt?: PositiveCompletionReceipt;
  activity?:ScanActivityItem[];
  interrupted?: 'stalled' | 'cancelled' | 'failed';
  processingWarning?: string;
  workPhase?: import('../ui/read-progress').ScanWorkPhase;
  currentRunNames?: number;
  currentRunRead?: number;
  status: string;
  percent: number;
  sampled: number;
  /** Work finished so far; it grows while the scan makes progress (the stall guard watches it). */
  workDone?: number;
  stable: number;
  expected: number | null;
  capacity: number | null;
  cards: ScannedCard[];
  seededCards?: number;
  growthPoints?: { current: number; maximum: number | null } | null;
  growthPointsEstimated?: boolean;
  growthHistory?: import('../../growth/complete-growth').GrowthCompletion[];
  sort?: CardSort | null;
  located: boolean;
  unreadable: number;
  queued: number;
  /** Active observation reads, distinct from queued jobs and confirmed cards. */
  activeReadings?: number;
  droppedFrames: number;
  liveMissedFrames?: number;
  liveInput?: 'video' | 'track';
  /** The shared picture is smaller than the supported size (row-scanner-state.ts, smallScreenNotice). */
  resolutionNotice?: string;
  /** Unresolved observations/evidence, not necessarily distinct identified cards. */
  unresolvedFieldChanges?:number;
  /** Lower bound from this scan's unidentified entries and unresolved ledger groups. */
  unresolvedObservations?:number;
  /** Observations resolved as repeats of an already-collected card. Kept as a
   * diagnostic count, not as unidentified cards or completion evidence. */
  duplicateUnidentifiedObservations?:number;
  /** Row-centred scan only: what to show again, worked out from the list table
   * (session/list-guidance.ts). `asks` are requests; `notes` are what the table cannot decide.
   * Presentation only: it supplies no card, no value and no completion evidence. */
  listGuidance?:{readonly asks:readonly string[];readonly notes:readonly string[];readonly map?:import('../session/list-guidance').ListGuidanceMap};
  autoStopped?: boolean;
  unidentified: UnidentifiedObservation[];
}
