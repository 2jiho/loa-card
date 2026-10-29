/** Metadata-only probe. No pixel copy, RGB conversion or recording belongs here. */
export interface ProbeFrame {
  readonly format: string | null;
  readonly codedWidth: number;
  readonly codedHeight: number;
  readonly displayWidth: number;
  readonly displayHeight: number;
  readonly visibleRect: { readonly x: number; readonly y: number; readonly width: number; readonly height: number } | null;
  readonly timestamp: number;
  readonly duration: number | null;
  readonly colorSpace: { readonly primaries: string | null; readonly transfer: string | null; readonly matrix: string | null; readonly fullRange: boolean | null };
  allocationSize(options: Record<string, never>): number;
  close(): void;
}

export interface ProbeTrack {
  readonly readyState: string;
  getSettings(): Pick<MediaTrackSettings, 'displaySurface' | 'width' | 'height' | 'frameRate'>;
  addEventListener(type: 'ended', listener: EventListener): void;
  removeEventListener(type: 'ended', listener: EventListener): void;
  stop(): void;
}
export interface ProbeStream { getTracks(): ProbeTrack[]; getVideoTracks(): ProbeTrack[] }
export interface ProbeReader {
  read(): Promise<ReadableStreamReadResult<ProbeFrame>>;
  cancel(): Promise<unknown>;
  releaseLock(): void;
}
export interface ProbePlatform {
  captureSupported: boolean;
  processorSupported: boolean;
  requestCapture(options: DisplayMediaStreamOptions): Promise<ProbeStream>;
  createReader(track: ProbeTrack): ProbeReader;
}

const finite = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? value : null;
const shortText = (value: unknown) => typeof value === 'string' ? value.replace(/\p{Cc}/gu, '').slice(0, 64) : null;

/** Read an explicit allowlist: never spread browser objects into a saved result. */
export function snapshotFrame(frame: ProbeFrame) {
  const rect = frame.visibleRect, color = frame.colorSpace;
  let allocationSize: number | null = null, allocationSizeError: 'query-failed' | null = null;
  try { allocationSize = finite(frame.allocationSize({})); }
  catch { allocationSizeError = 'query-failed'; }
  return {
    format: shortText(frame.format),
    codedWidth: finite(frame.codedWidth), codedHeight: finite(frame.codedHeight),
    displayWidth: finite(frame.displayWidth), displayHeight: finite(frame.displayHeight),
    visibleRect: rect ? { x: finite(rect.x), y: finite(rect.y), width: finite(rect.width), height: finite(rect.height) } : null,
    timestamp: finite(frame.timestamp), duration: finite(frame.duration),
    colorSpace: color ? { primaries: shortText(color.primaries), transfer: shortText(color.transfer), matrix: shortText(color.matrix), fullRange: typeof color.fullRange === 'boolean' ? color.fullRange : null } : null,
    allocationSize, allocationSizeError,
  };
}
export type FrameSnapshot = ReturnType<typeof snapshotFrame>;

function snapshotTrack(track: ProbeTrack) {
  try {
    const settings = track.getSettings();
    return { settings: { displaySurface: shortText(settings.displaySurface), width: finite(settings.width), height: finite(settings.height), frameRate: finite(settings.frameRate) }, error: null };
  } catch { return { settings: null, error: 'query-failed' as const }; }
}

export function assessNativeProfile(frame: FrameSnapshot) {
  const reasons: string[] = [];
  if (frame.format !== 'I420' && frame.format !== 'NV12') reasons.push(frame.format === null ? 'format-unknown' : 'format-not-I420-or-NV12');
  const color = frame.colorSpace;
  if (!color || color.primaries === null || color.transfer === null || color.matrix === null || color.fullRange === null) reasons.push('color-metadata-incomplete');
  if (color && (color.primaries !== 'bt709' || color.transfer !== 'bt709' || color.matrix !== 'bt709' || color.fullRange !== false)) reasons.push('not-confirmed-BT709-limited');
  const evenPositive = (n: number | null) => n !== null && Number.isInteger(n) && n > 0 && n % 2 === 0;
  const rect = frame.visibleRect;
  if (!evenPositive(frame.codedWidth) || !evenPositive(frame.codedHeight) || !rect || rect.x !== 0 || rect.y !== 0 || rect.width !== frame.codedWidth || rect.height !== frame.codedHeight || frame.displayWidth !== frame.codedWidth || frame.displayHeight !== frame.codedHeight) reasons.push('geometry-outside-initial-full-frame-profile');
  if (frame.allocationSize === null || frame.allocationSize <= 0 || !Number.isSafeInteger(frame.allocationSize)) reasons.push('allocation-size-unavailable-or-invalid');
  return {
    candidate: reasons.length === 0,
    notice: reasons.length === 0 ? '메타데이터상 후보, 실제 복사/색변환 미검증' : '초기 I420/NV12 · BT.709 limited 후보 조건 미충족. 실제 복사/색변환 미검증',
    reasons,
  };
}

export type ProbeStatus = 'idle' | 'selecting' | 'waiting' | 'completed' | 'cancelled' | 'timeout' | 'unsupported' | 'error';
type TerminalStatus = Exclude<ProbeStatus, 'idle' | 'selecting' | 'waiting'>;
export interface ProbeReport {
  schema: 'loa-card-native-source-metadata-v1';
  source: 'display-track-processor';
  scope: 'direct-track-only-not-scanner-video-wrapper';
  status: TerminalStatus;
  reason: string | null;
  track: ReturnType<typeof snapshotTrack>['settings'];
  trackSettingsError: string | null;
  frame: FrameSnapshot | null;
  profile: ReturnType<typeof assessNativeProfile> | null;
}
export interface ProbeState { status: ProbeStatus; report: ProbeReport | null }
export const FIRST_FRAME_DEADLINE_MS = 5_000;
export const MAX_PROBE_REPORT_BYTES = 4_096;

