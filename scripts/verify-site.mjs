import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createServer } from 'node:http';
const types = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.wasm': 'application/wasm', '.txt': 'text/plain; charset=utf-8', '.png': 'image/png', '.webp': 'image/webp' };
export async function verifySite(base, expected) {
  const url = new URL(base.endsWith('/') ? base : base + '/');
  if (!['https:', 'http:'].includes(url.protocol)) throw new Error('Expected an HTTP(S) site URL');
  async function get(path) {
    if (typeof path !== 'string' || path.startsWith('/') || path.split('/').includes('..') || path.includes('\\')) throw new Error('Invalid manifest path');
    const target = new URL(path, url);
    if (target.origin !== url.origin || !target.pathname.startsWith(url.pathname)) throw new Error('Manifest path outside deployment');
    const response = await fetch(target, { signal: AbortSignal.timeout(30000), redirect: 'error', cache: 'no-store' });
    if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
    return response;
  }
  const manifestText = await (await get('site-manifest.json')).text();
  if (process.env.EXPECTED_MANIFEST_SHA256 && createHash('sha256').update(manifestText).digest('hex') !== process.env.EXPECTED_MANIFEST_SHA256) throw new Error('Deployed build hash differs from the workflow artifact');
  const manifest = JSON.parse(manifestText);
  if (manifest.version !== 1 || !Array.isArray(manifest.files) || !manifest.files.length) throw new Error('Invalid deployment manifest');
  if (expected && JSON.stringify(manifest) !== JSON.stringify(expected)) throw new Error('Deployment manifest does not match this build');
  for (const required of ['index.html', 'scanner/cards.json', 'licenses/index.html', 'licenses/asset-notices.txt.html'])
    if (!manifest.files.some(file => file.path === required)) throw new Error(`Missing required asset: ${required}`);
  let next = 0, bytes = 0;
  const failures = [];
  await Promise.all(Array.from({ length: 6 }, async () => {
    while (next < manifest.files.length) {
      const file = manifest.files[next++];
      try {
        const response = await get(file.path);
        const extension = extname(file.path), type = response.headers.get('content-type') ?? '';
        if (['.js', '.mjs'].includes(extension) && !/(?:java|ecma)script/i.test(type)) throw new Error('JavaScript MIME mismatch');
        if (['.wasm', '.html', '.json', '.css'].includes(extension) && !type.startsWith(types[extension])) throw new Error(`MIME mismatch: ${type}`);
        const data = new Uint8Array(await response.arrayBuffer());
        if (data.length !== file.bytes || createHash('sha256').update(data).digest('hex') !== file.sha256) throw new Error('content checksum mismatch');
        if (file.path === 'index.html') {
          for (const match of new TextDecoder().decode(data).matchAll(/(?:src|href)="([^"]+)"/g)) {
            const target = new URL(match[1], url);
            if (target.origin !== url.origin || !target.pathname.startsWith(url.pathname)) throw new Error('Entry asset points outside deployment base');
            const path = decodeURIComponent(target.pathname.slice(url.pathname.length));
            if (!manifest.files.some(item => item.path === path)) throw new Error(`Entry asset not in manifest: ${path}`);
          }
        }
        bytes += data.length;
      } catch (error) { failures.push(`${file.path}: ${error.message}`); }
    }
  }));
  if (failures.length) throw new Error(failures.join('\n'));
  return { files: manifest.files.length, bytes };
}
async function main() {
  const local = process.argv.includes('--local'), base = process.env.PAGES_BASE_PATH || '/';
  let server;
  try {
    const expected = JSON.parse(await readFile('dist/site-manifest.json', 'utf8').catch(() => 'null'));
    if (local) {
      server = createServer(async (request, response) => {
        try {
          const name = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
          if (!name.startsWith(base) || name.includes('..')) { response.writeHead(404).end(); return; }
          const file = name.slice(base.length) || 'index.html';
          if (file.startsWith('/') || file.includes('\\') || file.includes(':')) { response.writeHead(404).end(); return; }
          const data = await readFile(resolve('dist', file));
          response.writeHead(200, { 'Content-Type': types[extname(file)] ?? 'application/octet-stream' }).end(data);
        } catch { response.writeHead(404).end(); }
      });
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    }
    const url = local ? `http://127.0.0.1:${server.address().port}${base}` : process.argv[2];
    if (!url) throw new Error('Usage: npm run verify:site -- https://host/repository/ OR --local');
    const report = await verifySite(url, expected);
    console.log(JSON.stringify({ url, ...report, note: 'HTTP bytes and MIME verified; browser screen sharing requires a separate check.' }, null, 2));
  } finally { if (server) await new Promise(resolve => server.close(resolve)); }
}
if (import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
