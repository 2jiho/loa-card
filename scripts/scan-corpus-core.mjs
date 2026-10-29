import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { link, lstat, mkdir, open, readdir, rename, rm, unlink } from 'node:fs/promises';
import { basename, extname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import { parseScanResult } from './scan-case-results.mjs';

export const DEFAULT_CORPUS_ROOT = 'fixtures/local/corpus';
export const MAX_CORPUS_RUN_BYTES = 16 * 1024 * 1024;
const HASH = /^[a-f0-9]{64}$/;
const MAX_INPUTS = 1_000;
const MAX_MANIFEST_BYTES = 2 * 1024 * 1024;
const EXTENSIONS = {
  video: new Set(['.mp4', '.webm', '.mov', '.m4v', '.mkv']),
  images: new Set(['.png', '.jpg', '.jpeg', '.webp', '.bmp', '.gif']),
  replay: new Set(['.loareplay']),
};

function fail(message) { throw new Error(message); }
function contained(parent, child) {
  const remainder = relative(parent, child);
  return remainder !== '' && !isAbsolute(remainder) && remainder !== '..' && !remainder.startsWith(`..${sep}`);
}
function validId(id) {
  if (typeof id !== 'string' || !HASH.test(id)) fail('Case ID must be a complete lowercase SHA-256 digest.');
  return id;
}

// Reject symlinks/junctions in every existing component, including an explicit root.
// This is a local single-writer store, not a security boundary against a process
// concurrently replacing directories. Never follow manifest-provided paths.
async function safePath(path, { create = false, missing = false } = {}) {
  const absolute = resolve(path);
  let current = parse(absolute).root;
  const components = relative(current, absolute).split(sep).filter(Boolean);
  for (let index = 0; index < components.length; index += 1) {
    current = join(current, components[index]);
    let stat;
    try { stat = await lstat(current); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      if (create) {
        try { await mkdir(current); } catch (creationError) { if (creationError.code !== 'EEXIST') throw creationError; }
        stat = await lstat(current);
      } else if (missing) return false;
      else fail('A corpus or input path does not exist.');
    }
    if (stat.isSymbolicLink()) fail('Symlinks and junctions are not allowed in corpus or input paths.');
    if ((create || index < components.length - 1) && !stat.isDirectory()) fail('A path component is not a directory.');
  }
  return true;
}

async function readHandle(path) {
  await safePath(path);
  const before = await lstat(path);
  if (!before.isFile()) fail('Input and corpus objects must be regular files.');
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const actual = await handle.stat();
    if (!actual.isFile() || before.dev !== actual.dev || before.ino !== actual.ino) fail('A file changed while it was being opened.');
    return { handle, before: actual };
  } catch (error) { await handle.close(); throw error; }
}

async function digestFile(path, copyTo) {
  const { handle, before } = await readHandle(path);
  const hash = createHash('sha256');
  let bytes = 0;
  let output;
  try {
    if (copyTo) output = await open(copyTo, 'wx');
    const buffer = Buffer.allocUnsafe(256 * 1024);
    // A single bounded buffer streams both hashing and copying, independent of file size.
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      hash.update(buffer.subarray(0, bytesRead)); bytes += bytesRead;
      if (output) {
        let offset = 0;
        while (offset < bytesRead) {
          const { bytesWritten } = await output.write(buffer, offset, bytesRead - offset, null);
          if (!bytesWritten) fail('Copy did not make progress.');
          offset += bytesWritten;
        }
      }
    }
    await output?.sync();
    const after = await handle.stat();
    if (before.size !== bytes || after.size !== bytes || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
      fail('An input changed during registration or verification; retry with a stable file.');
    }
    return { sha256: hash.digest('hex'), bytes };
  } finally { try { await output?.close(); } finally { await handle.close(); } }
}

function chooseKind(files, requested) {
  const kind = requested ?? (files.every(path => EXTENSIONS.images.has(extname(path).toLowerCase())) ? 'images'
    : files.length === 1 && EXTENSIONS.replay.has(extname(files[0]).toLowerCase()) ? 'replay' : 'video');
  if (!Object.hasOwn(EXTENSIONS, kind)) fail('Kind must be video, images, or replay.');
  if (kind !== 'images' && files.length !== 1) fail('A video or replay case requires exactly one input; use separate cases.');
  if (files.some(path => !EXTENSIONS[kind].has(extname(path).toLowerCase()))) fail('Input extension does not match the case kind.');
  return kind;
}

