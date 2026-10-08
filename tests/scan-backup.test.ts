import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory } from 'fake-indexeddb';
import { createScanBackup, BackupConflict } from '../src/features/card-scanner/scan-backup';
import type { ScannerState } from '../src/features/card-scanner/scanner';
const state = (status = '완료') => ({ status, cards: [], growthPoints: { current: 1234, maximum: 9999 } } as unknown as ScannerState);
async function seed(factory: IDBFactory, rows: [string, unknown][]) {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const req = factory.open('loacard-scan-backups', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('scans');
    req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error);
  });
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction('scans', 'readwrite');
    for (const [key, value] of rows) tx.objectStore('scans').put(value, key);
    tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error);
  }); db.close();
}
test('a new tab restores the same inventory and XP without sessionStorage', async () => {
  const factory = new IDBFactory(), a = createScanBackup(() => factory, () => null);
  assert.equal(await a.load(), undefined); await a.save(state());
  assert.deepEqual(await createScanBackup(() => factory, () => null).load(), state());
});
test('stale tab cannot overwrite a newer scan; explicit reload permits later changes', async () => {
  const factory = new IDBFactory(), a = createScanBackup(() => factory), b = createScanBackup(() => factory);
  await a.load(); await b.load(); await a.save(state('새 스캔'));
  await assert.rejects(b.save(state('옛 목록')), BackupConflict);
  assert.equal((await b.load())?.status, '새 스캔');
  await b.save(state('새 성장')); assert.equal((await a.load())?.status, '새 성장');
});
test('clear leaves a revision tombstone so an older tab cannot resurrect the list', async () => {
  const factory = new IDBFactory(), a = createScanBackup(() => factory), b = createScanBackup(() => factory);
  await a.load(); await a.save(state()); await b.load(); await a.clear();
  await assert.rejects(b.save(state()), BackupConflict);
  assert.equal(await b.load(), undefined);
});
test('queued writes retain their own snapshot and order', async () => {
  const factory = new IDBFactory(), a = createScanBackup(() => factory);
  await a.load(); const original = state('1'); const first = a.save(original);
  original.status = 'mutated'; const second = a.save(state('2'));
  await Promise.all([first, second]); assert.equal((await a.load())?.status, '2');
});
test('migrate current tab legacy inventory; unknown competing legacy inventories are not guessed', async () => {
  const factory = new IDBFactory(); await seed(factory, [['a', state('A')], ['b', state('B')]]);
  await assert.rejects(createScanBackup(() => factory, () => null).load(), /여러 개/);
  assert.equal((await createScanBackup(() => factory, () => null).load('b'))?.status, 'B');
  assert.equal((await createScanBackup(() => factory, () => null).load())?.status, 'B');
});
test('single orphan tab backup is recoverable and malformed/future records are never overwritten', async () => {
  const factory = new IDBFactory(); await seed(factory, [['old', state()]]);
  assert.deepEqual(await createScanBackup(() => factory, () => null).load(), state());
  await seed(factory, [['current', { version: 99, state: state(), revision: 'future' }]]);
  const client = createScanBackup(() => factory);
  await assert.rejects(client.load(), /형식/); await assert.rejects(client.save(state()), /형식/);
});
test('unavailable browser storage rejects without preventing a subsequent retry', async () => {
  let unavailable = true; const factory = new IDBFactory();
  const client = createScanBackup(() => { if (unavailable) throw new DOMException('blocked', 'SecurityError'); return factory; });
  await assert.rejects(client.load(), /blocked/); unavailable = false;
  await client.load(); await client.save(state()); assert.deepEqual(await client.load(), state());
});

test('a missing explicitly selected backup never falls back to another inventory', async () => {
  const factory = new IDBFactory(); await seed(factory, [['other', state('다른 계정')]]);
  const client = createScanBackup(() => factory, () => null);
  await assert.rejects(client.load('removed'), /선택한 이전 백업/);
  assert.equal((await client.load('other'))?.status, '다른 계정');
});

test('another tab migrating a backup cannot silently replace the selected legacy inventory', async () => {
  const factory = new IDBFactory(); await seed(factory,[['a',state('A')],['b',state('B')]]);
  const selecting=createScanBackup(()=>factory,()=>null);
  await assert.rejects(selecting.load(), /여러 개/);
  await createScanBackup(()=>factory,()=>null).load('a');
  await assert.rejects(selecting.load('b'), /다른 탭/);
  assert.equal((await selecting.load())?.status,'A');
});

test('corrupt card fields are rejected before rendering or migrating and cannot overwrite a good backup', async () => {
  const card = {id:'a',name:'카드',awakening:0,extraCopies:0,confidence:1,review:[],image:'',time:0,observations:1};
  const corruptCards = [[null], [{...card, review:null}], [{...card, name:5}],
    [{...card, awakening:NaN}], [{...card, extraCopies:undefined}], [card,card]];
  for (const cards of corruptCards) {
    const factory = new IDBFactory();
    const corrupt = {...state(),cards} as unknown as ScannerState;
    await seed(factory, [['old',corrupt]]);
    const client=createScanBackup(()=>factory,()=>null);
    await assert.rejects(client.load(), /이전 백업을 읽을 수/);
    await seed(factory,[['old',{...state(),cards:[card]}]]);
    assert.equal((await client.load())?.cards.length,1);
    await assert.rejects(client.save(corrupt), /목록 형식/);
    assert.equal((await client.load())?.cards.length,1);
    await seed(factory,[['current',{version:1,revision:'broken',state:corrupt}]]);
    await assert.rejects(client.load(), /저장된 목록 형식/);
  }
});
