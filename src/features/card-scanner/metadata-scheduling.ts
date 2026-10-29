export interface MetadataWork {
  /** Includes both queued metadata and its in-flight settlement. */
  pending: () => boolean;
  settle: () => Promise<void>;
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
