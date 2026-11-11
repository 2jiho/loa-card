/** Merge saved source frames and PNG observations without dropping either.
 * Only one decoded frame per input is held; advancement occurs after the
 * consumer copies the yielded pixels. Equal timestamps are both preserved. */
export async function* mergeFrames<A extends { time: number }, B extends { time: number }>(
  first: AsyncIterable<A>, second: AsyncIterable<B>, signal: AbortSignal,
) {
  const a = first[Symbol.asyncIterator](), b = second[Symbol.asyncIterator]();
  try {
    signal.throwIfAborted();
    let x = await a.next(), y = await b.next();
    while (!x.done || !y.done) {
      signal.throwIfAborted();
      if (!x.done && (y.done || x.value.time <= y.value.time)) {
        yield x.value; signal.throwIfAborted(); x = await a.next();
      } else if (!y.done) {
        yield y.value; signal.throwIfAborted(); y = await b.next();
      }
    }
  } finally {
    await Promise.allSettled([a.return?.(), b.return?.()]);
  }
}