export function corpusCaseId(kind, orderedHashes) {
  if (typeof kind !== 'string' || !Object.hasOwn(EXTENSIONS, kind) || !Array.isArray(orderedHashes) || !orderedHashes.length || orderedHashes.length > MAX_INPUTS
    || Array.from(orderedHashes).some(hash => typeof hash !== 'string' || !HASH.test(hash))) {
    fail('Invalid case identity.');
  }
  // Input order and repeats are part of the replay contract. Only stored bytes deduplicate.
  return createHash('sha256').update(JSON.stringify({ version: 1, kind, inputs: orderedHashes })).digest('hex');
}

function inputPath(index, extension) { return `input/${String(index + 1).padStart(4, '0')}${extension}`; }
function summary(manifest) {
  return { id: manifest.id, name: manifest.name, kind: manifest.kind, createdAt: manifest.createdAt,
    inputs: manifest.inputs.length, bytes: manifest.inputs.reduce((sum, input) => sum + input.bytes, 0),
    source: manifest.source, baseline: manifest.baseline, expected: manifest.expected };
}

/** Read bounded original bytes without following a symlink or reading a device. */
export async function readCorpusBytes(path, maxBytes = MAX_CORPUS_RUN_BYTES) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_CORPUS_RUN_BYTES) fail('Invalid JSON size limit.');
  const { handle, before } = await readHandle(path);
  try {
    if (before.size > maxBytes) fail('JSON input exceeds its size limit.');
    const buffer = Buffer.allocUnsafe(before.size + 1);
    let bytes = 0;
    for (;;) {
      const { bytesRead } = await handle.read(buffer, bytes, buffer.length - bytes, null);
      bytes += bytesRead;
      if (bytes > before.size) fail('JSON input changed while it was being read.');
      if (!bytesRead) break;
    }
    const after = await handle.stat();
    if (bytes !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) {
      fail('JSON input changed while it was being read.');
    }
    return buffer.subarray(0, bytes);
  } finally { await handle.close(); }
}

/** Bounded JSON input used by the CLI; cannot follow a symlink or read a device. */
export async function readCorpusJson(path, maxBytes = MAX_CORPUS_RUN_BYTES) {
  return JSON.parse((await readCorpusBytes(path, maxBytes)).toString('utf8'));
}

async function readManifest(root, id) {
  validId(id);
  const manifest = await readCorpusJson(join(root, 'cases', id, 'manifest.json'), MAX_MANIFEST_BYTES);
  if (!manifest || manifest.version !== 1 || manifest.id !== id || !Object.hasOwn(EXTENSIONS, manifest.kind)
    || typeof manifest.name !== 'string' || !manifest.name.trim() || manifest.name.length > 200 || /[\r\n\0]/.test(manifest.name)
    || typeof manifest.createdAt !== 'string' || !Number.isFinite(Date.parse(manifest.createdAt))
    || new Date(manifest.createdAt).toISOString() !== manifest.createdAt
    || manifest.source?.capturedAt !== null || manifest.source?.completeness !== 'unknown'
    || manifest.baseline !== null || manifest.expected !== null
    || !Array.isArray(manifest.inputs) || !manifest.inputs.length || manifest.inputs.length > MAX_INPUTS
    || (manifest.kind !== 'images' && manifest.inputs.length !== 1)) {
    fail('Invalid corpus manifest.');
  }
  for (const [index, input] of manifest.inputs.entries()) {
    if (!input || input.index !== index || typeof input.sha256 !== 'string' || !HASH.test(input.sha256)
      || !Number.isSafeInteger(input.bytes) || input.bytes < 0 || typeof input.name !== 'string' || !input.name || /[/\\\0]/.test(input.name)
      || typeof input.extension !== 'string' || !EXTENSIONS[manifest.kind].has(input.extension)
      || input.path !== inputPath(index, input.extension) || input.object !== `objects/${input.sha256}`) {
      fail('Invalid corpus input reference; paths must remain inside the case and object store.');
    }
  }
  if (manifest.id !== corpusCaseId(manifest.kind, manifest.inputs.map(input => input.sha256))) fail('Manifest case identity does not match its ordered inputs.');
  return manifest;
}

async function objectMatches(root, input) {
  const digest = await digestFile(join(root, 'objects', input.sha256));
  if (digest.sha256 !== input.sha256 || digest.bytes !== input.bytes) fail('Object checksum mismatch.');
}

