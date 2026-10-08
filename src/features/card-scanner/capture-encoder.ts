import type { DebugFrame } from "./debug-capture";
import { createBitmapDispatch } from "./bitmap-dispatch";
import type { SnapshotSource } from "./bitmap-dispatch";

interface EncoderWorker {
  onmessage: ((event: MessageEvent<CaptureReply>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  postMessage(message: unknown, transfer: Transferable[]): void;
  terminate(): void;
}
export interface RawCapture { width: number; height: number; time: number; pixels: Uint8ClampedArray<ArrayBuffer> }
export interface CaptureReply { id?: number; stored?: boolean; done?: boolean; frame?: DebugFrame; raw?: RawCapture; error?: string }
/** Store frozen source pixels in a Worker. Recovery reads them on demand;
 * explicit debug exports encode PNGs. Bound pending images independently of disk. */
export function createCaptureEncoder(record: (frame: DebugFrame) => void, report: (message: string) => void,
  worker: EncoderWorker = new Worker(new URL("./debug-encode-worker.ts", import.meta.url), { type: "module" }),
  byteLimit = 128 * 1024 * 1024,
  bitmapFactory: ((source: SnapshotSource) => Promise<ImageBitmap>) | undefined =
    typeof createImageBitmap === "function" ? source => createImageBitmap(source) : undefined) {
  const pending = new Map<number, { bytes: number; timer: ReturnType<typeof setTimeout> }>();
  let nextId = 0, nextOutput = 1, bytes = 0, stopped = false, failed = false;
  let finished: (() => void) | undefined, flushTimer: ReturnType<typeof setTimeout> | undefined;
  let finishing: Promise<void> | undefined;
  let discarding = false;
  let rawMode = false;
  let read: { id: number; resolve: (value: RawCapture) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> } | undefined;
  function cancelRead(error: Error) {
    if (!read) return;
    clearTimeout(read.timer); read.reject(error); read = undefined;
  }
  const copies = bitmapFactory ? createBitmapDispatch(bitmapFactory,
    (bitmap, metadata) => worker.postMessage({ ...metadata, bitmap }, [bitmap]),
    error => fail(`원본 캡처 전송 실패: ${error instanceof Error ? error.message : "비트맵 복사 실패"}`)) : undefined;
  function fail(message: string) {
    if (failed) return;
    failed = stopped = true; copies?.cancel();
    for (const item of pending.values()) clearTimeout(item.timer);
    pending.clear(); bytes = 0; clearTimeout(flushTimer);
    cancelRead(new Error(message));
    worker.terminate(); report(message); finished?.();
  }
  function renewFlushTimeout() {
    clearTimeout(flushTimer);
    flushTimer = setTimeout(() => fail("원본 PNG 압축 시간 초과"), 30000);
  }
  worker.onerror = event => fail(`원본 캡처 Worker 오류: ${event.message || "압축 실패"}`);
  worker.onmessage = event => {
    if (failed) return;
    const { id, stored, done, frame, raw, error } = event.data;
    if (error) { fail(`원본 캡처 실패: ${error}`); return; }
    if (stored && id !== undefined) {
      const item = pending.get(id);
      if (!item) { fail("원본 임시 저장 순서 오류"); return; }
      clearTimeout(item.timer); bytes -= item.bytes; pending.delete(id);
    } else if (raw) {
      if (discarding) return;
      if (!read || id !== read.id || pending.size || raw.pixels.length !== raw.width * raw.height * 4) {
        fail("원본 픽셀 프레임 순서 또는 크기 오류"); return;
      }
      clearTimeout(read.timer); read.resolve(raw); read = undefined;
    } else if (frame) {
      if (id !== nextOutput++) { fail("원본 PNG 프레임 순서 오류"); return; }
      record(frame); renewFlushTimeout();
    } else if (done) {
      if (!discarding && (pending.size || nextOutput !== nextId + 1)) { fail("원본 PNG 프레임 누락"); return; }
      for(const item of pending.values())clearTimeout(item.timer);
      pending.clear();bytes=0;
      clearTimeout(flushTimer); finished?.();
    }
  };
  const finish = (discard = rawMode) => {
    if (!finishing) finishing = (async () => {
      stopped = true;discarding=discard;
      if(discard) { copies?.cancel(); cancelRead(new DOMException("원본 읽기 종료", "AbortError")); }
      else if(copies)await copies.finish();
      if (!failed) await new Promise<void>(resolve => {
        finished = resolve; renewFlushTimeout();
        try { worker.postMessage(discard ? {discard:true} : {finish:true}, []); }
        catch { fail("원본 캡처 종료 요청 실패"); }
      });
      worker.terminate();
    })();
    return finishing;
  };
  return {
    submit(source: SnapshotSource, time: number, elapsed: number) {
      if (stopped) return;
      const width = "videoWidth" in source ? source.videoWidth : source.width;
      const height = "videoHeight" in source ? source.videoHeight : source.height;
      const size = width * height * 4;
      if (!width || !height) return;
      if (bytes + size > byteLimit) {
        stopped = true;
        report("원본 캡처 대기 용량 초과로 보완 기록을 중단했습니다. 연속 영상 판독은 계속됩니다.");
        return;
      }
      try {
        const id = ++nextId, metadata = { id, width, height, time, elapsed };
        pending.set(id, { bytes: size, timer: setTimeout(() => fail("원본 임시 저장 시간 초과"), 30000) });
        bytes += size;
        if (copies) { copies.submit(source, metadata); return; }
        // Compatibility path for browsers without ImageBitmap and test doubles.
        let canvas: HTMLCanvasElement, temporary = false;
        if ("videoWidth" in source) {
          canvas = document.createElement("canvas"); temporary = true;
          canvas.width = width; canvas.height = height;
          canvas.getContext("2d")!.drawImage(source, 0, 0);
        } else canvas = source;
        try {
          const pixels = canvas.getContext("2d", { willReadFrequently: true })!
            .getImageData(0, 0, width, height).data;
          worker.postMessage({ ...metadata, pixels }, [pixels.buffer]);
        } finally { if (temporary) canvas.width = canvas.height = 0; }
      } catch (error) { fail(`원본 캡처 실패: ${error instanceof Error ? error.message : "픽셀 전송 실패"}`); }
    },
    finish: () => finish(),
    /** Only for internal backups no longer needed after validated completion. */
    discard: () => finish(true),
    /** Internal recovery reads one lossless frame on demand. PNG/base64 and a
     * second IndexedDB recording are only needed for explicit debug exports. */
    async *frames(signal: AbortSignal) {
      if (rawMode || finishing) throw new Error("원본 읽기는 한 번만 시작할 수 있습니다.");
      rawMode = stopped = true;
      const abort = () => { void finish(true); };
      signal.addEventListener("abort", abort, { once: true });
      let canvas: HTMLCanvasElement | undefined;
      try {
        signal.throwIfAborted();
        await copies?.finish();
        signal.throwIfAborted();
        if (failed) throw new Error("원본 캡처 저장 실패");
        canvas = document.createElement("canvas");
        const context = canvas.getContext("2d")!;
        for (let id = 1; id <= nextId; id++) {
          signal.throwIfAborted();
          if (failed) throw new Error("원본 캡처 읽기 실패");
          const value = await new Promise<RawCapture>((resolve, reject) => {
            read = { id, resolve, reject, timer: setTimeout(() => fail("원본 픽셀 읽기 시간 초과"), 30000) };
            try { worker.postMessage({ read: id }, []); }
            catch { fail("원본 픽셀 읽기 요청 실패"); }
          });
          signal.throwIfAborted();
          if (canvas.width !== value.width || canvas.height !== value.height) {
            canvas.width = value.width; canvas.height = value.height;
          }
          context.putImageData(new ImageData(value.pixels, value.width, value.height), 0, 0);
          // The caller must copy the frame before advancing this iterator.
          yield { element: canvas, time: value.time, percent: id / nextId * 100 };
        }
      } finally {
        signal.removeEventListener("abort", abort);
        if (canvas) canvas.width = canvas.height = 0;
        await finish(true);
      }
    },
    get active() { return !stopped; },
    get captured() { return nextId; },
  };
}
