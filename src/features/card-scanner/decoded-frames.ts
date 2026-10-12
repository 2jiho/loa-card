import { ALL_FORMATS, BlobSource, CanvasSink, Input, UrlSource } from "mediabunny";
import { yieldForCapture } from "./input-source";

/** Sequential decoded samples, not a synthetic fixed-rate seek schedule.
 * The consumer must copy pixels before advancing this bounded canvas pool. */
export async function* decodedFrames(source: Blob | string, signal: AbortSignal) {
  signal.throwIfAborted();
  const input = new Input({ formats: ALL_FORMATS,
    source: typeof source === "string" ? new UrlSource(source) : new BlobSource(source) });
  const abort = () => input.dispose();
  signal.addEventListener("abort", abort, { once: true });
  try {
    const track = await input.getPrimaryVideoTrack();
    signal.throwIfAborted();
    if (!track || !await track.canDecode())
      throw new Error("이 영상의 프레임 디코딩을 지원하지 않습니다. Chrome 또는 Edge에서 다시 시도해 주세요.");
    const duration = await track.computeDuration();
    signal.throwIfAborted();
    const sink = new CanvasSink(track, { poolSize: 2 });
    let count = 0;
    for await (const sample of sink.canvases()) {
      signal.throwIfAborted();
      count++;
      yield { element: sample.canvas, time: sample.timestamp,
        percent: duration > 0 ? Math.min(100, Math.max(0, (sample.timestamp + sample.duration) / duration * 100)) : 0,
        still: false };
      // A decoder's prefetched samples may all resolve as microtasks. Yield
      // between frames so acquisition-only scans can process stop/UI events.
      await yieldForCapture(signal);
    }
    if (!count) throw new Error("영상에서 읽을 수 있는 프레임이 없습니다.");
  } catch (error) {
    signal.throwIfAborted();
    throw error;
  } finally {
    signal.removeEventListener("abort", abort);
    input.dispose();
  }
}