/** Register one ordered input sequence. Never creates an expected result or edits an existing case. */
export async function addCorpusCase(files, { root = DEFAULT_CORPUS_ROOT, name, kind: requestedKind } = {}) {
  if (!Array.isArray(files) || !files.length || files.length > MAX_INPUTS || Array.from(files).some(path => typeof path !== 'string' || !path)) {
    fail(`Provide between 1 and ${MAX_INPUTS} input files.`);
  }
  const kind = chooseKind(files, requestedKind);
  const label = name === undefined ? basename(files[0]) : name;
  if (typeof label !== 'string' || !label.trim() || label.length > 200 || /[\r\n\0]/.test(label)) fail('Case name must be a short non-empty single line.');
  const corpus = resolve(root);
  // Validate the entire input list before creating the store or writing any bytes.
  for (const file of files) {
    if (resolve(file) === corpus || contained(corpus, resolve(file))) fail('Register source files outside the corpus root.');
    const { handle } = await readHandle(file); await handle.close();
  }
  await safePath(corpus, { create: true });
  await safePath(join(corpus, 'objects'), { create: true });
  await safePath(join(corpus, 'cases'), { create: true });
  await safePath(join(corpus, '.tmp'), { create: true });
  const lockPath = join(corpus, '.write.lock');
  let lock;
  try { lock = await open(lockPath, 'wx'); }
  catch (error) { if (error.code === 'EEXIST') fail('Corpus is busy (.write.lock exists); do not remove the lock while a writer is active.'); throw error; }
  const stage = join(corpus, '.tmp', randomUUID());
  const createdObjects = [];
  let committed = false;
  try {
    await mkdir(stage);
    const inputs = [];
    const staged = new Map();
    for (const [index, file] of files.entries()) {
      const temporary = join(stage, `source-${index}`);
      // One pass captures the bytes and their identity together; never hash then copy the source again.
      const digest = await digestFile(file, temporary);
      const extension = extname(file).toLowerCase();
      const input = { index, name: basename(file), ...digest, extension, path: inputPath(index, extension), object: `objects/${digest.sha256}` };
      inputs.push(input);
      if (!staged.has(digest.sha256)) staged.set(digest.sha256, { temporary, input });
      else await unlink(temporary);
    }
    const id = corpusCaseId(kind, inputs.map(input => input.sha256));
    const destination = join(corpus, 'cases', id);
    if (await safePath(destination, { missing: true })) {
      const existing = await readManifest(corpus, id);
      await verifyCase(corpus, existing);
      return { created: false, manifest: existing };
    }
    for (const { temporary, input } of staged.values()) {
      const object = join(corpus, 'objects', input.sha256);
      try {
        // link is exclusive and atomic; never replace an existing content-addressed object.
        await link(temporary, object);
        createdObjects.push(object);
      } catch (error) {
        if (error.code !== 'EEXIST') fail('The corpus filesystem must support hardlinks; no duplicate-copy fallback was used.');
        await objectMatches(corpus, input);
      }
    }
    const caseStage = join(stage, 'case');
    await mkdir(caseStage); await mkdir(join(caseStage, 'input'));
    for (const input of inputs) {
      await safePath(join(corpus, 'objects', input.sha256));
      await link(join(corpus, 'objects', input.sha256), join(caseStage, ...input.path.split('/')));
    }
    const manifest = { version: 1, id, name: label.trim(), kind, createdAt: new Date().toISOString(),
      source: { capturedAt: null, completeness: 'unknown' }, inputs, baseline: null, expected: null };
    const manifestFile = await open(join(caseStage, 'manifest.json'), 'wx');
    try { await manifestFile.writeFile(`${JSON.stringify(manifest, null, 2)}\n`); await manifestFile.sync(); }
    finally { await manifestFile.close(); }
    await rename(caseStage, destination);
    committed = true;
    return { created: true, manifest };
  } finally {
    // Only this invocation's UUID directory and newly created objects are eligible for rollback.
    try {
      if (!contained(join(corpus, '.tmp'), stage)) fail('Unsafe staging cleanup path.');
      await rm(stage, { recursive: true, force: true });
      if (!committed) for (const object of createdObjects) await unlink(object);
    } finally { await lock.close(); await unlink(lockPath); }
  }
}

/** Read manifest summaries only; this does not claim to verify the input bytes. */
export async function listCorpusCases({ root = DEFAULT_CORPUS_ROOT } = {}) {
  const corpus = resolve(root);
  if (!await safePath(corpus, { missing: true }) || !await safePath(join(corpus, 'cases'), { missing: true })) return [];
  const entries = await readdir(join(corpus, 'cases'), { withFileTypes: true });
  const cases = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!HASH.test(entry.name)) continue;
    if (!entry.isDirectory()) fail('A corpus case must be a regular directory.');
    cases.push(summary(await readManifest(corpus, entry.name)));
  }
  return cases;
}

