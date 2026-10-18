/** Reopen exhausted, unresolved visual groups only for a fresh stable capture.
 * Holds metadata, never rasters. Pending work and exact-pixel repeats stay deduplicated. */
export class FreshObservations<T extends object> {
  private entries = new Map<number, { pixel: string; time: number; observation: T }>();
  private finished = new WeakSet<T>();
  private limit: number;
  constructor(limit = 2048) { this.limit = limit; }
  remember(group: number, pixel: string, time: number, observation: T) {
    this.entries.delete(group);
    this.entries.set(group, { pixel, time, observation });
    while (this.entries.size > this.limit) this.entries.delete(this.entries.keys().next().value!);
  }
  finish(observation: T | undefined) { if (observation) this.finished.add(observation); }
  retry(group: number, pixel: string, time: number, stable: boolean, resolved: (observation: T) => boolean) {
    const old = this.entries.get(group);
    return !!old && stable && Number.isFinite(time) && time - old.time >= .75 &&
      pixel !== old.pixel && this.finished.has(old.observation) && !resolved(old.observation);
  }
}
