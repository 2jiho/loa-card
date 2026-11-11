import test from 'node:test';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import {createReproductionSessionStore} from '../src/features/card-scanner/reproduction/reproduction-session-store';

const request=<T>(value:IDBRequest<T>)=>new Promise<T>((resolve,reject)=>{
  value.onsuccess=()=>resolve(value.result);value.onerror=()=>reject(value.error);
});
const environment={browser:'test',catalog:'catalog-1',build:'build-1'};
async function fixture(work:(store:ReturnType<typeof createReproductionSessionStore>,name:string)=>Promise<void>,maxSessions=2){
  const name=`raw-archive-${crypto.randomUUID()}`;
  const store=createReproductionSessionStore({dbName:name,ownerId:'owner-a',now:()=>1000,
    limits:{maxSessions,maxBytes:1_000_000,detailsReserveBytes:0}});
  try{await work(store,name);}finally{await request(indexedDB.deleteDatabase(name));}
}
async function sealed(store:ReturnType<typeof createReproductionSessionStore>){
  await store.beginSession({id:'one',createdAt:'2026-10-30T00:00:00.000Z',environment,record:true,
    protectForArchive:true,initial:{seed:'value'}});
  await store.appendChunk('one','exact',0,new Blob(['exact0']));
  await store.appendChunk('one','video',0,new Blob(['video0']));
  await store.appendChunk('one','exact',1,new Blob(['partial-tail']));
  await store.appendChunk('one','video',1,new Blob(['video1']));
  return (await store.sealSession('one',{status:'partial',summary:{reason:'captured'},metadata:{type:'video/webm'},reason:'interrupted'}))!;
}
async function mutate(name:string,action:(tx:IDBTransaction)=>void){
  const db=await request(indexedDB.open(name));
  try{await new Promise<void>((resolve,reject)=>{
    const tx=db.transaction(['sessions','chunks'],'readwrite');action(tx);
    tx.oncomplete=()=>resolve();tx.onabort=()=>reject(tx.error);tx.onerror=()=>reject(tx.error);
  });}finally{db.close();}
}

test('verified raw snapshot preserves every per-kind chunk and session metadata, including an incomplete tail',async()=>{
  await fixture(async store=>{
    const index=await sealed(store),snapshot=(await store.getVerifiedArchiveSnapshot('one'))!;
    assert.equal(snapshot.index.generation,index.generation);assert.equal(snapshot.index.archiveRevision,index.archiveRevision);
    assert.equal(snapshot.index.status,'partial');assert.equal(snapshot.index.reason,'interrupted');
    assert.deepEqual(snapshot.index.environment,environment);assert.deepEqual(snapshot.initial,{seed:'value'});
    assert.deepEqual(snapshot.summary,{reason:'captured'});assert.deepEqual(snapshot.metadata,{type:'video/webm'});
    assert.deepEqual(snapshot.chunks.map(({kind,seq,bytes})=>[kind,seq,bytes]),[
      ['video',0,6],['video',1,6],['exact',0,6],['exact',1,12],
    ]);
    assert.deepEqual(await Promise.all(snapshot.chunks.map(chunk=>chunk.blob.text())),['video0','video1','exact0','partial-tail']);
    assert.ok(snapshot.chunks.every(chunk=>/^[a-f0-9]{64}$/.test(chunk.sha256)));
    assert.ok(Object.isFrozen(snapshot.chunks));assert.ok(snapshot.chunks.every(Object.isFrozen));
    const previous=(await store.getVerifiedArchiveSession('one'))!;
    assert.equal(await previous.video.text(),'video0video1');assert.equal(await previous.exact!.text(),'exact0partial-tail');
    assert.deepEqual(snapshot.index.archive,{state:'pending'},'reading never acknowledges or releases a protected session');
  });
});

test('raw snapshot rejects modified bytes, missing chunks and sequence tampering',async()=>{
  for(const mode of ['bytes','missing','sequence'] as const)await fixture(async(store,name)=>{
    await sealed(store);
    await mutate(name,tx=>{
      const chunks=tx.objectStore('chunks');
      if(mode==='missing')chunks.delete(['one','exact',0]);
      else {
        const get=chunks.get(['one','exact',0]);
        get.onsuccess=()=>{
          if(mode==='bytes')chunks.put({...get.result,blob:new Blob(['CHANGE'])});
          else {chunks.delete(['one','exact',0]);chunks.put({...get.result,seq:4});}
        };
      }
    });
    await assert.rejects(store.getVerifiedArchiveSnapshot('one'),/일치|손상|해시/);
    assert.deepEqual((await store.listSessions())[0].archive,{state:'pending'});
  });
});

