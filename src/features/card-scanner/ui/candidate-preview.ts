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
  // Waiting callers retain their own canvas; both their number and estimated
  // RGBA bytes are bounded separately from the four native operations.
  const creditWaiters = new Set<() => void>();
  let creditWaiterBytes = 0;
  const maxCreditWaiters = 4, maxCreditWaiterBytes = 8 * 1024 * 1024;
  const releaseCanvas = (canvas:HTMLCanvasElement) => {
    try { canvas.width = 0; canvas.height = 0; }
    catch { /* Optional preview cleanup cannot reject recognition work. */ }
  };
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
        if (settled && encoded && !released) {
          released = true; pending--; jobs.delete(id);
          // A timed-out native job may hold credit after `waiting` reaches 0.
          // Wake only when the underlying snapshot/encode actually released it.
          for (const wake of [...creditWaiters]) wake();
        }
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
  const encodeOwned = (canvas:HTMLCanvasElement) => {
    /** Transfer only the thumbnail canvas to this job. Recognition can continue
     * with its separate crop; queue replacement cannot release these pixels. */
      const task = encode(canvas).then(image => { releaseCanvas(canvas); return image; }, () => { releaseCanvas(canvas); return ''; });
      owned.add(task);
      void task.then(() => owned.delete(task), () => owned.delete(task));
      return task;
  };
  /** Reserve native credit only when it is genuinely available. On saturation
   * the caller still owns the canvas and can wait without starting native work. */
  const tryEncodeOwned = (canvas:HTMLCanvasElement):Promise<string>|undefined => {
    if(!controller.signal.aborted && pending>=limit && canvas.width>0 && canvas.height>0)return;
    return encodeOwned(canvas);
  };
  /** Bounded backpressure for the few reader lanes that find all native credit
   * occupied. A permanently stalled browser callback cannot retain the canvas
   * or block a reader for longer than this optional preview deadline. */
  const encodeOwnedWhenAvailable = (canvas:HTMLCanvasElement):Promise<string> => {
    const immediate=tryEncodeOwned(canvas);if(immediate)return immediate;
    const bytes=canvas.width*canvas.height*4;
    if(!Number.isSafeInteger(bytes)||bytes<1||bytes>maxCreditWaiterBytes||
      creditWaiters.size>=maxCreditWaiters||creditWaiterBytes+bytes>maxCreditWaiterBytes){releaseCanvas(canvas);return Promise.resolve('');}
    creditWaiterBytes+=bytes;
    return new Promise(resolve=>{
      let settled=false,timer:ReturnType<typeof setTimeout>|undefined;
      const complete=(task?:Promise<string>)=>{
        if(settled)return;settled=true;clearTimeout(timer);creditWaiters.delete(wake);creditWaiterBytes-=bytes;
        controller.signal.removeEventListener('abort',abort);
        if(task)resolve(task);else{releaseCanvas(canvas);resolve('');}
      };
      const abort=()=>complete();
      const wake=()=>{
        if(settled||(!controller.signal.aborted&&pending>=limit&&canvas.width>0&&canvas.height>0))return;
        // Encoding can synchronously fail (e.g. tainted canvas), immediately
        // returning credit and notifying waiters. Remove this waiter first so
        // that reentrant notification cannot start it a second time.
        creditWaiters.delete(wake);
        const task=tryEncodeOwned(canvas);
        if(task)complete(task);else creditWaiters.add(wake);
      };
      creditWaiters.add(wake);controller.signal.addEventListener('abort',abort,{once:true});
      timer=setTimeout(abort,timeout);
      // Credit could have been freed before registration by a synchronous
      // native callback; recheck after the waiter is fully registered.
      wake();
    });
  };
  return {
    encode,
    encodeOwned,
    tryEncodeOwned,
    encodeOwnedWhenAvailable,
    get waitingForCredit() { return creditWaiters.size; },
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
