import { readFile, writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { decodeCtc } from "../src/features/card-scanner/ctc-decoder.ts";
import { createCtcLexicon, joinCtcLines } from "../src/features/card-scanner/ctc-lexicon.ts";
import { matchCardName } from "../src/features/card-scanner/card-dictionary.ts";
import { matchCtcCardName } from "../src/features/card-scanner/ctc-name-match.ts";

const json = async path => JSON.parse(await readFile(path, "utf8"));
const characters = await json("public/scanner/paddle-characters.json");
const { cards } = await json("public/scanner/cards.json");
const score = createCtcLexicon(characters, cards);
const results = [];
const firstLines = new Map();
for (const probe of await json("work/ctc-probes/manifest.json")) {
  const bytes = await readFile(probe.path);
  const probabilities = new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset+bytes.byteLength));
  const reading = decodeCtc(probabilities, probe.steps, characters);
  const started = performance.now();
  const candidates = score(probabilities, probe.steps, reading.text);
  const ms = performance.now()-started;
  const baseline = matchCardName(reading.text, cards);
  const correction = baseline ? null : matchCtcCardName({ ...reading, candidates }, cards);
  if (probe.height === 18 && probe.top === 14) firstLines.set(probe.name, { reading, probabilities });
  if (probe.top === 32) {
    const first = firstLines.get(probe.name);
    const data = joinCtcLines(first.probabilities, probabilities, characters.length);
    const text = (first.reading.text+reading.text).normalize("NFKC");
    const confidence = Math.min(first.reading.confidence, reading.confidence);
    const candidates = score(data,data.length/characters.length,text);
    const baseline = matchCardName(text,cards);
    const corrected = baseline ? null : matchCtcCardName({ text,confidence,candidates },cards);
    results.push({ ...probe, height:"joined", text,confidence,baseline:baseline?.card.name ?? null,
      correction:corrected?.card.name ?? null,candidates,ms:0 });
    continue;
  }
  results.push({ ...probe, text:reading.text, confidence:reading.confidence,
    baseline:baseline?.card.name ?? null, correction:correction?.card.name ?? null, candidates, ms });
}
const summary = {};
for (const manual of [true,false]) {
  const subset = results.filter(r=>r.manual===manual);
  summary[manual ? "manualLabelled" : "weakReferences"] = {
    strips:subset.length, baselineCorrect:subset.filter(r=>r.baseline===r.name).length,
    corrected:subset.filter(r=>r.correction===r.name).length,
    wrongCorrections:subset.filter(r=>r.correction && r.correction!==r.name),
  };
}
summary.decoderMs = { mean:results.reduce((sum,r)=>sum+r.ms,0)/results.length, maximum:Math.max(...results.map(r=>r.ms)) };
await writeFile("work/ctc-probes/results.json", JSON.stringify({ summary, results },null,2));
console.log(JSON.stringify(summary,null,2));
