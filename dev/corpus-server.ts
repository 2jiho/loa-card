import type { IncomingMessage, ServerResponse } from 'node:http';
import { BlockList, isIP } from 'node:net';
import { pipeline } from 'node:stream/promises';
import type { Plugin } from 'vite';
import { DEFAULT_CORPUS_ROOT, MAX_CORPUS_RUN_BYTES, listCorpusCases, openCorpusInput, readCorpusCase, storeCorpusRun } from '../scripts/scan-corpus-core.mjs';
import { snapshotSource } from './source-snapshot.ts';

const PREFIX = '/__corpus';
const loopbackPeers = new BlockList();
loopbackPeers.addSubnet('127.0.0.0', 8, 'ipv4');
loopbackPeers.addAddress('::1', 'ipv6');
const CASE = /^\/cases\/([a-f0-9]{64})(?:\/input\/(0|[1-9]\d{0,3}))?$/;
const RUN = /^\/cases\/([^/]+)\/runs$/;
const BODY_BLOCK_BYTES = 64 * 1024;
const MIME: Record<string, string> = {
  '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime', '.mkv': 'video/x-matroska',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.bmp': 'image/bmp', '.gif': 'image/gif',
  '.loareplay': 'application/octet-stream',
};

function json(response: ServerResponse, status: number, body: unknown) {
  response.statusCode = status;
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.end(JSON.stringify(body));
}

function isLoopbackPeer(address: string | undefined) {
  if (!address) return false;
  const family = isIP(address);
  // BlockList also matches IPv4-mapped IPv6 peers against the IPv4 subnet.
  return family !== 0 && loopbackPeers.check(address, family === 4 ? 'ipv4' : 'ipv6');
}

function byteRange(header: string | undefined, size: number): { start: number; end: number } | null {
  if (header === undefined) return size ? { start: 0, end: size - 1 } : { start: 0, end: -1 };
  const match = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!match || (!match[1] && !match[2]) || !size) return null;
  const first = Number(match[1]), last = Number(match[2]);
  if (!Number.isSafeInteger(first) || !Number.isSafeInteger(last)) return null;
  if (!match[1]) return last > 0 ? { start: Math.max(0, size - last), end: size - 1 } : null;
  const end = match[2] ? Math.min(last, size - 1) : size - 1;
  return first < size && first <= end ? { start: first, end } : null;
}

class RunBodyError extends Error {
  readonly status: number;
  constructor(status: number) { super('Invalid run request body.'); this.status = status; }
}

/** Fixed-size blocks bound both bytes and object count, even for tiny chunks.
 * Only a complete HTTP body can reach the immutable archive writer. */
function readRunBody(request: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const declared = request.headers['content-length'];
    if (declared !== undefined && (!/^\d+$/.test(declared) || !Number.isSafeInteger(Number(declared)))) {
      reject(new RunBodyError(400)); return;
    }
    if (declared !== undefined && Number(declared) > MAX_CORPUS_RUN_BYTES) { reject(new RunBodyError(413)); return; }
    if (request.aborted || request.destroyed) { reject(new RunBodyError(400)); return; }
    const blocks: Buffer[] = [];
    let bytes = 0, used = BODY_BLOCK_BYTES;
    const cleanup = () => {
      request.off('data', data); request.off('end', end); request.off('aborted', aborted);
      request.off('error', error); request.off('close', closed);
    };
    const fail = (status: number) => {
      cleanup(); blocks.length = 0; request.pause();
      // A disconnected IncomingMessage can emit an error after `aborted`.
      request.once('error', () => {});
      reject(new RunBodyError(status));
    };
    const data = (chunk: Buffer) => {
      if (bytes + chunk.length > MAX_CORPUS_RUN_BYTES) { fail(413); return; }
      let offset = 0;
      while (offset < chunk.length) {
        if (used === BODY_BLOCK_BYTES) { blocks.push(Buffer.allocUnsafe(BODY_BLOCK_BYTES)); used = 0; }
        const length = Math.min(BODY_BLOCK_BYTES - used, chunk.length - offset);
        chunk.copy(blocks[blocks.length - 1], used, offset, offset + length);
        offset += length; used += length;
      }
      bytes += chunk.length;
    };
    const end = () => {
      if (!request.complete || request.aborted || declared !== undefined && bytes !== Number(declared)) { fail(400); return; }
      cleanup(); resolve(Buffer.concat(blocks, bytes));
    };
    const aborted = () => fail(400);
    const error = () => fail(400);
    const closed = () => fail(400);
    request.on('data', data); request.once('end', end); request.once('aborted', aborted);
    request.once('error', error); request.once('close', closed);
  });
}

