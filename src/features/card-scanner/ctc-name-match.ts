import { dictionarySimilarity, normalizeName } from "./card-dictionary";
import type { CatalogName } from "./card-dictionary";
import type { NeuralReading } from "./neural-reader";

/** A lexicon winner alone is insufficient: retain visible text and reject ties,
 * weak glyphs, truncated names and unsupported completions.
 */
export function matchCtcCardName(reading: NeuralReading, cards: CatalogName[]) {
  const best = reading.candidates?.[0];
  if (!best || reading.confidence < .6 || best.relativeLikelihood < .85 || best.margin < .9) return null;
  const query = normalizeName(reading.text);
  if (query.length < 2 || cards.some(card => normalizeName(card.name).startsWith(query))) return null;
  const card = cards.find(card => card.id === best.id);
  if (!card || card.name !== best.name) return null;
  const score = dictionarySimilarity(reading.text, card.name);
  if (score < .8) return null;
  const other = cards.filter(c => c.id !== card.id)
    .reduce((value, c) => Math.max(value, dictionarySimilarity(reading.text, c.name)), 0);
  return { card, score, gap: score-other, exact: false,
    ctc: { relativeLikelihood: best.relativeLikelihood, margin: best.margin },
  };
}
