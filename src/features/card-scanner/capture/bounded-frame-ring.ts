/** A tiny bounded ring for frames that may be re-cropped after a failed
 * reading. It owns no recognition policy: it only keeps the most recent
 * `limit` frames and their opaque metadata. Reusing a slot drops the previous
 * frame binding, so old pixels can never be mistaken for a newer frame. */
export interface RetainedFrame<T, M> {
  readonly frame: T;
  readonly frameId: number;
  readonly meta: M;
}
interface Slot<T, M> {
  frame: T;
  frameId: number | null;
  meta: M | null;
  used: number;
}
export class BoundedFrameRing<T, M> {
  private readonly slots: Slot<T, M>[] = [];
  private readonly limit: number;
  private readonly create: () => T;
  private readonly resize: (frame: T, width: number, height: number) => void;
  private cursor = 0;
  private sequence = 0;
  constructor(limit: number, create: () => T, resize: (frame: T, width: number, height: number) => void) {
    if (!Number.isSafeInteger(limit) || limit <= 0) throw new RangeError('Invalid frame ring limit');
    this.limit = limit;
    this.create = create;
    this.resize = resize;
  }
  get capacity() { return this.limit; }
  get size() { return this.slots.filter(slot => slot.frameId !== null).length; }
  /** Returns the next slot's frame, dropping any previous binding first. */
  next(width: number, height: number): T {
    if (!Number.isSafeInteger(width) || width <= 0 || !Number.isSafeInteger(height) || height <= 0)
      throw new RangeError('Invalid frame dimensions');
    const index = this.cursor % this.limit;
    this.cursor++;
    let slot = this.slots[index];
    if (!slot) {
      slot = { frame: this.create(), frameId: null, meta: null, used: 0 };
      this.slots.push(slot);
    }
    slot.frameId = null;
    slot.meta = null;
    slot.used = ++this.sequence;
    this.resize(slot.frame, width, height);
    return slot.frame;
  }
  /** Binds an already-returned frame to a source frame ID. A repeated ID is
   * moved to this frame instead of leaving an older slot queryable. */
  bind(frame: T, frameId: number, meta: M): void {
    if (!Number.isSafeInteger(frameId) || frameId < 0) throw new RangeError('Invalid frame ID');
    for (const slot of this.slots) if (slot.frame !== frame && slot.frameId === frameId) {
      slot.frameId = null;
      slot.meta = null;
    }
    const slot = this.slots.find(candidate => candidate.frame === frame);
    if (!slot) throw Error('Frame does not belong to this ring');
    slot.frameId = frameId;
    slot.meta = meta;
    slot.used = ++this.sequence;
  }
  find(frameId: number): RetainedFrame<T, M> | undefined {
    if (!Number.isSafeInteger(frameId)) return;
    const slot = this.slots.find(candidate => candidate.frameId === frameId && candidate.meta !== null);
    return slot ? { frame: slot.frame, frameId, meta: slot.meta as M } : undefined;
  }
  /** Newest first. */
  entries(): readonly RetainedFrame<T, M>[] {
    return this.slots.filter(slot => slot.frameId !== null && slot.meta !== null)
      .sort((a, b) => b.used - a.used)
      .map(slot => ({ frame: slot.frame, frameId: slot.frameId as number, meta: slot.meta as M }));
  }
  clear(): void {
    this.slots.length = 0;
    this.cursor = 0;
  }
}