async function archiveRun(request: IncomingMessage, response: ServerResponse, id: string, root: string) {
  if (request.method !== 'POST') {
    response.setHeader('Allow', 'POST'); json(response, 405, { error: 'POST only.' }); return;
  }
  const rejectBody = (status: number, message: string) => {
    if (response.destroyed || request.aborted) return;
    // Do not drain an unbounded rejected upload or keep its connection alive.
    response.setHeader('Connection', 'close'); json(response, status, { error: message });
  };
  if (!/^[a-f0-9]{64}$/.test(id)) { rejectBody(400, 'Invalid corpus case ID.'); return; }
  const contentType = request.headers['content-type'];
  if (typeof contentType !== 'string' || !/^application\/json(?:\s*;\s*charset\s*=\s*(?:utf-8|"utf-8"))?\s*$/i.test(contentType.trim()) ||
      request.headers['content-encoding'] !== undefined && request.headers['content-encoding'] !== 'identity') {
    rejectBody(415, 'Use application/json with UTF-8 encoding.'); return;
  }
  try {
    const body = await readRunBody(request);
    if (request.aborted || response.destroyed || !request.complete) return;
    const result = await storeCorpusRun(body, { id, root });
    if (!response.destroyed) json(response, result.created ? 201 : 200, result);
  } catch (error) {
    if (response.destroyed || request.aborted) return;
    const code = (error as NodeJS.ErrnoException).code;
    const status = error instanceof RunBodyError ? error.status
      : code === 'CORPUS_RUN_TOO_LARGE' ? 413 : code === 'CORPUS_RUN_INVALID' ? 400
        : code === 'CORPUS_CASE_NOT_FOUND' ? 404 : code === 'CORPUS_BUSY' ? 409 : 500;
    const message = status === 413 ? 'Run report exceeds the 16 MiB limit.'
      : status === 400 ? 'Invalid or incomplete run report.' : status === 404 ? 'Corpus case is unavailable.'
        : status === 409 ? 'Corpus archive is busy. Retry later.' : 'Run report could not be archived.';
    rejectBody(status, message);
  }
}

/** Private development server: registered inputs are read-only; the sole write
 * appends an immutable run report to an existing case. No arbitrary paths. */
export async function serveCorpusRequest(request: IncomingMessage, response: ServerResponse, root = DEFAULT_CORPUS_ROOT, sourceRoot = process.cwd()) {
  const path = (request.url ?? '').split('?')[0];
  if (path !== PREFIX && !path.startsWith(`${PREFIX}/`)) return false;
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  // A LAN client can supply a matching Origin when Vite uses --host. The
  // transport peer must be local too; forwarding headers are never trusted.
  if (!isLoopbackPeer(request.socket?.remoteAddress)) {
    json(response, 403, { error: 'Loopback development access only.' }); return true;
  }
  // Avoid exposing private inputs to an unrelated website embedding a local URL.
  const origin = request.headers.origin;
  if (request.headers['sec-fetch-site'] === 'cross-site' ||
      (origin !== undefined && origin !== `http://${request.headers.host}` && origin !== `https://${request.headers.host}`)) {
    json(response, 403, { error: 'Same-origin development access only.' }); return true;
  }
  const route = path.slice(PREFIX.length), run = RUN.exec(route);
  if (run) { await archiveRun(request, response, run[1], root); return true; }
  if (request.method !== 'GET') {
    response.setHeader('Allow', 'GET'); json(response, 405, { error: 'GET only.' }); return true;
  }
  try {
    if (route === '/environment') {
      try { json(response, 200, await snapshotSource(sourceRoot)); }
      catch { json(response, 503, { error: 'Source snapshot unavailable or changed during reading. Retry after source edits stop.' }); }
      return true;
    }
    if (route === '' || route === '/') {
      const cases = (await listCorpusCases({ root })).map(item => ({
        id: item.id, name: item.name, kind: item.kind, createdAt: item.createdAt, inputs: item.inputs, bytes: item.bytes,
        source: { capturedAt: null, completeness: 'unknown' }, baseline: null, expected: null,
      }));
      json(response, 200, { cases, integrity: 'Run npm run corpus -- verify before comparing recognition results.' });
      return true;
    }
    const match = CASE.exec(route);
    if (!match) { json(response, 404, { error: 'Unknown corpus route.' }); return true; }
    const id = match[1];
    if (match[2] === undefined) {
      const manifest = await readCorpusCase({ root, id });
      json(response, 200, {
        version: manifest.version, id: manifest.id, name: manifest.name, kind: manifest.kind, createdAt: manifest.createdAt,
        source: { capturedAt: null, completeness: 'unknown' }, baseline: null, expected: null,
        inputs: manifest.inputs.map(input => ({ index: input.index, name: input.name, bytes: input.bytes, sha256: input.sha256,
          type: MIME[input.extension], url: `${PREFIX}/cases/${id}/input/${input.index}` })),
        integrity: 'Checksum verification is separate; run npm run corpus -- verify.',
      });
      return true;
    }
    const { handle, input } = await openCorpusInput({ root, id, index: Number(match[2]) });
    // The HTTP lifecycle owns this handle, including bad ranges and disconnects.
    try {
      if (response.destroyed || request.aborted) return true;
      const range = byteRange(request.headers.range, input.bytes);
      response.setHeader('Accept-Ranges', 'bytes');
      if (!range) {
        response.setHeader('Content-Range', `bytes */${input.bytes}`);
        json(response, 416, { error: 'Invalid byte range.' }); return true;
      }
      response.setHeader('Content-Type', MIME[input.extension]);
      response.setHeader('Content-Length', Math.max(0, range.end - range.start + 1));
      if (request.headers.range !== undefined) {
        response.statusCode = 206;
        response.setHeader('Content-Range', `bytes ${range.start}-${range.end}/${input.bytes}`);
      }
      if (!input.bytes) { response.end(); return true; }
      const stream = handle.createReadStream({ ...range, autoClose: false });
      // pipeline destroys the source when the browser cancels a seek/request.
      await pipeline(stream, response);
    } finally { await handle.close(); }
  } catch {
    if (response.headersSent || response.destroyed) response.destroy();
    else json(response, 404, { error: 'Corpus input is unavailable or invalid. Run npm run corpus -- verify.' });
  }
  return true;
}

export function corpusServerPlugin(root = DEFAULT_CORPUS_ROOT): Plugin {
  return {
    name: 'local-scan-corpus', apply: 'serve',
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        void serveCorpusRequest(request, response, root, server.config.root).then(handled => { if (!handled) next(); }).catch(() => response.destroy());
      });
    },
  };
}
