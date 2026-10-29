import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, readdir, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { addCorpusCase, corpusCaseId, listCorpusCases, readCorpusBytes, readCorpusJson, storeCorpusRun, verifyCorpus, MAX_CORPUS_RUN_BYTES } from '../scripts/scan-corpus-core.mjs';
import type { CorpusManifest } from '../scripts/scan-corpus-core.mjs';
import { runCorpusCli } from '../scripts/scan-corpus.mjs';
import { RunStateTrace, MAX_RUN_STATE_TRACE_BLOB_BYTES } from '../dev/run-state-trace';
import { ScanGrid } from '../src/features/card-scanner/scan-grid';
import { recordScanGrid, hashScanGridReplay, scanGridReplaySnapshot } from '../src/features/card-scanner/scan-grid-command';

const execFileAsync = promisify(execFile);
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
async function fixture(run: (directory: string, root: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'loa-scan-corpus-'));
  try { await run(directory, join(directory, 'corpus')); }
  finally { await rm(directory, { recursive: true, force: true }); }
}
async function source(directory: string, name: string, contents = name) {
  const path = join(directory, name); await writeFile(path, contents); return path;
}
async function manifestFile(root: string, id: string) { return JSON.parse(await readFile(join(root, 'cases', id, 'manifest.json'), 'utf8')); }
function runReport(manifest: CorpusManifest) {
  return { version: 1,
    result: { expected: 1, read: 1, unidentified: 0, experience: null,
      cards: [{ id: '1', name: '샨디', awakening: 1, extraCopies: 2, review: [] as string[] }] },
    validation: { caseId: manifest.id, input: manifest.inputs.map(({ index, name, sha256, bytes }) => ({ index, name, sha256, bytes })),
      completed: true, outcome: 'completed', sourceChanged: false as boolean | null,
      sourceStart: { sourceDigest: hash('source') }, sourceEnd: { sourceDigest: hash('source') } },
    diagnostics: { note: '프로그램의 관측 결과' } };
}
async function recordedState() {
  const trace = new RunStateTrace(); let clock = 0;
  const grid = recordScanGrid(new ScanGrid(fact => trace.record('observation-fact', fact, clock++)),
    command => trace.record('grid-command', command, clock++));
  grid.begin(true); grid.geometry(55); grid.group(0, 1, 1, true, 1); grid.record(1);
  const first = grid.start(1); grid.stage(1, 'deferred');
  const retry = grid.start(1); grid.finish(1, 'review', first); grid.finish(1, 'read', retry);
  grid.identify(1, 'test-card'); grid.liveViewport(1);
  return { execution: JSON.parse(await (await trace.snapshotBlob()).text()),
    executionExpected: { gridHash: await hashScanGridReplay(scanGridReplaySnapshot(grid)) } };
}

test('corpus copies and hashes once, preserves the source and creates no automatic truth', async () => {
  await fixture(async (directory, root) => {
    const bytes = Buffer.alloc(3 * 1024 * 1024 + 37, 137);
    const input = join(directory, 'video.mp4'); await writeFile(input, bytes);
    const result = await addCorpusCase([input], { root });
    assert.equal(result.created, true);
    assert.equal(result.manifest.inputs[0].sha256, hash(bytes));
    assert.equal(result.manifest.inputs[0].bytes, bytes.length);
    assert.deepEqual(result.manifest.source, { capturedAt: null, completeness: 'unknown' });
    assert.equal(result.manifest.baseline, null); assert.equal(result.manifest.expected, null);
    assert.equal(JSON.stringify(result.manifest).includes(directory), false);
    assert.deepEqual(await readFile(input), bytes);
    const registered = join(root, 'cases', result.manifest.id, 'input', '0001.mp4');
    assert.deepEqual(await readFile(registered), bytes);
    assert.equal((await stat(registered)).ino, (await stat(join(root, 'objects', hash(bytes)))).ino);
    assert.equal((await stat(input)).ino === (await stat(registered)).ino, false, 'source must never be linked into the store');
    assert.deepEqual(await verifyCorpus({ root }), { verified: true, cases: 1, inputs: 1, objects: 1, bytes: bytes.length });
    assert.deepEqual(await readdir(join(root, '.tmp')), []);
  });
});

