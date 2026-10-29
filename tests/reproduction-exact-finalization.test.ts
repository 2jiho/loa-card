import test from 'node:test';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import {IDBObjectStore} from 'fake-indexeddb';
import {createReproductionSessionStore,SessionStorageLimitError,SESSION_LEASE_MS} from '../src/features/card-scanner/reproduction-session-store';
import type {ExactFinalizationInput,SessionStoreOptions} from '../src/features/card-scanner/reproduction-session-store';

const env={browser:'test',catalog:'test',build:'test'};
const request=<T>(value:IDBRequest<T>)=>new Promise<T>((resolve,reject)=>{value.onsuccess=()=>resolve(value.result);value.onerror=()=>reject(value.error);});
const pixels=(length:number)=>Uint8Array.from({length},(_,i)=>(i*31+(i>>>8)*17)&255);
const start=(id:string)=>({id,createdAt:new Date(10000).toISOString(),environment:env,record:true});
const seal={status:'complete' as const,summary:{result:{read:1,expected:1,cards:[{id:'one'}]}},metadata:{type:'',complete:true}};
async function fixture(run:(store:ReturnType<typeof createReproductionSessionStore>,name:string,clock:{value:number})=>Promise<void>,limits:SessionStoreOptions['limits']={maxBytes:10000,maxChunkBytes:1024,detailsReserveBytes:0}){
  const name=`exact-finalization-${crypto.randomUUID()}`,clock={value:10000};
  const store=createReproductionSessionStore({dbName:name,ownerId:'owner-a',now:()=>clock.value,limits});
  try{await run(store,name,clock);}finally{await request(indexedDB.deleteDatabase(name));}
}
async function appendParts(store:ReturnType<typeof createReproductionSessionStore>,id:string,kind:'video'|'exact',blob:Blob){
  for(let from=0,seq=0;from<blob.size;from+=store.limits.maxChunkBytes,seq++)await store.appendChunk(id,kind,seq,blob.slice(from,from+store.limits.maxChunkBytes));
}
async function rawWrite(name:string,storeName:string,change:(store:IDBObjectStore)=>Promise<void>|void){
  const db=await request(indexedDB.open(name));
  try{await new Promise<void>((resolve,reject)=>{
    const tx=db.transaction(storeName,'readwrite');tx.oncomplete=()=>resolve();tx.onabort=()=>reject(tx.error);
    Promise.resolve(change(tx.objectStore(storeName))).catch(error=>{tx.abort();reject(error);});
  });}finally{db.close();}
}
async function state(store:ReturnType<typeof createReproductionSessionStore>,id:string){
  const value=(await store.getSession(id))!;return {index:value.index,initial:value.initial,summary:value.summary,metadata:value.metadata,
    receipt:value.exactFinalization,video:await value.video.text(),exact:value.exact?Array.from(new Uint8Array(await value.exact.arrayBuffer())):null};
}

