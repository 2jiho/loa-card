import type { ScannedCard } from "./recognizer-types";
import { catalogNameAmbiguityIndex, exactNameCompetitors, normalizeName } from "./card-dictionary";
import type { CatalogName } from "./card-dictionary";
import { confirmCatalogName } from "./name-confidence";

const collator = new Intl.Collator("ko");

/** Only an independently trusted, adjacent pair can bound a unique catalog name. */
export function confirmSortedNames(cards: ScannedCard[], observations: ScannedCard[], catalog: CatalogName[]) {
  if (!cards.some(card => card.review.includes("이름 확인"))) return cards.slice();
  const nameIndex = catalogNameAmbiguityIndex(catalog);
  const byId = new Map(catalog.map(card => [card.id, card]));
  const frames = new Map<string, Map<number, ScannedCard>>();
  for (const card of observations) {
    const p = card.capturePosition;
    if (!p?.stable || p.sort?.kind !== "name" || p.sort.direction === "unknown") continue;
    const frame = frames.get(p.frame) ?? new Map<number, ScannedCard>();
    frame.set(p.slot, card);
    frames.set(p.frame, frame);
  }
  const trusted = (card: ScannedCard) => {
    if (card.manual?.includes("name")) return true;
    const known = byId.get(card.id);
    if (!known || card.name !== known.name || card.review.includes("이름 확인")) return false;
    return card.nameEvidence?.some(reading => {
      const visible = normalizeName(reading.rawText);
      const matches = [known.name, ...(known.aliases ?? [])].some(name => normalizeName(name) === visible);
      if (!reading.exact || reading.ocrConfidence < 70 || !matches) return false;
      // Old replay evidence has no ambiguity flag. Recompute from the current
      // complete catalog before treating that text as an independent anchor.
      const nameAmbiguous = reading.nameAmbiguous === true ||
        exactNameCompetitors(nameIndex, known.id, visible).length > 0;
      return confirmCatalogName({...reading, nameAmbiguous, card: known}, false);
    });
  };
  const confirmed = new Set<string>();
  for (const frame of frames.values()) {
    for (const [slot, card] of frame) {
      if (!card.review.includes("이름 확인")) continue;
      const before = frame.get(slot - 1), after = frame.get(slot + 1);
      if (!before || !after || !trusted(before) || !trusted(after)) continue;
      const direction = card.capturePosition!.sort!.direction;
      if (before.capturePosition!.sort!.direction !== direction || after.capturePosition!.sort!.direction !== direction) continue;
      const sign = direction === "asc" ? 1 : -1;
      const candidates = catalog.filter(c =>
        sign * collator.compare(before.name, c.name) < 0 &&
        sign * collator.compare(c.name, after.name) < 0);
      if (candidates.length === 1 && candidates[0].id === card.id &&
        card.nameEvidence?.some(r => r.ocrConfidence >= 50 && r.score >= 0.83)) confirmed.add(card.id);
    }
  }
  return cards.map(card => confirmed.has(card.id) ? {
    ...card, nameConfirmedBy: "sort" as const,
    review: card.review.filter(reason => reason !== "이름 확인"),
  } : card);
}
