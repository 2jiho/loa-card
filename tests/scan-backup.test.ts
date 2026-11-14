import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory } from 'fake-indexeddb';
import { createScanBackup, BackupConflict } from '../src/features/card-scanner/persistence/scan-backup';
import type { ScannerState } from '../src/features/card-scanner/orchestration/scanner';
import {MAX_UNRESOLVED_FIELD_CHANGES,unattributedFieldReviewCount} from '../src/features/card-scanner/session/current-scan-fields';
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

test('the earlier scanner\'s warnings are neither saved nor checked',async()=>{
 const factory=new IDBFactory(),backup=createScanBackup(()=>factory,()=>null);
 await backup.load();await backup.save({...state(),headerConflict:true,captureWarning:'기록 실패'} as unknown as ScannerState);
 const restored=await backup.load() as Record<string,unknown>|null;
 assert.equal(restored?.headerConflict,undefined);assert.equal(restored?.captureWarning,undefined);
 // A field the backup no longer keeps cannot make a list unrestorable.
 for(const invalid of [null,'true',1])await backup.save({...state(),headerConflict:invalid} as unknown as ScannerState);
 const accessor=Object.defineProperty({...state()},'headerConflict',{get(){throw Error('must not invoke getter');}});
 await backup.save(accessor);
 assert.equal((await backup.load() as Record<string,unknown>|null)?.headerConflict,undefined);
});

test('live thumbnail activity is not persisted with the inventory',async()=>{
  const factory=new IDBFactory(),backup=createScanBackup(()=>factory);
  const input={...state(),activity:[{id:1,image:'temporary-crop',status:'reading' as const}]};
  await backup.load();await backup.save(input);
  assert.deepEqual(await backup.load(),state());
  assert.equal(input.activity.length,1);
});

test('the earlier scanner\'s monitor grid is not restored from a backup',async()=>{
  const factory=new IDBFactory(),backup=createScanBackup(()=>factory,()=>null);
  const grid={located:true,cells:Array.from({length:40},(_,i)=>({status:i===0?'read':i===1?'review':'unknown',...(i===0?{row:2}:{})})),
    inventory:Array.from({length:550},()=>({status:'unknown' as const})),
    recent:{captured:40,read:1,waiting:38,review:1},
    recentFrame:{frame:7,cells:Array.from({length:40},()=>({status:'unknown' as const}))},liveTracking:true,liveTop:4};
  const input={...state(),grid} as unknown as ScannerState;
  await backup.load();await backup.save(input);
  const restored=(await backup.load())! as unknown as Record<string,unknown>;
  assert.equal(Object.hasOwn(restored,'grid'),false);
  assert.equal(grid.recent.captured,40,'live input state is not mutated');
});

test('unresolved changed-field counts survive backup while malformed counts cannot overwrite it',async()=>{
 const factory=new IDBFactory(),backup=createScanBackup(()=>factory,()=>null);
 const input={...state(),unresolvedFieldChanges:MAX_UNRESOLVED_FIELD_CHANGES};
 await backup.load();await backup.save(input);
 const restored=(await backup.load())!;
 assert.equal(restored.unresolvedFieldChanges,MAX_UNRESOLVED_FIELD_CHANGES);
 assert.equal(unattributedFieldReviewCount(restored),MAX_UNRESOLVED_FIELD_CHANGES);
 for(const invalid of [null,-1,.5,NaN,Infinity,MAX_UNRESOLVED_FIELD_CHANGES+1]){
   await assert.rejects(backup.save({...input,unresolvedFieldChanges:invalid} as unknown as ScannerState),/올바르지 않아/);
   assert.equal((await backup.load())?.unresolvedFieldChanges,MAX_UNRESOLVED_FIELD_CHANGES);
 }
 const accessor=Object.defineProperty({...input},'unresolvedFieldChanges',{get(){throw Error('must not invoke getter');}});
 await assert.rejects(backup.save(accessor),/올바르지 않아/);
 await seed(factory,[['current',{version:1,revision:'corrupt-fields',state:{...input,unresolvedFieldChanges:MAX_UNRESOLVED_FIELD_CHANGES+1}}]]);
 await assert.rejects(backup.load(),/저장된 목록을 읽지 못했어요/);
});