test('capacity-only reconciliation appends after all 412 trailing bytes and atomically exchanges video for final details',async()=>{
  await fixture(async store=>{
    const producer=new Blob([pixels(3000)]);await store.beginSession(start('one'));
    await appendParts(store,'one','video',new Blob(['V'.repeat(3000)]));
    await store.appendChunk('one','exact',0,producer.slice(0,1000));await store.appendChunk('one','exact',1,producer.slice(1000,1412));
    await assert.rejects(store.appendChunk('one','exact',2,producer.slice(1412,2436)),SessionStorageLimitError);
    const before=await state(store,'one');assert.equal(before.index.status,'partial');assert.equal(before.index.failure?.kind,'storage-capacity');
    const incoming=structuredClone(seal),plan=await store.prepareExactFinalization('one',{producer,seal:incoming,omitVideo:true});
    incoming.summary.result.read=999;incoming.metadata.complete=false;
    assert.equal(plan.storedExactBytes,1412);assert.equal(plan.tailBytes,1588);assert.equal(plan.retainedVideoBytes,0);assert.ok(Object.isFrozen(plan));
    const result=await store.commitExactFinalization(plan),loaded=(await store.getSession('one'))!;
    assert.equal(result.status,'complete');assert.equal(result.sealed,true);assert.equal(result.reason,undefined);assert.equal(result.failure,undefined);
    assert.equal(loaded.video.size,0);assert.equal(loaded.exact!.size,3000);assert.deepEqual(new Uint8Array(await loaded.exact!.arrayBuffer()),pixels(3000));
    assert.deepEqual(result.chunkCounts,{video:0,exact:4});assert.equal(result.detailsBytes,plan.finalDetailsBytes);
    assert.equal((loaded.summary as typeof seal.summary).result.read,1);assert.equal((loaded.metadata as typeof seal.metadata).complete,true);
    assert.equal(loaded.exactFinalization?.storedExactBytes,1412);assert.equal(loaded.exactFinalization?.omittedVideoBytes,3000);
    assert.equal(loaded.exactFinalization?.originalCapacityFailure?.nonce,before.index.failure?.nonce);
    assert.equal(loaded.exactFinalization?.originalReason,before.index.reason);
    await assert.rejects(store.commitExactFinalization(plan),/계획/);
  },{maxBytes:5000,maxChunkBytes:1024,detailsReserveBytes:0});
});

test('prepare hashes actual stored bytes, not merely the stored SHA label, and checks producer prefix equality',async()=>{
  await fixture(async(store,name)=>{
    const producer=new Blob([pixels(1000)]);await store.beginSession(start('one'));await store.appendChunk('one','exact',0,producer.slice(0,400));
    const wrong=pixels(1000);wrong[17]^=255;
    await assert.rejects(store.prepareExactFinalization('one',{producer:new Blob([wrong]),seal,omitVideo:false}),/접두.*다릅니다/);
    await rawWrite(name,'chunks',async table=>{const chunk=await request(table.get(['one','exact',0]));chunk.blob=new Blob([new Uint8Array(400).fill(99)]);table.put(chunk);});
    await assert.rejects(store.prepareExactFinalization('one',{producer,seal,omitVideo:false}),/실제 해시/);
    assert.equal((await store.getSession('one'))!.index.status,'open');
  });
});

test('prepare reads <=configured chunk backing and is abortable outside the IDB transaction',async()=>{
  await fixture(async store=>{
    const producer=new Blob([pixels(3000)]);await store.beginSession(start('one'));await store.appendChunk('one','exact',0,producer.slice(0,412));
    const original=Blob.prototype.arrayBuffer;let peak=0,release!:()=>void,entered!:()=>void;
    const gate=new Promise<void>(resolve=>{release=resolve;}),waiting=new Promise<void>(resolve=>{entered=resolve;});
    Blob.prototype.arrayBuffer=async function(){peak=Math.max(peak,this.size);assert.ok(this.size<=1024);entered();await gate;return original.call(this);};
    const abort=new AbortController();
    try{
      const preparing=store.prepareExactFinalization('one',{producer,seal,omitVideo:true},{signal:abort.signal});await waiting;
      // A write completes while hashing is held: prepare owns no IDB lock.
      await store.heartbeat('one');abort.abort();await assert.rejects(preparing,{name:'AbortError'});release();
    }finally{Blob.prototype.arrayBuffer=original;release?.();}
    assert.ok(peak<=1024);assert.equal((await store.getSession('one'))!.index.sealed,false);
  });
});

test('wrong owner, expired lease, sealed session and non-capacity partial cannot mint a finalization plan',async()=>{
  await fixture(async(store,name,clock)=>{
    const producer=new Blob([pixels(100)]),input={producer,seal,omitVideo:true};
    await store.beginSession(start('one'));
    const other=createReproductionSessionStore({dbName:name,ownerId:'other',now:()=>clock.value});
    await assert.rejects(other.prepareExactFinalization('one',input),/소유/);
    clock.value+=SESSION_LEASE_MS;await assert.rejects(store.prepareExactFinalization('one',input),/만료/);
    await store.beginSession(start('sealed'));await store.sealSession('sealed',{status:'partial'});
    await assert.rejects(store.prepareExactFinalization('sealed',input),/닫혔/);
    await store.beginSession(start('forged'));
    await rawWrite(name,'sessions',async table=>{const index=await request(table.get('forged'));index.status='partial';index.reason='기록 보관 용량 한도를 초과해 이후 입력을 저장하지 못했습니다.';table.put(index);});
    await assert.rejects(store.prepareExactFinalization('forged',input),/용량 실패/);
  });
});

