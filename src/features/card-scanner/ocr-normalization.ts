/** Normalize Unicode presentation and invisible characters, preserving real glyphs. */
export function normalizeOcrText(text: string) {
  return text.normalize("NFKC").normalize("NFC")
    .replace(/[\u200B-\u200F\u2060\uFEFF]/g, "");
}

export function normalizeNumericOcr(text: string) {
  return normalizeOcrText(text).replace(/\s/g, "");
}
