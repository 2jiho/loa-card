import { createDetector } from './detector';
import { createRecognizer } from './recognizer';
import { createAcquisitionClient } from './acquisition-client';
import { createVisualClient } from './visual-client';
import { initializeWithin } from './initialization';
import { liveLanePlan } from './live-scan-policy';

export type PreparedScanner = Awaited<ReturnType<typeof prepareScanner>>;

/** Fresh, unused sessions are transferred to one scan, never shared across scans. */
export async function prepareScanner(status: (message: string) => void, signal: AbortSignal) {
  const lifetime = new AbortController();
  const abort = () => lifetime.abort(signal.reason);
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) abort();
  const readers: Awaited<ReturnType<typeof createRecognizer>>[] = [];
  const visuals: ReturnType<typeof createVisualClient>[] = [];
  let detector: Awaited<ReturnType<typeof createDetector>> | undefined;
  let acquisition: ReturnType<typeof createAcquisitionClient> | undefined;
  let disposed = false;
  async function dispose() {
    if (disposed) return;
    disposed = true;
    signal.removeEventListener('abort', abort);
    lifetime.abort();
    acquisition?.dispose();
    visuals.forEach(worker => worker?.dispose());
    detector?.dispose();
    await Promise.allSettled(readers.map(reader => reader.dispose()));
  }
  try {
    status('화면 검출 모듈 준비 중');
    detector = await initializeWithin(createDetector(), lifetime.signal, value => value.dispose());
    const lanes = liveLanePlan(navigator.hardwareConcurrency);
    for (let i = 0; i < lanes.readers; i++) {
      lifetime.signal.throwIfAborted();
      status(`인식 엔진 준비 ${i + 1} / ${lanes.readers}`);
      readers.push(await createRecognizer(message => status(`${i + 1}/${lanes.readers} · ${message}`), lifetime.signal));
    }
    acquisition = createAcquisitionClient(lifetime.signal);
    for (let i = 0; i < lanes.fast; i++) visuals.push(createVisualClient(lifetime.signal));
    await Promise.all([acquisition.ready(), ...visuals.map(worker => worker?.ready())]);
    lifetime.signal.throwIfAborted();
    // Cancellation stops Worker requests immediately; detector Mats stay alive
    // until the scanner has joined its in-flight work and calls dispose.
    return { detector, readers, acquisition, visuals, cancel: () => lifetime.abort(), dispose };
  } catch (error) {
    await dispose();
    throw error;
  }
}
