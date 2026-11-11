/** A prepared resource has exactly one owner: the slot, or its consumer. */
export function createPreparedSlot<T extends { dispose(): void | Promise<void> }>(
  create: (signal: AbortSignal) => Promise<T>,
  options:{onCleanupError?:(error:unknown)=>void}={},
) {
  const controller = new AbortController();
  let value: T | undefined;
  let closed = false;
  const release=async(resource:T)=>{
    try{await resource.dispose();}catch(error){try{options.onCleanupError?.(error);}catch{/* Preserve the cleanup error. */}throw error;}
  };
  const ready = create(controller.signal).then(async resource => {
    if (closed) {
      // The caller already saw cancellation; report cleanup failure separately
      // without replacing the original abort reason.
      try{await release(resource);}catch{/* The owner receives onCleanupError. */}
      throw controller.signal.reason;
    }
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
      return resource ? release(resource) : undefined;
    },
  };
}
