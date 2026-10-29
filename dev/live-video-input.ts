import {observeMediaPlayback} from './media-playback-observer';
import type {MediaPlaybackEndReason,MediaPlaybackObserver,MediaPlaybackOptions} from './media-playback-observer';

/** Development adapter: native media playback feeds the screen scanner loop.
 * This does not reproduce OS capture timing or guarantee every video frame. */
export interface LiveVideoInput {
  start(): Promise<void>;
  dispose(): void;
  readonly inputSeconds: number;
  readonly durationSeconds: number;
  readonly ended: boolean;
  /** Natural end/disposal resolves; cancellation or a media failure rejects. */
  readonly completion: Promise<void>;
}

const READY_TIMEOUT_MS = 10_000;
type CaptureVideo = HTMLVideoElement & { captureStream?: () => MediaStream };

export async function prepareLiveVideoInput(url: string, target: HTMLVideoElement, signal: AbortSignal,
  options:Partial<MediaPlaybackOptions>&{sourceContainer?:HTMLElement}={}): Promise<LiveVideoInput> {
  signal.throwIfAborted();
  const address = new URL(url, window.location.href);
  if (!['http:', 'https:', 'blob:'].includes(address.protocol) || address.origin !== window.location.origin ||
    address.username || address.password || address.hash) throw Error('같은 개발 페이지의 영상 URL만 사용할 수 있습니다.');
  const originalTargetInput = target.srcObject, originalTargetSource = target.getAttribute('src');
  if (originalTargetInput) throw Error('미리보기 영상이 이미 다른 입력에 연결되어 있습니다.');
  const source = document.createElement('video') as CaptureVideo;
  if (typeof source.captureStream !== 'function') throw Error('이 브라우저는 영상 captureStream()을 지원하지 않습니다.');
  source.muted = true; source.defaultMuted = true; source.playsInline = true; source.hidden = true;
  source.preload = 'auto'; source.loop = false; source.playbackRate = 1;
  const lifetime = new AbortController();
  let captured: MediaStream | undefined, output: MediaStream | undefined;
  const ownedClones: MediaStreamTrack[] = [];
  let closed = false, inputEnded = false, started = false, priming = false, releasedTarget = false;
  let seconds = 0, duration = 0, startPromise: Promise<void> | undefined;
  let watchdog: ReturnType<typeof setInterval> | undefined;
  let playback:MediaPlaybackObserver|undefined,playbackEnd:MediaPlaybackEndReason|undefined;
  let resolveCompletion!: () => void, rejectCompletion!: (reason: unknown) => void;
  const completion = new Promise<void>((resolve, reject) => { resolveCompletion = resolve; rejectCompletion = reject; });
  // The caller may still be preparing its scanner when a native error arrives.
  void completion.catch(() => {});
  const targetMuted = target.muted, targetInline = target.playsInline;
  const ownershipError = () => Error('미리보기 영상이 다른 입력으로 변경되었습니다.');
  const ownsTarget = () => !!output && target.srcObject === output && target.getAttribute('src') === null;
  const rememberTime = () => { if (Number.isFinite(source.currentTime)) seconds = Math.max(0, source.currentTime); };
  const stopTracks = () => {
    for (const track of ownedClones) track.stop();
    for (const track of captured?.getTracks() ?? []) track.stop();
  };
  const stopInput = (reason:MediaPlaybackEndReason) => {
    playbackEnd??=reason;playback?.stop(playbackEnd);
    rememberTime(); source.pause(); stopTracks();
    if (watchdog !== undefined) { clearInterval(watchdog); watchdog = undefined; }
  };
  const cleanup = (reason:MediaPlaybackEndReason) => {
    if (closed) return; closed = true; stopInput(reason);
    signal.removeEventListener('abort', aborted);
    source.removeEventListener('error', sourceError); source.removeEventListener('ended', ended);
    target.removeEventListener('error', targetError);
    captured?.removeEventListener('addtrack', addedTrack);
    if (ownsTarget()) {
      releasedTarget = true;
      target.pause(); target.srcObject = null; target.muted = targetMuted; target.playsInline = targetInline; target.load();
    }
    source.removeAttribute('src'); source.load(); source.remove();
  };
  const fail = (error: unknown,reason:MediaPlaybackEndReason='error') => {
    if (closed) return;
    lifetime.abort(error); cleanup(reason); rejectCompletion(error);
  };
  const aborted = () => fail(signal.reason,'aborted');
  const sourceError = () => fail(Error(`영상 재생 실패${source.error ? ` (코드 ${source.error.code})` : ''}`));
  const targetError = () => { if (ownsTarget()) fail(Error('실시간 영상 입력을 재생할 수 없습니다.')); };
  const ended = () => {
    if (closed) return;
    if (!started || priming) { fail(Error('실시간 입력 준비 중 영상이 종료됐습니다.')); return; }
    inputEnded = true; stopInput('ended'); resolveCompletion();
    // Retain the last target frame until the scanner has completed final reads.
  };
  const addedTrack = () => { for (const track of captured?.getAudioTracks() ?? []) track.stop(); };
  signal.addEventListener('abort', aborted, { once: true });
  source.addEventListener('error', sourceError); source.addEventListener('ended', ended);
  target.addEventListener('error', targetError);

  function bounded<T>(promise: Promise<T>, label: string): Promise<T> {
    if (lifetime.signal.aborted) { void promise.catch(() => {}); return Promise.reject(lifetime.signal.reason); }
    return new Promise<T>((resolve, reject) => {
      const tidy = () => { clearTimeout(timer); lifetime.signal.removeEventListener('abort', abort); };
      const abort = () => { tidy(); reject(lifetime.signal.reason); };
      const timer = setTimeout(() => { tidy(); reject(Error(`${label} 시간 초과`)); }, READY_TIMEOUT_MS);
      lifetime.signal.addEventListener('abort', abort, { once: true });
      promise.then(value => { tidy(); resolve(value); }, error => { tidy(); reject(error); });
    });
  }
  function waitFor(test: () => boolean, events: [EventTarget, string][], initiate?: () => void): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const tidy = () => { for (const [element, name] of events) element.removeEventListener(name, check);
        lifetime.signal.removeEventListener('abort', abort); };
      const check = () => { if (test()) { tidy(); resolve(); } };
      const abort = () => { tidy(); reject(lifetime.signal.reason); };
      for (const [element, name] of events) element.addEventListener(name, check);
      lifetime.signal.addEventListener('abort', abort, { once: true });
      if (lifetime.signal.aborted) { abort(); return; }
      try { initiate?.(); check(); } catch (error) { tidy(); reject(error); }
    });
  }
  function play(element: HTMLVideoElement): Promise<void> {
    const pending = element.play();
    // A browser play request can settle after cancellation/timeout. It must
    // never restart an abandoned source or pause a new owner's target stream.
    void pending.then(() => {
      if ((closed || inputEnded) && (element === source || ownsTarget() ||
        releasedTarget && !target.srcObject && !target.getAttribute('src'))) element.pause();
    }, () => {});
    return pending;
  }

  try {
    // Explicit development comparison only: connected, visible source versus
    // detached source. This changes compositor conditions, not input pixels or
    // timestamps, and must be recorded as a different test configuration.
    if(options.sourceContainer){source.hidden=false;options.sourceContainer.append(source);}
    await bounded(waitFor(() => source.readyState >= 2, [[source, 'loadeddata']], () => {
      source.src = address.href; source.load();
    }), '영상 준비');
    lifetime.signal.throwIfAborted();
    if (!source.videoWidth || !source.videoHeight || !Number.isFinite(source.duration) || source.duration <= 0)
      throw Error('크기와 길이를 확인할 수 있는 영상만 사용할 수 있습니다.');
    duration = source.duration;
    captured = source.captureStream();
    captured.addEventListener('addtrack', addedTrack); addedTrack();
    const hasVideo = () => !!captured?.getVideoTracks().some(track => track.readyState === 'live');
    if (!hasVideo()) {
      // Some implementations only publish tracks after their first playback.
      // Prime off-screen, then rewind before attaching anything to the scanner.
      priming = true;
      const tracks = waitFor(hasVideo, [[captured, 'addtrack']]);
      await bounded(Promise.all([play(source), tracks]), '영상 트랙 준비');
      source.pause();
      if (source.currentTime !== 0) await bounded(waitFor(() => source.currentTime === 0 && !source.seeking,
        [[source, 'seeked']], () => { source.currentTime = 0; }), '영상 시작 위치 준비');
      priming = false;
    }
    lifetime.signal.throwIfAborted();
    const tracks = captured.getVideoTracks().filter(track => track.readyState === 'live');
    if (!tracks.length) throw Error('실시간 입력에 사용할 영상 트랙이 없습니다.');
    for (const track of tracks) ownedClones.push(track.clone());
    output = new MediaStream(ownedClones);
    // Loading/priming yielded to the browser. An input installed in that time
    // belongs to its new owner; do not pause it or remove its source attribute.
    if (target.srcObject !== originalTargetInput || target.getAttribute('src') !== originalTargetSource)
      throw ownershipError();
    target.pause(); target.removeAttribute('src'); target.muted = true; target.playsInline = true; target.srcObject = output;
    return {
      start() {
        if (closed || inputEnded) return Promise.reject(lifetime.signal.reason ?? Error('이미 종료된 영상 입력입니다.'));
        if (!ownsTarget()) { const error = ownershipError(); fail(error); return Promise.reject(error); }
        if (startPromise) return startPromise;
        started = true;
        startPromise = (async () => {
          try {
            // Priming and rewind have finished. Attach to the original source
            // before either native play request, independently of target rVFC.
            if(options.onPlayback)playback=observeMediaPlayback(source,{onPlayback:options.onPlayback,
              onPlaybackError:options.onPlaybackError});
            if(playbackEnd)playback?.stop(playbackEnd);
            lifetime.signal.throwIfAborted();
            await bounded(Promise.race([Promise.all([play(target), play(source)]), completion]), '실시간 영상 시작');
            lifetime.signal.throwIfAborted();
            if (!ownsTarget()) throw ownershipError();
            if (!inputEnded) watchdog = setInterval(() => {
              if (!ownsTarget()) { fail(ownershipError()); return; }
              // MediaStreamTrack.stop() does not dispatch its own ended event.
              // Scanner auto-stop should also stop needless source decoding.
              if (output?.getVideoTracks().every(track => track.readyState === 'ended')) {
                stopInput('stopped'); resolveCompletion();
              }
            }, 100);
          } catch (error) { if (inputEnded && !lifetime.signal.aborted) return; fail(error); throw error; }
        })();
        return startPromise;
      },
      dispose() { if (closed) return; lifetime.abort(new DOMException('Disposed', 'AbortError')); cleanup('disposed'); resolveCompletion(); },
      get inputSeconds() { if (!closed) rememberTime(); return seconds; },
      get durationSeconds() { return duration; },
      get ended() { return inputEnded; },
      completion,
    };
  } catch (error) { fail(error); throw error; }
}
