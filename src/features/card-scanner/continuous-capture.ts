import { decodedFrames } from "./decoded-frames";
import { recordingBitrate } from "./capture-settings";

export interface ContinuousRecording { blob: Blob; duration: number }
/** Record the source stream in the browser's encoder, independently of card/OCR work. */
export function recordContinuous(stream: MediaStream, report: (message: string) => void,
  Recorder: typeof MediaRecorder = MediaRecorder, limit = 256 * 1024 * 1024, stopTimeoutMs = 10_000) {
  const mimeType = ["video/webm;codecs=vp8", "video/webm;codecs=vp9", "video/webm"]
    .find(type => Recorder.isTypeSupported(type));
  if (!mimeType) throw new Error("연속 화면 기록을 지원하지 않는 브라우저입니다.");
  const track = stream.getVideoTracks?.()[0];
  if (track && "contentHint" in track) track.contentHint = "text";
  const recorder = new Recorder(stream, { mimeType, videoBitsPerSecond: recordingBitrate(track?.getSettings() ?? {}) });
  const chunks: Blob[] = [];
  let bytes = 0, failed = false, stoppedAt = 0;
  let settled = false, finishing = false, stopTimer:ReturnType<typeof setTimeout>|undefined;
  const startedAt = performance.now();
  let resolve!: (recording: ContinuousRecording | undefined) => void;
  const completed = new Promise<ContinuousRecording | undefined>(done => { resolve = done; });
  const fail = (message: string) => {
    if (failed) return;
    failed = true; chunks.length = 0; report(message);
  };
  const settle = () => {
    if(settled)return;
    settled=true;clearTimeout(stopTimer);
    recorder.removeEventListener('dataavailable',onData);
    recorder.removeEventListener('error',onError);
    recorder.removeEventListener('stop',settle);
    resolve(failed || !chunks.length ? undefined : {
      blob:new Blob(chunks,{type:recorder.mimeType||mimeType}),
      duration:((stoppedAt||performance.now())-startedAt)/1000,
    });
    chunks.length=0;
  };
  const finish = () => {
    if(finishing||settled)return completed;
    finishing=true;
    if (!stoppedAt) stoppedAt = performance.now();
    stopTimer=setTimeout(()=>{fail('녹화 종료 시간 초과 · 수집된 카드는 유지됩니다.');settle();},stopTimeoutMs);
    try{if (recorder.state !== "inactive") recorder.stop();}
    catch{fail('녹화 종료 실패 · 수집된 카드는 유지됩니다.');settle();}
    return completed;
  };
  const onData = (event:BlobEvent) => {
    if (failed || !event.data.size) return;
    bytes += event.data.size;
    if (bytes > limit) {
      fail("연속 화면 기록 용량을 초과해 누락 구간 자동 보완이 중단됐습니다. 수집된 카드 목록은 유지됩니다.");
      void finish(); return;
    }
    chunks.push(event.data);
  };
  const onError = () => {
    fail("연속 화면 기록에 실패해 누락 구간을 자동 보완할 수 없습니다.");
    void finish();
  };
  recorder.addEventListener('dataavailable',onData);
  recorder.addEventListener('error',onError);
  recorder.addEventListener('stop',settle,{once:true});
  recorder.start(500);
  return { finish, startedAt };
}

/** Read every encoded presentation frame, including variable-rate recordings. */
export async function* recordedFrames(recording: ContinuousRecording, signal: AbortSignal) {
  yield* decodedFrames(recording.blob, signal);
}