test('the unresolved-input lower bound survives backup and invalid values cannot replace it',async()=>{
 const factory=new IDBFactory(),backup=createScanBackup(()=>factory,()=>null);
 const input={...state(),sampled:1,unidentified:[],droppedFrames:0,unresolvedObservations:2};
 await backup.load();await backup.save(input);
 assert.equal((await backup.load())!.unresolvedObservations,2);
 for(const invalid of [null,-1,.5,NaN,Infinity]){
  await assert.rejects(backup.save({...input,unresolvedObservations:invalid} as unknown as ScannerState));
  assert.equal((await backup.load())!.unresolvedObservations,2);
 }
 const getter=Object.defineProperty({...input},'unresolvedObservations',{get(){throw Error('must not invoke getter');}});
 await assert.rejects(backup.save(getter),/올바르지 않아/);
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
  await assert.rejects(client.load(), /올바르지 않아|읽지 못/); await assert.rejects(client.save(state()), /올바르지 않아|읽지 못/);
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
  await assert.rejects(client.load('removed'), /고른 이전 백업/);
  assert.equal((await client.load('other'))?.status, '다른 계정');
});

test('another tab migrating a backup cannot silently replace the selected legacy inventory', async () => {
  const factory = new IDBFactory(); await seed(factory,[['a',state('A')],['b',state('B')]]);
  const selecting=createScanBackup(()=>factory,()=>null);
  await assert.rejects(selecting.load(), /여러 개/);
  await createScanBackup(()=>factory,()=>null).load('a');
  await assert.rejects(selecting.load('b'), /다른 (LoaCard )?탭/);
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
    await assert.rejects(client.load(), /이전 백업을 읽지 못/);
    await seed(factory,[['old',{...state(),cards:[card]}]]);
    assert.equal((await client.load())?.cards.length,1);
    await assert.rejects(client.save(corrupt), /올바르지 않아/);
    assert.equal((await client.load())?.cards.length,1);
    await seed(factory,[['current',{version:1,revision:'broken',state:corrupt}]]);
    await assert.rejects(client.load(), /저장된 목록을 읽지 못했어요/);
  }
});


test('inventory backups retain field proof, unknown values, thumbnails and growth undo but omit scan diagnostics and the earlier scanner\'s fields',async()=>{
 const factory=new IDBFactory(),backup=createScanBackup(()=>factory,()=>null);
 const card={id:'a',name:'카드',awakening:null,extraCopies:null,confidence:.8,review:['장수 확인'],image:'data:image/png;base64,card',time:1,observations:2,captureOrder:45,countReliable:false,nameConfirmedBy:'repeat' as const};
 const history=[{label:'성장',cardsBefore:[{...card,awakening:0,extraCopies:2}],pointsBefore:{current:2000,maximum:null},estimatedBefore:false}];
 const input={...state(),cards:[card],growthHistory:history,expected:1,currentRunNames:1,currentRunRead:0,autoStopped:false,
   unidentified:[{image:'data:image/png;base64,unknown',time:2,pending:false,captureOrder:46}],
   recognitionNeeded:[{slot:14,captureTime:2,reason:'툴팁 패널 가림'}],
   discardedObservations:[{image:'data:image/png;base64,hard',time:3,pending:false,captureOrder:47,reason:'판독 불가'}],
   ledger:{traces:Array.from({length:1000},()=>({detail:'raw diagnostic'}))},captureDiagnostics:{samples:[{image:'full-frame'}]},
   activity:[],grid:{slots:[]},livePerformance:{readMs:300},queued:2,droppedFrames:4} as unknown as ScannerState;
 await backup.load();await backup.save(input);
 const restored=(await backup.load())!;
 assert.deepEqual(restored.cards,[card]);assert.deepEqual(restored.growthHistory,history);
 assert.deepEqual(restored.unidentified,input.unidentified);assert.equal(restored.currentRunRead,0);
 for(const key of ['ledger','captureDiagnostics','activity','grid','livePerformance','recognitionNeeded','discardedObservations'])assert.equal(Object.hasOwn(restored,key),false,key);
 assert.equal(restored.queued,0);assert.equal(restored.droppedFrames,4,'capture loss remains visible after restore');
 assert.equal((input as unknown as {ledger:{traces:unknown[]}}).ledger.traces.length,1000,'original runtime state is untouched');
 // Old full-state storage is read through the same projection.
 await seed(factory,[['current',{version:1,revision:'legacy-full',savedAt:1,state:input}]]);
 assert.equal((await backup.load() as Record<string,unknown>|null)?.ledger,undefined);
});

