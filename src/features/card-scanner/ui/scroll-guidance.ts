/** Scroll geometry is a hint, not evidence of a missing identity. Keep it
 * informational until processing ends, and hide it once this run is complete. */
export function scrollGuidance(input: {
  gaps: number; busy: boolean; expected: number | null; collected: number;
  autoStopped?: boolean; recoverySkipped?: boolean;
}): 'collecting' | 'rescan' | null {
  if (!input.gaps || input.autoStopped || input.recoverySkipped) return null;
  const knownTotal = input.expected !== null && Number.isInteger(input.expected) && input.expected > 0;
  if (knownTotal && input.collected >= input.expected!) return null;
  if (input.busy) return 'collecting';
  return knownTotal && input.collected < input.expected! ? 'rescan' : null;
}
