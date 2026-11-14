import type { IncomingMessage, ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { BlockList, isIP } from 'node:net';
import { pipeline } from 'node:stream/promises';
import type { Plugin } from 'vite';
import { DEFAULT_CORPUS_ROOT, MAX_CORPUS_RUN_BYTES, listCorpusCases, openCorpusInput, readCorpusCase, storeCorpusRun } from '../scripts/scan-corpus-core.mjs';
import { snapshotSource } from './source-snapshot.ts';
import {archiveReplayRequest,replayReaderFromSource,rawSessionReaderFromSource,ReplayArchiveError} from './replay-archive.ts';
import type {ReplayReader} from './replay-archive.ts';
import {archiveDirectInput,DirectArchiveError} from './direct-input-archive.ts';

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
  '.loareplay': 'application/octet-stream', '.loaraw': 'application/octet-stream',
};

function json(response: ServerResponse, status: number, body: unknown) {
  response.statusCode = status;
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.end(JSON.stringify(body));
}

// Allow a small eager request body to finish before closing the connection so
// the browser receives the rejection rather than a TCP reset. Never wait for
// oversized or streaming bodies, and bound the wait for stalled clients.
function rejectReplayBody(request: IncomingMessage, response: ServerResponse, status: number, message: string) {
  if (response.destroyed || request.aborted) return;
  response.setHeader('Connection', 'close');
  const length = request.headers['content-length'];
  if (!request.complete && length && /^\d+$/.test(length) && Number(length) <= BODY_BLOCK_BYTES) {
    let timer: ReturnType<typeof setTimeout>;
    const finish = () => {
      clearTimeout(timer);request.off('end',finish);request.off('aborted',finish);
      if (!response.destroyed && !request.aborted && !response.writableEnded) json(response,status,{error:message});
    };
    request.once('end',finish);request.once('aborted',finish);
    timer=setTimeout(finish,500);timer.unref();request.resume();return;
  }
  json(response,status,{error:message});
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

/** The upload writes only a server-named private file. Require an explicit
 * same-origin browser origin and a literal local Host to prevent a remote DNS
 * rebinding name from using the loopback peer check as write authorization. */
async function archiveReplay(request:IncomingMessage,response:ServerResponse,root:string,readReplay:ReplayReader,kind:'replay'|'raw-session'='replay'){
 const reject=(status:number,message:string)=>{
  if(response.destroyed||request.aborted)return;
  rejectReplayBody(request,response,status,message);
 };
 if(request.method!=='POST'){response.setHeader('Allow','POST');reject(405,'POST only.');return;}
 const host=request.headers.host,origin=request.headers.origin;
 const hostMatch=typeof host==='string'?/^(?:localhost|127\.0\.0\.1|\[::1\])(?::([1-9]\d{0,4}))?$/i.exec(host):null;
 const scheme=(request.socket as typeof request.socket & {encrypted?:boolean})?.encrypted?'https':'http';
 if(!hostMatch||hostMatch[1]&&Number(hostMatch[1])>65535||typeof origin!=='string'||
   origin!==`${scheme}://${host}`){reject(403,'Local same-origin access only.');return;}
 const type=request.headers['content-type'];
 if(typeof type!=='string'||type.trim().toLowerCase()!=='application/octet-stream'||
  request.headers['content-encoding']!==undefined&&request.headers['content-encoding']!=='identity'){
  reject(415,'Use an uncompressed replay binary.');return;
 }
 const controller=new AbortController();
 const disconnected=()=>{if(!response.writableFinished)controller.abort();};
 response.once('close',disconnected);
 try{
  const result=await archiveReplayRequest(request,root,readReplay,controller.signal,{kind});
  if(!response.destroyed)json(response,result.created?201:200,result);
 }catch(error){
  const busy=error instanceof Error&&/Corpus is busy/.test(error.message);
  const status=error instanceof ReplayArchiveError?error.status:busy?409:500;
  reject(status,status===409?'Replay archive is busy.':status===413?'Replay exceeds the archive limit.':
   status===400?'Invalid or incomplete replay.':status===408?'Replay upload timed out.':'Replay could not be archived.');
 }finally{response.off('close',disconnected);}
}

async function archiveDirect(request:IncomingMessage,response:ServerResponse,root:string,readReplay:ReplayReader){
 const reject=(status:number,message:string)=>{if(!response.destroyed&&!request.aborted)rejectReplayBody(request,response,status,message);};
 if(request.method!=='POST'){response.setHeader('Allow','POST');reject(405,'POST only.');return;}
 const host=request.headers.host,origin=request.headers.origin;
 const match=typeof host==='string'?/^(?:localhost|127\.0\.0\.1|\[::1\])(?::([1-9]\d{0,4}))?$/i.exec(host):null;
 const scheme=(request.socket as typeof request.socket & {encrypted?:boolean})?.encrypted?'https':'http';
 if(!match||match[1]&&Number(match[1])>65535||typeof origin!=='string'||origin!==`${scheme}://${host}`){reject(403,'Local same-origin access only.');return;}
 const type=request.headers['content-type'];
 if(typeof type!=='string'||type.trim().toLowerCase()!=='application/octet-stream'||
  request.headers['content-encoding']!==undefined&&request.headers['content-encoding']!=='identity'){
  reject(415,'Use an uncompressed direct input binary.');return;
 }
 const controller=new AbortController(),disconnected=()=>{if(!response.writableFinished)controller.abort();};
 response.once('close',disconnected);
 try{const result=await archiveDirectInput(request,root,readReplay,controller.signal);if(!response.destroyed)json(response,result.created?201:200,result);}
 catch(error){const busy=error instanceof Error&&/Corpus is busy/.test(error.message);
  const conflict=error instanceof Error&&error.message==='Input selection ID conflicts with an existing record.';
  const status=error instanceof DirectArchiveError?error.status:busy||conflict?409:500;
  reject(status,conflict?'Input selection conflicts with a prior record.':status===409?'Input archive is busy.':status===413?'Input exceeds the archive limit.':status===400?'Invalid or incomplete input.':
   status===408?'Input upload timed out.':'Input could not be archived.');
 }finally{response.off('close',disconnected);}
}

/** Dev-only presentation timing upload. Writes one server-named JSON file so a
 * manual Chrome/Edge share can be inspected without exposing a path parameter. */
const GRID_MANIFEST_MAX_BYTES=2*1024*1024;
const RESCUE_PROOF_MAX_BYTES=1024*1024;
/** Dev-only storage for the evidence-only fixed-row rescue proof. */
async function archiveFixedRowRescueProof(request:IncomingMessage,response:ServerResponse,sourceRoot:string){
 if(request.method!=='POST'){response.setHeader('Allow','POST');json(response,405,{error:'POST only.'});return;}
 const type=request.headers['content-type'];
 if(typeof type!=='string'||!type.toLowerCase().startsWith('application/json')){json(response,415,{error:'Use application/json.'});return;}
 const length=request.headers['content-length'];
 if(length!==undefined&&(!/^\d+$/.test(length)||Number(length)>RESCUE_PROOF_MAX_BYTES)){json(response,413,{error:'Proof is too large.'});return;}
 try{
  const chunks:Buffer[]=[];let bytes=0;
  for await (const chunk of request){
   const buffer=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk as Uint8Array);
   bytes+=buffer.byteLength;
   if(bytes>RESCUE_PROOF_MAX_BYTES)throw Error('too large');
   chunks.push(buffer);
  }
  const value:unknown=JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if(!value||typeof value!=='object'||Array.isArray(value)||
    (value as {version?:unknown}).version!==1||(value as {kind?:unknown}).kind!=='fixed-row-rescue-proof')
   throw Error('invalid proof');
  const text=JSON.stringify(value),sha256=createHash('sha256').update(text).digest('hex');
  await mkdir(join(sourceRoot,'work'),{recursive:true});
  await writeFile(join(sourceRoot,'work','fixed-row-rescue-proof.json'),text,'utf8');
  json(response,200,{stored:true,file:'work/fixed-row-rescue-proof.json',sha256,bytes:Buffer.byteLength(text)});
 }catch{json(response,400,{error:'Fixed-row rescue proof could not be stored.'});}
}
/** Dev-only storage for the reproducible fixed-grid reconstruction manifest.
 * The client supplies no path; the server names the single work file. */
