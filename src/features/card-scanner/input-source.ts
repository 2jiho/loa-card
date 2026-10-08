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
/** Images pass through the same pipeline without a synthetic video timeline. */
export async function* imageInputs(images: HTMLImageElement[], signal: AbortSignal) {
  for (const [index, element] of images.entries()) {
    signal.throwIfAborted();
    yield { element, percent: ((index + 1) / images.length) * 100, still: true };
  }
}
export { startVideoFrames as startLiveFrames } from "./live-frame-clock";
