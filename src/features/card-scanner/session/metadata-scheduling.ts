export interface MetadataWork {
  /** Includes both queued metadata and its in-flight settlement. */
  pending: () => boolean;
  settle: () => Promise<void>;
}

/** DEV drain reservation may wait for already-started metadata after accepted
 * input drains. That work retains exclusive use of the primary OCR reader;
 * reservation is not permission to run header OCR concurrently with it. */
export function canReserveCompletionDrain(input:{held:boolean;active:boolean;primaryOcrReading:boolean;
  previewWaiting:number;readingJobs:number;queueSettled:boolean;video:boolean;callbackClock:boolean}):boolean {
  // Preview encoding owns separate pixels and does not use the OCR session.
  // The parameter remains for old diagnostics, not as an admission condition.
  return input.held&&!input.active&&!input.primaryOcrReading&&input.readingJobs===0&&input.queueSettled&&
    input.video&&input.callbackClock;
}

/** Only work using the metadata reader's own OCR session must wait for it.
 * Independent visual/OCR sessions and source acquisition remain runnable. */
export async function waitForReaderMetadata(usesPrimarySession: boolean, metadata: MetadataWork): Promise<void> {
  if (!usesPrimarySession) return;
  // The first settlement can also read an initial inventory header. A newer
  // metadata job may arrive during that await, so drain the shared session.
  do { await metadata.settle(); } while (metadata.pending());
}

/** Completion can reserve capture only after name coverage is plausible.
 * Ordinary metadata refreshes never acquire this global pause. Return true
 * when verification should resume on the next turn with settled metadata. */
export async function deferCompletionForMetadata(
  plausibleCoverage: boolean,
  metadata: MetadataWork,
  pauseCapture: (paused: boolean) => void,
): Promise<boolean> {
  if (!plausibleCoverage || !metadata.pending()) return false;
  pauseCapture(true);
  try {
    await metadata.settle();
    return true;
  } finally {
    pauseCapture(false);
  }
}
