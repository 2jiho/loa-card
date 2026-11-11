import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { auditPortraitCompetitors } from '../scripts/audit-portrait-competitors.mjs';

const read = async (file:string) => JSON.parse(await readFile(file, 'utf8'));
const artifact = 'public/scanner/portrait-competitors.json';
const pinFile = 'src/features/card-scanner/portrait-competitor-pins.json';

test('reviewed competitors pass and malformed, mislabeled or changed references fail', async () => {
  const [payload, pins, catalog, atlas, screen] = await Promise.all([
    read(artifact), read(pinFile), read('public/scanner/cards.json'),
    read('public/scanner/artwork-details.json'), read('public/scanner/screen-artwork-details.json'),
  ]);
  const validate = (value:unknown, otherAtlas = atlas) => auditPortraitCompetitors(value, pins, catalog, otherAtlas, screen);
  assert.doesNotThrow(() => validate(payload));
  const wrongVersion = structuredClone(payload); wrongVersion.version = 2;
  const wrongId = structuredClone(payload); wrongId.cards['3200002'] = wrongId.cards['3201001']; delete wrongId.cards['3201001'];
  const short = structuredClone(payload); short.cards['3201001'] = Buffer.alloc(199).toString('base64');
  const wrongHash = structuredClone(payload); const bytes = Buffer.from(wrongHash.cards['3201001'], 'base64'); bytes[0] ^= 1; wrongHash.cards['3201001'] = bytes.toString('base64');
  const invalidBase64 = structuredClone(payload); invalidBase64.cards['3201001'] += '!';
  for (const bad of [wrongVersion, wrongId, short, wrongHash, invalidBase64]) assert.throws(() => validate(bad), /portrait competitor/i);
  assert.throws(() => validate(payload, {...atlas, '3201001':payload.cards['3201001']}), /identity reference/i);
});

test('data audit accepts the reviewed artifact and fails a corrupt artifact even if its review hash is updated', async () => {
  const root = process.cwd();
  const tmp = await mkdtemp(path.join(tmpdir(), 'loacard-audit-'));
  assert.ok(path.resolve(tmp).startsWith(path.resolve(tmpdir()) + path.sep));
  try {
    const review = await read('data-review.json');
    const files = new Set<string>([...Object.keys(review.files), ...review.inGameEvidence.map((entry:{file:string}) => entry.file),
      'public/scanner/cards.json', 'public/growth/master.json', 'public/raid/master.json', 'src/features/merchants/merchants.json',
      'public/scanner/artwork-details.json', 'public/scanner/screen-artwork-details.json', artifact, pinFile]);
    for (const file of files) {
      await mkdir(path.dirname(path.join(tmp, file)), {recursive:true});
      await cp(path.join(root, file), path.join(tmp, file));
    }
    await cp('data-review.json', path.join(tmp, 'data-review.json'));
    const script = path.join(root, 'scripts/audit-runtime-data.mjs');
    assert.doesNotThrow(() => execFileSync(process.execPath, [script], {cwd:tmp, stdio:'pipe'}));
    const original = await read(path.join(tmp, artifact));
    const badSchema = structuredClone(original); badSchema.version = 2;
    const badFeature = structuredClone(original);
    const bytes = Buffer.from(badFeature.cards['3201001'], 'base64'); bytes[0] ^= 1;
    badFeature.cards['3201001'] = bytes.toString('base64');
    for (const [invalid, expected] of [[badSchema, /Invalid portrait competitor schema/], [badFeature, /Invalid portrait competitor feature or hash/]] as const) {
      await writeFile(path.join(tmp, artifact), JSON.stringify(invalid));
      review.files[artifact].sha256 = createHash('sha256').update(JSON.stringify(invalid)).digest('hex');
      await writeFile(path.join(tmp, 'data-review.json'), JSON.stringify(review));
      const result = spawnSync(process.execPath, [script], {cwd:tmp, encoding:'utf8'});
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, expected);
    }
  } finally {
    await rm(tmp, {recursive:true, force:true});
  }
});
