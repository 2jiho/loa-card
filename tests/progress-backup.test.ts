import test from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory } from 'fake-indexeddb';
import { createProgressBackup, progressSnapshotState } from '../src/features/card-scanner/persistence/progress-backup';
import type { ScannerState } from '../src/features/card-scanner/orchestration/scanner';

const card = { id:'a', name:'카드', awakening:2, extraCopies:3, confidence:.9, review:[], image:'data:image/png;base64,card', time:1, observations:2 };

function state(): ScannerState {
  return {
    status:'카드를 읽고 있어요', percent:50, sampled:40, stable:40, expected:30, capacity:300, located:true,
    cards:[card], unreadable:0, queued:2, droppedFrames:1,
    unidentified:[{ image:'data:image/png;base64,unknown', time:2, pending:false }],
    growthHistory:[],
    grid:{
      located:true,
      cells:Array.from({length:40},(_,i)=>({ status:i===0?'read':i===1?'review':'unknown', ...(i===0?{row:2}:{}) })),
      inventory:Array.from({length:30},()=>({ status:'unknown' as const })),
      recent:{captured:40,read:1,waiting:37,reading:0,review:1},
      recentFrame:{frame:3,cells:Array.from({length:40},()=>({status:'unknown' as const}))},
      liveTracking:true,liveTop:2,
    },
  } as unknown as ScannerState;
}

async function seed(factory: IDBFactory, row: unknown) {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = factory.open('loacard-scan-progress',1);
    request.onupgradeneeded = () => request.result.createObjectStore('progress');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction('progress','readwrite');
    tx.objectStore('progress').put(row,'current');
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

test('progress checkpoints restore as an interrupted display state without images, live-frame claims or the earlier grid',async()=>{
  const factory = new IDBFactory(), progress = createProgressBackup(()=>factory);
  assert.equal(await progress.load(),undefined);
  await progress.save(state());
  const restored = await progress.load();
  assert.ok(restored);
  assert.equal(restored!.state.status,'스캔 중지');
  assert.equal(restored!.state.interrupted,'cancelled');
  assert.equal(restored!.state.cards[0].id,'a');
  assert.equal(restored!.state.cards[0].awakening,2);
  assert.equal(restored!.state.cards[0].extraCopies,3);
  assert.equal(restored!.state.cards[0].image,'');
  assert.equal(restored!.state.unidentified?.[0].image,'');
  assert.equal(restored!.state.growthHistory,undefined);
  // The earlier scanner's monitor grid is not restored.
  assert.equal(Object.hasOwn(restored!.state,'grid'),false);
});

test('progress checkpoint saves replace the previous checkpoint and clear removes it',async()=>{
  const factory = new IDBFactory(), progress = createProgressBackup(()=>factory);
  await progress.save(state());
  const first = await progress.load();
  const next = { ...state(), currentRunRead:12 } as ScannerState;
  await progress.save(next);
  const second = await progress.load();
  assert.ok(second!.savedAt >= first!.savedAt);
  assert.equal(second!.state.currentRunRead,12);
  await progress.clear();
  assert.equal(await progress.load(),undefined);
});

test('malformed live states are rejected before they replace a checkpoint',async()=>{
  const factory = new IDBFactory(), progress = createProgressBackup(()=>factory);
  await progress.save(state());
  const corrupt = { ...state(), cards:[{...card, awakening:9}] } as unknown as ScannerState;
  await assert.rejects(progress.save(corrupt),/진행 기록 형식/);
  assert.equal((await progress.load())!.state.cards.length,1);
});

test('malformed stored checkpoints are rejected instead of being rendered',async()=>{
  const factory = new IDBFactory(), progress = createProgressBackup(()=>factory);
  await seed(factory,{version:1,savedAt:1,state:{...state(),cards:[null]}});
  await assert.rejects(progress.load(),/진행 기록을 읽을 수 없습니다/);
});

test('progress projection keeps unknown fields distinct and never marks a completion',()=>{
  const snapshot = progressSnapshotState(state());
  assert.equal(snapshot.status,'스캔 중지');
  assert.equal(snapshot.interrupted,'cancelled');
  assert.notEqual(snapshot.status,'완료');
  assert.equal(snapshot.cards[0].awakening,2);
});