async function archiveGridReconstruction(request:IncomingMessage,response:ServerResponse,sourceRoot:string){
 if(request.method!=='POST'){response.setHeader('Allow','POST');json(response,405,{error:'POST only.'});return;}
 const type=request.headers['content-type'];
 if(typeof type!=='string'||!type.toLowerCase().startsWith('application/json')){json(response,415,{error:'Use application/json.'});return;}
 const length=request.headers['content-length'];
 if(length!==undefined&&(!/^\d+$/.test(length)||Number(length)>GRID_MANIFEST_MAX_BYTES)){json(response,413,{error:'Manifest is too large.'});return;}
 try{
  const chunks:Buffer[]=[];let bytes=0;
  for await (const chunk of request){
   const buffer=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk as Uint8Array);
   bytes+=buffer.byteLength;
   if(bytes>GRID_MANIFEST_MAX_BYTES)throw Error('too large');
   chunks.push(buffer);
  }
  const value:unknown=JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if(!value||typeof value!=='object'||Array.isArray(value)||
    (value as {version?:unknown}).version!==1||(value as {kind?:unknown}).kind!=='grid-video-reconstruction')
   throw Error('invalid manifest');
  const text=JSON.stringify(value),sha256=createHash('sha256').update(text).digest('hex');
  await mkdir(join(sourceRoot,'work'),{recursive:true});
  await writeFile(join(sourceRoot,'work','grid-reconstruction.json'),text,'utf8');
  json(response,200,{stored:true,file:'work/grid-reconstruction.json',sha256,bytes:Buffer.byteLength(text)});
 }catch{json(response,400,{error:'Grid reconstruction manifest could not be stored.'});}
}

