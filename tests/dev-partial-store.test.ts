import test from 'node:test';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import {IDBObjectStore} from 'fake-indexeddb';
import {createPartialStore,createLatestPartialWriter,sanitizePartialSnapshot,PartialStoreError,type PartialSnapshot,type PartialStore} from '../src/features/card-scanner/persistence/partial-store';

const del=(db:string)=>new Promise<void>((resolve,reject)=>{const req=indexedDB.deleteDatabase(db);req.onsuccess=()=>resolve();req.onerror=()=>reject(req.error);});
const snapshot=(id='one'):PartialSnapshot=>({cards:[{id,name:`카드 ${id}`,identityUncertain:false,awakening:1,extraCopies:2}],expected:1,growthPoints:200});
async function fixture(fn:(store:PartialStore,name:string)=>Promise<void>){const name=`loacard-dev-partial-proof-${crypto.randomUUID()}`;try{await fn(createPartialStore({dbName:name}),name);}finally{await del(name);}}

test('snapshot strips image, OCR and arbitrary fields; impossible values are rejected',()=>{
 const input={...snapshot(),preview:'secret image',cards:[{...snapshot().cards[0],image:'secret',ocr:'private'}]};
 const output=sanitizePartialSnapshot(input);assert.deepEqual(output,snapshot());assert.doesNotMatch(JSON.stringify(output),/secret|ocr|preview/);
 assert.throws(()=>sanitizePartialSnapshot({...snapshot(),cards:[{...snapshot().cards[0],awakening:4,extraCopies:10}]}),PartialStoreError);
 assert.throws(()=>sanitizePartialSnapshot({...snapshot(),cards:[{...snapshot().cards[0],identityUncertain:undefined} as never]}),PartialStoreError);
 assert.throws(()=>sanitizePartialSnapshot({...snapshot(),cards:[snapshot().cards[0],snapshot().cards[0]]}),PartialStoreError);
 assert.throws(()=>sanitizePartialSnapshot({...snapshot(),expected:-1}),PartialStoreError);
});

test('independent store instances serialize competing CAS writes, and a deleted record cannot be resurrected',async()=>fixture(async(store,name)=>{
 const other=createPartialStore({dbName:name}),handle=await store.start();
 assert.equal((await store.read(handle.id))?.status,'pending');assert.deepEqual(await store.list(),[],'an unsaved reservation is not a zero-card partial result');
 const writes=await Promise.allSettled([store.save(handle,snapshot('a')),other.save(handle,snapshot('b'))]);
 assert.equal(writes.filter(item=>item.status==='fulfilled').length,1);
 const failure=writes.find(item=>item.status==='rejected') as PromiseRejectedResult;assert.equal(failure.reason.code,'conflict');
 const row=await store.read(handle.id);assert.equal(row?.status,'partial');assert.equal(row?.revision,1);
 await other.remove(handle);assert.equal((await store.read(handle.id))?.status,'deleted');
 await assert.rejects(store.save({...handle,revision:1},snapshot('late')),(e:unknown)=>e instanceof PartialStoreError&&e.code==='conflict');
 assert.deepEqual(await other.list(),[]);
}));

test('tombstones cannot be compacted or bypassed by opening another instance',async()=>fixture(async(store,name)=>{
 const first=await store.start();await store.remove(first);
 for(let i=1;i<128;i++)await store.start();
 await assert.rejects(createPartialStore({dbName:name}).start(),(e:unknown)=>e instanceof PartialStoreError&&e.code==='capacity');
 assert.equal((await store.read(first.id))?.status,'deleted');assert.equal((await store.list()).length,0);
 assert.deepEqual(await store.stats(),{partial:0,pending:127,deleted:1,limit:128});
}));

test('latest writer keeps at most one inflight and one replaceable pending snapshot',async()=>{
 const first:{resolve?:()=>void}={},calls:string[]=[],h={id:crypto.randomUUID(),epoch:crypto.randomUUID(),revision:0};
 const mock={save:async(handle:typeof h,data:PartialSnapshot)=>{calls.push(data.cards[0].id);if(calls.length===1)await new Promise<void>(r=>{first.resolve=r;});return {...handle,revision:handle.revision+1};},remove:async()=>{}} as unknown as PartialStore;
 const states:string[]=[],writer=createLatestPartialWriter(mock,h,s=>states.push(s.state));
 writer.offer(snapshot('a'));writer.offer(snapshot('b'));writer.offer(snapshot('c'));assert.deepEqual(calls,['a']);first.resolve!();await writer.flush();
 assert.deepEqual(calls,['a','c']);assert.deepEqual(states,['saving','saved','saving','saved']);
});

test('a write with unknown commit status fences pending and later offers',async()=>{
 const h={id:crypto.randomUUID(),epoch:crypto.randomUUID(),revision:0},statuses:string[]=[],err=new PartialStoreError('unknown','unknown');let calls=0;
 const mock={save:async()=>{calls++;throw err;},remove:async()=>{}} as unknown as PartialStore;
 const writer=createLatestPartialWriter(mock,h,s=>statuses.push(`${s.state}:${s.code??''}`));writer.offer(snapshot('a'));writer.offer(snapshot('b'));
 await assert.rejects(writer.flush(),err);assert.equal(calls,1);assert.throws(()=>writer.offer(snapshot('later')),err);
 assert.deepEqual(statuses,['saving:','error:unknown']);
});

