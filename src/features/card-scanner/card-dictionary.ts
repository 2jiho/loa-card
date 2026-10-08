import { normalizeOcrText } from "./ocr-normalization";
export interface CatalogName {
  id: string;
  name: string;
  rarity: number;
  maxAwakening?: number;
  aliases?: string[];
}
export function normalizeName(text: string) {
  return normalizeOcrText(text)
    .replace(/[^가-힣A-Za-z0-9]/g, "")
    .toLowerCase();
}
function syllables(text: string) {
  const result: number[] = [];
  for (const character of normalizeName(text)) {
    const value = character.charCodeAt(0) - 0xac00;
    if (value >= 0 && value < 11172)
      result.push(
        0x1100 + Math.floor(value / 588),
        0x1161 + Math.floor((value % 588) / 28),
        0x11a7 + (value % 28),
      );
    else result.push(character.charCodeAt(0));
  }
  return result;
}
export function dictionarySimilarity(a: string, b: string) {
  const left = syllables(a),
    right = syllables(b);
  if (!left.length || !right.length) return 0;
  let row = right.map((_, i) => i + 1);
  row.unshift(0);
  for (let i = 0; i < left.length; i++) {
    const next = [i + 1];
    for (let j = 0; j < right.length; j++)
      next.push(
        Math.min(
          next[j] + 1,
          row[j + 1] + 1,
          row[j] + (left[i] === right[j] ? 0 : 1),
        ),
      );
    row = next;
  }
  return 1 - row[right.length] / Math.max(left.length, right.length);
}
/** A closed vocabulary corrects small OCR errors, but never fills a missing suffix. */
export function matchCardName(text: string, cards: CatalogName[]) {
  const query = normalizeName(text);
  const exact = cards.filter((c) => normalizeName(c.name) === query || c.aliases?.some(alias => normalizeName(alias) === query));
  if (exact.length === 1)
    return { card: exact[0], score: 1, gap: 1, exact: true };
  if (query.length < 2) return null;
  if (cards.some((c) => normalizeName(c.name).startsWith(query))) return null;
  const scores = cards
    .filter(
      (c) =>
        Math.abs(normalizeName(c.name).length - query.length) <=
        Math.max(1, Math.floor(query.length * 0.2)),
    )
    .map((card) => ({ card, score: dictionarySimilarity(text, card.name) }))
    .sort((a, b) => b.score - a.score);
  const best = scores[0];
  const minimum = query.length === 2 ? 0.83 : query.length === 3 ? 0.88 : 0.84;
  const gap = best ? best.score - (scores[1]?.score ?? 0) : 0;
  return best &&
    best.score >= minimum &&
    gap >= (query.length === 2 ? 0.15 : 0.09)
    ? { ...best, gap, exact: false }
    : null;
}
