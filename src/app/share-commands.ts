export type CursorMode = 'unknown' | 'excluded' | 'included' | 'unsupported';

/** Request a window share with cursor exclusion when the browser supports it.
 * This does not own React state, scanning or completion. */
export async function requestWindowShare(): Promise<{stream: MediaStream; cursorMode: CursorMode; supportsCursor: boolean}> {
  const supportsCursor = (navigator.mediaDevices.getSupportedConstraints() as Record<string, unknown>).cursor === true;
  const videoConstraints: MediaTrackConstraints & {cursor?: 'never'} = {
    displaySurface: 'window',
    frameRate: {ideal: 60, max: 60},
    ...(supportsCursor ? {cursor: 'never' as const} : {}),
  };
  const stream = await navigator.mediaDevices.getDisplayMedia({video: videoConstraints, audio: false});
  const track = stream.getVideoTracks()[0];
  if (!track) {
    stopShareStream(stream);
    throw Error('공유 화면의 비디오 트랙을 확인할 수 없습니다.');
  }
  const settings = track.getSettings() as MediaTrackSettings & {cursor?: string};
  const cursorMode: CursorMode = settings.cursor === 'never' ? 'excluded'
    : settings.cursor === 'always' ? 'included'
      : settings.cursor === undefined && !supportsCursor ? 'unsupported' : 'unknown';
  return {stream, cursorMode, supportsCursor};
}

/** Stop every track independently; one failed stop must not leave others open. */
export function stopShareStream(stream: MediaStream | null | undefined): void {
  try {
    stream?.getTracks().forEach(track => { try { track.stop(); } catch { /* Continue closing other tracks. */ } });
  } catch { /* Stream state is unavailable. */ }
}

type ShareAttemptGuard = ReturnType<typeof import('../features/card-scanner/capture/share-stream-owner').createShareAttemptGuard>;

interface ShareCoreRefs {
  stream: {current: MediaStream | null};
  controller: {current: AbortController | null};
  engineReady: {current: boolean};
}

interface ShareRefs extends ShareCoreRefs {
  video: {current: HTMLVideoElement | null};
}

/** Close the current share without touching scan results. */
export function closeWindowShare(options: ShareCoreRefs & {
  guard: ShareAttemptGuard;
  setSharing: (value: boolean) => void;
}): void {
  options.guard.invalidate();
  if (!options.engineReady.current) options.controller.current?.abort();
  stopShareStream(options.stream.current);
  options.setSharing(false);
}

/** Acquire a window share and hand a live, played stream to the scanner.
 * The caller owns completion; this only owns picker/play state transitions. */
export async function openWindowShare(options: ShareRefs & {
  guard: ShareAttemptGuard;
  preparationUncertain: () => boolean;
  setSharePicking: (value: boolean) => void;
  setSharing: (value: boolean) => void;
  setCursorMode: (mode: CursorMode) => void;
  setReady: (value: boolean) => void;
  setActionError: (value: string) => void;
  onStart: () => void;
}): Promise<void> {
  const {guard, stream, controller, engineReady, video} = options;
  const token = guard.begin();
  if (token === undefined) return;
  options.setSharePicking(true);
  let next: MediaStream | undefined;
  const stopOwn = () => stopShareStream(next);
  try {
    const shared = await requestWindowShare();
    next = shared.stream;
    if (!guard.current(token)) { stopOwn(); return; }
    if (options.preparationUncertain()) throw Error('이전 인식 엔진 준비 자원의 종료를 확인해 주세요.');
    const selectedTrack = next.getVideoTracks()[0]!;
    options.setCursorMode(shared.cursorMode);
    stream.current = next;
    options.setSharing(true);
    video.current!.srcObject = next;
    // Chooser has settled. The epoch still fences a late play completion.
    guard.finish(token);
    options.setSharePicking(guard.picking());
    const source = next;
    selectedTrack.addEventListener('ended', () => {
      if (stream.current !== source) return;
      guard.invalidate();
      stream.current = null;
      options.setSharing(false);
      if (!engineReady.current) controller.current?.abort();
    });
    if (selectedTrack.readyState !== 'live') throw Error('선택한 화면 공유가 종료되었습니다.');
    await video.current!.play();
    if (options.preparationUncertain()) throw Error('이전 인식 엔진 준비 자원의 종료를 확인해 주세요.');
    if (!guard.current(token) || stream.current !== next || selectedTrack.readyState !== 'live') {
      stopOwn();
      return;
    }
    options.setReady(true);
    options.onStart();
  } catch (error) {
    stopOwn();
    if (guard.current(token)) {
      if (next && stream.current === next) {
        stream.current = null;
        options.setSharing(false);
      }
      // Closing the picker (or a browser that refuses the share) is not a failure to explain in browser words.
      const refused = error instanceof DOMException && (error.name === 'NotAllowedError' || error.name === 'AbortError');
      options.setActionError(refused ? '화면 공유를 시작하지 않았습니다. 다시 공유하려면 화면 공유 시작을 눌러 주세요.' : error instanceof Error ? error.message : '화면 공유 실패');
    }
  } finally {
    guard.finish(token);
    options.setSharePicking(guard.picking());
  }
}