/** Private development server: immutable cases and run reports only; neither
 * write endpoint accepts a client-supplied filesystem path. */
export async function serveCorpusRequest(request: IncomingMessage, response: ServerResponse, root = DEFAULT_CORPUS_ROOT, sourceRoot = process.cwd(),readReplay?:ReplayReader,readRaw?:ReplayReader) {
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
    if(path===`${PREFIX}/replay`||path===`${PREFIX}/raw-session`||path===`${PREFIX}/direct-input`)rejectReplayBody(request,response,403,'Same-origin development access only.');
    else json(response, 403, { error: 'Same-origin development access only.' }); return true;
  }
  const route = path.slice(PREFIX.length), run = RUN.exec(route);
  if(route==='/replay'){await archiveReplay(request,response,root,readReplay??replayReaderFromSource(sourceRoot));return true;}
  if(route==='/raw-session'){await archiveReplay(request,response,root,readRaw??rawSessionReaderFromSource(sourceRoot),'raw-session');return true;}
  if(route==='/direct-input'){await archiveDirect(request,response,root,readReplay??replayReaderFromSource(sourceRoot));return true;}
  if(route==='/grid-reconstruction'){await archiveGridReconstruction(request,response,sourceRoot);return true;}
  if(route==='/fixed-row-rescue-proof'){await archiveFixedRowRescueProof(request,response,sourceRoot);return true;}
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

export function corpusServerPlugin(root = DEFAULT_CORPUS_ROOT, sourceRoot?:string): Plugin {
  return {
    name: 'local-scan-corpus', apply: 'serve',
    configureServer(server) {
      const source=sourceRoot??server.config.root;
      const readReplay=replayReaderFromSource(source);
      const readRaw=rawSessionReaderFromSource(source);
      server.middlewares.use((request, response, next) => {
        void serveCorpusRequest(request, response, root, source,readReplay,readRaw).then(handled => { if (!handled) next(); }).catch(() => response.destroy());
      });
    },
  };
}
