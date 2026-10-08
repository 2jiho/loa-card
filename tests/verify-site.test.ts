import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { verifySite } from '../scripts/verify-site.mjs';
test('deployment checker detects missing assets, bad MIME, changed bytes and wrong base', async () => {
  let failure = '';
  const files = new Map([
    ['index.html', '<script src="/project/assets/app.js"></script>'],
    ['assets/app.js', 'console.log(1)'],
    ['scanner/cards.json', '{}'],
    ['licenses/index.html', '<h1>라이선스</h1>'],
    ['licenses/asset-notices.txt.html', '<h1>고지</h1>'],
  ]);
  function manifest() { return { version: 1, files: [...files].map(([path, body]) => ({path, bytes:Buffer.byteLength(body), sha256:createHash('sha256').update(body).digest('hex')})) }; }
  const server = createServer((req, res) => {
    const name = req.url!.slice('/project/'.length);
    if (name === 'site-manifest.json') { res.setHeader('content-type','application/json'); res.end(JSON.stringify(manifest())); return; }
    if (failure === '404' && name === 'assets/app.js') { res.writeHead(404).end(); return; }
    res.setHeader('content-type', name.endsWith('.js') ? failure === 'mime' ? 'text/html' : 'text/javascript' : name.endsWith('.json') ? 'application/json' : 'text/html');
    res.end(failure === 'bytes' && name === 'assets/app.js' ? 'modified' : files.get(name));
  });
  await new Promise<void>(resolve => server.listen(0,'127.0.0.1',resolve));
  const address = server.address() as {port:number}, url = `http://127.0.0.1:${address.port}/project/`;
  try {
    assert.equal((await verifySite(url, manifest())).files, 5);
    failure = '404'; await assert.rejects(verifySite(url), /HTTP 404/);
    failure = 'mime'; await assert.rejects(verifySite(url), /MIME/);
    failure = 'bytes'; await assert.rejects(verifySite(url), /checksum/);
    failure = ''; files.set('index.html', '<script src="/assets/app.js"></script>');
    await assert.rejects(verifySite(url), /outside deployment base/);
  } finally { await new Promise<void>((resolve,reject) => server.close(error => error ? reject(error) : resolve())); }
});
