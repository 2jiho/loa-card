import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer, request as httpRequest } from 'node:http';
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addCorpusCase, MAX_CORPUS_RUN_BYTES, verifyCorpus } from '../scripts/scan-corpus-core.mjs';
import { corpusServerPlugin, serveCorpusRequest } from '../dev/corpus-server.ts';

async function fixture(run: (context: { directory: string; root: string; url: string; pending: Set<Promise<unknown>> }) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'loa-corpus-http-'));
  const root = join(directory, 'corpus');
  const pending = new Set<Promise<unknown>>();
  const server = createServer((request, response) => {
    const task = serveCorpusRequest(request, response, root).then(handled => {
      if (!handled) { response.statusCode = 418; response.end('next'); }
    });
    pending.add(task);
    void task.finally(() => pending.delete(task));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  try { await run({ directory, root, url: `http://127.0.0.1:${address.port}`, pending }); }
  finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await Promise.all(pending);
    // Only the exact temporary directory created by this test is removed.
    await rm(directory, { recursive: true, force: true });
  }
}

async function add(directory: string, root: string, name: string, body: string | Buffer) {
  const path = join(directory, name); await writeFile(path, body);
  return addCorpusCase([path], { root });
}

async function peerRequest(address: string | undefined, options: {
  path?: string; method?: string; headers?: IncomingHttpHeaders; missingSocket?: boolean;
} = {}) {
  let body = '';
  const headers = new Map<string, string>();
  const request = {
    url: options.path ?? '/__corpus/unknown', method: options.method ?? 'GET',
    headers: { host: 'localhost:5201', origin: 'http://localhost:5201', 'sec-fetch-site': 'same-origin', ...options.headers },
    socket: options.missingSocket ? undefined : { remoteAddress: address },
  } as unknown as IncomingMessage;
  const response = {
    statusCode: 200,
    setHeader(name: string, value: string) { headers.set(name.toLowerCase(), value); },
    end(value: string) { body = value; },
  } as unknown as ServerResponse;
  const handled = await serveCorpusRequest(request, response);
  return { handled, status: response.statusCode, headers, body };
}

test('dev corpus permits only loopback transport peers, including IPv4-mapped IPv6', async () => {
  for (const address of ['127.0.0.1', '127.0.0.0', '127.255.255.255', '127.7.8.9',
    '::1', '0:0:0:0:0:0:0:1', '::ffff:127.7.8.9', '::ffff:7f07:809', '0:0:0:0:0:FFFF:7f07:809']) {
    const response = await peerRequest(address);
    assert.equal(response.handled, true, address);
    assert.equal(response.status, 404, `${address}: accepted peer must reach route validation`);
    assert.match(response.body, /Unknown corpus route/);
  }
  for (const address of [undefined, '', 'localhost', '127.1', '127.0.0.1:5201', '[::1]', '2130706433',
    '126.255.255.255', '128.0.0.1', '0.0.0.0', '10.1.2.3', '192.168.1.2', '203.0.113.7',
    '::', '::2', 'fc00::1', 'fe80::1', '::127.0.0.1', '::ffff:192.168.1.2', '::ffff:8000:1']) {
    const response = await peerRequest(address);
    assert.equal(response.handled, true, String(address));
    assert.equal(response.status, 403, String(address));
    assert.match(response.body, /Loopback development access only/);
    assert.equal(response.headers.get('cache-control'), 'no-store');
  }
  assert.equal((await peerRequest(undefined, { missingSocket: true })).status, 403);
});

function runReport(manifest: { id: string; inputs: { index: number; sha256: string; bytes: number }[] }) {
  return {
    version: 1,
    result: { expected: 1, read: 1, unidentified: 0, experience: 100,
      cards: [{ id: 'card', name: '테스트 카드', awakening: 0, extraCopies: 1, review: [] }] },
    validation: { caseId: manifest.id, input: manifest.inputs.map(({ index, sha256, bytes }) => ({ index, sha256, bytes })),
      completed: true, outcome: 'completed', sourceChanged: false,
      sourceStart: { sourceDigest: 'a'.repeat(64) }, sourceEnd: { sourceDigest: 'a'.repeat(64) } },
  };
}