test('corpus identity is path/name independent but keeps ordered inputs and repetitions', async () => {
  await fixture(async (directory, root) => {
    const a = await source(directory, 'a.png', 'A'); const b = await source(directory, 'b.png', 'B');
    const sameA = await source(directory, 'renamed.png', 'A');
    const ab = await addCorpusCase([a, b], { root, name: 'original' });
    const originalManifest = await readFile(join(root, 'cases', ab.manifest.id, 'manifest.json'), 'utf8');
    const duplicate = await addCorpusCase([sameA, b], { root, name: 'ignored new label' });
    const ba = await addCorpusCase([b, a], { root });
    const aab = await addCorpusCase([a, a, b], { root });
    assert.equal(duplicate.created, false);
    assert.equal(duplicate.manifest.id, ab.manifest.id);
    assert.equal(duplicate.manifest.name, 'original');
    assert.equal(await readFile(join(root, 'cases', ab.manifest.id, 'manifest.json'), 'utf8'), originalManifest);
    assert.notEqual(ba.manifest.id, ab.manifest.id); assert.notEqual(aab.manifest.id, ab.manifest.id);
    assert.deepEqual(aab.manifest.inputs.map(input => [input.index, input.sha256]), [[0, hash('A')], [1, hash('A')], [2, hash('B')]]);
    assert.equal((await readdir(join(root, 'objects'))).length, 2);
    assert.equal((await listCorpusCases({ root })).length, 3);
    assert.deepEqual(await verifyCorpus({ root }), { verified: true, cases: 3, inputs: 7, objects: 2, bytes: 7 });
  });
});

test('replay and video kinds are explicit in identity and unknown capture time stays null', async () => {
  await fixture(async (directory, root) => {
    const replay = await source(directory, 'scan.loareplay', 'same'); const video = await source(directory, 'scan.mp4', 'same');
    const first = await addCorpusCase([replay], { root }); const second = await addCorpusCase([video], { root });
    assert.equal(first.manifest.kind, 'replay'); assert.equal(second.manifest.kind, 'video');
    assert.notEqual(first.manifest.id, second.manifest.id);
    assert.equal(first.manifest.source.capturedAt, null);
    assert.equal((await readdir(join(root, 'objects'))).length, 1);
  });
});

test('list reads metadata only while verify detects missing or corrupted stored bytes', async () => {
  await fixture(async (directory, root) => {
    const input = await source(directory, 'a.png', 'original');
    const { manifest } = await addCorpusCase([input], { root });
    await writeFile(join(root, 'objects', manifest.inputs[0].sha256), 'changed');
    assert.equal((await listCorpusCases({ root }))[0].inputs, 1);
    await assert.rejects(verifyCorpus({ root }), /checksum mismatch/);
    await assert.rejects(addCorpusCase([input], { root }), /checksum mismatch/);
    await rm(join(root, 'objects', manifest.inputs[0].sha256));
    assert.equal((await listCorpusCases({ root })).length, 1);
    await assert.rejects(verifyCorpus({ root }), /does not exist/);
  });
});

test('case input links are verified independently of the content-addressed object', async () => {
  await fixture(async (directory, root) => {
    const input = await source(directory, 'a.png');
    const { manifest } = await addCorpusCase([input], { root });
    const registered = join(root, 'cases', manifest.id, 'input', '0001.png');
    await rename(registered, `${registered}.old`); await writeFile(registered, 'different');
    await assert.rejects(verifyCorpus({ root }), /Case input checksum mismatch/);
  });
});

test('failed registration rolls back only new objects and its own staging files', async () => {
  await fixture(async (directory, root) => {
    const a = await source(directory, 'a.png', 'new'); const b = await source(directory, 'b.png', 'B');
    await mkdir(join(root, 'objects'), { recursive: true });
    const existing = join(root, 'objects', hash('B')); await writeFile(existing, 'corrupt existing object');
    await assert.rejects(addCorpusCase([a, b], { root }), /Object checksum mismatch/);
    assert.deepEqual(await readdir(join(root, 'objects')), [hash('B')]);
    assert.equal(await readFile(existing, 'utf8'), 'corrupt existing object');
    assert.deepEqual(await readdir(join(root, 'cases')), []);
    assert.deepEqual(await readdir(join(root, '.tmp')), []);
    assert.equal((await readdir(root)).includes('.write.lock'), false);
    assert.equal(await readFile(a, 'utf8'), 'new'); assert.equal(await readFile(b, 'utf8'), 'B');
  });
});

test('registration rejects invalid inputs before changing the store', async () => {
  await fixture(async (directory, root) => {
    const input = await source(directory, 'a.png'); const video = await source(directory, 'a.mp4');
    await assert.rejects(addCorpusCase([], { root }), /Provide between/);
    await assert.rejects(addCorpusCase([input], { root, kind: 'unknown' }), /Kind must/);
    await assert.rejects(addCorpusCase([input], { root, kind: 'video' }), /extension/);
    await assert.rejects(addCorpusCase([video, video], { root }), /exactly one/);
    await assert.rejects(addCorpusCase([input, join(directory, 'missing.png')], { root }), /does not exist/);
    await mkdir(join(directory, 'directory.png'));
    await assert.rejects(addCorpusCase([join(directory, 'directory.png')], { root }), /regular files/);
    await assert.rejects(addCorpusCase([input], { root, name: '../bad\nlabel' }), /single line/);
    assert.deepEqual(await listCorpusCases({ root }), []);
    assert.equal((await readdir(directory)).includes('corpus'), false);
  });
});