export function formatProbeReport(report: ProbeReport) {
  const json = JSON.stringify(report, null, 2);
  if (new TextEncoder().encode(json).byteLength > MAX_PROBE_REPORT_BYTES) throw new Error('Metadata report exceeds its size limit');
  return json;
}

interface Run {
  finished: boolean;
  stream?: ProbeStream;
  track?: ProbeTrack;
  ended?: EventListener;
  reader?: ProbeReader;
  timer?: ReturnType<typeof setTimeout>;
  trackSnapshot?: ReturnType<typeof snapshotTrack>;
  released: boolean;
  resolve(report: ProbeReport): void;
}

/** The picker cannot be programmatically cancelled. Stopped runs clean up a late
 * granted stream and a late delivered frame without publishing a second result. */
export function createNativeSourceProbe(platform: ProbePlatform, onState: (state: ProbeState) => void = () => {}) {
  let active: Run | undefined, disposed = false;
  const stoppedTracks = new WeakSet<ProbeTrack>();
  const publish = (state: ProbeState) => { try { onState(state); } catch { /* UI errors cannot retain a capture. */ } };
  const stopStream = (stream: ProbeStream) => {
    for (const track of stream.getTracks()) if (!stoppedTracks.has(track)) {
      stoppedTracks.add(track);
      try { track.stop(); } catch { /* Continue releasing the other tracks. */ }
    }
  };
  const release = (run: Run) => {
    if (run.released || !run.reader) return;
    try { run.reader.releaseLock(); run.released = true; } catch { /* Retry after a pending read/cancel settles. */ }
  };
  const finish = (run: Run, status: TerminalStatus, reason: string | null, frame: FrameSnapshot | null = null) => {
    if (run.finished) return;
    run.finished = true;
    clearTimeout(run.timer);
    if (run.track && run.ended) run.track.removeEventListener('ended', run.ended);
    if (run.reader) {
      try { void Promise.resolve(run.reader.cancel()).catch(() => {}).finally(() => release(run)); }
      catch { release(run); }
    }
    if (run.stream) stopStream(run.stream);
    const report: ProbeReport = {
      schema: 'loa-card-native-source-metadata-v1', source: 'display-track-processor', scope: 'direct-track-only-not-scanner-video-wrapper', status, reason,
      track: run.trackSnapshot?.settings ?? null, trackSettingsError: run.trackSnapshot?.error ?? null,
      frame, profile: frame ? assessNativeProfile(frame) : null,
    };
    if (active === run) { active = undefined; publish({ status, report }); }
    run.resolve(report);
  };
  const receiveStream = (run: Run, stream: ProbeStream) => {
    if (run.finished) { stopStream(stream); return; }
    run.stream = stream;
    try {
      const track = stream.getVideoTracks()[0];
      if (!track) { finish(run, 'error', 'no-video-track'); return; }
      run.track = track; run.trackSnapshot = snapshotTrack(track);
      if (track.readyState !== 'live') { finish(run, 'cancelled', 'track-ended'); return; }
      run.ended = () => finish(run, 'cancelled', 'track-ended');
      track.addEventListener('ended', run.ended);
      // First-frame deadline begins after the user has selected a source.
      run.timer = setTimeout(() => finish(run, 'timeout', 'first-frame-deadline'), FIRST_FRAME_DEADLINE_MS);
      run.reader = platform.createReader(track);
      publish({ status: 'waiting', report: null });
      void run.reader.read().then(next => {
        let frame: FrameSnapshot | null = null, failed = false;
        if (next.value) {
          try { if (!run.finished && !next.done) frame = snapshotFrame(next.value); }
          catch { failed = true; }
          finally { try { next.value.close(); } catch { failed = true; } }
        }
        if (run.finished) return;
        if (failed) finish(run, 'error', 'frame-metadata-failed', frame);
        else if (next.done || !frame) finish(run, 'error', 'reader-ended-without-frame');
        else finish(run, 'completed', null, frame);
      }).catch(() => finish(run, 'error', 'frame-read-failed')).finally(() => release(run));
    } catch { finish(run, 'error', 'frame-reader-setup-failed'); }
  };
  return {
    start(): Promise<ProbeReport> {
      if (active) finish(active, 'cancelled', 'replaced');
      let resolve!: Run['resolve'];
      const completion = new Promise<ProbeReport>(done => { resolve = done; });
      const run: Run = { finished: false, released: false, resolve }; active = run;
      if (disposed) { finish(run, 'cancelled', 'disposed'); return completion; }
      if (!platform.captureSupported || !platform.processorSupported) {
        finish(run, 'unsupported', !platform.captureSupported ? 'display-capture-unavailable' : 'track-processor-unavailable'); return completion;
      }
      publish({ status: 'selecting', report: null });
      if (run.finished) return completion;
      try {
        // Invoke in the button's user gesture; no awaited preparation precedes it.
        const request = platform.requestCapture({ video: { displaySurface: 'window', frameRate: { ideal: 60, max: 60 } }, audio: false });
        void request.then(stream => receiveStream(run, stream)).catch(error => {
          const name = error && typeof error === 'object' && 'name' in error ? error.name : null;
          finish(run, name === 'AbortError' || name === 'NotAllowedError' ? 'cancelled' : 'error', name === 'AbortError' || name === 'NotAllowedError' ? 'capture-cancelled-or-denied' : 'capture-request-failed');
        });
      } catch { finish(run, 'error', 'capture-request-failed'); }
      return completion;
    },
    stop() { if (active) finish(active, 'cancelled', 'stopped'); },
    dispose() { disposed = true; if (active) finish(active, 'cancelled', 'disposed'); },
  };
}
