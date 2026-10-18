import { normalizeNumericOcr, normalizeOcrText } from "./ocr-normalization";
export type SortKind = "name" | "default" | "rarity" | "owned" | "awakening";
export interface CardSort {
  kind: SortKind;
  direction: "asc" | "desc" | "unknown";
}
/** A missing arrow is not a direction change. Learning a previously unknown
 * direction also does not invalidate positions captured under the same sort. */
export function reconcileCardSort(current:CardSort|null,next:CardSort|null):{sort:CardSort|null;changed:boolean} {
  if(!next)return {sort:current,changed:false};
  if(!current)return {sort:next,changed:false};
  if(current.kind!==next.kind)return {sort:next,changed:true};
  if(next.direction==='unknown')return {sort:current,changed:false};
  return {sort:next,changed:current.direction!=='unknown'&&current.direction!==next.direction};
}
export function parseGrowthPoints(text: string) {
  const match = /^(\d+)\/(\d+)$/.exec(normalizeNumericOcr(text).replace(/[,()]/g, ""));
  if (!match) return null;
  const current = Number(match[1]),
    maximum = Number(match[2]);
  return Number.isSafeInteger(current) &&
    current >= 0 &&
    current <= maximum &&
    maximum <= 999999999
    ? { current, maximum }
    : null;
}
export function parseCardSort(text: string): CardSort | null {
  const label = normalizeOcrText(text).replace(/\s/g, "");
  const kinds: Record<string, SortKind> = {
    이름순: "name",
    이름역순: "name",
    기본정렬: "default",
    기본순: "default",
    등급순: "rarity",
    보유순: "owned",
    각성단계순: "awakening",
  };
  const kind = kinds[label];
  return kind
    ? { kind, direction: label === "이름역순" ? "desc" : "unknown" }
    : null;
}
/** The arrow describes direction separately from the sort label. */
export function readSortArrow(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
): CardSort["direction"] {
  const rows = new Map<number, number>();
  for (let y = 3; y < height - 3; y++)
    for (let x = 3; x < width - 3; x++) {
      const i = (y * width + x) * 4,
        r = rgba[i],
        g = rgba[i + 1],
        b = rgba[i + 2];
      if (r > 140 && g > 110 && r > g * 1.04 && g > b * 1.15)
        rows.set(y, (rows.get(y) ?? 0) + 1);
    }
  const active = [...rows].filter(([, n]) => n >= 2);
  if (active.length < 4) return "unknown";
  const split = Math.floor(active.length / 2),
    top = active.slice(0, split),
    bottom = active.slice(-split);
  const mean = (a: [number, number][]) =>
    a.reduce((n, [, v]) => n + v, 0) / a.length;
  if (Math.abs(mean(top) - mean(bottom)) < 2) return "unknown";
  return mean(bottom) > mean(top) ? "asc" : "desc";
}
