/** Coalesce presentation snapshots only. Capture and recognition never wait here. */
export function createLatestPublisher<T>(deliver: (value: T) => void, interval: number) {
  let pending: { value: T } | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const drain = () => {
    timer = undefined;
    if (!pending) return;
    const { value } = pending;
    pending = undefined;
    deliver(value);
    timer = setTimeout(drain, interval);
  };
  return {
    publish(value: T) {
      if (interval <= 0) { deliver(value); return; }
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
