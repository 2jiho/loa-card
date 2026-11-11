/** Evidence-only rescue for an unidentified observation. It re-crops one
 * fixed grid slot and runs the existing portrait matcher, but it never calls
 * inventory, name confirmation or completion. A match here is a diagnostic
 * candidate; only the normal reading path may establish card identity. */
export interface FixedGridRescueMatch {
  readonly id: string;
  readonly name: string;
  readonly correlation: number;
  readonly margin: number;
}
export interface FixedGridRescueFrame {
  readonly frameId: number;
  readonly captureTime: number;
  readonly grayFor: (slot: number) => ArrayLike<number> | null;
}
export interface FixedGridRescueEvidence extends FixedGridRescueMatch {
  readonly source: 'retained-frame' | 'observation-feature' | 'canonical-row';
  readonly frameId: number;
  readonly captureTime: number;
  readonly slot: number;
}
export interface FixedGridRescueResult {
  readonly frameCount: number;
  readonly unavailable: boolean;
  readonly evidence: readonly FixedGridRescueEvidence[];
}
export interface FixedGridRescueRecord {
  readonly version: 1;
  readonly group: number;
  readonly order: number;
  readonly slot: number;
  readonly captureTime: number;
  readonly pending: boolean;
  readonly frameCount: number;
  readonly unavailable: boolean;
  readonly evidence: readonly FixedGridRescueEvidence[];
}
export interface FixedGridRescueState {
  readonly version: 1;
  readonly attempted: number;
  readonly matched: number;
  readonly unavailable: number;
  readonly records: readonly FixedGridRescueRecord[];
}
export const FIXED_GRID_RESCUE_MAX_RECORDS = 32;
export const FIXED_GRID_RESCUE_MAX_FRAMES = 8;
/** video-7 scanner calibration. The game viewport keeps these boxes fixed while
 * cards scroll inside them. Other resolutions must use their own layout. */
export const FIXED_GRID_COLUMNS = [138,295,453,610,767,924,1081,1239,1396,1553] as const;
export const FIXED_GRID_ROWS = [392,635,878,1121] as const;
export const FIXED_GRID_CARD_WIDTH = 140;
export const FIXED_GRID_CARD_HEIGHT = 210;
export function fixedGridCell(slot:number){
  if (!Number.isSafeInteger(slot) || slot < 0 || slot >= 40) return null;
  return Object.freeze({ x: FIXED_GRID_COLUMNS[slot % 10], y: FIXED_GRID_ROWS[Math.floor(slot / 10)],
    width: FIXED_GRID_CARD_WIDTH, height: FIXED_GRID_CARD_HEIGHT });
}
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
/** Runs only the portrait matcher on the requested slot. The caller decides
 * which retained frames are in range; validation here keeps malformed
 * diagnostics out of the result. */
export function rescueFixedRowSlot(input: {
  slot: number;
  captureTime: number;
  source: FixedGridRescueEvidence['source'];
  frames: readonly FixedGridRescueFrame[];
  match: (gray: ArrayLike<number>) => FixedGridRescueMatch | null;
  maxTimeDistanceSeconds?: number;
}): FixedGridRescueResult {
  if (!Number.isSafeInteger(input.slot) || input.slot < 0 || input.slot >= 40) throw new RangeError('Invalid rescue slot');
  if (!finite(input.captureTime) || input.captureTime < 0) throw new RangeError('Invalid rescue capture time');
  if (input.source !== 'retained-frame' && input.source !== 'observation-feature' && input.source !== 'canonical-row')
    throw new RangeError('Invalid rescue source');
  const maxDistance = input.maxTimeDistanceSeconds ?? .5;
  if (!finite(maxDistance) || maxDistance <= 0) throw new RangeError('Invalid rescue time window');
  if (!Array.isArray(input.frames)) throw Error('Invalid rescue frames');
  const frames = input.frames.slice(0, FIXED_GRID_RESCUE_MAX_FRAMES)
    .filter(frame => frame && Number.isSafeInteger(frame.frameId) && frame.frameId >= 0 &&
      finite(frame.captureTime) && Math.abs(frame.captureTime - input.captureTime) <= maxDistance);
  const evidence: FixedGridRescueEvidence[] = [];
  for (const frame of frames) {
    let gray: ArrayLike<number> | null;
    try { gray = frame.grayFor(input.slot); } catch { continue; }
    if (!gray) continue;
    let match: FixedGridRescueMatch | null;
    try { match = input.match(gray); } catch { continue; }
    if (!match || typeof match.id !== 'string' || !match.id || typeof match.name !== 'string' ||
      !finite(match.correlation) || !finite(match.margin)) continue;
    evidence.push(Object.freeze({ source: input.source, frameId: frame.frameId,
      captureTime: frame.captureTime, slot: input.slot, id: match.id, name: match.name,
      correlation: match.correlation, margin: match.margin }));
  }
  evidence.sort((a, b) => b.correlation - a.correlation || a.frameId - b.frameId);
  return Object.freeze({ frameCount: frames.length, unavailable: frames.length === 0,
    evidence: Object.freeze(evidence) });
}
export interface FixedGridRescueConfirmation {
  readonly id: string;
  readonly name: string;
  readonly correlation: number;
  readonly margin: number;
  readonly evidence: readonly FixedGridRescueEvidence[];
}
/** Promotes rescue evidence to an identity only when two distinct frames agree
 * on one card, no competing ID exists, the standard portrait gates pass, and
 * the card is not already in the inventory. The caller must still read fields
 * and keep the result reviewable. */