test('a stalled storage open times out, closes a late connection, and does not poison queued retries',async()=>{
 const factory=new IDBFactory();let request:IDBOpenDBRequest|undefined,stall=true,closed=0;
 const fake={open(){request={} as IDBOpenDBRequest;return request;}} as unknown as IDBFactory;
 const backup=createScanBackup(()=>stall?fake:factory,()=>null,{openTimeoutMs:10});
 const load=backup.load();await assert.rejects(load,/응답하지 않아요|저장이 끝나지 않았어요/);
 stall=false;await backup.load();await backup.save(state());
 Object.defineProperty(request!,'result',{value:{close(){closed++;}}});
 request!.onsuccess?.call(request!,new Event('success'));
 assert.equal(closed,1);assert.deepEqual(await backup.load(),state());
});

test('blocked opens reject promptly and close a connection delivered after rejection',async()=>{
 let request:IDBOpenDBRequest|undefined,closed=0;
 const backup=createScanBackup(()=>({open(){request={} as IDBOpenDBRequest;queueMicrotask(()=>request!.onblocked?.call(request!,new Event('blocked') as IDBVersionChangeEvent));return request;}} as unknown as IDBFactory),()=>null);
 await assert.rejects(backup.load(),/다른 (LoaCard )?탭/);
 Object.defineProperty(request!,'result',{value:{close(){closed++;}}});
 request!.onsuccess?.call(request!,new Event('success'));assert.equal(closed,1);
});

test('a stalled transaction aborts within its budget and allows later operations',async()=>{
 const factory=new IDBFactory();let stall=true,aborted=0,closed=0;
 const tx={objectStore:()=>({get:()=>({})}),abort(){aborted++;}} as unknown as IDBTransaction;
 const db={transaction:()=>tx,close(){closed++;}} as unknown as IDBDatabase;
 const fake={open(){const request={result:db} as IDBOpenDBRequest;queueMicrotask(()=>request.onsuccess?.call(request,new Event('success')));return request;}} as unknown as IDBFactory;
 const backup=createScanBackup(()=>stall?fake:factory,()=>null,{transactionTimeoutMs:10});
 await assert.rejects(backup.load(),/응답하지 않아요|저장이 끝나지 않았어요/);assert.equal(aborted,1);assert.equal(closed,1);
 // A late completion must not update the client's revision after timeout.
 tx.oncomplete?.call(tx,new Event('complete'));
 stall=false;await backup.load();await backup.save(state('retry'));assert.equal((await backup.load())?.status,'retry');
});

test('a stored list that cannot be read can still be cleared, and is never loaded or overwritten', async () => {
  const factory = new IDBFactory();
  await seed(factory, [['current', {version: 1, revision: 'r', savedAt: 1, state: {cards: 'not a list'}}]]);
  const backup = createScanBackup(() => factory, () => null);
  await assert.rejects(backup.load(), /저장된 목록을 읽지 못했어요/);
  await assert.rejects(backup.save(state()));
  await backup.clear();
  assert.equal(await createScanBackup(() => factory, () => null).load(), undefined);
});
