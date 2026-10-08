import { decodedFrames } from "./decoded-frames";
import { recordingBitrate } from "./capture-settings";

export interface ContinuousRecording { blob: Blob; duration: number }
/** Record the source stream in the browser's encoder, independently of card/OCR work. */
export function recordContinuous(stream: MediaStream, report: (message: string) => void,
  Recorder: typeof MediaRecorder = MediaRecorder, limit = 256 * 1024 * 1024) {
  const mimeType = ["video/webm;codecs=vp8", "video/webm;codecs=vp9", "video/webm"]
    .find(type => Recorder.isTypeSupported(type));
  if (!mimeType) throw new Error("연속 화면 기록을 지원하지 않는 브라우저입니다.");
  const track = stream.getVideoTracks?.()[0];
  if (track && "contentHint" in track) track.contentHint = "text";
  const recorder = new Recorder(stream, { mimeType, videoBitsPerSecond: recordingBitrate(track?.getSettings() ?? {}) });
  const chunks: Blob[] = [];
  let bytes = 0, failed = false, stoppedAt = 0;
  const startedAt = performance.now();
  let resolve!: (recording: ContinuousRecording | undefined) => void;
  const completed = new Promise<ContinuousRecording | undefined>(done => { resolve = done; });
  const fail = (message: string) => {
    if (failed) return;
    failed = true; chunks.length = 0; report(message);
  };
  const finish = () => {
    if (!stoppedAt) stoppedAt = performance.now();
    if (recorder.state !== "inactive") recorder.stop();
    return completed;
  };
  recorder.addEventListener("dataavailable", event => {
    if (failed || !event.data.size) return;
    bytes += event.data.size;
    if (bytes > limit) {
      fail("연속 화면 기록 용량을 초과해 누락 구간 자동 보완이 중단됐습니다. 수집된 카드 목록은 유지됩니다.");
      void finish(); return;
    }
    chunks.push(event.data);
  });
  recorder.addEventListener("error", () => {
    fail("연속 화면 기록에 실패해 누락 구간을 자동 보완할 수 없습니다.");
    void finish();
  });
  recorder.addEventListener("stop", () => {
    resolve(failed || !chunks.length ? undefined : {
      blob: new Blob(chunks, { type: recorder.mimeType || mimeType }),
      duration: ((stoppedAt || performance.now()) - startedAt) / 1000,
    });
    chunks.length = 0;
  }, { once: true });
  recorder.start(500);
  return { finish, startedAt };
}

/** Read every encoded presentation frame, including variable-rate recordings. */
export async function* recordedFrames(recording: ContinuousRecording, signal: AbortSignal) {
  yield* decodedFrames(recording.blob, signal);
}
