import type {ScanGridSnapshot} from '../session/scan-grid';
import type {ScanMonitorState} from './scan-monitor-store';

interface FeedbackSource {
  expected: number | null;
  capacity: number | null;
  interrupted?: 'stalled' | 'cancelled' | 'failed';
  unresolvedFieldChanges?: number;
  queued?: number;
  activeReadings?: number;
  currentRunNames?: number;
  cards?: readonly {review: readonly string[]}[];
  droppedFrames: number;
  sampled: number;
  headerConflict?: boolean;
}

/** Image-free snapshot for the scanner's immediate progress lane. Build this
 * from the current scanner state on every publication; a grid-only update may
 * not erase a still-active header conflict. */
export function scannerFeedbackState(
  state:FeedbackSource,
  grid:ScanGridSnapshot, completed:number|undefined, unresolvedCount:number,
):ScanMonitorState {
  const review=state.cards?.some(card=>Array.isArray(card?.review))
    ?state.cards.filter(card => Array.isArray(card?.review) && card.review.length > 0).length:undefined;
  return {grid,currentRunRead:completed,
    ...(state.currentRunNames===undefined?{}:{currentRunNames:state.currentRunNames}),...(review===undefined?{}:{review}),
    expected:state.expected,capacity:state.capacity,interrupted:state.interrupted,
    headerConflict:state.headerConflict,unresolvedFieldChanges:state.unresolvedFieldChanges,
    queued:state.queued,activeReadings:state.activeReadings,unresolvedCount,droppedFrames:state.droppedFrames,hasInput:state.sampled>0};
}