test('remove stops pending writes before awaiting deletion; late completion cannot schedule another write',async()=>{
 let release!:()=>void;const started=new Promise<void>(r=>{release=r;}),calls:string[]=[],h={id:crypto.randomUUID(),epoch:crypto.randomUUID(),revision:0};
 const mock={save:async(handle:typeof h,data:PartialSnapshot)=>{calls.push(data.cards[0].id);await started;return {...handle,revision:1};},remove:async()=>{calls.push('remove');}} as unknown as PartialStore;
 const writer=createLatestPartialWriter(mock,h);writer.offer(snapshot('a'));writer.offer(snapshot('b'));await writer.remove();release();await writer.flush();
 assert.deepEqual(calls,['a','remove']);assert.throws(()=>writer.offer(snapshot('later')),PartialStoreError);
});

test('open timeout reports unknown instead of asserting no commit',async()=>{
 const previous=Object.getOwnPropertyDescriptor(globalThis,'indexedDB');
 Object.defineProperty(globalThis,'indexedDB',{configurable:true,value:{open:()=>({})}});
 try{await assert.rejects(createPartialStore({dbName:'loacard-dev-partial-delayed',timeoutMs:10}).start(),(e:unknown)=>e instanceof PartialStoreError&&e.code==='unknown');}
 finally{if(previous)Object.defineProperty(globalThis,'indexedDB',previous);}
});

test('transaction timeout attempts abort and a later completion cannot turn failure into success',async()=>{
 const previous=Object.getOwnPropertyDescriptor(globalThis,'indexedDB');let aborted=false,closed=false;
 const tx:{oncomplete?:()=>void;onabort?:()=>void;onerror?:()=>void;objectStore:()=>unknown;abort:()=>void}={objectStore:()=>({count:()=>({})}),abort:()=>{aborted=true;}};
 const fakeDb={transaction:()=>tx,close:()=>{closed=true;},onversionchange:undefined};
 Object.defineProperty(globalThis,'indexedDB',{configurable:true,value:{open:()=>{const req:{result:unknown;onsuccess?:()=>void}={result:fakeDb};queueMicrotask(()=>req.onsuccess?.());return req;}}});
 try{await assert.rejects(createPartialStore({dbName:'loacard-dev-partial-delayed-tx',timeoutMs:10}).start(),(e:unknown)=>e instanceof PartialStoreError&&e.code==='unknown');assert.equal(aborted,true);assert.equal(closed,true);assert.doesNotThrow(()=>tx.oncomplete?.());}
 finally{if(previous)Object.defineProperty(globalThis,'indexedDB',previous);}
});

test('a real tombstone fences a writer whose save starts after deletion',async()=>fixture(async store=>{
 const h=await store.start();let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});
 const delayed={...store,save:async(handle:typeof h,value:PartialSnapshot)=>{await gate;return store.save(handle,value);}};
 const writer=createLatestPartialWriter(delayed,h);writer.offer(snapshot('late'));await writer.remove();release();
 await assert.rejects(writer.flush(),(e:unknown)=>e instanceof PartialStoreError&&e.code==='conflict');
 assert.equal((await store.read(h.id))?.status,'deleted');assert.deepEqual(await store.list(),[]);
}));

test('a quota exception is reported as uncertain and the prior saved snapshot remains readable',async()=>fixture(async store=>{
 const first=await store.start(),saved=await store.save(first,snapshot('before'));
 const original=IDBObjectStore.prototype.put;
 IDBObjectStore.prototype.put=function(){throw new DOMException('quota','QuotaExceededError');};
 try{await assert.rejects(store.save(saved,snapshot('after')),(e:unknown)=>e instanceof PartialStoreError&&e.code==='unknown');}
 finally{IDBObjectStore.prototype.put=original;}
 const row=await store.read(saved.id);assert.equal(row?.status,'partial');if(row?.status==='partial')assert.deepEqual(row.snapshot,snapshot('before'));
}));

test('invalid persisted payload is rejected rather than surfaced as verified partial data',async()=>fixture(async(store,name)=>{
 const h=await store.start();const db=await new Promise<IDBDatabase>((resolve,reject)=>{const req=indexedDB.open(name);req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error);});
 await new Promise<void>((resolve,reject)=>{const tx=db.transaction('snapshots','readwrite');tx.objectStore('snapshots').put({...h,status:'partial',updatedAt:Date.now(),snapshot:{cards:'corrupt',expected:null,growthPoints:null}});tx.oncomplete=()=>resolve();tx.onerror=()=>reject(tx.error);});db.close();
 await assert.rejects(store.read(h.id),(e:unknown)=>e instanceof PartialStoreError&&e.code==='invalid');
 await assert.rejects(store.list(),(e:unknown)=>e instanceof PartialStoreError&&e.code==='invalid');
}));

test('existing app and recording database names are rejected',()=>{assert.throws(()=>createPartialStore({dbName:'loacard-reproduction'}),PartialStoreError);assert.throws(()=>createPartialStore({dbName:'loacard-scan-backups'}),PartialStoreError);});
