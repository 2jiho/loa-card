export interface LiveFrameStamp { readonly mediaTime: number; readonly presentedFrames: number; readonly missedFrames: number }

/** Follow delivered video frames instead of polling the same raster at 30 Hz.
 * The watchdog still notices a stopped share when no video callback arrives. */
export function startVideoFrames(video: HTMLVideoElement, signal: AbortSignal,
  onFrame: (stamp?: LiveFrameStamp) => void, onStop: () => void,
  onError: (error: unknown) => void, interval = 33, onPreview?:()=>void) {
  let active = true, callbackId: number | undefined, lastTime = -Infinity;
  let previousPresented: number | undefined;
  const callbacks = typeof video.requestVideoFrameCallback === "function" &&
    typeof video.cancelVideoFrameCallback === "function";
  const dispose = () => {
    if (!active) return;
    active = false; clearInterval(timer);
    if (callbackId !== undefined) video.cancelVideoFrameCallback(callbackId);
    signal.removeEventListener("abort", dispose);
  };
  const live = () => {
    if (!active) return false;
    if (!(video.srcObject as MediaStream | null)?.getVideoTracks().some(track => track.readyState === "live")) {
      dispose(); onStop(); return false;
    }
    return true;
  };
  const fail = (error: unknown) => { dispose(); onError(error); };
  const frame: VideoFrameRequestCallback = (_, metadata) => {
    callbackId = undefined;
    try {
      if (!live()) return;
      // Register before processing so errors/abort cancel the latest callback.
      callbackId = video.requestVideoFrameCallback(frame);
      const missedFrames = previousPresented === undefined ? 0 :
        Math.max(0, metadata.presentedFrames - previousPresented - 1);
      previousPresented = metadata.presentedFrames;
      if (metadata.mediaTime === lastTime) return;
      lastTime = metadata.mediaTime;
      // Paint the current scroll position before capture/encoding can occupy
      // the main thread. The timer remains a background-compositor fallback.
      onPreview?.();
      onFrame(Object.freeze({ mediaTime: metadata.mediaTime, presentedFrames: metadata.presentedFrames, missedFrames }));
    } catch (error) { fail(error); }
  };
  const timer = setInterval(() => {
    try {
      if (!live() || video.readyState < 2) return;
      // A covered/background video may not receive compositor callbacks.
      // Keep display-only tracking independent; never duplicate capture jobs.
      onPreview?.();
      if (callbacks || video.currentTime === lastTime) return;
      lastTime = video.currentTime; onFrame();
    } catch (error) { fail(error); }
  }, interval);
  signal.addEventListener("abort", dispose, { once: true });
  if (signal.aborted) dispose();
  else if (callbacks) {
    try { callbackId = video.requestVideoFrameCallback(frame); }
    catch (error) { fail(error); }
  }
  return dispose;
}
