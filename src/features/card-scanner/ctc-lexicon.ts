import { normalizeName } from "./card-dictionary";

export interface LexiconEntry { id: string; name: string }
export interface LexiconCandidate extends LexiconEntry {
  relativeLikelihood: number;
  margin: number;
}
function logAdd(a: number, b: number) {
  if (a === -Infinity) return b;
  if (b === -Infinity) return a;
  return Math.max(a, b) + Math.log1p(Math.exp(-Math.abs(a - b)));
}

/** Sum every CTC alignment of a complete name; do not complete a visible prefix.
 * The two spellings support composed Hangul and the model's decomposed jamo.
 * Scores are evidence ratios, not calibrated probabilities of correct identity.
 */
export function createCtcLexicon(characters: string[], entries: LexiconEntry[]) {
  const symbols = characters.map((c, index) => index === 0 ? "" :
    c.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]/gu, ""));
  const classes = new Map<string, number[]>();
  symbols.forEach((s, i) => { const indices = classes.get(s) ?? []; indices.push(i); classes.set(s, indices); });
  const names = entries.map(entry => ({
    ...entry, normalized: normalizeName(entry.name),
    variants: [...new Set([normalizeName(entry.name), normalizeName(entry.name).normalize("NFD")])]
      .map(text => Array.from(text)).filter(tokens => tokens.every(token => classes.has(token))),
  })).filter(entry => entry.normalized.length && entry.variants.length);
  const used = [...new Set(["", ...names.flatMap(entry => entry.variants.flat())])];
  const index = new Map(used.map((symbol, i) => [symbol, i]));
  const compiled = names.map(entry => ({ ...entry,
    variants: entry.variants.map(tokens => tokens.map(token => index.get(token)!)),
  }));
  return (probabilities: Float32Array, steps: number, greedyText: string) => {
    if (probabilities.length !== steps * characters.length)
      throw new Error("OCR 문자표와 모델 출력이 맞지 않습니다.");
    const query = normalizeName(greedyText);
    if (query.length < 2 || compiled.some(entry => entry.normalized === query)) return [];
    // A cut-off line is not evidence for the unseen rest of a longer name.
    if (compiled.some(entry => entry.normalized.startsWith(query))) return [];
    const emissions = new Float64Array(steps * used.length);
    let greedyLog = 0;
    for (let t = 0; t < steps; t++) {
      const offset = t * characters.length;
      let best = 0;
      for (let c = 0; c < characters.length; c++) {
        const p = probabilities[offset+c];
        if (Number.isFinite(p) && p > best) best = p;
      }
      if (!best) return [];
      greedyLog += Math.log(best);
      for (let s = 0; s < used.length; s++) {
        let sum = 0;
        for (const c of classes.get(used[s])!) {
          const p = probabilities[offset+c];
          if (Number.isFinite(p) && p > 0) sum += p;
        }
        emissions[t*used.length+s] = sum > 0 ? Math.log(sum) : -Infinity;
      }
    }
    const ranked = compiled.filter(entry => Math.abs(entry.normalized.length-query.length) <= Math.max(1, Math.floor(query.length*.2)))
      .map(entry => {
        let likelihood = -Infinity;
        for (const tokens of entry.variants) {
          const states = new Int32Array(tokens.length*2+1);
          tokens.forEach((token, i) => states[i*2+1] = token);
          let previous = new Float64Array(states.length).fill(-Infinity);
          previous[0] = 0;
          for (let t = 0; t < steps; t++) {
            const next = new Float64Array(states.length).fill(-Infinity);
            for (let s = 0; s < states.length; s++) {
              let value = logAdd(previous[s], s > 0 ? previous[s-1] : -Infinity);
              if (s > 1 && states[s] !== 0 && states[s] !== states[s-2]) value = logAdd(value, previous[s-2]);
              next[s] = value + emissions[t*used.length+states[s]];
            }
            previous = next;
          }
          likelihood = Math.max(likelihood, logAdd(previous[states.length-1], previous[states.length-2]));
        }
        return { id: entry.id, name: entry.name, likelihood,
          relativeLikelihood: Math.min(1, Math.exp((likelihood-greedyLog)/Math.max(1, entry.normalized.length))),
        };
      }).filter(candidate => Number.isFinite(candidate.likelihood))
      .sort((a, b) => b.likelihood-a.likelihood);
    return ranked.slice(0, 3).map((candidate, i): LexiconCandidate => ({
      id: candidate.id, name: candidate.name, relativeLikelihood: candidate.relativeLikelihood,
      margin: i === 0 ? 1-Math.exp((ranked[1]?.likelihood ?? -Infinity)-candidate.likelihood) : 0,
    }));
  };
}

/** A forced blank at the seam preserves repeated letters across two UI lines. */
export function joinCtcLines(first: Float32Array, second: Float32Array, classes: number) {
  if (classes < 1 || first.length % classes || second.length % classes) throw new Error("OCR 줄 출력이 맞지 않습니다.");
  const joined = new Float32Array(first.length+classes+second.length);
  joined.set(first);
  joined[first.length] = 1;
  joined.set(second, first.length+classes);
  return joined;
}
