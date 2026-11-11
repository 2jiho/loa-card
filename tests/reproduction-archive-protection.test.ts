import test from 'node:test';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import {createReproductionSessionStore,SessionStorageLimitError} from '../src/features/card-scanner/reproduction/reproduction-session-store';
import {beginReproduction,createReproductionArchiveAccess} from '../src/features/card-scanner/reproduction/scan-reproduction';

const environment={browser:'test',catalog:'test',build:'test'};
const receipt={caseId:'a'.repeat(64),sha256:'b'.repeat(64),bytes:123};
const req=<T>(value:IDBRequest<T>)=>new Promise<T>((resolve,reject)=>{value.onsuccess=()=>resolve(value.result);value.onerror=()=>reject(value.error);});
async function fixture(work:(store:ReturnType<typeof createReproductionSessionStore>,clock:{value:number},name:string)=>Promise<void>,maxSessions=2){
  const name=`archive-protection-${crypto.randomUUID()}`,clock={value:10_000};
  const store=createReproductionSessionStore({dbName:name,ownerId:'owner-a',now:()=>clock.value,
    limits:{maxSessions,maxBytes:100_000,detailsReserveBytes:0}});
  try{await work(store,clock,name);}finally{await req(indexedDB.deleteDatabase(name));}
}
const start=(id:string,protectForArchive=true)=>({id,createdAt:new Date().toISOString(),environment,record:true,protectForArchive});
const expected=(row:{generation?:string;archiveRevision?:string})=>({generation:row.generation!,revision:row.archiveRevision!});

test('protected complete input survives capacity until exact archive ACK and never changes user pin',async()=>{
  await fixture(async store=>{
    const initial=await store.beginSession(start('one'));
    assert.deepEqual(initial.archive,{state:'pending'});assert.equal(initial.pinned,false);
    await store.appendChunk('one','exact',0,new Blob(['frame']));
    const sealed=(await store.sealSession('one',{status:'complete',metadata:{bytes:0,completed:true,recordState:'complete',
      exact:{bytes:5,complete:true,dropped:0,error:'',frames:1}}}))!;
    await store.beginSession(start('two',false));await store.sealSession('two',{status:'complete'});
    await store.pinSession('one',true);
    const verifiedReceipt={...receipt,exactVerified:true as const};
    const ack=await store.acknowledgeArchive('one',expected(sealed),verifiedReceipt);
    assert.equal(ack.pinned,true);assert.deepEqual(ack.archive,{state:'stored',...verifiedReceipt,coverage:'declared-complete'});
    assert.deepEqual((await store.acknowledgeArchive('one',expected(sealed),verifiedReceipt)).archive,ack.archive);
    await store.beginSession(start('three',false));
    assert.ok(await store.getSession('one'),'user pin remains effective after acknowledgement');
    await store.pinSession('one',false);
    await store.sealSession('three',{status:'complete'});
    await store.beginSession(start('four',false));
    assert.equal(await store.getSession('one'),undefined,'acknowledged unpinned complete record may be evicted');
  });
});

test('complete index with absent or contradictory exact metadata remains protected after ACK',async()=>{
  await fixture(async store=>{
    await store.beginSession(start('one'));await store.appendChunk('one','exact',0,new Blob(['frame']));
    const sealed=(await store.sealSession('one',{status:'complete',metadata:{bytes:0,completed:true,recordState:'complete',
      exact:{bytes:5,complete:false,dropped:1,error:'missing',frames:1}}}))!;
    const ack=await store.acknowledgeArchive('one',expected(sealed),receipt);
    assert.equal(ack.archive?.state,'stored');
    if(ack.archive?.state==='stored')assert.equal(ack.archive.coverage,'partial');
    await assert.rejects(store.beginSession(start('two')),SessionStorageLimitError);
    assert.ok(await store.getSession('one'));
  },1);
});

