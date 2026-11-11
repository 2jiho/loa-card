/** Start each source snapshot immediately, then transfer in capture order.
 * Pixel readback happens in the Worker instead of blocking video playback. */
export type SnapshotSource = HTMLCanvasElement | HTMLVideoElement | VideoFrame;
export function createBitmapDispatch(make: (canvas: SnapshotSource) => Promise<ImageBitmap>,
  send: (bitmap: ImageBitmap, metadata: { id: number; width: number; height: number; time: number; elapsed: number }) => void,
  report: (error: unknown) => void) {
  let canceled = false, tail = Promise.resolve();
  let unblock!: () => void;
  const cancellation = new Promise<void>(resolve => { unblock = resolve; });
  return {
    submit(canvas: SnapshotSource, metadata: { id: number; width: number; height: number; time: number; elapsed: number }) {
      if (canceled) return;
      // Attach rejection handling immediately even if an earlier copy is pending.
      let copy: Promise<{ bitmap: ImageBitmap } | { error: unknown }>;
      try { copy = make(canvas).then(bitmap => ({ bitmap }), error => ({ error })); }
      catch (error) { report(error); return; }
      tail = tail.then(async () => {
        const result = await copy;
        if ("error" in result) { if (!canceled) report(result.error); return; }
        if (canceled) { result.bitmap.close(); return; }
        try { send(result.bitmap, metadata); }
        catch (error) { result.bitmap.close(); report(error); }
      });
    },
    finish() { return Promise.race([tail, cancellation]); },
    cancel() { canceled = true; unblock(); },
  };
}
