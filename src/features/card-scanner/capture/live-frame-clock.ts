export interface LiveFrameStamp { readonly mediaTime: number; readonly presentedFrames: number; readonly missedFrames: number }

export type LiveFrameRelation = 'first' | 'advance' | 'duplicate' | 'regression' | 'invalid' | 'unknown';
/** Metadata observations describe callbacks while the track is live, not
 * physical display frames. Even an uninterrupted sequence cannot prove that
 * the OS produced or the browser delivered every frame. No pixels or history
 * are retained here. Sequence overflow is signaled by null. */
export type LiveFrameObservation =
  | Readonly<{ kind:'mode'; mode:'callback'|'timer' }>
  | Readonly<{ kind:'callback'; sequence:number|null; mediaTime:number|null; presentedFrames:number|null;
      mediaRelation:LiveFrameRelation; presentedRelation:LiveFrameRelation; missedFrames:number|null; captureEligible:boolean }>
  | Readonly<{ kind:'timer'; sequence:number|null; mediaTime:number|null; mediaRelation:LiveFrameRelation; captureEligible:boolean }>;
export interface LiveFrameObservationSink {
  /** Synchronous, non-retaining notification before a callback may be skipped.
   * Consumers that cannot handle every notification must treat coverage as unknown. */
  onObservation(observation:LiveFrameObservation):void;
  /** Observers must invalidate their own evidence if delivery fails. */
  onError?(error:unknown):void;
}

/** Follow delivered video frames instead of polling the same raster at 30 Hz.
 * The watchdog still notices a stopped share when no video callback arrives. */
export function startVideoFrames(video: HTMLVideoElement, signal: AbortSignal,
  onFrame: (stamp?: LiveFrameStamp) => void, onStop: () => void,
  onError: (error: unknown) => void, interval = 33, onPreview?:()=>void,
  observer?:LiveFrameObservationSink) {
  let active = true, callbackId: number | undefined, lastTime = -Infinity;
  let previousPresented: number | undefined;
  const callbacks = typeof video.requestVideoFrameCallback === "function" &&
    typeof video.cancelVideoFrameCallback === "function";
  let observationSequence=0,observed=false,previousMedia:number|null=null,previousCounter:number|null=null;
  const nextSequence=()=>observationSequence<Number.MAX_SAFE_INTEGER?++observationSequence:null;
  const emit=(event:LiveFrameObservation)=>{
    if(!observer)return;
    try{observer.onObservation(Object.freeze(event));}catch(error){try{observer.onError?.(error);}catch{/* Diagnostics never stop capture. */}}
  };
  const relation=(value:number|null,previous:number|null):LiveFrameRelation=>
    value===null?'invalid':!observed?'first':previous===null?'unknown':
      value===previous?'duplicate':value>previous?'advance':'regression';
  if(observer)emit({kind:'mode',mode:callbacks?'callback':'timer'});
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
      if(observer){
        const media=Number.isFinite(metadata.mediaTime)&&metadata.mediaTime>=0?metadata.mediaTime:null;
        const counter=Number.isSafeInteger(metadata.presentedFrames)&&metadata.presentedFrames>=0?metadata.presentedFrames:null;
        const mediaRelation=relation(media,previousMedia),presentedRelation=relation(counter,previousCounter);
        const gap=counter!==null&&previousCounter!==null&&presentedRelation==='advance'?counter-previousCounter-1:null;
        emit({kind:'callback',sequence:nextSequence(),mediaTime:media,presentedFrames:counter,
          mediaRelation,presentedRelation,missedFrames:gap,captureEligible:metadata.mediaTime!==lastTime});
        previousMedia=media;previousCounter=counter;observed=true;
      }
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
      if(!callbacks&&observer){
        const media=Number.isFinite(video.currentTime)&&video.currentTime>=0?video.currentTime:null;
        emit({kind:'timer',sequence:nextSequence(),mediaTime:media,mediaRelation:relation(media,previousMedia),
          captureEligible:video.currentTime!==lastTime});
        previousMedia=media;observed=true;
      }
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