test('run POST appends exact immutable report bytes, deduplicates, and leaves truth and inputs unchanged', async () => {
  await fixture(async ({ directory, root, url }) => {
    const { manifest } = await add(directory, root, 'video.mp4', 'input');
    const manifestPath = join(root, 'cases', manifest.id, 'manifest.json');
    const before = await readFile(manifestPath);
    const report = runReport(manifest), body = JSON.stringify({ ...report, privateNote: directory }, null, 2);
    const target = `${url}/__corpus/cases/${manifest.id}/runs`;
    const send = () => fetch(target, { method: 'POST', headers: { 'Content-Type': 'application/json; charset=UTF-8', Origin: url, 'Sec-Fetch-Site': 'same-origin' }, body });
    const response = await send();
    assert.equal(response.status, 201);assert.equal(response.headers.get('cache-control'), 'no-store');
    const result = await response.json();
    const digest = createHash('sha256').update(body).digest('hex');
    assert.deepEqual(Object.keys(result).sort(), ['created', 'file', 'id', 'sha256', 'summary']);
    assert.equal(result.created, true);assert.equal(result.id, manifest.id);assert.equal(result.sha256, digest);
    assert.equal(result.file, `cases/${manifest.id}/runs/run-${digest}.json`);
    assert.equal(result.summary.verification, 'unverified');assert.equal(result.summary.classification, 'completed');
    assert.equal(JSON.stringify(result).includes(directory), false, 'response must not echo original reports or absolute paths');
    assert.deepEqual(await readFile(join(root, ...result.file.split('/'))), Buffer.from(body));
    const duplicate = await send();assert.equal(duplicate.status, 200);assert.equal((await duplicate.json()).created, false);
    const changed = await fetch(target, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(report) });
    assert.equal(changed.status, 201);assert.notEqual((await changed.json()).sha256, digest);
    assert.equal((await readdir(join(root, 'cases', manifest.id, 'runs'))).length, 2);
    assert.deepEqual(await readFile(manifestPath), before);assert.equal((await verifyCorpus({ root })).verified, true);
    assert.deepEqual(await readdir(join(root, '.tmp')), []);
  });
});

