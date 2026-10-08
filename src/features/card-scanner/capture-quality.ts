import type { Box } from "./detector";
import { emptySlotVector, isEmptySlotVector } from "./empty-slot";
import { blankNameLine } from './name-visibility';
export interface CaptureQuality {
  usable: boolean;
  reason: string;
  sharpness: number;
}
/** Geometry and image evidence only; no OCR, jewels or DB identity required. */
export function insideCard(box: Box, viewport: Box) {
  return box.width > 0 && box.height > 0 && box.x >= viewport.x && box.y >= viewport.y &&
    box.x + box.width <= viewport.x + viewport.width && box.y + box.height <= viewport.y + viewport.height;
}
export function inspectCapture(rgba: ArrayLike<number>, width: number, height: number, complete: boolean, labelVisible: boolean, aligned = true, structural = false): CaptureQuality {
  if (!complete) return { usable: false, reason: "화면 경계에서 카드 잘림", sharpness: 0 };
  if (rgba.length !== width * height * 4 || width < 2 || height < 2)
    return { usable: false, reason: "유효하지 않은 이미지", sharpness: 0 };
  const gray = (x: number, y: number) => {
    const i = (y * width + x) * 4;
    return .299 * rgba[i] + .587 * rgba[i + 1] + .114 * rgba[i + 2];
  };
  let edges = 0, samples = 0;
  // Score the name band, not colorful portrait detail. This ranks observations;
  // low scores alone never reject a legitimate softly rendered card name.
  for (let y = Math.round(height * .07); y < Math.round(height * .24); y += 2)
    for (let x = 6; x < width - 6; x += 2) {
      edges += Math.abs(gray(x, y) - gray(x - 1, y)) + Math.abs(gray(x, y) - gray(x, y - 1));
      samples++;
    }
  const sharpness = samples ? edges / samples : 0;
  if (!labelVisible && isEmptySlotVector(emptySlotVector(rgba, width, height)))
    return { usable: false, reason: "미보유 카드 뒷면 · 빈 슬롯", sharpness };
  if (blankNameLine(rgba, width, height))
    return { usable: false, reason: "이름 영역에 글자 대비 없음 · 가림 해제 후 재관측", sharpness };
  if (!labelVisible && !structural) return { usable: false, reason: "이름 영역 표시 없음 · 빈칸 또는 이동/가림", sharpness };
  if (!aligned) return { usable: false, reason: "카드 이동 중 · 온전한 관측 대기", sharpness };
  return { usable: true, reason: labelVisible ? "판독 후보" : "테두리 확인 · 원본 이름 판독 후보", sharpness };
}
function difference(a: ArrayLike<number>, b: ArrayLike<number>) {
  if (a.length !== b.length) return Infinity;
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += Math.abs(a[i] - b[i]);
  return sum / a.length;
}
/** Name, count and jewels must settle; animated portrait pixels need not.
 * Comparing the name band also prevents equal counters on different cards
 * from being mistaken for a repeated observation after scrolling. */
export function sameFieldObservation(a: Uint8Array, b: Uint8Array) {
  if (a.length !== 3240 || b.length !== 3240) return false;
  return [[0, 864], [864, 2016], [2016, 2592]].every(([from, to]) =>
    difference(a.subarray(from, to), b.subarray(from, to)) < 2.5);
}
/** A card moves vertically in its column, including when scrolling back up. */
export function settledFields(vector: Uint8Array, slot: number, previous: Uint8Array[]) {
  for (let i = slot % 10; i < previous.length; i += 10)
    if (sameFieldObservation(vector, previous[i])) return true;
  return false;
}
export function sameCapture(a: Uint8Array, b: Uint8Array) {
  if (a.length !== b.length) return false;
  if (a.length !== 3240) return difference(a, b) < 5;
  // Preserve separate name, counter/jewels and lower-field tolerances. A small
  // changed counter must not disappear into the large unchanged portrait.
  return [[0, 864, 2.5], [864, 2016, 2.5], [2016, 2592, 2.5], [2592, 3240, 5]].every(
    ([from, to, limit]) => difference(a.subarray(from, to), b.subarray(from, to)) < limit,
  );
}
/** Same-column observation groups, independent of OCR identity. */
export class CaptureObservations {
  private nextId = 0;
  private buckets = new Map<string, { id: number; vector: Uint8Array; score: number; stable: boolean }[]>();
  offer(vector: Uint8Array, column: number, score: number, stable: boolean): "new" | "better" | "duplicate" {
    return this.offerDetailed(vector, column, score, stable).decision;
  }
  offerDetailed(vector: Uint8Array, column: number, score: number, stable: boolean): { id: number; decision: "new" | "better" | "duplicate" } {
    const keys = [];
    for (let part = 0; part < 3; part++) {
      const from = Math.floor(part * vector.length / 3), to = Math.floor((part + 1) * vector.length / 3);
      let sum = 0;
      for (let i = from; i < to; i++) sum += vector[i];
      keys.push(Math.floor(sum / (to - from) / 16));
    }
    const key = `${column}/${keys.join("/")}`, bucket = this.buckets.get(key) ?? [];
    // Close images can land on opposite sides of a quantization boundary.
    // Inspect neighboring bins but still require every field to agree.
    let old: (typeof bucket)[number] | undefined;
    search: for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) for (let c = -1; c <= 1; c++) {
      old = this.buckets.get(`${column}/${keys[0]+a}/${keys[1]+b}/${keys[2]+c}`)?.find(item => sameCapture(item.vector, vector));
      if (old) break search;
    }
    if (old) {
      if ((!old.stable && stable) || (stable === old.stable && score > old.score * 1.15 + .5)) {
        old.vector = vector.slice(); old.score = score; old.stable = stable;
        return { id: old.id, decision: "better" };
      }
      return { id: old.id, decision: "duplicate" };
    }
    const id = ++this.nextId;
    bucket.push({ id, vector: vector.slice(), score, stable });
    this.buckets.set(key, bucket);
    return { id, decision: "new" };
  }
}
