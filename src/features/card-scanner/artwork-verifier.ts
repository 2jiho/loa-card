import { dictionarySimilarity, normalizeName } from "./card-dictionary";
import type { CatalogName } from "./card-dictionary";

export interface ArtworkEvidence {
  correlation: number; margin: number; visiblePrefix: string;
  mode: "prefix" | "prefix-correction" | "name-correction";
  textSimilarity: number;
  textGap?: number;
}

export function confirmArtwork(evidence: ArtworkEvidence, confidence: number) {
  if (evidence.mode === "prefix") return confidence >= .85 && evidence.textSimilarity === 1 &&
    evidence.correlation >= .9 && evidence.margin >= .12;
  if (confidence < .75) return false;
  return evidence.mode === "prefix-correction"
    ? evidence.textSimilarity >= .92 && evidence.correlation >= .94 && evidence.margin >= .12
    : (evidence.textSimilarity >= .8 && evidence.correlation >= .9 && evidence.margin >= .2) ||
      // A nearly identical portrait can corroborate a noisier label only if
      // both independent searches select the same unambiguous DB entry.
      (evidence.textSimilarity >= .75 && (evidence.textGap ?? 0) >= .15 &&
        evidence.correlation >= .97 && evidence.margin >= .12);
}

function unit(values: Float32Array) {
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  let square = 0;
  for (let i = 0; i < values.length; i++) {
    values[i] -= mean;
    square += values[i] ** 2;
  }
  if (square < 1e-6) return null;
  const length = Math.sqrt(square);
  return values.map(value => value / length);
}

/** Uses only artwork rows 8–12 of a 24×32 card. Names, counters and jewels
 * are excluded. Artwork must independently beat every catalog reference.
 */
export function createArtworkVerifier(cards: (CatalogName & { feature?: string })[]) {
  const references = cards.flatMap(card => {
    if (!card.feature) return [];
    const bytes = Uint8Array.from(atob(card.feature), c => c.charCodeAt(0));
    if (bytes.length !== 720) return [];
    const vector = unit(Float32Array.from({ length: 100 }, (_, i) => {
      const p = 120 + i * 3;
      return .299 * bytes[p] + .587 * bytes[p + 1] + .114 * bytes[p + 2];
    }));
    const registered = unit(Float32Array.from({ length: 80 }, (_, i) => {
      const p = 180 + i * 3;
      return .299 * bytes[p] + .587 * bytes[p + 1] + .114 * bytes[p + 2];
    }));
    return vector ? [{ card, vector, registered }] : [];
  });
  return (rgba: ArrayLike<number>, rawText: string, confidence: number) => {
    const query = normalizeName(rawText);
    if (rgba.length !== 24 * 32 * 4 || confidence < .75 || query.length < 3 || /[ㄱ-ㅎㅏ-ㅣᄀ-ᇿ]/u.test(rawText) ||
        cards.some(card => normalizeName(card.name) === query)) return null;
    const candidates = cards.filter(card => {
      const name = normalizeName(card.name);
      return query.length >= 4 && name.startsWith(query) && query.length / name.length >= .55;
    });
    if (candidates.length > 1) return null;
    const vector = unit(Float32Array.from({ length: 100 }, (_, i) => {
      const p = ((8 + Math.floor(i / 20)) * 24 + 2 + i % 20) * 4;
      return .299 * rgba[p] + .587 * rgba[p + 1] + .114 * rgba[p + 2];
    }));
    if (!vector || references.length < 2) return null;
    // Small geometry/resizing differences move the portrait relative to the
    // static atlas. Compare every reference under the same bounded offsets.
    // Rows 9–12 allow +/-1 without touching either name line or count/jewels.
    const aligned = [-1, 0, 1].flatMap(dy => [-1, 0, 1].flatMap(dx => {
      const query = unit(Float32Array.from({ length: 80 }, (_, i) => {
        const p = ((9 + Math.floor(i / 20) + dy) * 24 + 2 + i % 20 + dx) * 4;
        return .299 * rgba[p] + .587 * rgba[p + 1] + .114 * rgba[p + 2];
      }));
      return query ? [query] : [];
    }));
    const ranked = references.map(reference => ({ card: reference.card,
      correlation: Math.max(reference.vector.reduce((sum, value, i) => sum + value * vector[i], 0),
        ...aligned.map(query => reference.registered?.reduce((sum, value, i) => sum + value * query[i], 0) ?? -1)),
    })).sort((a, b) => b.correlation - a.correlation);
    const best = ranked[0], margin = best.correlation - ranked[1].correlation;
    let mode: ArtworkEvidence["mode"] = "prefix", textSimilarity = 1, textGap = 0;
    if (candidates.length) {
      if (best.card.id !== candidates[0].id) return null;
    } else {
      const name = normalizeName(best.card.name);
      if (query.length < name.length - 1) {
        if (query.length < 4 || query.length / name.length < .55) return null;
        textSimilarity = dictionarySimilarity(query, name.slice(0, query.length));
        // The artwork can resolve tied strokes, but cannot contradict a better text candidate.
        const bestText = Math.max(...cards.map(card => dictionarySimilarity(query, normalizeName(card.name).slice(0, query.length))));
        if (bestText - textSimilarity > .02) return null;
        mode = "prefix-correction";
      } else {
        textSimilarity = dictionarySimilarity(query, name);
        mode = "name-correction";
        const textRanked = cards.map(card => ({ id: card.id, score: dictionarySimilarity(query, card.name) }))
          .sort((a, b) => b.score - a.score);
        if (textRanked[0]?.id === best.card.id) textGap = textRanked[0].score - (textRanked[1]?.score ?? 0);
      }
    }
    const artwork = { correlation: best.correlation, margin, visiblePrefix: rawText, mode, textSimilarity, textGap };
    if (!confirmArtwork(artwork, confidence)) return null;
    const score = dictionarySimilarity(rawText, best.card.name);
    return { card: best.card, score, exact: false, gap: 0,
      artwork };
  };
}