test('run POST requires JSON UTF-8 and rejects malformed reports and mismatched case inputs', async () => {
  await fixture(async ({ directory, root, url }) => {
    const { manifest } = await add(directory, root, 'video.mp4', 'input');
    const target = `${url}/__corpus/cases/${manifest.id}/runs`, report = runReport(manifest);
    for (const headers of [{}, { 'Content-Type': 'text/plain' }, { 'Content-Type': 'application/json; charset=latin1' },
      { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip' }]) {
      const response = await fetch(target, { method: 'POST', headers, body: JSON.stringify(report) });
      assert.equal(response.status, 415);await response.text();
    }
    const mismatched = structuredClone(report);mismatched.validation.input[0].sha256 = 'b'.repeat(64);
    const wrongCase = structuredClone(report);wrongCase.validation.caseId = 'c'.repeat(64);
    for (const body of ['', '{', '[]', '{}', JSON.stringify(wrongCase), JSON.stringify(mismatched), Buffer.from([0xff])]) {
      const response = await fetch(target, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
      assert.equal(response.status, 400);assert.equal((await response.text()).includes(directory), false);
    }
    await assert.rejects(readdir(join(root, 'cases', manifest.id, 'runs')), { code: 'ENOENT' });
  });
});

test('run POST validates IDs and methods without allowing arbitrary writes', async () => {
  await fixture(async ({ directory, root, url }) => {
    const { manifest } = await add(directory, root, 'video.mp4', 'input');
    const target = `${url}/__corpus/cases/${manifest.id}/runs`;
    for (const method of ['GET', 'PUT', 'DELETE', 'HEAD']) {
      const response = await fetch(target, { method });
      assert.equal(response.status, 405);assert.equal(response.headers.get('allow'), 'POST');await response.text();
    }
    for (const id of ['nope', 'A'.repeat(64), '%00', 'a'.repeat(63)]) {
      const response = await fetch(`${url}/__corpus/cases/${id}/runs`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      assert.equal(response.status, 400, id);await response.text();
    }
    const absent = runReport({ ...manifest, id: 'b'.repeat(64) });
    const response = await fetch(`${url}/__corpus/cases/${absent.validation.caseId}/runs`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(absent),
    });
    assert.equal(response.status, 404);assert.equal((await response.text()).includes(directory), false);
  });
});

test('run POST preserves the real loopback and same-origin boundary', async () => {
  const path = `/__corpus/cases/${'a'.repeat(64)}/runs`;
  for (const peer of ['192.168.1.2', '::ffff:192.168.1.2', undefined]) {
    const response = await peerRequest(peer, { path, method: 'POST', headers: { 'Content-Type': 'application/json', 'x-forwarded-for': '127.0.0.1' } });
    assert.equal(response.status, 403);assert.match(response.body, /Loopback/);
  }
  await fixture(async ({ directory, root, url }) => {
    const { manifest } = await add(directory, root, 'video.mp4', 'input');
    for (const headers of [{ Origin: 'https://outside.example' }, { Origin: 'null' }, { 'Sec-Fetch-Site': 'cross-site' }]) {
      const response = await fetch(`${url}/__corpus/cases/${manifest.id}/runs`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(runReport(manifest)),
      });
      assert.equal(response.status, 403);await response.text();
    }
    await assert.rejects(readdir(join(root, 'cases', manifest.id, 'runs')), { code: 'ENOENT' });
  });
});

test('run POST enforces the body limit for declared and streamed lengths, including exact boundary', { timeout: 10_000 }, async () => {
  await fixture(async ({ directory, root, url }) => {
    const { manifest } = await add(directory, root, 'video.mp4', 'input');
    const target = `${url}/__corpus/cases/${manifest.id}/runs`;
    for (const declared of [true, false]) {
      const status = await new Promise<number>((resolve, reject) => {
        const request = httpRequest(target, { method: 'POST', headers: {
          'Content-Type': 'application/json', ...(declared ? { 'Content-Length': MAX_CORPUS_RUN_BYTES + 1 } : {}),
        } }, response => { response.resume();response.on('end', () => resolve(response.statusCode!)); });
        request.on('error', reject);
        if (!declared) { const chunk = Buffer.alloc(64 * 1024, 32);for (let i = 0; i < 256; i++) request.write(chunk);request.write(' '); }
        request.end();
      });
      assert.equal(status, 413, declared ? 'declared' : 'chunked');
    }
    await assert.rejects(readdir(join(root, 'cases', manifest.id, 'runs')), { code: 'ENOENT' });
    const serialized = JSON.stringify(runReport(manifest));
    const body = Buffer.alloc(MAX_CORPUS_RUN_BYTES, 32);body.write(serialized);
    const response = await fetch(target, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
    assert.equal(response.status, 201);const result = await response.json();
    assert.deepEqual(await readFile(join(root, ...result.file.split('/'))), body);
  });
});

test('disconnected or incomplete POST bodies never archive and release request handling', { timeout: 5000 }, async () => {
  await fixture(async ({ directory, root, url, pending }) => {
    const { manifest } = await add(directory, root, 'video.mp4', 'input');
    const body = JSON.stringify(runReport(manifest));
    const request = httpRequest(`${url}/__corpus/cases/${manifest.id}/runs`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) + 20 },
    });
    request.on('error', () => {});request.write(body);
    for (let attempt = 0; !pending.size && attempt < 100; attempt++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(pending.size, 1, 'server must be waiting for the incomplete body');
    const handling = [...pending];request.destroy();await Promise.all(handling);
    assert.equal(pending.size, 0);
    await assert.rejects(readdir(join(root, 'cases', manifest.id, 'runs')), { code: 'ENOENT' });
    const response = await fetch(`${url}/__corpus`);assert.equal(response.status, 200);await response.text();
  });
});

test('dev corpus ignores spoofed forwarding headers across its whole namespace', async () => {
  const headers = { 'x-forwarded-for': '127.0.0.1', forwarded: 'for="[::1]";host=localhost:5201;proto=http',
    'x-real-ip': '127.0.0.1' };
  for (const path of ['/__corpus', '/__corpus/', '/__corpus?private=1', '/__corpus/environment',
    `/__corpus/cases/${'a'.repeat(64)}`, `/__corpus/cases/${'a'.repeat(64)}/input/0`]) {
    for (const address of ['192.168.1.2', '::ffff:192.168.1.2', undefined]) {
      const response = await peerRequest(address, { path, headers });
      assert.equal(response.status, 403, `${address} ${path}`);
      assert.match(response.body, /Loopback development access only/);
    }
  }
  const local = await peerRequest('::1', { headers: { 'x-forwarded-for': '203.0.113.7', forwarded: 'for=203.0.113.7' } });
  assert.equal(local.status, 404, 'forwarding headers do not replace a genuine local peer either');
  for (const path of ['/unrelated', '/__corpus-other', '/__corpusX']) {
    const response = await peerRequest('192.168.1.2', { path, headers });
    assert.equal(response.handled, false, path);
    assert.equal(response.body, '', path);
    assert.equal(response.headers.size, 0, 'unrelated middleware keeps ownership of its response');
  }
});

test('a real IPv4 loopback request is allowed without trusting forwarding headers', async () => {
  await fixture(async ({ directory, root, url }) => {
    const { manifest } = await add(directory, root, 'local.png', 'local input');
    const response = await fetch(`${url}/__corpus/cases/${manifest.id}/input/0`, {
      headers: { 'x-forwarded-for': '192.168.1.2', forwarded: 'for=192.168.1.2' },
    });
    assert.equal(response.status, 200);
    assert.equal(await response.text(), 'local input');
  });
});

test('a real IPv6 loopback connection passes the peer boundary', async t => {
  let peer: string | undefined;
  const pending = new Set<Promise<unknown>>();
  const server = createServer((request, response) => {
    peer = request.socket.remoteAddress;
    const task = serveCorpusRequest(request, response);
    pending.add(task);
    void task.then(() => pending.delete(task), () => pending.delete(task));
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '::1', () => { server.removeListener('error', reject); resolve(); });
    });
  } catch (error) {
    if (['EAFNOSUPPORT', 'EADDRNOTAVAIL'].includes((error as NodeJS.ErrnoException).code ?? '')) {
      t.skip('IPv6 loopback is not available on this host.'); return;
    }
    throw error;
  }
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  try {
    const response = await fetch(`http://[::1]:${address.port}/__corpus/unknown`);
    assert.equal(peer, '::1');
    assert.equal(response.status, 404);
    assert.match(await response.text(), /Unknown corpus route/);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await Promise.all(pending);
  }
});

