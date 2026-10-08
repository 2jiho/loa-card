import { readdir, mkdir, copyFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
const source = process.argv[2];
if (!source) throw new Error('Usage: node scripts/prepare-screenshots.mjs "path/to/Screenshots"');
const files = (await readdir(source)).filter(name => /^스크린샷 \d{4}-\d{2}-\d{2} \d{6}\.png$/.test(name)).sort();
const dates = [...new Set(files.map(name => name.slice(5, 15)))].sort().slice(-2);
if (dates.length !== 2) throw new Error("Expected two dated screenshot groups");
for (const [index, date] of dates.entries()) {
  const group = index + 1, names = files.filter(name => name.includes(date));
  if (names.length !== 10) throw new Error(`Expected ten screenshots in ${date}`);
  const folder = resolve(`fixtures/local/screenshots-${group}`);
  await mkdir(folder, { recursive: true });
  for (const [i, name] of names.entries()) await copyFile(join(source, name), join(folder, `${String(i + 1).padStart(2, "0")}.png`));
  await writeFile(resolve(`fixtures/local/screenshots-${group}.json`), JSON.stringify({ images: names.map((_, i) => `/__fixtures/screenshots-${group}/${String(i + 1).padStart(2, "0")}.png`) }));
  console.log(`Prepared screenshot group ${group}: ${date} (10 original PNGs, excluded from Git)`);
}
