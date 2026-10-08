import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const read = async path => JSON.parse(await readFile(path, 'utf8'));
const review = await read('data-review.json');
const sources = {};
for (const [path, expected] of Object.entries(review.files)) {
  const bytes = await readFile(path);
  // JSON content hashing survives Git's Windows/Unix newline conversion.
  const actual = createHash('sha256').update(JSON.stringify(JSON.parse(bytes.toString('utf8')))).digest('hex');
  if (actual !== expected.sha256) throw new Error(`Review changed data before building: ${path}. Update data-review.json with evidence and date.`);
  sources[path] = { ...expected, bytes: bytes.length };
}
const catalog = await read('public/scanner/cards.json'), growth = await read('public/growth/master.json');
const raid = await read('public/raid/master.json'), merchants = await read('src/features/merchants/merchants.json');
const byId = new Map(catalog.cards.map(card => [card.id, card]));
if (byId.size !== catalog.cards.length) throw new Error('Duplicate catalog IDs');
for (const card of [...growth.cards, ...raid.cards, ...merchants.groups.flatMap(group => group.cards)]) {
  const reference = byId.get(card.id);
  if (!reference || reference.name !== card.name || (card.rarity !== undefined && reference.rarity !== card.rarity)) throw new Error(`Broken card reference: ${card.id}`);
}
for (const group of [...growth.books, ...raid.sets])
  for (const id of group.cardIds) if (!byId.has(id)) throw new Error(`Unknown card ${id} in ${group.name}`);
const documented = new Set();
for (const evidence of review.inGameEvidence) {
  const rows = await read(evidence.file);
  for (const row of rows) {
    const card = catalog.cards.find(card => card.name === row.name);
    if (!card) throw new Error(`Unknown observed card: ${row.name}`);
    documented.add(card.id);
  }
}
const unverified = catalog.cards.filter(card => !documented.has(card.id)).map(({ id, name }) => ({ id, name }));
const report = { reviewedOn: review.reviewedOn, catalogVersion: catalog.version, cards: byId.size,
  inGameEvidenceDocumented: documented.size, releaseStatusNotIndividuallyDocumented: unverified,
  note: 'Client metadata is not proof of release. Missing documentation does not mean a card is unreleased. Scanner coverage is a separate measure.', sources };
await mkdir('work', { recursive: true });
await writeFile('work/data-audit.json', JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ reviewedOn: report.reviewedOn, cards: report.cards, inGameEvidenceDocumented: documented.size, releaseEvidencePending: unverified.length }));
if (process.argv.includes('--require-release-evidence') && unverified.length) throw new Error('Release evidence is incomplete; see work/data-audit.json');