/** Read the validated manifest without following caller-provided input paths. */
export async function readCorpusCase({ root = DEFAULT_CORPUS_ROOT, id } = {}) {
  return readManifest(resolve(root), id);
}

/** Sanitized errors suitable for both the CLI and the loopback-only dev route. */
export class CorpusRunError extends Error {
  constructor(code, message) { super(message); this.name = 'CorpusRunError'; this.code = code; }
}

function invalidRun(message) { throw new CorpusRunError('CORPUS_RUN_INVALID', message); }
async function releaseRunWriter(corpus, stage, lock, lockPath, preserveFailure) {
  try {
    try {
      if (stage) {
        if (!contained(join(corpus, '.tmp'), stage)) fail('Unsafe run staging cleanup path.');
        await rm(stage, { recursive: true, force: true });
      }
    } finally {
      if (lock) { try { await lock.close(); } finally { await unlink(lockPath); } }
    }
  } catch {
    // A secondary cleanup error must not hide the primary validation/storage
    // failure. On the success path, failed cleanup must still be reported.
    if (!preserveFailure) throw new CorpusRunError('CORPUS_RUN_STORAGE', 'Run report storage cleanup failed; inspect the corpus before retrying.');
  }
}
function runSummary(report, result) {
  const validation = report.validation;
  const outcomes = ['completed', 'partial', 'cancelled', 'failed', 'interrupted', 'source-changed', 'source-unverified'];
  const reportedOutcome = outcomes.includes(validation.outcome) ? validation.outcome : 'unknown';
  const start = validation.sourceStart?.sourceDigest, end = validation.sourceEnd?.sourceDigest;
  const digestsKnown = typeof start === 'string' && HASH.test(start) && typeof end === 'string' && HASH.test(end);
  const sourceChanged = validation.sourceChanged === true || reportedOutcome === 'source-changed' || digestsKnown && start !== end
    ? true : validation.sourceChanged === false && digestsKnown ? false : null;
  let classification = reportedOutcome;
  if (sourceChanged) classification = 'source-changed';
  else if (reportedOutcome === 'completed') {
    if (validation.completed !== true || result.expected === null || result.read !== result.expected || result.cards.length !== result.expected
      || result.unidentified || result.cards.some(card => card.review.length || card.awakening === null || card.extraCopies === null)) classification = 'partial';
    else if (sourceChanged === null) classification = 'source-unverified';
  }
  // Even matching source digests and complete program observations are not
  // independently verified expected values. Never promote a run to truth.
  return { classification, reportedOutcome, sourceChanged, verification: 'unverified',
    cards: result.cards.length, expected: result.expected, read: result.read, unidentified: result.unidentified };
}

/** Archive one immutable report for an existing ordered input case. Input
 * metadata is checked against its manifest; media bytes are not rehashed here. */