test('dev corpus lists validated cases and streams images in registered order without exposing file paths', async () => {
  await fixture(async ({ directory, root, url }) => {
    await writeFile(join(directory, 'z.png'), 'first'); await writeFile(join(directory, 'a.png'), 'second');
    const { manifest } = await addCorpusCase([join(directory, 'z.png'), join(directory, 'a.png'), join(directory, 'z.png')], { root });
    const indexResponse = await fetch(`${url}/__corpus`);
    assert.equal(indexResponse.status, 200); assert.equal(indexResponse.headers.get('cache-control'), 'no-store');
    const index = await indexResponse.json();
    assert.equal(index.cases[0].id, manifest.id);
    const response = await fetch(`${url}/__corpus/cases/${manifest.id}`);
    const detail = await response.json();
    assert.deepEqual(detail.inputs.map(input => input.name), ['z.png', 'a.png', 'z.png']);
    assert.deepEqual(detail.inputs.map(input => input.index), [0, 1, 2]);
    assert.equal(JSON.stringify(detail).includes(directory), false);
    assert.equal(JSON.stringify(detail).includes('objects/'), false);
    assert.equal(detail.baseline, null); assert.equal(detail.expected, null);
    for (const [i, body] of ['first', 'second', 'first'].entries()) {
      const input = await fetch(`${url}${detail.inputs[i].url}`);
      assert.equal(input.headers.get('content-type'), 'image/png');
      assert.equal(input.headers.get('cross-origin-resource-policy'), 'same-origin');
      assert.equal(await input.text(), body);
    }
    assert.equal(await readFile(join(directory, 'z.png'), 'utf8'), 'first');
    assert.equal((await verifyCorpus({ root })).verified, true);
  });
});

test('dev corpus supports bounded, open-ended and suffix video ranges and rejects invalid ranges', async () => {
  await fixture(async ({ directory, root, url }) => {
    const { manifest } = await add(directory, root, 'video.mp4', '0123456789');
    const inputUrl = `${url}/__corpus/cases/${manifest.id}/input/0`;
    for (const [range, body, contentRange] of [
      ['bytes=2-4', '234', 'bytes 2-4/10'], ['bytes=7-', '789', 'bytes 7-9/10'],
      ['bytes=-3', '789', 'bytes 7-9/10'], ['bytes=8-999', '89', 'bytes 8-9/10'],
    ]) {
      const response = await fetch(inputUrl, { headers: { Range: range } });
      assert.equal(response.status, 206); assert.equal(response.headers.get('content-type'), 'video/mp4');
      assert.equal(response.headers.get('content-range'), contentRange);
      assert.equal(response.headers.get('content-length'), String(body.length));
      assert.equal(await response.text(), body);
    }
    for (const range of ['bytes=10-', 'bytes=4-2', 'bytes=-0', 'bytes=-', 'bytes=0-1,4-5', 'bytes=9007199254740992-', 'none']) {
      const response = await fetch(inputUrl, { headers: { Range: range } });
      assert.equal(response.status, 416, range); assert.equal(response.headers.get('content-range'), 'bytes */10');
      await response.text();
    }
    const { manifest: empty } = await add(directory, root, 'empty.mp4', '');
    const emptyUrl = `${url}/__corpus/cases/${empty.id}/input/0`;
    assert.equal((await fetch(emptyUrl)).headers.get('content-length'), '0');
    assert.equal((await fetch(emptyUrl, { headers: { Range: 'bytes=0-' } })).status, 416);
  });
});

