import type { ScannedCard } from "./recognizer";
import type { CatalogName } from "./card-dictionary";

const collator = new Intl.Collator("ko");

/** Only an independently trusted, adjacent pair can bound a unique catalog name. */
export function confirmSortedNames(cards: ScannedCard[], observations: ScannedCard[], catalog: CatalogName[]) {
  const frames = new Map<string, Map<number, ScannedCard>>();
  for (const card of observations) {
    const p = card.capturePosition;
    if (!p?.stable || p.sort?.kind !== "name" || p.sort.direction === "unknown") continue;
    const frame = frames.get(p.frame) ?? new Map<number, ScannedCard>();
    frame.set(p.slot, card);
    frames.set(p.frame, frame);
  }
  const trusted = (card: ScannedCard) => card.manual?.includes("name") ||
    card.nameEvidence?.some(r => r.exact && r.ocrConfidence >= 70);
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
