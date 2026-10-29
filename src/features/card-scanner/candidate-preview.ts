type PreviewReader = Pick<FileReader, 'result' | 'onload' | 'onerror' | 'onabort' | 'readAsDataURL' | 'abort'>;
type PreviewWorker = Pick<Worker, 'onmessage' | 'onerror' | 'onmessageerror' | 'postMessage' | 'terminate'>;

interface CandidatePreviewOptions {
  signal?: AbortSignal;
  maxPending?: number;
  timeoutMs?: number;
  createReader?: () => PreviewReader;
  createWorker?: () => PreviewWorker | undefined;
  createBitmap?: (canvas: HTMLCanvasElement) => Promise<ImageBitmap>;
}

/** Optional thumbnails must not block recognition or accumulate stalled encodes.
 * The caller retains ownership of the canvas and may release it after the returned
 * promise settles. toBlob snapshots its pixels when called; a late callback owns
 * only that snapshot and can never update the settled result.
 * https://html.spec.whatwg.org/multipage/canvas.html#dom-canvas-toblob
 */
export function createCandidatePreviewEncoder({
  signal,
  maxPending = 4,
  timeoutMs = 750,
  createReader = () => new FileReader(),
  createWorker = () => typeof Worker !== 'undefined' && typeof OffscreenCanvas !== 'undefined' && typeof createImageBitmap !== 'undefined'
    ? new Worker(new URL('./candidate-preview-worker.ts', import.meta.url), { type: 'module' }) : undefined,
  createBitmap = canvas => createImageBitmap(canvas),
}: CandidatePreviewOptions = {}) {
  const limit = Number.isInteger(maxPending) && maxPending > 0 ? maxPending : 4;
  const timeout = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 750;
  const controller = new AbortController();
  const abortSession = () => controller.abort();
  if (signal?.aborted) controller.abort();
  else signal?.addEventListener('abort', abortSession, { once: true });
  let pending = 0, waiting = 0;
  const owned = new Set<Promise<string>>();
  type Job = { backend: 'freezing' | 'worker' | 'html'; worker?: PreviewWorker; finish: (image?: string) => void; complete: () => void };
  const jobs = new Map<number, Job>();
  let worker: PreviewWorker | undefined, workerUnavailable = false, nextId = 0;
  const stopWorker = (failed: PreviewWorker) => {
    if (worker !== failed) return;
    worker = undefined; workerUnavailable = true;
    failed.onmessage = failed.onerror = failed.onmessageerror = null;
    failed.terminate();
    for (const job of [...jobs.values()]) {
      if (job.worker !== failed) continue;
      // A transferred bitmap belongs to the terminated worker. A snapshot still
      // being made retains its credit until its promise closes that late bitmap.
      if (job.backend === 'worker') job.complete();
      job.finish();
    }
  };
  const getWorker = () => {
    if (worker || workerUnavailable) return worker;
    try { worker = createWorker(); } catch { /* Unsupported/CSP: use the bounded native fallback. */ }
    if (!worker) { workerUnavailable = true; return; }
    const current = worker;
    current.onmessage = event => {
      const job = jobs.get(event.data?.id);
      if (!job || job.worker !== current || job.backend !== 'worker') return;
      if (event.data.error) { stopWorker(current); return; }
      job.complete();
      job.finish(typeof event.data.image === 'string' ? event.data.image : '');
    };
    current.onerror = current.onmessageerror = () => stopWorker(current);
    return current;
  };

  const encode = (canvas: HTMLCanvasElement): Promise<string> => {
    if (controller.signal.aborted || pending >= limit || canvas.width <= 0 || canvas.height <= 0)
      return Promise.resolve('');
    pending++; waiting++;
    return new Promise(resolve => {
      const id = ++nextId;
      let settled = false, encoded = false, released = false, reading = false;
      let reader: PreviewReader | undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const release = () => {
        // toBlob and createImageBitmap cannot be cancelled. Timed-out native
        // work keeps its credit until its callback/promise returns.
        if (settled && encoded && !released) { released = true; pending--; jobs.delete(id); }
      };
      const finish = (value = '') => {
        if (settled) return;
        settled = true;
        waiting--;
        clearTimeout(timer);
        controller.signal.removeEventListener('abort', abort);
        if (reader) {
          reader.onload = reader.onerror = reader.onabort = null;
          if (reading) {
            reading = false;
            try { reader.abort(); } catch { /* The optional read may have already ended. */ }
          }
        }
        release();
        resolve(value);
      };
      const abort = () => finish();
      const job: Job = { backend: 'html', finish, complete: () => { encoded = true; release(); } };
      jobs.set(id, job);
      controller.signal.addEventListener('abort', abort, { once: true });
      // A busy renderer can delay a healthy worker's reply. End this optional
      // wait without switching the entire scan back to main-thread encoding.
      // Its native credit remains occupied until the reply or worker disposal.
      timer = setTimeout(finish, timeout);
      const nativeEncode = () => { try {
        job.backend = 'html'; job.worker = undefined;
        canvas.toBlob(blob => {
          if (encoded) return;
          encoded = true;
          if (settled) { release(); return; }
          if (!blob) { finish(); return; }
          try {
            reader = createReader();
            reader.onload = () => {
              reading = false;
              finish(typeof reader?.result === 'string' ? reader.result : '');
            };
            reader.onerror = reader.onabort = () => { reading = false; finish(); };
            reading = true;
            reader.readAsDataURL(blob);
          } catch { reading = false; finish(); }
        }, 'image/jpeg', 0.92);
      } catch { encoded = true; finish(); } };
      const current = getWorker();
      if (!current) { nativeEncode(); return; }
      job.backend = 'freezing'; job.worker = current;
      try {
        // createImageBitmap captures this canvas, independently of recognition's
        // crop. Only the returned bitmap crosses the worker boundary.
        void createBitmap(canvas).then(bitmap => {
          if (settled || controller.signal.aborted || worker !== current) {
            bitmap.close(); job.complete(); finish(); return;
          }
          job.backend = 'worker';
          try { current.postMessage({ id, bitmap }, [bitmap]); }
          catch { bitmap.close(); job.complete(); finish(); stopWorker(current); }
        }, () => {
          if (settled || controller.signal.aborted || worker !== current) { job.complete(); finish(); }
          else nativeEncode();
        }).catch(() => { job.complete(); finish(); });
      } catch { nativeEncode(); }
    });
  };
  return {
    encode,
    /** Transfer only the thumbnail canvas to this job. Recognition can continue
     * with its separate crop; queue replacement cannot release these pixels. */
    encodeOwned(canvas: HTMLCanvasElement) {
      const release = () => {
        try { canvas.width = 0; canvas.height = 0; }
        catch { /* Optional preview cleanup cannot reject recognition work. */ }
      };
      const task = encode(canvas).then(image => { release(); return image; }, () => { release(); return ''; });
      owned.add(task);
      void task.then(() => owned.delete(task), () => owned.delete(task));
      return task;
    },
    /** Unresolved callers, excluding abandoned native work after a timeout. */
    get waiting() { return waiting; },
    async dispose() {
      signal?.removeEventListener('abort', abortSession);
      controller.abort();
      if (worker) stopWorker(worker);
      await Promise.allSettled([...owned]);
    },
  };
}
