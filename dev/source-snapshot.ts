import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';

const execute = promisify(execFile);
export const SOURCE_READ_BUFFER_BYTES = 256 * 1024;
export const SOURCE_SNAPSHOT_SCOPE = [
  'src', 'dev', 'public/scanner', 'package.json', 'package-lock.json', 'vite.config.ts',
  'tsconfig.json', 'tsconfig.app.json', 'tsconfig.node.json',
  'scripts/scan-corpus-core.mjs', 'scripts/scan-case-results.mjs', 'scripts/scan-corpus.mjs',
  'scripts/scan-human-expected.mjs',
  'scripts/prepare-ocr-assets.mjs', 'licenses/third-party/manifest.json',
] as const;

export interface SourceSnapshot {
  version: 1;
  sourceDigest: string;
  capturedAt: string;
  git: { head: string; dirty: boolean | 'unknown' };
  files: number;
  bytes: number;
  durationMs: number;
  readBufferBytes: number;
  scope: string[];
}
type FileEntry = { path: string; bytes: number; mtimeMs: number; ctimeMs: number; dev: number; ino: number };

async function checkedPath(root: string, path: string) {
  const local = relative(root, path);
  if (isAbsolute(local) || local === '..' || local.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`))
    throw new Error('Source snapshot path escaped its root.');
  // Reject symlinks/junctions rather than silently omitting recognition inputs.
  const stat = await lstat(path);
  if (stat.isSymbolicLink() || await realpath(path) !== path) throw new Error('Source snapshot cannot follow linked paths.');
  return stat;
}

async function sourceFiles(root: string): Promise<FileEntry[]> {
  const files: FileEntry[] = [];
  async function visit(path: string) {
    const stat = await checkedPath(root, path);
    if (stat.isDirectory()) {
      for (const name of (await readdir(path)).sort()) await visit(join(path, name));
    } else if (stat.isFile()) {
      files.push({ path: relative(root, path).replaceAll('\\', '/'), bytes: stat.size,
        mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs, dev: stat.dev, ino: stat.ino });
    } else throw new Error('Source snapshot accepts regular files only.');
  }
  for (const entry of SOURCE_SNAPSHOT_SCOPE) await visit(join(root, entry));
  return files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}

async function gitState(root: string): Promise<SourceSnapshot['git']> {
  const options = { cwd: root, encoding: 'utf8' as const, timeout: 5000, maxBuffer: 1024 * 1024, windowsHide: true };
  let head = 'unknown';
  try {
    const revision = (await execute('git', ['rev-parse', '--verify', 'HEAD'], options)).stdout.trim();
    if (/^[a-f0-9]{40,64}$/.test(revision)) head = revision;
  } catch { /* Source archives are also valid development inputs. */ }
  try {
    return { head, dirty: (await execute('git', ['status', '--porcelain', '--untracked-files=normal'], options)).stdout.trim().length > 0 };
  } catch { return { head, dirty: 'unknown' }; }
}

/** A filesystem snapshot taken at run boundaries, not the Vite startup hash.
 * Hashes relative names, lengths and streamed bytes, including untracked source.
 * The payload buffer is fixed-size; original media and generated OCR binaries
 * are excluded. Pinned model hashes and dependency versions are included. */
export async function snapshotSource(directory = process.cwd()): Promise<SourceSnapshot> {
  const started = performance.now();
  const supplied = resolve(directory);
  if ((await lstat(supplied)).isSymbolicLink()) throw new Error('Source snapshot root cannot be linked.');
  const root = await realpath(supplied);
  const files = await sourceFiles(root);
  const digest = createHash('sha256').update('loacard-source-snapshot-v1\0');
  const buffer = Buffer.allocUnsafe(SOURCE_READ_BUFFER_BYTES);
  let bytes = 0;
  for (const entry of files) {
    const path = join(root, entry.path);
    const stat = await checkedPath(root, path);
    if (!stat.isFile() || stat.dev !== entry.dev || stat.ino !== entry.ino || stat.size !== entry.bytes ||
        stat.mtimeMs !== entry.mtimeMs || stat.ctimeMs !== entry.ctimeMs) throw new Error('Source changed while taking snapshot.');
    const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const before = await handle.stat();
      if (!before.isFile() || before.dev !== entry.dev || before.ino !== entry.ino || before.size !== entry.bytes ||
          before.mtimeMs !== entry.mtimeMs || before.ctimeMs !== entry.ctimeMs) throw new Error('Source changed while taking snapshot.');
      digest.update(JSON.stringify([entry.path, entry.bytes])).update('\0');
      let position = 0;
      while (position < entry.bytes) {
        const read = await handle.read(buffer, 0, Math.min(buffer.length, entry.bytes - position), position);
        if (!read.bytesRead) throw new Error('Source changed while taking snapshot.');
        digest.update(buffer.subarray(0, read.bytesRead)); position += read.bytesRead;
      }
      const after = await handle.stat();
      if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs)
        throw new Error('Source changed while taking snapshot.');
      bytes += position;
    } finally { await handle.close(); }
  }
  // Detect additions, deletions, replacements and renames during the read too.
  if (JSON.stringify(files) !== JSON.stringify(await sourceFiles(root))) throw new Error('Source changed while taking snapshot.');
  const git = await gitState(root);
  return { version: 1, sourceDigest: digest.digest('hex'), capturedAt: new Date().toISOString(), git,
    files: files.length, bytes, durationMs: performance.now() - started, readBufferBytes: buffer.length,
    scope: [...SOURCE_SNAPSHOT_SCOPE] };
}