test('raw snapshot rejects reseal, deletion and replacement while chunk hashing is in flight',async()=>{
  for(const mode of ['reseal','delete','replace'] as const)await fixture(async store=>{
    await sealed(store);
    const original=Blob.prototype.arrayBuffer;let entered!:()=>void,release!:()=>void;
    const reading=new Promise<void>(resolve=>{entered=resolve;}),hold=new Promise<void>(resolve=>{release=resolve;});
    Blob.prototype.arrayBuffer=function(){entered();return hold.then(()=>original.call(this));};
    try{
      const pending=store.getVerifiedArchiveSnapshot('one');
      await reading;
      // The snapshot read is still held; allow operations on a replacement to
      // hash its new chunk without changing the pending snapshot's Blob.
      Blob.prototype.arrayBuffer=original;
      if(mode==='reseal')await store.sealSession('one',{status:'partial',summary:{changed:true}});
      else {
        await store.deleteSession('one');
        if(mode==='replace')await sealed(store);
      }
      release();await assert.rejects(pending,/변경|삭제/);
    }finally{release();Blob.prototype.arrayBuffer=original;}
  });
});

test('raw snapshot hashes one bounded original chunk at a time and cancellation leaves protection intact',async()=>{
  await fixture(async store=>{
    await sealed(store);
    const original=Blob.prototype.arrayBuffer;let largest=0;
    Blob.prototype.arrayBuffer=function(){largest=Math.max(largest,this.size);return original.call(this);};
    try{await store.getVerifiedArchiveSnapshot('one');}finally{Blob.prototype.arrayBuffer=original;}
    assert.equal(largest,12);
    let entered!:()=>void;
    const reading=new Promise<void>(resolve=>{entered=resolve;});
    Blob.prototype.arrayBuffer=function(){entered();return new Promise<ArrayBuffer>(()=>{});};
    try{
      const abort=new AbortController(),pending=store.getVerifiedArchiveSnapshot('one',{signal:abort.signal});
      await reading;abort.abort(new DOMException('cancelled','AbortError'));
      await assert.rejects(pending,{name:'AbortError'});
    }finally{Blob.prototype.arrayBuffer=original;}
    assert.deepEqual((await store.getSession('one'))!.index.archive,{state:'pending'});
  });
});

test('a partial session remains eviction protected even when its raw archive receipt is acknowledged',async()=>{
  await fixture(async store=>{
    const index=await sealed(store),raw={kind:'raw-session' as const,caseId:'a'.repeat(64),sha256:'b'.repeat(64),bytes:1234,replayCaseId:'c'.repeat(64)};
    const acknowledged=await store.acknowledgeArchive('one',{generation:index.generation!,revision:index.archiveRevision!},raw);
    assert.deepEqual(acknowledged.archive,{state:'stored',...raw,coverage:'partial'});
    await assert.rejects(store.beginSession({id:'two',createdAt:'2026-10-30T00:00:01.000Z',environment,record:true}),/용량|한도/);
    assert.ok(await store.getSession('one'),'an acknowledged partial session stays protected');
  },1);
});

test('raw receipt never releases a complete session even if its metadata declares a complete replay',async()=>{
  await fixture(async store=>{
    await store.beginSession({id:'one',createdAt:'2026-10-30T00:00:00.000Z',environment,record:true,protectForArchive:true});
    await store.appendChunk('one','exact',0,new Blob(['frame']));
    const index=(await store.sealSession('one',{status:'complete',metadata:{bytes:0,completed:true,recordState:'complete',
      exact:{bytes:5,complete:true,dropped:0,error:'',frames:1}}}))!;
    const raw={kind:'raw-session' as const,caseId:'a'.repeat(64),sha256:'b'.repeat(64),bytes:1234};
    const expected={generation:index.generation!,revision:index.archiveRevision!};
    const acknowledged=await store.acknowledgeArchive('one',expected,raw);
    assert.deepEqual(acknowledged.archive,{state:'stored',...raw,coverage:'unknown'});
    assert.deepEqual((await store.acknowledgeArchive('one',expected,raw)).archive,acknowledged.archive);
    await assert.rejects(store.acknowledgeArchive('one',expected,{...raw,replayCaseId:'c'.repeat(64)}),/다릅니다/);
    await assert.rejects(store.acknowledgeArchive('one',expected,{caseId:raw.caseId,sha256:raw.sha256,bytes:raw.bytes}),/다릅니다/);
    await assert.rejects(store.beginSession({id:'two',createdAt:'2026-10-30T00:00:01.000Z',environment,record:true}),/용량|한도/);
    assert.ok(await store.getSession('one'));
  },1);
});

