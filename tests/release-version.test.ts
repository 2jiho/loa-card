import test from 'node:test';
import assert from 'node:assert/strict';
import { releaseNotes } from '../scripts/release-version.mjs';

const pkg = { version: '0.1.0' };
const lock = { version: '0.1.0', packages: { '': pkg } };
test('release notes select the exact version section', () => {
  assert.equal(releaseNotes('v0.1.0', pkg, lock, '# Changes\r\n## v0.1.0 - 2026-10-18\r\n\r\n- Scanner\r\n## v0.0.9\r\n- Older'), '- Scanner\n');
});
test('release rejects mismatched or malformed versions and missing notes', () => {
  for (const tag of ['v0', 'v0.1.1', 'v0.1.0-beta', 'v00.1.0']) assert.throws(() => releaseNotes(tag, pkg, lock, '## v0.1.0\n- A'));
  assert.throws(() => releaseNotes('v0.1.0', pkg, { ...lock, version: '0.0.0' }, '## v0.1.0\n- A'));
  assert.throws(() => releaseNotes('v0.1.0', pkg, { ...lock, packages: {} }, '## v0.1.0\n- A'));
  assert.throws(() => releaseNotes('v0.1.0', pkg, lock, '## v0.1.01\n- A'));
  assert.throws(() => releaseNotes('v0.1.0', pkg, lock, '## v0.1.0\n\n## v0.0.9\n- A'));
});