test('manifest traversal and mismatched ordered identity are rejected before reading references', async () => {
  await fixture(async (directory, root) => {
    const input = await source(directory, 'a.png');
    const { manifest } = await addCorpusCase([input], { root });
    const path = join(root, 'cases', manifest.id, 'manifest.json');
    const modified = structuredClone(manifest);
    modified.inputs[0].path = '../../outside.png';
    await writeFile(path, JSON.stringify(modified));
    await assert.rejects(verifyCorpus({ root }), /Invalid corpus input reference/);
    modified.inputs[0].path = manifest.inputs[0].path;
    modified.inputs[0].sha256 = hash('other'); modified.inputs[0].object = `objects/${hash('other')}`;
    await writeFile(path, JSON.stringify(modified));
    await assert.rejects(listCorpusCases({ root }), /ordered inputs/);
    await assert.rejects(verifyCorpus({ root, id: '../outside' }), /complete lowercase SHA-256/);
  });
});

test('symlink/junction roots and ancestors are rejected without following them', async (t) => {
  await fixture(async (directory, root) => {
    const real = join(directory, 'real'); await mkdir(real);
    const pointer = join(directory, 'pointer');
    try { await symlink(real, pointer, process.platform === 'win32' ? 'junction' : 'dir'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'EPERM') { t.skip('Symlink permission unavailable'); return; } throw error; }
    const input = await source(real, 'a.png');
    await assert.rejects(addCorpusCase([join(pointer, 'a.png')], { root }), /Symlinks and junctions/);
    await assert.rejects(addCorpusCase([input], { root: join(pointer, 'corpus') }), /Symlinks and junctions/);
    await assert.rejects(listCorpusCases({ root: pointer }), /Symlinks and junctions/);
    assert.deepEqual(await readdir(real), ['a.png']);
  });
});

test('writer lock prevents concurrent mutation and is not deleted by another invocation', async () => {
  await fixture(async (directory, root) => {
    const input = await source(directory, 'a.png'); await mkdir(root);
    const lock = join(root, '.write.lock'); await writeFile(lock, 'another writer');
    await assert.rejects(addCorpusCase([input], { root }), /Corpus is busy/);
    assert.equal(await readFile(lock, 'utf8'), 'another writer');
    assert.deepEqual(await readdir(join(root, 'objects')), []);
  });
});

test('CLI add/list/verify emit concise JSON, preserve order and reject incorrect arguments', async () => {
  await fixture(async (directory, root) => {
    const a = await source(directory, 'a.png'); const b = await source(directory, 'b.png');
    const output: string[] = []; const write = (line: string) => output.push(line);
    await runCorpusCli(['add', b, a, '--name', 'ordered', '--root', root], write);
    const registration = JSON.parse(output.at(-1)!);
    assert.equal(registration.kind, 'images'); assert.equal(registration.inputs, 2);
    assert.deepEqual((await manifestFile(root, registration.id)).inputs.map(input => input.name), ['b.png', 'a.png']);
    await runCorpusCli(['list', '--root', root], write); assert.equal(JSON.parse(output.at(-1)!).length, 1);
    await runCorpusCli(['verify', registration.id, '--root', root], write); assert.equal(JSON.parse(output.at(-1)!).verified, true);
    assert.equal(output.join('\n').includes(directory), false);
    await assert.rejects(runCorpusCli(['add', a, '--root', root, '--root', root], write), /repeated/);
    await assert.rejects(runCorpusCli(['list', '--kind', 'images'], write), /Unknown option/);
    await assert.rejects(runCorpusCli(['list', a], write), /does not accept/);
    await assert.rejects(runCorpusCli(['verify', 'a', 'b'], write), /at most one/);
    await assert.rejects(runCorpusCli(['delete'], write), /Unknown corpus command/);
  });
});