test('capacity permission is instance-bound and normal sealSession still cannot promote partial to complete',async()=>{
  await fixture(async(store,name,clock)=>{
    const producer=new Blob([pixels(3000)]);await store.beginSession(start('one'));
    await appendParts(store,'one','video',new Blob(['V'.repeat(3000)]));await store.appendChunk('one','exact',0,producer.slice(0,1000));
    await assert.rejects(store.appendChunk('one','exact',1,producer.slice(1000,2024)),SessionStorageLimitError);
    const clone=createReproductionSessionStore({dbName:name,ownerId:'owner-a',now:()=>clock.value,limits:store.limits});
    await assert.rejects(clone.prepareExactFinalization('one',{producer,seal,omitVideo:true}),/용량 실패/);
    const sealed=await store.sealSession('one',{status:'complete'});assert.equal(sealed!.status,'partial');assert.equal(sealed!.sealed,true);
    await assert.rejects(store.prepareExactFinalization('one',{producer,seal,omitVideo:true}),/닫혔/);
  },{maxBytes:5000,maxChunkBytes:1024,detailsReserveBytes:0});
});

test('opaque plans reject JSON copies, another store and a changed prefix; heartbeat/pin alone remain allowed',async()=>{
  await fixture(async(store,name,clock)=>{
    const producer=new Blob([pixels(1000)]);await store.beginSession(start('one'));await store.appendChunk('one','exact',0,producer.slice(0,400));
    const input={producer,seal,omitVideo:true},plan=await store.prepareExactFinalization('one',input);
    await assert.rejects(store.commitExactFinalization(JSON.parse(JSON.stringify(plan))),/계획/);
    const clone=createReproductionSessionStore({dbName:name,ownerId:'owner-a',now:()=>clock.value});
    await assert.rejects(clone.commitExactFinalization(plan),/계획/);
    await store.appendChunk('one','exact',1,producer.slice(400,500));
    await assert.rejects(store.commitExactFinalization(plan),/접두.*변경/);
    const fresh=await store.prepareExactFinalization('one',input);clock.value+=20;await store.heartbeat('one');await store.pinSession('one',true);
    const done=await store.commitExactFinalization(fresh);assert.equal(done.pinned,true);assert.equal(done.status,'complete');
  });
});

test('deleting and recreating the same session ID cannot reuse an old prepared plan',async()=>{
  await fixture(async store=>{
    const producer=new Blob([pixels(1000)]),input={producer,seal,omitVideo:true};
    await store.beginSession(start('one'));await store.appendChunk('one','exact',0,producer.slice(0,400));
    const plan=await store.prepareExactFinalization('one',input),generation=(await store.getSession('one'))!.index.generation;
    await store.deleteSession('one',{cancelOwned:true});await store.beginSession(start('one'));await store.appendChunk('one','exact',0,producer.slice(0,400));
    assert.notEqual((await store.getSession('one'))!.index.generation,generation);
    await assert.rejects(store.commitExactFinalization(plan),/접두.*변경/);
  });
});

