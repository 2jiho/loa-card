/** Browser monotonic clock behind a named helper. Event handlers use it for
 * arrival/deadline timestamps; it is not a render-time value. */
export function monotonicNow(){return performance.now();}
