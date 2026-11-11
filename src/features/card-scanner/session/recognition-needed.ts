/** A bounded, presentation-only list of slots whose only captures were
 * positively obstructed by a tooltip or cursor. It never supplies a card
 * identity or a field value, and clearing it requires a later usable capture
 * of the same slot. */
export interface RecognitionNeededSlot {
  slot: number;
  captureTime: number;
  reason: string;
  /** Seeded from an explicit case/frame target. A later clean capture of the
   * same slot may be a different card and cannot clear this warning. */
  pinned?: true;
}

const MAX_REASON = 200;

function validSlot(slot: unknown): slot is number {
  return Number.isSafeInteger(slot) && Number(slot) >= 0 && Number(slot) < 40;
}
function validTime(time: unknown): time is number {
  return typeof time === 'number' && Number.isFinite(time) && time >= 0;
}
function boundedReason(reason: unknown): string | null {
  if (typeof reason !== 'string') return null;
  const value = reason.trim().slice(0, MAX_REASON);
  return value.length ? value : null;
}

/** Record the newest positive obstruction for a slot. Invalid diagnostics are
 * ignored: a malformed reason never creates a UI warning. */
export function recordRecognitionNeeded(
  target: Map<number, RecognitionNeededSlot>,
  slot: number,
  captureTime: number,
  reason: string,
  pinned = false,
): void {
  if (!validSlot(slot) || !validTime(captureTime)) return;
  const bounded = boundedReason(reason);
  if (!bounded) return;
  const previous = target.get(slot);
  if (previous && previous.captureTime > captureTime) return;
  target.set(slot, Object.freeze({slot, captureTime, reason: bounded, ...(pinned ? {pinned: true as const} : {})}));
}

/** A later usable capture (or a confirmed empty slot) clears the warning.
 * An older completion cannot erase a newer obstruction. */
export function clearRecognitionNeeded(
  target: Map<number, RecognitionNeededSlot>,
  slot: number,
  captureTime: number,
): void {
  if (!validSlot(slot) || !validTime(captureTime)) return;
  const previous = target.get(slot);
  if (previous?.pinned) return;
  if (previous && previous.captureTime > captureTime) return;
  target.delete(slot);
}

/** Deterministic snapshot for the UI and final status. */
export function recognitionNeededSlots(target: ReadonlyMap<number, RecognitionNeededSlot>): RecognitionNeededSlot[] {
  return [...target.values()].sort((a, b) => a.slot - b.slot);
}

/** Slots are positions in the most recently captured 4x10 screen, not stable
 * inventory rows. The label says so instead of implying a card identity. */
export function recognitionNeededSlotLabel(slot: number): string {
  if (!validSlot(slot)) return '위치 확인 불가';
  return `최근 화면 ${Math.floor(slot / 10) + 1}행 ${slot % 10 + 1}열`;
}
