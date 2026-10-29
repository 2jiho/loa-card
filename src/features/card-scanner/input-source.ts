export function waitForInput(signal: AbortSignal, delay = 30) {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, delay);
    const abort = () => {
      clearTimeout(timer);
      reject(new DOMException("Stopped", "AbortError"));
    };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
}

/** Yield without the nested setTimeout minimum where the browser supports it. */
export async function yieldForCapture(signal: AbortSignal) {
  signal.throwIfAborted();
  const scheduler=(globalThis as typeof globalThis & {scheduler?:{yield?:()=>Promise<void>}}).scheduler;
  if(scheduler?.yield)await scheduler.yield();
  else await waitForInput(signal,0);
  signal.throwIfAborted();
}

export async function decodeImageSources(sources: string[]) {
  return Promise.all(
    sources.map(async (src) => {
      const image = new Image();
      image.src = src;
      await image.decode();
      return image;
    }),
  );
}

/** Decode one registered image at a time, retaining it only while the consumer
 * handles that frame. Image order is meaningful; a capture timestamp is unknown.
 * The zero time is synthetic and must not be treated as a recorded capture time. */
export async function* streamImageInputs(sources: readonly string[], signal: AbortSignal) {
  for (const [index, source] of sources.entries()) {
    signal.throwIfAborted();
    const image = new Image();
    try {
      await new Promise<void>((resolve, reject) => {
        const cleanup = () => signal.removeEventListener('abort', abort);
        const abort = () => { cleanup(); reject(signal.reason); };
        const failed = (error: unknown) => { cleanup(); reject(error); };
        signal.addEventListener('abort', abort, { once: true });
        try {
          image.src = source;
          void image.decode().then(() => { cleanup(); resolve(); }, failed);
        } catch (error) { failed(error); }
      });
      signal.throwIfAborted();
      yield { element: image, time: 0, percent: ((index + 1) / sources.length) * 100 };
    } finally { image.removeAttribute('src'); }
  }
}
export type StillImageSources = readonly HTMLImageElement[] | readonly string[];

/** Normal images have their own adapter; URL inputs retain only one decoded
 * image at a time. Their zero timestamp is synthetic, not a replay receipt. */
export async function* imageInputs(images: StillImageSources, signal: AbortSignal) {
  if (images.every(image => typeof image === 'string')) {
    for await (const frame of streamImageInputs(images as readonly string[], signal))
      yield { ...frame, still: true };
    return;
  }
  if (images.some(image => typeof image === 'string'))
    throw new TypeError('Image inputs must contain either URL strings or image elements.');
  for (const [index, element] of (images as readonly HTMLImageElement[]).entries()) {
    signal.throwIfAborted();
    yield { element, percent: ((index + 1) / images.length) * 100, still: true };
  }
}
export { startVideoFrames as startLiveFrames } from "./live-frame-clock";