test('protected sessions keep their actual bytes/reservations and failed final budget changes nothing',async()=>{
  await fixture(async store=>{
    await store.beginSession(start('pinned'));await appendParts(store,'pinned','video',new Blob(['P'.repeat(2200)]));await store.sealSession('pinned',{status:'complete'});await store.pinSession('pinned',true);
    await store.beginSession(start('active'));await appendParts(store,'active','video',new Blob(['A'.repeat(1000)]));
    await store.beginSession(start('target'));const producer=new Blob([pixels(2500)]);await store.appendChunk('target','exact',0,producer.slice(0,400));
    const before=await store.listSessions(),plan=await store.prepareExactFinalization('target',{producer,seal,omitVideo:true});
    await assert.rejects(store.commitExactFinalization(plan),SessionStorageLimitError);assert.deepEqual(await store.listSessions(),before);
    assert.equal((await store.getSession('pinned'))!.video.size,2200);assert.equal((await store.getSession('active'))!.video.size,1000);
  },{maxBytes:5500,maxChunkBytes:1024,detailsReserveBytes:512});
});

async function rollbackFixture(run:(store:ReturnType<typeof createReproductionSessionStore>,plan:Awaited<ReturnType<ReturnType<typeof createReproductionSessionStore>['prepareExactFinalization']>>)=>Promise<void>){
  await fixture(async store=>{
    await store.beginSession(start('victim'));await appendParts(store,'victim','video',new Blob(['V'.repeat(2500)]));await store.sealSession('victim',{status:'complete'});
    await store.beginSession(start('target'));await appendParts(store,'target','video',new Blob(['T'.repeat(500)]));
    const producer=new Blob([pixels(3000)]);await store.appendChunk('target','exact',0,producer.slice(0,400));
    const before=[await state(store,'victim'),await state(store,'target')],plan=await store.prepareExactFinalization('target',{producer,seal,omitVideo:true});
    await run(store,plan);assert.deepEqual([await state(store,'victim'),await state(store,'target')],before);
    const fresh=await store.prepareExactFinalization('target',{producer,seal,omitVideo:true});await store.commitExactFinalization(fresh);
    assert.equal(await store.getSession('victim'),undefined);assert.equal((await store.getSession('target'))!.exact!.size,3000);
  },{maxBytes:5000,maxChunkBytes:1024,detailsReserveBytes:0});
}
test('Quota during tail write rolls back video removal, retention eviction, details and the sealed index',async()=>{
  await rollbackFixture(async(store,plan)=>{
    const add=IDBObjectStore.prototype.add;
    IDBObjectStore.prototype.add=function(...args:Parameters<typeof add>){if(this.name==='chunks')throw new DOMException('Quota','QuotaExceededError');return add.apply(this,args);};
    try{await assert.rejects(store.commitExactFinalization(plan),{name:'QuotaExceededError'});}finally{IDBObjectStore.prototype.add=add;}
  });
});
test('abort after an IDB tail write is queued rolls the entire reconciliation transaction back',async()=>{
  await rollbackFixture(async(store,plan)=>{
    const add=IDBObjectStore.prototype.add,abort=new AbortController();
    IDBObjectStore.prototype.add=function(...args:Parameters<typeof add>){const pending=add.apply(this,args);if(this.name==='chunks')abort.abort();return pending;};
    try{await assert.rejects(store.commitExactFinalization(plan,{signal:abort.signal}),{name:'AbortError'});}finally{IDBObjectStore.prototype.add=add;}
  });
});

test('known quota loss cannot be reclassified as storage-capacity by metadata.complete',async()=>{
  await fixture(async store=>{
    await store.beginSession(start('one'));const producer=new Blob([pixels(1000)]);await store.appendChunk('one','exact',0,producer.slice(0,400));
    const add=IDBObjectStore.prototype.add;
    IDBObjectStore.prototype.add=function(...args:Parameters<typeof add>){if(this.name==='chunks')throw new DOMException('Quota','QuotaExceededError');return add.apply(this,args);};
    try{await assert.rejects(store.appendChunk('one','exact',1,producer.slice(400,500)),{name:'QuotaExceededError'});}finally{IDBObjectStore.prototype.add=add;}
    assert.equal((await store.getSession('one'))!.index.failure?.kind,'storage-quota');
    await assert.rejects(store.prepareExactFinalization('one',{producer,seal:{...seal,metadata:{complete:true}},omitVideo:true}),/이외의 실패/);
  });
});
