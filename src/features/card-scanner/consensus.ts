import type { ScannedCard } from "./recognizer";
import { identityFieldPool } from "./identity-fields";

/** Counts follow the latest reliable capture, not the most common historical value. */
export function consensus(observations: ScannedCard[]): ScannedCard {
  if (!observations.length) throw new Error("No observations");
  const newest = observations.map((card, index) => ({ card, index }))
    .sort((a, b) => (b.card.captureOrder ?? b.index) - (a.card.captureOrder ?? a.index) || b.index - a.index)
    .map(item => item.card);
  const fieldObservations = identityFieldPool(observations);
  const fieldNewest = newest.filter(card => fieldObservations.includes(card));
  const best = [...observations].sort(
    (a, b) => a.review.length - b.review.length || b.confidence - a.confidence,
  )[0];
  const review = best.review.filter(
    (r) => !r.includes("각성") && !r.includes("장수"),
  );
  const nameEvidence = [...new Map(observations.flatMap(card => card.nameEvidence ?? [])
    .map(reading => [reading.readingId, reading])).values()].slice(-16);
  const eligible = nameEvidence.filter(reading => reading.stable && reading.ocrConfidence >= 70 && reading.gap >= 0.15 && reading.score >= 0.83);
  const repeated = eligible.some((a, i) => eligible.slice(i + 1).some(b =>
    a.frame && b.frame && a.frame !== b.frame && a.fingerprint !== b.fingerprint && (a.rawText !== b.rawText || a.engine !== b.engine)));
  if (repeated) {
    for (let i = review.length - 1; i >= 0; i--)
      if (review[i] === "이름 확인") review.splice(i, 1);
  }
  const select = (key: "awakening" | "extraCopies", label: string) => {
    const manual = newest.find((c) => c.manual?.includes(key));
    if (manual) {
      if (manual[key] === null) review.push(`${label} 확인`);
      return manual[key];
    }
    if (key === "extraCopies") {
      const readable = fieldNewest.filter(card => card.extraCopies !== null && Number.isInteger(card.extraCopies) && card.extraCopies >= 0 && card.extraCopies <= 15);
      const latest = readable.find(card => card.countReliable !== false) ?? readable[0];
      if (!latest) { review.push(`${label} 확인`); return null; }
      if (latest.countReliable === false) review.push(`${label} 안정 관측 필요`);
      return latest.extraCopies;
    }
    const votes = new Map<number, number>();
    for (const card of fieldObservations)
      if (card[key] !== null)
        votes.set(card[key], (votes.get(card[key]) ?? 0) + 1);
    const ranked = [...votes].sort((a, b) => b[1] - a[1]);
    if (!ranked.length) {
      review.push(`${label} 확인`);
      return null;
    }
    if (
      ranked.length > 1 &&
      (ranked[0][1] < 2 || ranked[0][1] <= ranked[1][1] * 2)
    )
      review.push(`${label} 관측 충돌`);
    return ranked[0][0];
  };
  let awakening = select("awakening", "각성"),
    extraCopies = select("extraCopies", "장수");
  // Independent historical votes can combine a past awakening with a newer
  // counter that was read under a different awakening. Prefer a complete,
  // explicitly reliable observation; do not infer a compatible replacement.
  const manualFields = newest.some(card => card.manual?.some(field => field === "awakening" || field === "extraCopies"));
  const pair = manualFields ? undefined : fieldNewest.find(card =>
    card.countReliable === true && card.awakening !== null &&
    Number.isInteger(card.awakening) && card.awakening >= 0 && card.awakening <= 5 &&
    card.extraCopies !== null && Number.isInteger(card.extraCopies) && card.extraCopies >= 0 &&
    card.extraCopies <= 15 - card.awakening * (card.awakening + 1) / 2);
  if (pair) {
    awakening = pair.awakening; extraCopies = pair.extraCopies;
    for (let i = review.length - 1; i >= 0; i--)
      if (review[i].includes("각성") || review[i].includes("장수")) review.splice(i, 1);
  }
  if (
    awakening !== null &&
    extraCopies !== null &&
    extraCopies > 15 - (awakening * (awakening + 1)) / 2
  )
    review.push("각성·장수 조합 확인");
  const representative =
    fieldNewest.find(
      (c) => c.countReliable !== false &&
        c.awakening === awakening && c.extraCopies === extraCopies,
    ) ?? fieldNewest.find(
      (c) =>
        c.awakening === awakening &&
        c.extraCopies === extraCopies,
    ) ?? best;
  const manualName = newest.find((c) => c.manual?.includes("name"));
  if (manualName) {
    for (let i = review.length - 1; i >= 0; i--)
      if (review[i].includes("이름") || review[i] === "카드 식별 확인" || review[i].includes("그림 보조 식별")) review.splice(i, 1);
  }
  return {
    ...best,
    nameEvidence,
    nameConfirmedBy: repeated ? "repeat" : best.nameConfirmedBy,
    name: manualName?.name ?? best.name,
    awakening,
    extraCopies,
    review,
    countDiagnostics: representative.countDiagnostics,
    image: representative.image,
    time: representative.time,
    captureOrder: Math.max(...newest.map(card => card.captureOrder ?? 0)),
    countReliable: extraCopies !== null && (newest.some(card => card.manual?.includes("extraCopies") && card.extraCopies === extraCopies) ||
      fieldNewest.some(card => card.extraCopies === extraCopies && card.countReliable !== false)),
    manual: [...new Set(observations.flatMap((c) => c.manual ?? []))],
    observations: observations.reduce((n, c) => n + c.observations, 0),
  };
}
