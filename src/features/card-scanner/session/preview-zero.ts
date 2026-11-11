/** Which stored preview may confirm "no extra copies" for a card at the end of a scan.
 *
 * Previews are given in the order they should be preferred. A preview that shows an empty
 * counter is accepted only when no LATER capture of the same card showed a counter with a
 * positive count: a later observation overrides an earlier one, never the reverse. */
export interface PreviewCountReading {
  /** Capture order of the preview (larger is later). */
  readonly order:number;
  /** The preview shows an explicit empty counter. */
  readonly zero:boolean;
  /** The preview shows a counter icon with a positive count. */
  readonly positive:boolean;
}

/** Index of the preview to accept, or -1 when none may confirm zero. */
export function selectZeroPreview(readings:readonly PreviewCountReading[]):number {
  let latestPositive=-Infinity;
  for(const reading of readings)if(reading.positive&&reading.order>latestPositive)latestPositive=reading.order;
  return readings.findIndex(reading=>reading.zero&&reading.order>=latestPositive);
}
