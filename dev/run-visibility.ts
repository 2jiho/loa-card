export type RunVisibilityState = DocumentVisibilityState | 'unknown';
export interface RunVisibilityEvent {
  readonly kind: 'initial' | 'change';
  readonly state: RunVisibilityState;
  readonly hidden: boolean | null;
  readonly atMs: number | null;
}
export interface RunVisibilitySummary {
  readonly version: 1;
  readonly clock: 'page-performance-now';
  readonly initial: RunVisibilityState;
  readonly final: RunVisibilityState;
  readonly everHidden: boolean;
  readonly changes: number;
  readonly initialAtMs: number | null;
  readonly finalAtMs: number | null;
  readonly events: readonly Readonly<RunVisibilityEvent>[];
  readonly dropped: number;
  readonly invalidClock: number;
  readonly sourceErrors: number;
  readonly disposed: boolean;
}
export type RunVisibilitySource = Pick<Document, 'visibilityState' | 'hidden'> & {
  addEventListener(type: 'visibilitychange', listener: EventListener): void;
  removeEventListener(type: 'visibilitychange', listener: EventListener): void;
};

/** Bounded metadata on the page performance clock; no rebasing or polling.
 * Visibility does not prove paint timing, causality, or full background CPU use. */
export function createRunVisibilityObserver(source: RunVisibilitySource,
  { now = () => performance.now() }: { now?: () => number } = {}) {
  const events: RunVisibilityEvent[] = [];
  const increment = (count: number) => Math.min(Number.MAX_SAFE_INTEGER, count + 1);
  let changes = 0, dropped = 0, invalidClock = 0, sourceErrors = 0;
  let disposed = false, everHidden = false, lastClock: number | null = null;

  function observe(): Omit<RunVisibilityEvent, 'kind'> {
    let state: RunVisibilityState = 'unknown', hidden: boolean | null = null, sourceFailed = false;
    try {
      const value = source.visibilityState;
      if (value === 'visible' || value === 'hidden') state = value;
      else { sourceErrors = increment(sourceErrors); sourceFailed = true; }
    } catch { sourceErrors = increment(sourceErrors); sourceFailed = true; }
    try {
      const value = source.hidden;
      if (typeof value === 'boolean') hidden = value;
      else { sourceErrors = increment(sourceErrors); sourceFailed = true; }
    } catch { sourceErrors = increment(sourceErrors); sourceFailed = true; }
    let atMs: number | null = null;
    try {
      const value = now();
      if (typeof value === 'number' && Number.isFinite(value) && value >= 0 &&
        (lastClock === null || value >= lastClock)) { lastClock = value; atMs = value; }
      else invalidClock = increment(invalidClock);
    } catch { invalidClock = increment(invalidClock); }
    if (state === 'hidden' || hidden === true) everHidden = true;
    return { state, hidden, atMs: sourceFailed ? null : atMs };
  }
  function append(kind: RunVisibilityEvent['kind'], observed: Omit<RunVisibilityEvent, 'kind'>) {
    if (events.length < 64) events.push(Object.freeze({ kind, ...observed }));
    else dropped = increment(dropped);
  }
  const first = observe();
  const initial = first.state, initialAtMs = first.atMs;
  let final = first.state, finalAtMs = first.atMs;
  append('initial', first);
  const visibilityChanged: EventListener = () => {
    if (disposed) return;
    changes = increment(changes);
    const observed = observe(); final = observed.state; finalAtMs = observed.atMs;
    append('change', observed);
  };
  try { source.addEventListener('visibilitychange', visibilityChanged); }
  catch { sourceErrors = increment(sourceErrors); }

  function summary(): RunVisibilitySummary {
    return Object.freeze({ version: 1, clock: 'page-performance-now', initial, final, everHidden, changes,
      initialAtMs, finalAtMs, events: Object.freeze(events.map(event => Object.freeze({ ...event }))),
      dropped, invalidClock, sourceErrors, disposed });
  }
  return {
    snapshot(): RunVisibilitySummary {
      if (!disposed) { const observed = observe(); final = observed.state; finalAtMs = observed.atMs; }
      return summary();
    },
    dispose(): RunVisibilitySummary {
      if (!disposed) {
        disposed = true;
        const observed = observe(); final = observed.state; finalAtMs = observed.atMs;
        try { source.removeEventListener('visibilitychange', visibilityChanged); }
        catch { sourceErrors = increment(sourceErrors); }
      }
      return summary();
    },
  };
}
