/** Expensive OCR retries require evidence of a complete field, not colored fragments. */
export function retryEligible(input: {
  labelPixels: number; stable: boolean; borderAlignment: number;
  awakening: number | null; hasNameBand: boolean;
  blankName?: boolean; needsIdentity?: boolean;
}) {
  // Borders or jewels cannot recover text from a flat covered name line.
  // Known-card count/awakening retries still have useful work to perform.
  if (input.blankName && input.needsIdentity !== false) return false;
  if (input.borderAlignment >= .8) return true;
  return input.labelPixels >= 35 &&
    (input.stable || input.awakening !== null || input.hasNameBand);
}
