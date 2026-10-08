export interface TrackFrameStamp {
  frame: VideoFrame;
  /** Source timestamp mapped onto performance.now(), in milliseconds. */
  capturedAt: number;
  /** Absent when the browser does not expose a native discard counter. */
  missedFrames?: number;
}

interface Processor {
  readable: ReadableStream<VideoFrame>;
  discardedFrames?: number;
}
type ProcessorConstructor = new (options: { track: MediaStreamTrack; maxBufferSize: number }) => Processor;

/** Optional Chromium input path. Other contexts/browsers retain the video callback
 * path. Own each native frame until the asynchronous consumer finishes using it. */
export function tryStartTrackFrames(video: HTMLVideoElement, signal: AbortSignal,
  onFrame: (stamp: TrackFrameStamp) => Promise<void> | void,
  onStop: () => void, onError: (error: unknown) => void,
  ProcessorClass = (globalThis as typeof globalThis & { MediaStreamTrackProcessor?: ProcessorConstructor }).MediaStreamTrackProcessor,
) {
  const track = (video.srcObject as MediaStream | null)?.getVideoTracks()[0];
  if (!ProcessorClass || !track || track.readyState !== 'live' || signal.aborted) return undefined;
  let processor: Processor, reader: ReadableStreamDefaultReader<VideoFrame>;
  try {
    processor = new ProcessorClass({ track, maxBufferSize: 4 });
    reader = processor.readable.getReader();
  } catch { return undefined; }
  let active = true, waitingForFrame = false, firstTimestamp: number | undefined, firstObservedAt = 0, previousDiscarded = 0;
  const dispose = () => {
    if (!active) return;
    active = false;
    clearInterval(watchdog);
    signal.removeEventListener('abort', dispose);
    void reader.cancel().catch(() => {});
  };
  const stopped = () => {
    if (!active) return;
    dispose(); onStop();
  };
  // Drain frames already queued when sharing ends. Only cancel an idle read:
  // ending the track must not discard the last visible row behind a slow crop.
  const watchdog = setInterval(() => { if (waitingForFrame && track.readyState !== 'live') stopped(); }, 100);
  signal.addEventListener('abort', dispose, { once: true });
  void (async () => {
    try {
      while (active) {
        waitingForFrame = true;
        const next = await reader.read();
        waitingForFrame = false;
        if (next.done) { stopped(); break; }
        const frame = next.value;
        try {
          if (!active) break;
          if (firstTimestamp === undefined) { firstTimestamp = frame.timestamp; firstObservedAt = performance.now(); }
          const discarded = processor.discardedFrames;
          const missedFrames = typeof discarded === 'number' && Number.isFinite(discarded) ? Math.max(0, discarded - previousDiscarded) : undefined;
          if (typeof discarded === 'number' && Number.isFinite(discarded)) previousDiscarded = discarded;
          await onFrame({ frame, capturedAt: firstObservedAt + (frame.timestamp - firstTimestamp) / 1000, missedFrames });
        } finally { frame.close(); }
      }
    } catch (error) {
      if (active) { dispose(); onError(error); }
    } finally { reader.releaseLock(); }
  })();
  return dispose;
}
