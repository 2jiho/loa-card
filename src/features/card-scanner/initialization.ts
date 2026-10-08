/** A cancelled startup must not publish a late result or leak its resources. */
export function initializeWithin<T>(operation: Promise<T>, signal: AbortSignal,
  disposeLate: (value: T) => void, timeoutMs = 120_000): Promise<T> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: unknown, value?: T) => {
      if (settled) return;
      settled = true; clearTimeout(timer); signal.removeEventListener('abort', abort);
      if (error) reject(error); else resolve(value!);
    };
    const abort = () => finish(signal.reason ?? new DOMException('스캔 중지', 'AbortError'));
    const timer = setTimeout(() => finish(new Error('화면 검출 모듈 준비 시간이 초과됐습니다. 연결을 확인하고 다시 시작해 주세요.')), timeoutMs);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    operation.then(value => { if (settled) disposeLate(value); else finish(undefined, value); }, error => finish(error));
  });
}