export function confirmFixedGridRescue(input: {
  slot: number;
  captureTime: number;
  records: readonly FixedGridRescueRecord[];
  existingIds: ReadonlySet<string>;
  minDistinctFrames?: number;
  maxTimeDistanceSeconds?: number;
  minCorrelation?: number;
  minMargin?: number;
}): FixedGridRescueConfirmation | null {
  if (!Number.isSafeInteger(input.slot) || input.slot < 0 || input.slot >= 40) throw new RangeError('Invalid rescue slot');
  if (!finite(input.captureTime) || input.captureTime < 0) throw new RangeError('Invalid rescue capture time');
  if (!Array.isArray(input.records)) throw Error('Invalid rescue records');
  if (!input.existingIds || typeof input.existingIds.has !== 'function') throw Error('Invalid existing identities');
  const minFrames = input.minDistinctFrames ?? 2, maxDistance = input.maxTimeDistanceSeconds ?? .5;
  const minCorrelation = input.minCorrelation ?? .94, minMargin = input.minMargin ?? .2;
  if (!Number.isSafeInteger(minFrames) || minFrames < 2) throw new RangeError('Invalid rescue frame agreement');
  if (!finite(maxDistance) || maxDistance <= 0) throw new RangeError('Invalid rescue time window');
  if (!finite(minCorrelation) || !finite(minMargin)) throw new RangeError('Invalid rescue gates');
  const evidence: FixedGridRescueEvidence[] = [];
  for (const record of input.records) {
    if (!record || record.slot !== input.slot || !finite(record.captureTime) ||
      Math.abs(record.captureTime - input.captureTime) > maxDistance) continue;
    for (const item of record.evidence) {
      if (!item || item.slot !== input.slot || !finite(item.captureTime) ||
        Math.abs(item.captureTime - input.captureTime) > maxDistance) continue;
      evidence.push(item);
    }
  }
  if (!evidence.length) return null;
  const ids = new Set(evidence.map(item => item.id));
  if (ids.size !== 1) return null;
  const best = evidence.slice().sort((a, b) => b.correlation - a.correlation || b.margin - a.margin)[0];
  if (input.existingIds.has(best.id)) return null;
  if (new Set(evidence.map(item => item.frameId)).size < minFrames) return null;
  if (best.correlation < minCorrelation || best.margin < minMargin) return null;
  return Object.freeze({ id: best.id, name: best.name, correlation: best.correlation, margin: best.margin,
    evidence: Object.freeze(evidence) });
}
/** Appends bounded diagnostic evidence. The returned object contains only
 * rescue counters and records; it cannot replace a card or unknown entry. */
export function appendFixedGridRescue(current: FixedGridRescueState | undefined,
  record: FixedGridRescueRecord, limit = FIXED_GRID_RESCUE_MAX_RECORDS): FixedGridRescueState {
  if (!Number.isSafeInteger(limit) || limit <= 0) throw new RangeError('Invalid rescue record limit');
  const previous = current?.version === 1 ? current : undefined;
  const safeRecord = Object.freeze({ ...record,
    evidence: Object.freeze(record.evidence.slice(0, FIXED_GRID_RESCUE_MAX_FRAMES)) });
  const records = [...(previous?.records ?? []), safeRecord].slice(-limit);
  return Object.freeze({
    version: 1,
    attempted: (previous?.attempted ?? 0) + 1,
    matched: (previous?.matched ?? 0) + (safeRecord.evidence.length ? 1 : 0),
    unavailable: (previous?.unavailable ?? 0) + (safeRecord.unavailable ? 1 : 0),
    records: Object.freeze(records),
  });
}
/** Display-only hint: a rescue observation whose evidence matches one
 * already-collected card is likely the same card seen again. The caller can
 * require more independent frames for stronger wording. It does not reduce the
 * unidentified count, change a card, or prove collection. */
export function duplicateRescueObservationCount(records: readonly FixedGridRescueRecord[],
  existingIds: ReadonlySet<string>, minDistinctFrames = 2): number {
  if (!Array.isArray(records) || !existingIds || typeof existingIds.has !== 'function') return 0;
  if (!Number.isSafeInteger(minDistinctFrames) || minDistinctFrames < 1) return 0;
  let count = 0;
  for (const record of records) {
    const evidence = record?.evidence;
    if (!Array.isArray(evidence) || !evidence.length) continue;
    const ids = new Set<string>(), frames = new Set<number>();
    let valid = true;
    for (const item of evidence) {
      if (!item || typeof item.id !== 'string' || !item.id ||
        !Number.isSafeInteger(item.frameId) || item.frameId < 0) { valid = false; break; }
      ids.add(item.id);
      frames.add(item.frameId);
    }
    if (!valid || ids.size !== 1 || frames.size < minDistinctFrames) continue;
    const best = evidence.reduce((a, b) => b.correlation > a.correlation ? b : a);
    if (best.correlation < .94 || best.margin < .2) continue;
    if (existingIds.has(ids.values().next().value!)) count++;
  }
  return count;
}
