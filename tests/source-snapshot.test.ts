import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
import { snapshotSource, SOURCE_READ_BUFFER_BYTES, SOURCE_SNAPSHOT_SCOPE } from '../dev/source-snapshot.ts';
import { serveCorpusRequest } from '../dev/corpus-server.ts';

const execute = promisify(execFile);
async function fixture(run: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'loa-source-snapshot-'));
  try {
    for (const path of SOURCE_SNAPSHOT_SCOPE) {
      const directory = ['src', 'dev', 'public/scanner'].includes(path);
      await mkdir(directory ? join(root, path) : dirname(join(root, path)), { recursive: true });
      if (!directory) await writeFile(join(root, path), `${path}\n`);
    }
    await writeFile(join(root, 'src', 'engine.ts'), 'export const threshold=0.9;');
    await run(root);
  } finally { await rm(root, { recursive: true, force: true }); }
}

test('source snapshots are relative, deterministic, bounded and work without Git', async () => {
  await fixture(async first => fixture(async second => {
    const body = Buffer.alloc(SOURCE_READ_BUFFER_BYTES * 5 + 19, 97);
    await writeFile(join(first, 'public/scanner', 'large.json'), body);
    await writeFile(join(first, 'dev', 'z.ts'), 'last');
    await writeFile(join(first, 'dev', 'a.ts'), 'first');
    await writeFile(join(second, 'dev', 'a.ts'), 'first');
    await writeFile(join(second, 'dev', 'z.ts'), 'last');
    await writeFile(join(second, 'public/scanner', 'large.json'), body);
    const a = await snapshotSource(first), b = await snapshotSource(second);
    assert.equal(a.sourceDigest, b.sourceDigest, 'creation order, absolute path and timestamps do not affect identity');
    assert.match(a.sourceDigest, /^[a-f0-9]{64}$/);
    assert.deepEqual(a.git, { head: 'unknown', dirty: 'unknown' });
    assert.equal(a.readBufferBytes, 256 * 1024);
    assert.ok(a.bytes > body.length); assert.equal(a.files, 16);
    assert.ok(Number.isFinite(a.durationMs) && a.durationMs >= 0);
    assert.ok(Number.isFinite(Date.parse(a.capturedAt)));
    assert.equal(JSON.stringify(a).includes(first), false);
    body[body.length - 1] = 98;
    await writeFile(join(second, 'public/scanner', 'large.json'), body);
    assert.notEqual((await snapshotSource(second)).sourceDigest, a.sourceDigest, 'the complete streamed payload is hashed');
  }));
});

test('the same Git HEAD does not mask edits or newly added untracked source', async () => {
  await fixture(async root => {
    const git = (...args: string[]) => execute('git', args, { cwd: root, windowsHide: true });
    await git('init', '--quiet'); await git('add', '.');
    await git('-c', 'user.name=Snapshot Test', '-c', 'user.email=snapshot@example.invalid', 'commit', '--quiet', '-m', 'fixture');
    const original = await snapshotSource(root);
    assert.match(original.git.head, /^[a-f0-9]{40,64}$/); assert.equal(original.git.dirty, false);
    await writeFile(join(root, 'src', 'engine.ts'), 'export const threshold=0.8;');
    const edit = await snapshotSource(root);
    assert.equal(edit.git.head, original.git.head); assert.equal(edit.git.dirty, true);
    assert.notEqual(edit.sourceDigest, original.sourceDigest);
    await writeFile(join(root, 'src', 'new-worker.ts'), 'new untracked worker');
    const added = await snapshotSource(root);
    assert.equal(added.git.head, original.git.head); assert.notEqual(added.sourceDigest, edit.sourceDigest);
    await rename(join(root, 'src', 'new-worker.ts'), join(root, 'src', 'renamed-worker.ts'));
    const renamed = await snapshotSource(root);
    assert.notEqual(renamed.sourceDigest, added.sourceDigest, 'relative file names are part of the snapshot');
    await mkdir(join(root, 'work'));
    await writeFile(join(root, 'work', 'private-result.json'), 'private fixture');
    assert.equal((await snapshotSource(root)).sourceDigest, renamed.sourceDigest, 'private inputs and result files are outside the fixed source scope');
  });
});

test('dependency and pinned model metadata are part of the dynamic digest', async () => {
  await fixture(async root => {
    let previous = (await snapshotSource(root)).sourceDigest;
    for (const path of ['package-lock.json', 'scripts/prepare-ocr-assets.mjs', 'licenses/third-party/manifest.json',
      'scripts/scan-corpus-core.mjs','scripts/scan-case-results.mjs','scripts/scan-corpus.mjs','scripts/scan-human-expected.mjs']) {
      await writeFile(join(root, path), `changed ${path}`);
      const next = (await snapshotSource(root)).sourceDigest;
      assert.notEqual(next, previous, path); previous = next;
    }
    await rm(join(root, 'package-lock.json'));
    await assert.rejects(snapshotSource(root), /ENOENT/, 'a missing required source cannot silently produce a valid digest');
  });
});

test('linked directories and root junctions are refused instead of reading outside source scope', async () => {
  await fixture(async root => {
    const outside = await mkdtemp(join(tmpdir(), 'loa-source-outside-'));
    try {
      await writeFile(join(outside, 'private.ts'), 'must not enter snapshot');
      await symlink(outside, join(root, 'src', 'linked'), 'junction');
      await assert.rejects(snapshotSource(root), /linked paths/);
      await symlink(root, join(outside, 'linked-root'), 'junction');
      await assert.rejects(snapshotSource(join(outside, 'linked-root')), /root cannot be linked/);
    } finally { await rm(outside, { recursive: true, force: true }); }
  });
});

test('environment route recomputes each request and retains GET, origin and path privacy guards', async () => {
  await fixture(async root => {
    const pending = new Set<Promise<unknown>>();
    const server = createServer((request, response) => {
      const task = serveCorpusRequest(request, response, join(root, 'unused-corpus'), root);
      pending.add(task); void task.then(() => pending.delete(task), () => pending.delete(task));
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address(); assert.ok(address && typeof address !== 'string');
    const url = `http://127.0.0.1:${address.port}/__corpus/environment`;
    try {
      const response = await fetch(url); assert.equal(response.status, 200);
      assert.equal(response.headers.get('cache-control'), 'no-store');
      assert.equal(response.headers.get('cross-origin-resource-policy'), 'same-origin');
      const before = await response.json();
      assert.equal(JSON.stringify(before).includes(root), false);
      await writeFile(join(root, 'dev', 'new-handler.ts'), 'new handler');
      const after = await (await fetch(url)).json();
      assert.notEqual(before.sourceDigest, after.sourceDigest, 'a long-lived server never caches a run-boundary source hash');
      assert.equal((await fetch(url, { method: 'POST' })).status, 405);
      assert.equal((await fetch(url, { headers: { Origin: 'https://unrelated.invalid' } })).status, 403);
      assert.equal((await fetch(url, { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
      await rm(join(root, 'package-lock.json'));
      const failed = await fetch(url); assert.equal(failed.status, 503);
      assert.equal((await failed.text()).includes(root), false, 'filesystem error paths are not returned to the browser');
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      await Promise.all(pending);
    }
  });
});