test('dev corpus rejects writes, cross-site requests and arbitrary/encoded paths', async () => {
  await fixture(async ({ directory, root, url }) => {
    const { manifest } = await add(directory, root, 'video.mp4', 'private');
    const target = `/__corpus/cases/${manifest.id}/input/0`;
    for (const method of ['POST', 'PUT', 'DELETE', 'HEAD']) {
      const response = await fetch(`${url}${target}`, { method });
      assert.equal(response.status, 405); assert.equal(response.headers.get('allow'), 'GET');
    }
    for (const headers of [{ Origin: 'https://outside.example' }, { 'Sec-Fetch-Site': 'cross-site' }]) {
      assert.equal((await fetch(`${url}${target}`, { headers })).status, 403);
    }
    const paths = ['/__corpus/objects/secret', '/__corpus/cases/nope', `${target}/../other`,
      `/__corpus/cases/${manifest.id}/input/-1`, `/__corpus/cases/${manifest.id}/input/9999`,
      '/__corpus/%2e%2e/%2e%2e/secret', '/__corpus/%5c..%5csecret', '/__corpus/cases/%00'];
    for (const path of paths) {
      const response = await new Promise<{ status: number; body: string }>((resolve, reject) => {
        httpRequest(url, { path }, response => {
          let body = ''; response.setEncoding('utf8'); response.on('data', data => { body += data; });
          response.on('end', () => resolve({ status: response.statusCode!, body }));
        }).on('error', reject).end();
      });
      assert.equal(response.status, 404, path); assert.equal(response.body.includes(directory), false);
    }
    assert.equal((await fetch(`${url}/unrelated`)).status, 418);
  });
});

test('dev corpus rejects a tampered manifest, symlinked input and changed file size', async t => {
  await fixture(async ({ directory, root, url }) => {
    const { manifest } = await add(directory, root, 'video.mp4', 'original');
    const manifestPath = join(root, 'cases', manifest.id, 'manifest.json');
    const inputPath = join(root, 'cases', manifest.id, 'input', '0001.mp4');
    const target = `${url}/__corpus/cases/${manifest.id}/input/0`;
    const original = await readFile(manifestPath, 'utf8');
    const changed = JSON.parse(original); changed.inputs[0].path = '../../outside.mp4';
    await writeFile(manifestPath, JSON.stringify(changed));
    assert.equal((await fetch(target)).status, 404);
    assert.equal((await fetch(`${url}/__corpus/cases/${manifest.id}`)).status, 404);
    await writeFile(manifestPath, original);
    const extra = JSON.parse(original); extra.source.privatePath = directory;
    await writeFile(manifestPath, JSON.stringify(extra));
    assert.equal((await (await fetch(`${url}/__corpus`)).text()).includes(directory), false);
    assert.equal((await (await fetch(`${url}/__corpus/cases/${manifest.id}`)).text()).includes(directory), false);
    await writeFile(manifestPath, original);
    await writeFile(inputPath, 'size changed');
    assert.equal((await fetch(target)).status, 404);
    await rm(inputPath);
    try { await symlink(join(directory, 'video.mp4'), inputPath, 'file'); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EPERM') { t.diagnostic('File symlink creation unavailable; junction guard still tested separately.'); return; }
      throw error;
    }
    assert.equal((await fetch(target)).status, 404);
  });
});

test('dev corpus rejects a junction root and finishes file handling after a client disconnect', async () => {
  await fixture(async ({ directory, root, url, pending }) => {
    const { manifest } = await add(directory, root, 'large.mp4', Buffer.alloc(16 * 1024 * 1024, 17));
    await new Promise<void>((resolve, reject) => {
      const request = httpRequest(`${url}/__corpus/cases/${manifest.id}/input/0`, response => {
        response.once('data', () => { response.destroy(); request.destroy(); resolve(); });
        response.on('error', () => {});
      });
      request.on('error', reject); request.end();
    });
    await Promise.all([...pending]);
    assert.equal((await verifyCorpus({ root })).verified, true);
    const other = join(directory, 'other'); await mkdir(other);
    await rm(root, { recursive: true, force: true });
    await symlink(other, root, process.platform === 'win32' ? 'junction' : 'dir');
    assert.equal((await fetch(`${url}/__corpus`)).status, 404);
  });
});

test('corpus middleware is registered only for development serving', () => {
  const plugin = corpusServerPlugin();
  assert.equal(plugin.apply, 'serve');
  assert.equal(plugin.configurePreviewServer, undefined);
  assert.equal(plugin.generateBundle, undefined);
});