test('legacy complete acknowledgement without event and pixel proof is protected and can upgrade to raw',async()=>{
  await fixture(async (store,_clock,name)=>{
    await store.beginSession(start('one'));await store.appendChunk('one','exact',0,new Blob(['frame']));
    const sealed=(await store.sealSession('one',{status:'complete',metadata:{bytes:0,completed:true,recordState:'complete',
      exact:{bytes:5,complete:true,dropped:0,error:'',frames:1}}}))!;
    // Model an index written by the older version, whose receipt trusted only
    // the recording metadata and has no independent event/pixel proof.
    const db=await req(indexedDB.open(name));
    await new Promise<void>((resolve,reject)=>{
      const tx=db.transaction('sessions','readwrite');
      tx.objectStore('sessions').put({...sealed,archive:{state:'stored',...receipt,coverage:'declared-complete'}});
      tx.oncomplete=()=>resolve();tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error);
    });db.close();
    await assert.rejects(store.beginSession(start('two')),SessionStorageLimitError);
    assert.ok(await store.getSession('one'),'a legacy metadata-only receipt cannot allow eviction');
    const raw={kind:'raw-session' as const,caseId:'c'.repeat(64),sha256:'d'.repeat(64),bytes:12,replayCaseId:receipt.caseId};
    const upgraded=await store.acknowledgeArchive('one',expected(sealed),raw);
    assert.deepEqual(upgraded.archive,{state:'stored',...raw,coverage:'unknown'});
    assert.ok(await store.getSession('one'));
  },1);
});

test('pending and acknowledged partial inputs remain protected; empty failure markers stay bounded',async()=>{
  await fixture(async store=>{
    await store.beginSession(start('partial'));
    await store.appendChunk('partial','exact',0,new Blob(['prefix']));
    const partial=(await store.sealSession('partial',{status:'partial'}))!;
    await store.acknowledgeArchive('partial',expected(partial),receipt);
    await assert.rejects(store.beginSession(start('full')),SessionStorageLimitError);
    const marker=(await store.listSessions()).find(item=>item.id==='full')!;
    assert.equal(marker.status,'partial');assert.equal(marker.bytes,0);assert.deepEqual(marker.archive,{state:'pending'});
    await assert.rejects(store.beginSession(start('another')),SessionStorageLimitError);
    assert.equal((await store.listSessions()).filter(item=>item.bytes===0).length,1,'retry does not accumulate empty protected markers');
    assert.ok(await store.getSession('partial'));
    assert.equal(await store.deleteSession('partial'),true,'explicit user deletion remains possible');
  },1);
});

test('stale ACK cannot release resealed or replaced sessions',async()=>{
  await fixture(async store=>{
    await store.beginSession(start('one'));await store.appendChunk('one','exact',0,new Blob(['prefix']));
    const first=(await store.sealSession('one',{status:'partial',summary:{value:'first'}}))!;
    const second=(await store.sealSession('one',{status:'partial',summary:{value:'other'}}))!;
    assert.notEqual(first.archiveRevision,second.archiveRevision);
    await assert.rejects(store.acknowledgeArchive('one',expected(first),receipt),/변경/);
    assert.deepEqual((await store.getSession('one'))!.index.archive,{state:'pending'});
    await store.deleteSession('one');await store.beginSession(start('one'));
    await store.appendChunk('one','exact',0,new Blob(['new']));await store.sealSession('one',{status:'complete'});
    await assert.rejects(store.acknowledgeArchive('one',expected(second),receipt),/변경/);
  });
});

test('interrupted protected session stays protected and conflicting ACK is rejected',async()=>{
  await fixture(async (store,clock,name)=>{
    await store.beginSession(start('one'));await store.appendChunk('one','exact',0,new Blob(['prefix']));
    clock.value+=130_000;
    const other=createReproductionSessionStore({dbName:name,ownerId:'owner-b',now:()=>clock.value,
      limits:{maxSessions:1,maxBytes:100_000,detailsReserveBytes:0}});
    const [recovered]=await other.recoverInterrupted();
    assert.equal(recovered.status,'partial');assert.deepEqual(recovered.archive,{state:'pending'});
    await other.acknowledgeArchive('one',expected(recovered),receipt);
    await assert.rejects(other.acknowledgeArchive('one',expected(recovered),{...receipt,sha256:'c'.repeat(64)}),/다릅니다/);
    await assert.rejects(other.beginSession(start('two')),SessionStorageLimitError);
    assert.equal((await other.getSession('one'))!.index.pinned,false);
  },1);
});

test('recorder opt-in exposes a sealed retry candidate and rejects non-detailed protection',async()=>{
  await fixture(async store=>{
    assert.throws(()=>beginReproduction([],environment,{record:false,store,protectForArchive:true}),/상세/);
    const run=beginReproduction([],environment,{record:true,store,protectForArchive:true});
    run.options.continuous!({blob:new Blob(['preview'],{type:'video/webm'}),duration:1});
    const file=await run.finish(undefined,false);assert.ok(file);
    const access=createReproductionArchiveAccess(store),candidate=await access.load(run.id);
    assert.ok(candidate&&'file' in candidate);assert.equal(candidate.file.metadata.recordState,'partial');
    await run.acknowledgeArchive(receipt);
    assert.equal((await store.getSession(run.id))!.index.archive?.state,'stored');
    assert.equal((await store.getSession(run.id))!.index.pinned,false);
    assert.ok(await access.load(run.id),'partial remains available for manual retry');
  });
});

