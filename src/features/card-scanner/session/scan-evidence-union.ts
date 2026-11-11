/** Merge independent card-identity evidence sources without treating the
 * result as recognition truth or completion authority. The scanner and the
 * fixed-grid artwork proof can each miss different cards; this module records
 * exactly which identity came from which side. It is diagnostic/verification
 * code for offline evidence and must not be used to fill occluded fields. */
export interface EvidenceCard {
  readonly id: string;
  readonly name: string;
}
export interface ScanEvidenceUnion {
  readonly expected: number;
  readonly proofCount: number;
  readonly scannerCount: number;
  readonly unionCount: number;
  readonly missingCount: number;
  readonly excessCount: number;
  /** True only when the combined identities cover the header count. This is
   * evidence coverage, not a confirmation of fields or a successful scan. */
  readonly coversExpected: boolean;
  readonly proofOnly: readonly EvidenceCard[];
  readonly scannerOnly: readonly EvidenceCard[];
}
function cards(source: string, value: readonly EvidenceCard[]): Map<string, EvidenceCard> {
  if (!Array.isArray(value)) throw Error(`Invalid ${source} cards`);
  const result = new Map<string, EvidenceCard>();
  for (const card of value) {
    if (!card || typeof card.id !== 'string' || !card.id || typeof card.name !== 'string' || !card.name)
      throw Error(`Invalid ${source} card`);
    if (result.has(card.id)) throw Error(`Duplicate ${source} card: ${card.id}`);
    result.set(card.id, Object.freeze({ id: card.id, name: card.name }));
  }
  return result;
}
export function mergeScanEvidence(input: {
  expected: number;
  proof: readonly EvidenceCard[];
  scanner: readonly EvidenceCard[];
}): ScanEvidenceUnion {
  const { expected } = input;
  if (!Number.isSafeInteger(expected) || expected <= 0) throw Error('Invalid expected card count');
  const proof = cards('proof', input.proof);
  const scanner = cards('scanner', input.scanner);
  const ids = new Set([...proof.keys(), ...scanner.keys()]);
  for (const id of ids) {
    const a = proof.get(id), b = scanner.get(id);
    if (a && b && a.name !== b.name) throw Error(`Conflicting names for card ${id}`);
  }
  const proofOnly = [...proof.values()].filter(card => !scanner.has(card.id))
    .sort((a, b) => a.id.localeCompare(b.id));
  const scannerOnly = [...scanner.values()].filter(card => !proof.has(card.id))
    .sort((a, b) => a.id.localeCompare(b.id));
  const unionCount = ids.size;
  const missingCount = Math.max(0, expected - unionCount);
  const excessCount = Math.max(0, unionCount - expected);
  return Object.freeze({
    expected, proofCount: proof.size, scannerCount: scanner.size, unionCount,
    missingCount, excessCount, coversExpected: missingCount === 0,
    proofOnly: Object.freeze(proofOnly), scannerOnly: Object.freeze(scannerOnly),
  });
}
