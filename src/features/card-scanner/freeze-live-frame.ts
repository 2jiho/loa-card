export interface FrozenLiveFrame {
  source: VideoFrame | HTMLCanvasElement;
  width: number;
  height: number;
  /** Move the owned native snapshot exactly once. close() never closes a taken
   * frame; the receiver must close/transfer it. Canvas snapshots cannot move. */
  takeNative(): VideoFrame | undefined;
  /** Releases only the snapshot owned by this result, at most once. */
  close(): void;
}

export interface LiveFramePlatform {
  createFrame?: (video: HTMLVideoElement) => VideoFrame;
  createCanvas(): HTMLCanvasElement;
}

const validSize = (width: number, height: number) =>
  Number.isInteger(width) && Number.isInteger(height) && width > 0 && height > 0;

function owned(source: FrozenLiveFrame['source'], width: number, height: number, release: () => void): FrozenLiveFrame {
  let closed = false;
  return { source, width, height,
    takeNative() {if(closed||!('displayWidth' in source))return;closed=true;return source;},
    close() { if (!closed) { closed = true; release(); } } };
}

/** Freeze before yielding: later decoder advancement cannot change this input.
 * This does not change acquisition's CPU raster/Worker path. A borrowed track
 * frame is cloned, never transferred or closed by this helper. */
export function freezeLiveFrame(source: HTMLVideoElement | VideoFrame, platform: LiveFramePlatform = {
  createFrame: typeof VideoFrame === 'undefined' ? undefined : video => new VideoFrame(video),
  createCanvas: () => document.createElement('canvas'),
}): FrozenLiveFrame | null {
  const borrowed = 'displayWidth' in source;
  const width = borrowed ? source.displayWidth : source.videoWidth;
  const height = borrowed ? source.displayHeight : source.videoHeight;
  if (!validSize(width, height)) return null;

  let snapshot: VideoFrame | undefined;
  try { snapshot = borrowed ? source.clone() : platform.createFrame?.(source); }
  catch { /* Older/unsupported sources retain the immediate CPU snapshot path. */ }
  if (snapshot) {
    if (validSize(snapshot.displayWidth, snapshot.displayHeight))
      return owned(snapshot, snapshot.displayWidth, snapshot.displayHeight, () => snapshot.close());
    snapshot.close();
  }

  const canvas = platform.createCanvas();
  canvas.width = width; canvas.height = height;
  try {
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) throw new Error('화면 프레임 복사 컨텍스트 없음');
    // Keep the same unscaled CPU-backed draw used by the existing scanner.
    context.drawImage(source, 0, 0);
    return owned(canvas, width, height, () => { canvas.width = 0; canvas.height = 0; });
  } catch (error) {
    canvas.width = 0; canvas.height = 0;
    throw error;
  }
}

/** Measure only the synchronous snapshot effect. Caller bookkeeping and
 * diagnostic sinks must not inflate the adaptive admission cadence. */
export function freezeLiveFrameTimed(source:HTMLVideoElement|VideoFrame,platform?:LiveFramePlatform,now:()=>number=()=>performance.now()) {
  const started=now();
  const frame=freezeLiveFrame(source,platform);
  return {frame,freezeMs:now()-started};
}
