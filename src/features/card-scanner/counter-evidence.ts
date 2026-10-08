import { normalizeNumericOcr } from "./ocr-normalization";
export interface CounterReading {
  engine: "neural" | "tesseract";
  variant: string;
  text: string;
  confidence: number;
}

/** Normalize surrounding OCR punctuation, never join separate digit groups. */
export function parseCounterEvidence(text: string, maximum: number) {
  const match = /^[([]?([+±]?)\.?([0-9]{1,2})\.?[,;:]?[)\]]?-?$/.exec(normalizeNumericOcr(text));
  if (!match) return null;
  const value = Number(match[2]);
  return value >= 1 && value <= maximum ? { value, plus: match[1] === "+" } : null;
}

export function confirmCounter(readings: CounterReading[], maximum: number): number | null {
  const usable = readings.map(r => ({ ...r, parsed: parseCounterEvidence(r.text, maximum) }));
  const neural = usable.filter(r => r.engine === "neural" && r.confidence >= 70 && r.parsed !== null);
  const values = new Set(neural.map(r => r.parsed!.value));
  // A valid conflicting number stays unresolved, rather than being majority-voted.
  if (values.size !== 1) return null;
  const value = neural[0].parsed!.value;
  const neuralVariants = new Set(neural.map(r => r.variant));
  const marked = neural.filter(r => r.parsed!.plus);
  if (neuralVariants.size >= 2 && new Set(marked.map(r => r.variant)).size >= 2 && Math.max(...neural.map(r => r.confidence)) >= 90) return value;
  const supporting = usable.filter(r => r.engine === "tesseract" && r.parsed?.plus && r.parsed.value === value && r.confidence >= 60);
  if (supporting.some(r => r.confidence >= 85)) return value;
  // Moderate neural agreement needs a second OCR engine, not threshold variants.
  if (neuralVariants.size >= 2 && new Set(marked.map(r => r.variant)).size >= 2 && supporting.length) return value;
  if (new Set(supporting.filter(r => !r.variant.startsWith("threshold")).map(r => r.variant)).size >= 2) return value;
  return null;
}
