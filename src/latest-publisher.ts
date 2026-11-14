/** Coalesce presentation snapshots only. Capture and recognition never wait here.
 * `interval` may depend on the value just delivered (the wait before the next one). */
export function createLatestPublisher<T>(deliver: (value: T) => void, interval: number | ((delivered: T) => number)) {
  const wait = (value: T) => typeof interval === 'function' ? interval(value) : interval;
  let pending: { value: T } | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const drain = () => {
    timer = undefined;
    if (!pending) return;
    const { value } = pending;
    pending = undefined;
    deliver(value);
    timer = setTimeout(drain, wait(value));
  };
  return {
    publish(value: T) {
      if (typeof interval === 'number' && interval <= 0) { deliver(value); return; }
      pending = { value };
      if (timer === undefined) drain();
    },
    flush() {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      const latest = pending;
      pending = undefined;
      if (latest) deliver(latest.value);
    },
    cancel() {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      pending = undefined;
    },
  };
}
