/** A prepared resource has exactly one owner: the slot, or its consumer. */
export function createPreparedSlot<T extends { dispose(): void | Promise<void> }>(
  create: (signal: AbortSignal) => Promise<T>,
) {
  const controller = new AbortController();
  let value: T | undefined;
  let closed = false;
  const ready = create(controller.signal).then(async resource => {
    if (closed) { await resource.dispose(); throw controller.signal.reason; }
    value = resource;
  });
  return {
    ready,
    take() {
      if (closed || !value) return undefined;
      const resource = value;
      value = undefined;
      closed = true;
      return resource;
    },
    dispose() {
      if (closed) return;
      closed = true;
      controller.abort();
      const resource = value;
      value = undefined;
      return resource?.dispose();
    },
  };
}
