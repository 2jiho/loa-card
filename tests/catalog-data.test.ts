import {test} from 'node:test';
import assert from 'node:assert/strict';
import {
  loadCardCatalog,
  loadGrowthMaster,
  loadRaidMaster,
  parseCardCatalog,
  parseGrowthMaster,
  parseRaidMaster,
} from '../src/data/catalog';

test('card catalog parser keeps version and cards', () => {
  const catalog = parseCardCatalog({version: 'v1', cards: [{id: 'a', name: '국왕 실리안', rarity: 4}]});
  assert.equal(catalog.version, 'v1');
  assert.equal(catalog.cards[0].id, 'a');
});

test('card catalog parser rejects missing or empty cards', () => {
  assert.throws(() => parseCardCatalog({version: 'v1'}), /카드 사전 형식 오류/u);
  assert.throws(() => parseCardCatalog({version: 'v1', cards: []}), /카드 사전 형식 오류/u);
});

test('growth and raid parsers require their card and rule arrays', () => {
  const growth = parseGrowthMaster({version: 'v1', targets: [], stats: [], cards: [], books: []});
  assert.equal(growth.version, 'v1');
  assert.throws(() => parseGrowthMaster({version: 'v1', cards: []}), /도감 데이터 형식 오류/u);
  const raid = parseRaidMaster({version: 'v1', cards: [], sets: []});
  assert.equal(raid.version, 'v1');
  assert.throws(() => parseRaidMaster({version: 'v1', cards: []}), /레이드 카드 데이터 형식 오류/u);
});

test('catalog loaders use the documented data paths', async () => {
  const original = globalThis.fetch;
  const requests: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    requests.push(String(input));
    return new Response(JSON.stringify(
      String(input).includes('growth/')
        ? {version: 'g', targets: [], stats: [], cards: [], books: []}
        : String(input).includes('raid/')
          ? {version: 'r', cards: [], sets: []}
          : {version: 'c', cards: [{id: 'a', name: '국왕 실리안', rarity: 4}]},
    ), {status: 200, headers: {'Content-Type': 'application/json'}});
  }) as typeof fetch;
  try {
    assert.equal((await loadCardCatalog()).version, 'c');
    assert.equal((await loadGrowthMaster()).version, 'g');
    assert.equal((await loadRaidMaster()).version, 'r');
    assert.deepEqual(requests, ['/scanner/cards.json', '/growth/master.json', '/raid/master.json']);
  } finally {
    globalThis.fetch = original;
  }
});

test('catalog loader reports the HTTP status without returning a partial catalog', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => new Response('', {status: 404})) as typeof fetch;
  try {
    await assert.rejects(() => loadCardCatalog(), /카드 사전 로드 실패 \(404\)/u);
  } finally {
    globalThis.fetch = original;
  }
});
