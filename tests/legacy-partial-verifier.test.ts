import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('legacy partial comparisons cannot certify unbound input even when every old value matches', async () => {
  const first = JSON.parse(await readFile('tests/fixtures/first-row.json', 'utf8'));
  const manual = JSON.parse(await readFile('tests/fixtures/manual-cards.json', 'utf8'));
  const counts = JSON.parse(await readFile('tests/fixtures/manual-counters.json', 'utf8'));
  const photos = JSON.parse(await readFile('tests/fixtures/manual-screenshot-cards.json', 'utf8'));
  const directory = await mkdtemp(join(tmpdir(), 'loa-partial-comparison-'));
  try {
    // Inputs deliberately contain no video hash, captured frame or code version.
    const cards = [...first.cards, ...manual, ...counts].map(card => ({ ...card, review: [] }));
    const video = join(directory, 'video.json');
    await writeFile(video, JSON.stringify({ expected: first.expectedOwnedTypes, cards }));
    const runVideo = () => spawnSync(process.execPath, ['scripts/verify-scan.mjs', video], { encoding: 'utf8' });
    const matchedVideo = runVideo();
    assert.equal(matchedVideo.status, 3, matchedVideo.stderr);
    assert.equal(JSON.parse(matchedVideo.stdout).verificationStatus, 'unverified-source');
    cards[0].awakening = 999;
    await writeFile(video, JSON.stringify({ expected: first.expectedOwnedTypes, cards }));
    assert.equal(runVideo().status, 1);

    const screenshot = join(directory, 'screenshot.json');
    const screenshotCards = [...photos, ...Array.from({ length: 384 - photos.length }, (_, index) => ({
      name: `synthetic-card-${index}`, awakening: 0, extraCopies: 0,
    }))];
    await writeFile(screenshot, JSON.stringify({ expected: 384, capacity: 450, cards: screenshotCards }));
    const runScreenshot = () => spawnSync(process.execPath, ['scripts/verify-screenshot-scan.mjs', screenshot], { encoding: 'utf8' });
    const matchedScreenshot = runScreenshot();
    assert.equal(matchedScreenshot.status, 3, matchedScreenshot.stderr);
    screenshotCards[0].awakening = 999;
    await writeFile(screenshot, JSON.stringify({ expected: 384, capacity: 450, cards: screenshotCards }));
    assert.equal(runScreenshot().status, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