test('raw receipt requires valid kind and replay case identity',async()=>{
  await fixture(async store=>{
    const index=await sealed(store),expected={generation:index.generation!,revision:index.archiveRevision!};
    const base={caseId:'a'.repeat(64),sha256:'b'.repeat(64),bytes:1234};
    await assert.rejects(store.acknowledgeArchive('one',expected,{...base,kind:'raw-session',replayCaseId:'invalid'}),/확인 정보/);
    await assert.rejects(store.acknowledgeArchive('one',expected,{...base,replayCaseId:'c'.repeat(64)}),/확인 정보/);
    assert.deepEqual((await store.listSessions())[0].archive,{state:'pending'});
  });
});

test('an old partial replay receipt upgrades only to raw plus the same replay case under the same seal',async()=>{
  await fixture(async store=>{
    const index=await sealed(store),expected={generation:index.generation!,revision:index.archiveRevision!};
    const replay={caseId:'a'.repeat(64),sha256:'b'.repeat(64),bytes:1234};
    const raw={kind:'raw-session' as const,caseId:'c'.repeat(64),sha256:'d'.repeat(64),bytes:5678,replayCaseId:replay.caseId};
    assert.equal((await store.acknowledgeArchive('one',expected,replay)).archive?.state,'stored');
    await assert.rejects(store.acknowledgeArchive('one',expected,{...raw,replayCaseId:'e'.repeat(64)}),/다릅니다/);
    const {replayCaseId:_replayCaseId,...withoutReplay}=raw;
    await assert.rejects(store.acknowledgeArchive('one',expected,withoutReplay),/다릅니다/);
    await assert.rejects(store.acknowledgeArchive('one',{...expected,revision:'wrong'},raw),/변경/);
    const upgraded=await store.acknowledgeArchive('one',expected,raw);
    assert.deepEqual(upgraded.archive,{state:'stored',...raw,coverage:'partial'});
    assert.deepEqual((await store.acknowledgeArchive('one',expected,raw)).archive,upgraded.archive);
    await assert.rejects(store.acknowledgeArchive('one',expected,replay),/다릅니다/);
    await assert.rejects(store.acknowledgeArchive('one',expected,{...raw,sha256:'f'.repeat(64)}),/다릅니다/);
    await assert.rejects(store.beginSession({id:'two',createdAt:'2026-10-30T00:00:01.000Z',environment,record:true}),/용량|한도/);
    assert.ok(await store.getSession('one'),'upgraded partial input stays protected');
  },1);
});

test('legacy unknown complete replay may upgrade; verified complete replay may not',async()=>{
  for(const declaredComplete of [false,true])await fixture(async store=>{
    await store.beginSession({id:'one',createdAt:'2026-10-30T00:00:00.000Z',environment,record:true,protectForArchive:true});
    await store.appendChunk('one','exact',0,new Blob(['frame']));
    const metadata=declaredComplete?{bytes:0,completed:true,recordState:'complete',
      exact:{bytes:5,complete:true,dropped:0,error:'',frames:1}}:undefined;
    const index=(await store.sealSession('one',{status:'complete',...(metadata?{metadata}:{})}))!;
    const expected={generation:index.generation!,revision:index.archiveRevision!};
    const replay={caseId:'a'.repeat(64),sha256:'b'.repeat(64),bytes:1234,...(declaredComplete?{exactVerified:true as const}:{})};
    const raw={kind:'raw-session' as const,caseId:'c'.repeat(64),sha256:'d'.repeat(64),bytes:5678,replayCaseId:replay.caseId};
    const previous=await store.acknowledgeArchive('one',expected,replay);
    assert.equal(previous.archive?.state,'stored');
    if(previous.archive?.state!=='stored')throw Error('missing archive');
    assert.equal(previous.archive.coverage,declaredComplete?'declared-complete':'unknown');
    if(declaredComplete){
      await assert.rejects(store.acknowledgeArchive('one',expected,raw),/다릅니다/);
      assert.deepEqual((await store.getSession('one'))!.index.archive,previous.archive);
    }else{
      const upgraded=await store.acknowledgeArchive('one',expected,raw);
      assert.deepEqual(upgraded.archive,{state:'stored',...raw,coverage:'unknown'});
      await assert.rejects(store.beginSession({id:'two',createdAt:'2026-10-30T00:00:01.000Z',environment,record:true}),/용량|한도/);
    }
  },1);
});
