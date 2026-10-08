import { normalizeNumericOcr } from "./ocr-normalization";
/** Reject incomplete OCR strings instead of filling missing digits. */
export function parseInventoryTotal(text: string) {
  const match = /^(\d+)\/(\d+)$/.exec(normalizeNumericOcr(text).replace(/[()]/g, ""));
  if (!match) return null;
  const owned = Number(match[1]),
    capacity = Number(match[2]);
  return owned > 0 && owned <= capacity && capacity <= 2000
    ? { owned, capacity }
    : null;
}
export function parseExtraCopies(text: string, maximum = 15) {
  const match = /^\+(\d{1,2})$/.exec(normalizeNumericOcr(text));
  if (!match) return null;
  const count = Number(match[1]);
  return count >= 1 && count <= maximum ? count : null;
}