test('importing the CLI has no side effects and direct invocation reports errors without source paths', async () => {
  const cli = resolve('scripts/scan-corpus.mjs');
  await fixture(async (directory) => {
    const imported = await execFileAsync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(pathToFileURL(cli).href)})`], { cwd: directory });
    assert.equal(imported.stdout, ''); assert.equal(imported.stderr, ''); assert.deepEqual(await readdir(directory), []);
    const help = await execFileAsync(process.execPath, [cli, '--help'], { cwd: directory });
    assert.match(help.stdout, /Input order and repeated images/);
    await assert.rejects(execFileAsync(process.execPath, [cli, 'add', join(directory, 'missing.mp4')], { cwd: directory }), error => {
      const result = error as Error & { stderr: string };
      assert.match(result.stderr, /does not exist/); assert.equal(result.stderr.includes(directory), false); return true;
    });
  });
});

test('case hash API rejects malformed identities and distinguishes sequence ordering', () => {
  assert.notEqual(corpusCaseId('images', [hash('A'), hash('B')]), corpusCaseId('images', [hash('B'), hash('A')]));
  assert.notEqual(corpusCaseId('images', [hash('A')]), corpusCaseId('images', [hash('A'), hash('A')]));
  assert.throws(() => corpusCaseId('images', []), /Invalid case identity/);
  assert.throws(() => corpusCaseId('images', ['../x']), /Invalid case identity/);
  assert.throws(() => corpusCaseId('images', new Array(1)), /Invalid case identity/);
  assert.throws(() => corpusCaseId('images', Array(1_001).fill(hash('A'))), /Invalid case identity/);
});

test('comparison reports scoped equality and returns mismatch code without changing global exit status', async () => {
  await fixture(async (directory) => {
    const card = { id: '1', name: '샨디', awakening: 1, extraCopies: 2, review: [] };
    const baseline = { expected: 1, read: 1, unidentified: 0, experience: null, cards: [card] };
    const reference = await source(directory, 'reference.json', JSON.stringify(baseline));
    const actual = await source(directory, 'actual.json', JSON.stringify({ result: { ...baseline, experience: 0,
      cards: [card, { ...card, id: '2', name: '실리안' }] } }));
    const output: string[] = []; const write = (line: string) => output.push(line);
    const previousExitCode = process.exitCode;
    assert.equal(await runCorpusCli(['compare', reference, actual], write), 2);
    const full = JSON.parse(output.at(-1)!);
    assert.equal(full.same, false); assert.equal(full.exactSame, false); assert.equal(full.added.length, 1);
    assert.equal(full.headers[0].field, 'experience'); assert.match(full.interpretation, /not recognition accuracy/);
    assert.equal(await runCorpusCli(['compare', reference, actual, '--scope', 'partial'], write), 0);
    const partial = JSON.parse(output.at(-1)!);
    assert.equal(partial.same, true); assert.equal(partial.exactSame, false);
    assert.deepEqual(partial.checked, { cards: 'reference', headers: false, extraIds: false });
    assert.equal(process.exitCode, previousExitCode);
    await assert.rejects(runCorpusCli(['compare', reference], write), /requires a reference/);
    await assert.rejects(runCorpusCli(['compare', reference, actual, '--scope', 'guess'], write), /full or partial/);
    await assert.rejects(runCorpusCli(['compare', reference, actual, '--root', directory], write), /Unknown option/);
    const cli = resolve('scripts/scan-corpus.mjs');
    await assert.rejects(execFileAsync(process.execPath, [cli, 'compare', reference, actual]), error => {
      const failure = error as Error & { code: number; stdout: string };
      assert.equal(failure.code, 2); assert.equal(JSON.parse(failure.stdout).same, false); return true;
    });
  });
});

test('JSON reads reject oversized, non-file, symlink and malformed input without unbounded reads', async (t) => {
  await fixture(async (directory) => {
    const good = await source(directory, 'ok.json', '{"ok":true}');
    assert.deepEqual(await readCorpusJson(good), { ok: true });
    await assert.rejects(readCorpusJson(good, 2), /size limit/);
    await assert.rejects(readCorpusJson(good, 16 * 1024 * 1024 + 1), /Invalid JSON size limit/);
    await assert.rejects(readCorpusJson(directory), /regular files/);
    const malformed = await source(directory, 'bad.json', '{');
    await assert.rejects(readCorpusJson(malformed), SyntaxError);
    const huge = join(directory, 'huge.json'); await writeFile(huge, Buffer.alloc(16 * 1024 * 1024 + 1, 32));
    await assert.rejects(runCorpusCli(['compare', good, huge], () => undefined), /size limit/);
    const pointer = join(directory, 'pointer');
    try { await symlink(directory, pointer, process.platform === 'win32' ? 'junction' : 'dir'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'EPERM') { t.skip('Symlink permission unavailable'); return; } throw error; }
    await assert.rejects(readCorpusJson(join(pointer, 'ok.json')), /Symlinks and junctions/);
  });
});

test('manifest metadata corruption cannot be reported as a verified corpus', async () => {
  await fixture(async (directory, root) => {
    const input = await source(directory, 'a.mp4');
    const { manifest } = await addCorpusCase([input], { root });
    const path = join(root, 'cases', manifest.id, 'manifest.json');
    for (const patch of [
      { createdAt: 'not a date' }, { source: { capturedAt: 'guessed', completeness: 'complete' } },
      { expected: { automaticallyCorrect: true } }, { baseline: 'auto.json' }, { name: '' },
    ]) {
      await writeFile(path, JSON.stringify({ ...manifest, ...patch }));
      await assert.rejects(verifyCorpus({ root }), /Invalid corpus manifest/);
    }
    const second = { ...manifest.inputs[0], index: 1, path: 'input/0002.mp4' };
    await writeFile(path, JSON.stringify({ ...manifest, inputs: [...manifest.inputs, second] }));
    await assert.rejects(verifyCorpus({ root }), /Invalid corpus manifest/);
  });
});

test('replay-state verifies captured grid commands and observation facts without rerunning recognition', async () => {
  await fixture(async directory => {
    const report = await recordedState();
    const path = await source(directory, 'report.json', JSON.stringify({ result: { privateInput: 'not printed' }, ...report }));
    const output: string[] = []; const write = (line: string) => output.push(line);
    const previousExitCode = process.exitCode;
    assert.equal(await runCorpusCli(['replay-state', path], write), 0);
    const replay = JSON.parse(output.at(-1)!);
    assert.equal(replay.scope, 'display-and-observation-state');
    assert.equal(replay.complete, true); assert.equal(replay.grid.supported, true);
    assert.equal(replay.grid.hash, report.executionExpected.gridHash);
    assert.equal(replay.expectedHash, report.executionExpected.gridHash); assert.equal(replay.matchesCapturedState, true);
    assert.equal(replay.observations.read, 1); assert.equal(replay.observations.review, 0);
    assert.equal(replay.interpretation, 'not OCR/live scheduler/recognition accuracy');
    assert.equal(output.join('\n').includes('privateInput'), false); assert.equal(output.join('\n').includes(directory), false);
    assert.equal(process.exitCode, previousExitCode);
    const cli = resolve('scripts/scan-corpus.mjs');
    const command = await execFileAsync(process.execPath, ['--import', 'tsx', cli, 'replay-state', path]);
    assert.deepEqual(JSON.parse(command.stdout), replay); assert.equal(command.stderr, '');
  });
});

test('replay-state without captured hash is explicitly unverified, including empty event boundaries', async () => {
  await fixture(async directory => {
    const { execution } = await recordedState();
    for (const value of [execution, { execution }, { execution, executionExpected: {} },
      { version: 1, complete: true, dropped: 0, events: [] }]) {
      const path = await source(directory, 'trace.json', JSON.stringify(value));
      let output = '';
      assert.equal(await runCorpusCli(['replay-state', path], line => { output = line; }), 0);
      const result = JSON.parse(output);
      assert.equal(result.expectedHash, null); assert.equal(result.matchesCapturedState, null);
      if (result.events === 0) {
        assert.equal(result.grid.supported, false); assert.equal(result.observations.supported, false);
        assert.equal(result.grid.hash, null);
      }
    }
  });
});

test('replay-state mismatches return code 2 through both the API and the actual CLI', async () => {
  await fixture(async directory => {
    const report = await recordedState(); report.executionExpected.gridHash = '0'.repeat(64);
    const path = await source(directory, 'mismatch.json', JSON.stringify(report));
    let output = '';
    assert.equal(await runCorpusCli(['replay-state', path], line => { output = line; }), 2);
    const replay = JSON.parse(output); assert.equal(replay.matchesCapturedState, false);
    assert.notEqual(replay.grid.hash, replay.expectedHash);
    const cli = resolve('scripts/scan-corpus.mjs');
    await assert.rejects(execFileAsync(process.execPath, ['--import', 'tsx', cli, 'replay-state', path]), error => {
      const failure = error as Error & { code: number; stdout: string; stderr: string };
      assert.equal(failure.code, 2); assert.deepEqual(JSON.parse(failure.stdout), replay);
      assert.equal(failure.stderr, ''); return true;
    });
  });
});

test('replay-state rejects incomplete, malformed and oversized traces rather than reporting equality', async () => {
  await fixture(async directory => {
    const report = await recordedState(); const output: string[] = []; const write = (line: string) => output.push(line);
    for (const invalid of [null, [], { execution: null }, { ...report, executionExpected: null },
      { ...report, executionExpected: { gridHash: 'incorrect' } },
      { ...report.execution, version: 3 }, { ...report.execution, complete: false, dropped: 1 },
      { ...report.execution, chunks: [{ ...report.execution.chunks[0], events: 0 }] }]) {
      const path = await source(directory, 'bad.json', JSON.stringify(invalid));
      await assert.rejects(runCorpusCli(['replay-state', path], write));
    }
    const partial = await source(directory, 'partial.json', JSON.stringify({ ...report.execution, complete: false, dropped: 1,
      lastSeq: report.execution.lastSeq + 1 }));
    const cli = resolve('scripts/scan-corpus.mjs');
    await assert.rejects(execFileAsync(process.execPath, ['--import', 'tsx', cli, 'replay-state', partial]), error => {
      const failure = error as Error & { code: number; stdout: string; stderr: string };
      assert.equal(failure.code, 1); assert.equal(failure.stdout, ''); assert.match(failure.stderr, /불완전한 상태 기록/);
      assert.equal(failure.stderr.includes(directory), false); return true;
    });
    const largeTrace = await source(directory, 'large-trace.json', JSON.stringify({ ...report.execution, padding: 'x'.repeat(MAX_RUN_STATE_TRACE_BLOB_BYTES) }));
    await assert.rejects(runCorpusCli(['replay-state', largeTrace], write), /용량 한도/);
    const huge = join(directory, 'huge-report.json'); await writeFile(huge, Buffer.alloc(16 * 1024 * 1024 + 1, 32));
    await assert.rejects(runCorpusCli(['replay-state', huge], write), /size limit/);
    await assert.rejects(runCorpusCli(['replay-state'], write), /requires one/);
    await assert.rejects(runCorpusCli(['replay-state', partial, partial], write), /requires one/);
    await assert.rejects(runCorpusCli(['replay-state', partial, '--root', directory], write), /Unknown option/);
    await assert.rejects(runCorpusCli(['replay-state', partial, '--scope', 'partial'], write), /Unknown option/);
    assert.deepEqual(output, []);
  });
});

test('record-run preserves exact UTF-8 report bytes, snapshots caller memory and never rewrites duplicate runs or the manifest', async () => {
  await fixture(async (directory, root) => {
    const { manifest } = await addCorpusCase([await source(directory, 'one.mp4')], { root });
    const manifestPath = join(root, 'cases', manifest.id, 'manifest.json'), before = await readFile(manifestPath);
    const report = runReport(manifest);
    const original = Buffer.from(`\ufeff${JSON.stringify(report, null, 2)}\r\n`, 'utf8');
    const callerBytes = Uint8Array.from(original);
    const pending = storeCorpusRun(callerBytes, { root, id: manifest.id });
    callerBytes.fill(0);
    const first = await pending;
    assert.equal(first.created, true); assert.equal(first.id, manifest.id); assert.equal(first.sha256, hash(original));
    assert.equal(first.file, `cases/${manifest.id}/runs/run-${hash(original)}.json`);
    const stored = join(root, ...first.file.split('/')), fileStat = await stat(stored);
    assert.deepEqual(await readFile(stored), original);
    const duplicate = await storeCorpusRun(original, { root, id: manifest.id });
    assert.deepEqual(duplicate, { ...first, created: false });
    assert.equal((await stat(stored)).mtimeMs, fileStat.mtimeMs);
    assert.deepEqual(await readFile(manifestPath), before);
    assert.deepEqual(await readdir(join(root, 'cases', manifest.id, 'runs')), [`run-${hash(original)}.json`]);
    assert.deepEqual(await readdir(join(root, '.tmp')), []);
    assert.equal((await readdir(root)).includes('.write.lock'), false);
    assert.equal(first.summary.classification, 'completed'); assert.equal(first.summary.verification, 'unverified');
    assert.equal(JSON.stringify(first).includes(directory), false);
  });
});

test('record-run validates exact case ID, ordered input hashes, sizes, indexes and repeated inputs before writing', async () => {
  await fixture(async (directory, root) => {
    const a = await source(directory, 'a.png', 'A'), b = await source(directory, 'b.png', 'B');
    const { manifest } = await addCorpusCase([a, a, b], { root });
    const original = runReport(manifest);
    const check = async (report: unknown, id = manifest.id) => assert.rejects(storeCorpusRun(Buffer.from(JSON.stringify(report)), { root, id }),
      { code: 'CORPUS_RUN_INVALID' });
    await check({ ...original, version: 2 });
    await check({ ...original, result: null });
    await check({ ...original, validation: null });
    await check(original, '../outside');
    await check({ ...original, validation: { ...original.validation, caseId: hash('other case') } });
    for (const inputs of [original.validation.input.slice(1), [...original.validation.input].reverse(),
      [...original.validation.input].reverse().map((input, index) => ({ ...input, index })),
      original.validation.input.map((input, index) => ({ ...input, sha256: index === 2 ? hash('A') : input.sha256 })),
      original.validation.input.map((input, index) => ({ ...input, bytes: index === 2 ? input.bytes + 1 : input.bytes })),
      original.validation.input.map(input => ({ ...input, index: input.index + 1 })),
      [...original.validation.input, original.validation.input[0]]]) {
      await check({ ...original, validation: { ...original.validation, input: inputs } });
    }
    for (const validation of [{ ...original.validation, completed: 'yes' }, { ...original.validation, sourceChanged: 'false' }])
      await check({ ...original, validation });
    assert.deepEqual(await readdir(join(root, 'cases', manifest.id)), ['input', 'manifest.json']);
    // A different display filename is not a different source; ordered hashes are authoritative.
    original.validation.input[0].name = 'renamed.png';
    assert.equal((await storeCorpusRun(Buffer.from(JSON.stringify(original)), { root, id: manifest.id })).created, true);
  });
});

test('record-run archives partial, cancelled and failed observations without promoting baseline or expected', async () => {
  await fixture(async (directory, root) => {
    const { manifest } = await addCorpusCase([await source(directory, 'one.mp4')], { root });
    for (const outcome of ['partial', 'cancelled', 'failed', 'interrupted']) {
      const report = runReport(manifest);
      report.validation.completed = false; report.validation.outcome = outcome;
      report.result.read = 0; report.result.cards[0].review = ['장수 확인'];
      const bytes = Buffer.from(JSON.stringify(report));
      const saved = await storeCorpusRun(bytes, { root, id: manifest.id });
      assert.equal(saved.summary.classification, outcome); assert.equal(saved.summary.reportedOutcome, outcome);
      assert.equal(saved.summary.verification, 'unverified'); assert.equal(saved.summary.read, 0);
      assert.deepEqual(await readFile(join(root, ...saved.file.split('/'))), bytes);
    }
    assert.equal((await readdir(join(root, 'cases', manifest.id, 'runs'))).length, 4);
    assert.deepEqual(await manifestFile(root, manifest.id), manifest);
    assert.equal(manifest.baseline, null); assert.equal(manifest.expected, null);
  });
});

test('record-run exposes changed, unknown and inconsistent completion metadata without false completion', async () => {
  await fixture(async (directory, root) => {
    const { manifest } = await addCorpusCase([await source(directory, 'one.mp4')], { root });
    const report = runReport(manifest);
    const cases = [
      { value: { ...report, validation: { ...report.validation, sourceChanged: true } }, classification: 'source-changed', changed: true },
      { value: { ...report, validation: { ...report.validation, sourceEnd: { sourceDigest: hash('edited') } } }, classification: 'source-changed', changed: true },
      { value: { ...report, validation: { ...report.validation, sourceStart: null, sourceEnd: null } }, classification: 'source-unverified', changed: null },
      { value: { ...report, validation: { ...report.validation, sourceChanged: null } }, classification: 'source-unverified', changed: null },
      { value: { ...report, result: { ...report.result, read: 0 } }, classification: 'partial', changed: false },
      { value: { ...report, result: { ...report.result, expected: null } }, classification: 'partial', changed: false },
      { value: { ...report, validation: { ...report.validation, completed: false } }, classification: 'partial', changed: false },
      { value: { ...report, validation: { ...report.validation, outcome: 'new-unknown-outcome' } }, classification: 'unknown', changed: false },
    ];
    for (const item of cases) {
      const saved = await storeCorpusRun(Buffer.from(JSON.stringify(item.value)), { root, id: manifest.id });
      assert.equal(saved.summary.classification, item.classification); assert.equal(saved.summary.sourceChanged, item.changed);
      assert.equal(saved.summary.verification, 'unverified');
    }
    assert.deepEqual(await manifestFile(root, manifest.id), manifest);
  });
});

test('record-run rejects oversized, malformed UTF-8 and missing cases without creating a new corpus', async () => {
  await fixture(async (directory, root) => {
    const id = hash('no case'), check = (bytes: Uint8Array) => storeCorpusRun(bytes, { root, id });
    await assert.rejects(check(Buffer.alloc(MAX_CORPUS_RUN_BYTES + 1)), { code: 'CORPUS_RUN_TOO_LARGE' });
    for (const bytes of [Buffer.from([0xff]), Buffer.from('{'), Buffer.from('[]'), Buffer.from('null')])
      await assert.rejects(check(bytes), { code: 'CORPUS_RUN_INVALID' });
    await assert.rejects(storeCorpusRun('not bytes' as unknown as Uint8Array, { root, id }), { code: 'CORPUS_RUN_INVALID' });
    const report = { version: 1, result: { expected: null, read: 0, unidentified: 0, experience: null, cards: [] },
      validation: { caseId: id, input: [] } };
    await assert.rejects(check(Buffer.from(JSON.stringify(report))), { code: 'CORPUS_CASE_NOT_FOUND' });
    assert.deepEqual(await readdir(directory), []);
  });
});

test('record-run honors the common writer lock and refuses corrupt content-addressed files without overwrite', async () => {
  await fixture(async (directory, root) => {
    const { manifest } = await addCorpusCase([await source(directory, 'one.mp4')], { root });
    const bytes = Buffer.from(JSON.stringify(runReport(manifest))), lockPath = join(root, '.write.lock');
    await writeFile(lockPath, 'another writer');
    await assert.rejects(storeCorpusRun(bytes, { root, id: manifest.id }), { code: 'CORPUS_BUSY' });
    assert.equal(await readFile(lockPath, 'utf8'), 'another writer'); await rm(lockPath);
    const runs = join(root, 'cases', manifest.id, 'runs'); await mkdir(runs);
    const target = join(runs, `run-${hash(bytes)}.json`); await writeFile(target, 'corrupted');
    await assert.rejects(storeCorpusRun(bytes, { root, id: manifest.id }), { code: 'CORPUS_RUN_STORAGE' });
    assert.equal(await readFile(target, 'utf8'), 'corrupted');
    assert.deepEqual(await readdir(join(root, '.tmp')), []);
    assert.equal((await readdir(root)).includes('.write.lock'), false);
  });
});

test('record-run rejects junctions in the root, case and runs paths without writing outside the case', async (t) => {
  await fixture(async (directory, root) => {
    const { manifest } = await addCorpusCase([await source(directory, 'one.mp4')], { root });
    const bytes = Buffer.from(JSON.stringify(runReport(manifest))), outside = join(directory, 'outside'); await mkdir(outside);
    const pointer = join(directory, 'root-link');
    try { await symlink(root, pointer, process.platform === 'win32' ? 'junction' : 'dir'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'EPERM') { t.skip('Symlink permission unavailable'); return; } throw error; }
    await assert.rejects(storeCorpusRun(bytes, { root: pointer, id: manifest.id }), { code: 'CORPUS_RUN_STORAGE' });
    const casePath = join(root, 'cases', manifest.id), moved = `${casePath}-moved`;
    await rename(casePath, moved); await symlink(moved, casePath, process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(storeCorpusRun(bytes, { root, id: manifest.id }), { code: 'CORPUS_RUN_STORAGE' });
    await rm(casePath); await rename(moved, casePath);
    await symlink(outside, join(casePath, 'runs'), process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(storeCorpusRun(bytes, { root, id: manifest.id }), { code: 'CORPUS_RUN_STORAGE' });
    assert.deepEqual(await readdir(outside), []); assert.deepEqual(await readdir(join(root, '.tmp')), []);
    assert.equal((await readdir(root)).includes('.write.lock'), false);
  });
});

test('record-run CLI reads bounded regular files, emits a small archive receipt and performs no implicit truth promotion', async () => {
  await fixture(async (directory, root) => {
    const { manifest } = await addCorpusCase([await source(directory, 'one.mp4')], { root });
    const original = `  ${JSON.stringify(runReport(manifest))}\n`;
    const input = await source(directory, 'run.json', original), output: string[] = [];
    assert.equal(Buffer.from(await readCorpusBytes(input)).toString('utf8'), original);
    const write = (line: string) => output.push(line), previousExitCode = process.exitCode;
    assert.equal(await runCorpusCli(['record-run', manifest.id, input, '--root', root], write), 0);
    const first = JSON.parse(output.at(-1)!); assert.equal(first.created, true); assert.equal(first.summary.verification, 'unverified');
    assert.equal(output.join('').includes(directory), false); assert.equal(output.join('').includes('diagnostics'), false);
    assert.equal(process.exitCode, previousExitCode);
    const cli = resolve('scripts/scan-corpus.mjs');
    const repeated = await execFileAsync(process.execPath, [cli, 'record-run', manifest.id, input, '--root', root]);
    assert.equal(JSON.parse(repeated.stdout).created, false); assert.equal(repeated.stderr, '');
    assert.equal(await readFile(join(root, ...first.file.split('/')), 'utf8'), original);
    await assert.rejects(runCorpusCli(['record-run', manifest.id], write), /requires a case ID/);
    await assert.rejects(runCorpusCli(['record-run', manifest.id, input, input], write), /requires a case ID/);
    await assert.rejects(runCorpusCli(['record-run', manifest.id, input, '--scope', 'full'], write), /Unknown option/);
    await assert.rejects(runCorpusCli(['record-run', manifest.id, directory], write), /regular files/);
    const huge = join(directory, 'large.json'); await writeFile(huge, Buffer.alloc(MAX_CORPUS_RUN_BYTES + 1));
    await assert.rejects(runCorpusCli(['record-run', manifest.id, huge, '--root', root], write), /size limit/);
    await assert.rejects(execFileAsync(process.execPath, [cli, 'record-run', manifest.id, join(directory, 'private-missing.json'), '--root', root]), error => {
      const failure = error as Error & { stderr: string; code: number };
      assert.equal(failure.code, 1); assert.equal(failure.stderr.includes(directory), false); assert.equal(failure.stderr.includes('private-missing'), false);
      return true;
    });
    assert.deepEqual(await manifestFile(root, manifest.id), manifest);
  });
});