export async function storeCorpusRun(bytes, { id, root = DEFAULT_CORPUS_ROOT } = {}) {
  if (!(bytes instanceof Uint8Array)) invalidRun('Run report must be UTF-8 bytes.');
  if (bytes.byteLength > MAX_CORPUS_RUN_BYTES) throw new CorpusRunError('CORPUS_RUN_TOO_LARGE', 'Run report exceeds the 16 MiB size limit.');
  if (typeof id !== 'string' || !HASH.test(id)) invalidRun('Case ID must be a complete lowercase SHA-256 digest.');
  // Own the snapshot before the first await: the caller may reuse its request
  // buffer while validation/storage is pending. Hash and store these same bytes.
  const snapshot = Buffer.from(bytes);
  let report, result;
  try { report = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(snapshot)); }
  catch { invalidRun('Run report must contain valid UTF-8 JSON.'); }
  if (!report || typeof report !== 'object' || Array.isArray(report) || report.version !== 1 || !Object.hasOwn(report, 'result')) {
    invalidRun('Run report must have version 1 and a result.');
  }
  try { result = parseScanResult(report.result); }
  catch { invalidRun('Run report contains an invalid scan result.'); }
  const validation = report.validation;
  if (!validation || typeof validation !== 'object' || Array.isArray(validation) || validation.caseId !== id) {
    invalidRun('Run report case ID does not match the requested case.');
  }
  if (Object.hasOwn(validation, 'completed') && typeof validation.completed !== 'boolean'
    || Object.hasOwn(validation, 'sourceChanged') && validation.sourceChanged !== null && typeof validation.sourceChanged !== 'boolean') {
    invalidRun('Run report contains invalid completion or source metadata.');
  }
  const corpus = resolve(root), destination = join(corpus, 'cases', id);
  let lock, stage, failed = false;
  const lockPath = join(corpus, '.write.lock');
  try {
    if (!await safePath(join(destination, 'manifest.json'), { missing: true })) {
      throw new CorpusRunError('CORPUS_CASE_NOT_FOUND', 'The requested corpus case does not exist.');
    }
    const manifest = await readManifest(corpus, id);
    if (!Array.isArray(validation.input) || validation.input.length !== manifest.inputs.length || validation.input.some((input, index) =>
      !input || input.index !== index || input.sha256 !== manifest.inputs[index].sha256 || input.bytes !== manifest.inputs[index].bytes)) {
      invalidRun('Run report inputs do not match the case input sequence, hashes, and sizes.');
    }
    try { lock = await open(lockPath, 'wx'); }
    catch (error) {
      if (error.code === 'EEXIST') throw new CorpusRunError('CORPUS_BUSY', 'Corpus is busy; another writer holds the lock.');
      throw error;
    }
    const sha256 = createHash('sha256').update(snapshot).digest('hex');
    const file = `cases/${id}/runs/run-${sha256}.json`;
    const target = join(corpus, ...file.split('/'));
    const summary = runSummary(report, result);
    const existing = async () => {
      const saved = await readCorpusBytes(target);
      if (!snapshot.equals(saved)) throw new CorpusRunError('CORPUS_RUN_STORAGE', 'Existing run report does not match its content address.');
      return { created: false, id, sha256, file, summary };
    };
    if (await safePath(target, { missing: true })) return await existing();
    await safePath(join(destination, 'runs'), { create: true });
    await safePath(join(corpus, '.tmp'), { create: true });
    const staging = join(corpus, '.tmp', randomUUID());
    await mkdir(staging); stage = staging;
    const temporary = join(stage, 'run.json');
    const handle = await open(temporary, 'wx');
    try { await handle.writeFile(snapshot); await handle.sync(); }
    finally { await handle.close(); }
    try { await link(temporary, target); }
    catch (error) {
      if (error.code === 'EEXIST') return await existing();
      throw new CorpusRunError('CORPUS_RUN_STORAGE', 'The corpus filesystem must support atomic hardlinks for run storage.');
    }
    return { created: true, id, sha256, file, summary };
  } catch (error) {
    failed = true;
    if (error instanceof CorpusRunError) throw error;
    throw new CorpusRunError('CORPUS_RUN_STORAGE', 'Run report storage failed; check corpus paths and permissions.');
  } finally {
    await releaseRunWriter(corpus, stage, lock, lockPath, failed);
  }
}

/** Open one validated stored input. The caller owns and must close the handle.
 * This checks its size and regular-file identity, not its checksum; run verify
 * before recognition comparisons to verify the full stored byte sequence. */
export async function openCorpusInput({ root = DEFAULT_CORPUS_ROOT, id, index } = {}) {
  const corpus = resolve(root);
  const manifest = await readManifest(corpus, id);
  if (!Number.isSafeInteger(index) || index < 0 || index >= manifest.inputs.length) fail('Invalid corpus input index.');
  const input = manifest.inputs[index];
  const opened = await readHandle(join(corpus, 'cases', manifest.id, ...input.path.split('/')));
  if (opened.before.size !== input.bytes) {
    await opened.handle.close();
    fail('Case input size mismatch; verify the corpus before testing.');
  }
  return { handle: opened.handle, input };
}

async function verifyCase(root, manifest, verifiedObjects = new Set()) {
  for (const input of manifest.inputs) {
    if (!verifiedObjects.has(input.sha256)) {
      await objectMatches(root, input); verifiedObjects.add(input.sha256);
    }
    const digest = await digestFile(join(root, 'cases', manifest.id, ...input.path.split('/')));
    if (digest.sha256 !== input.sha256 || digest.bytes !== input.bytes) fail('Case input checksum mismatch.');
  }
}

/** Verify persisted bytes and ordered case identity, never recognition accuracy. */
export async function verifyCorpus({ root = DEFAULT_CORPUS_ROOT, id } = {}) {
  const corpus = resolve(root);
  await safePath(corpus);
  const ids = id === undefined ? (await listCorpusCases({ root: corpus })).map(item => item.id) : [validId(id)];
  const objects = new Set();
  let inputs = 0;
  let bytes = 0;
  for (const caseId of ids) {
    const manifest = await readManifest(corpus, caseId);
    await verifyCase(corpus, manifest, objects);
    inputs += manifest.inputs.length;
    bytes += manifest.inputs.reduce((sum, input) => sum + input.bytes, 0);
  }
  return { verified: true, cases: ids.length, inputs, objects: objects.size, bytes };
}