test('archive loading and acknowledgement reject changed chunk bytes even with unchanged recorded hash',async()=>{
  await fixture(async (store,_clock,name)=>{
    await store.beginSession(start('one'));await store.appendChunk('one','exact',0,new Blob(['first']));
    const sealed=(await store.sealSession('one',{status:'partial'}))!;
    assert.equal(await (await store.getVerifiedArchiveSession('one'))!.exact!.text(),'first');
    const db=await req(indexedDB.open(name));
    await new Promise<void>((resolve,reject)=>{
      const tx=db.transaction('chunks','readwrite'),chunks=tx.objectStore('chunks');
      const reading=chunks.get(['one','exact',0]);
      reading.onsuccess=()=>chunks.put({...reading.result,blob:new Blob(['other'])});
      tx.oncomplete=()=>resolve();tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error);
    });db.close();
    await assert.rejects(store.getVerifiedArchiveSession('one'),/실제 해시/);
    await assert.rejects(store.acknowledgeArchive('one',expected(sealed),receipt),/실제 해시/);
    assert.deepEqual((await store.getSession('one'))!.index.archive,{state:'pending'});
  });
});

test('archive verification aborts while reading a chunk and keeps its protected record',async()=>{
  await fixture(async store=>{
    await store.beginSession(start('one'));await store.appendChunk('one','exact',0,new Blob(['first']));
    await store.sealSession('one',{status:'partial'});
    const original=Blob.prototype.arrayBuffer;let entered!:()=>void;
    const reading=new Promise<void>(resolve=>{entered=resolve;});
    Blob.prototype.arrayBuffer=function(){entered();return new Promise<ArrayBuffer>(()=>{});};
    try{
      const controller=new AbortController(),pending=store.getVerifiedArchiveSession('one',{signal:controller.signal});
      await reading;controller.abort(new DOMException('cancelled','AbortError'));
      await assert.rejects(pending,{name:'AbortError'});
    }finally{Blob.prototype.arrayBuffer=original;}
    assert.deepEqual((await store.getSession('one'))!.index.archive,{state:'pending'});
  });
});

test('archive verification detects resealing while bounded chunk hashing is in flight',async()=>{
  await fixture(async store=>{
    await store.beginSession(start('one'));await store.appendChunk('one','exact',0,new Blob(['first']));
    await store.sealSession('one',{status:'partial',summary:{value:'first'}});
    const original=Blob.prototype.arrayBuffer;let entered!:()=>void,release!:()=>void;
    const reading=new Promise<void>(resolve=>{entered=resolve;}),hold=new Promise<void>(resolve=>{release=resolve;});
    Blob.prototype.arrayBuffer=function(){entered();return hold.then(()=>original.call(this));};
    try{
      const pending=store.getVerifiedArchiveSession('one');
      await reading;await store.sealSession('one',{status:'partial',summary:{value:'other'}});release();
      await assert.rejects(pending,/변경/);
    }finally{release();Blob.prototype.arrayBuffer=original;}
    assert.deepEqual((await store.getSession('one'))!.index.archive,{state:'pending'});
  });
});

test('archive verification reads bounded chunks rather than materializing the composed input',async()=>{
  await fixture(async store=>{
    await store.beginSession(start('one'));
    await store.appendChunk('one','exact',0,new Blob(['a'.repeat(20_000)]));
    await store.appendChunk('one','exact',1,new Blob(['b'.repeat(20_000)]));
    await store.sealSession('one',{status:'partial'});
    const original=Blob.prototype.arrayBuffer;let largest=0;
    Blob.prototype.arrayBuffer=function(){
      largest=Math.max(largest,this.size);
      if(this.size>20_000)throw Error('whole composed input was materialized');
      return original.call(this);
    };
    let verified:Awaited<ReturnType<typeof store.getVerifiedArchiveSession>>;
    try{verified=await store.getVerifiedArchiveSession('one');}finally{Blob.prototype.arrayBuffer=original;}
    assert.equal(largest,20_000);assert.equal(verified!.exact!.size,40_000);
  });
});
