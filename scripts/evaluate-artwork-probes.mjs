import { readFile, writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { createArtworkVerifier } from "../src/features/card-scanner/artwork-verifier.ts";
const json = async path => JSON.parse(await readFile(path, "utf8"));
const { cards } = await json("public/scanner/cards.json");
const verify = createArtworkVerifier(cards);
const results = (await json("work/artwork-probes.json")).map(({ rgba, ...probe }) => {
  const start = performance.now();
  const match = verify(rgba, probe.text, probe.confidence);
  return { ...probe, match, ms: performance.now()-start };
});
const summary = {};
for (const group of ["manual", "video1", "video2"]) {
  const rows = results.filter(r => r.group === group);
  summary[group] = { samples: rows.length, confirmed: rows.filter(r => r.match?.card.name === r.name).length,
    disagreements: rows.filter(r => r.match && r.match.card.name !== r.name).map(r => ({ expected: r.name, text: r.text, match: r.match })),
    names: rows.filter(r => r.match).map(r => ({ name: r.match.card.name, text: r.text, artwork: r.match.artwork })),
  };
}
const timing = { meanMs: results.reduce((sum, r) => sum+r.ms, 0)/results.length, maxMs: Math.max(...results.map(r => r.ms)) };
await writeFile("work/artwork-probe-results.json", JSON.stringify({ summary, timing, results }, null, 2));
console.log(JSON.stringify(Object.fromEntries(Object.entries(summary).map(([group, { names: _names, ...counts }]) => [group, counts])), null, 2));

console.log(JSON.stringify({ artworkOnlyTiming: timing }));
