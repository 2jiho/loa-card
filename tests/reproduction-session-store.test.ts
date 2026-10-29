import test from 'node:test';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import {IDBObjectStore} from 'fake-indexeddb';
import {createReproductionSessionStore,REPRODUCTION_DATABASE_VERSION,SESSION_LEASE_MS,MAX_SESSION_CHUNK_BYTES,
  MAX_SESSION_DETAILS_BYTES,DEFAULT_SESSION_LIMITS,SessionStorageLimitError} from '../src/features/card-scanner/reproduction-session-store';
import type {SessionStart,SessionStoreOptions} from '../src/features/card-scanner/reproduction-session-store';

const environment={browser:'test',catalog:'test-data',build:'test-build'};

test('exact finalization preserves a raw prefix ending inside an entry and rejects stale or reused plans',async()=>{
  await fixture(async store=>{
    await store.beginSession(start('raw-prefix'));
    const producer=new Blob([new Uint8Array(2048).map((_,i)=>i%251)]);
    await store.appendChunk('raw-prefix','exact',0,producer.slice(0,412));
    await store.appendChunk('raw-prefix','video',0,new Blob(['preview']));
    const input={producer,omitVideo:true,seal:{status:'complete' as const,metadata:{test:true}}};
    const stale=await store.prepareExactFinalization('raw-prefix',input);
    await store.appendChunk('raw-prefix','exact',1,producer.slice(412,800));
    await assert.rejects(store.commitExactFinalization(stale));
    assert.equal((await store.getSession('raw-prefix'))!.video.size,7);
    const plan=await store.prepareExactFinalization('raw-prefix',input);
    assert.equal(plan.storedExactBytes,800);
    await store.commitExactFinalization(plan);
    const saved=(await store.getSession('raw-prefix'))!;
    assert.deepEqual(await saved.exact!.arrayBuffer(),await producer.arrayBuffer());
    assert.equal(saved.video.size,0);
    await assert.rejects(store.commitExactFinalization(plan));
  });
});

test('cancelled finalization and a mismatching producer leave source and preview intact',async()=>{
  await fixture(async store=>{
    await store.beginSession(start('cancel-final'));
    await store.appendChunk('cancel-final','exact',0,new Blob(['original']));
    await store.appendChunk('cancel-final','video',0,new Blob(['preview']));
    const input={producer:new Blob(['original-tail']),omitVideo:true,seal:{status:'complete' as const}};
    await assert.rejects(store.prepareExactFinalization('cancel-final',{...input,producer:new Blob(['different-tail'])}));
    const plan=await store.prepareExactFinalization('cancel-final',input);
    const controller=new AbortController();controller.abort();
    await assert.rejects(store.commitExactFinalization(plan,{signal:controller.signal}));
    const saved=(await store.getSession('cancel-final'))!;
    assert.equal(await saved.exact!.text(),'original');assert.equal(await saved.video.text(),'preview');
    assert.equal(saved.index.sealed,false);assert.equal(saved.exactFinalization,undefined);
  });
});
const start=(id:string,index=0):SessionStart=>({id,createdAt:new Date(10_000+index*1000).toISOString(),environment,record:true,
  initial:{seed:[],signature:'test-source',environment}});
const req=<T>(request:IDBRequest<T>)=>new Promise<T>((resolve,reject)=>{
  request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);
});
async function rawDatabase(dbName:string,version?:number) {
  return req(indexedDB.open(dbName,version));
}
async function fixture(work:(store:ReturnType<typeof createReproductionSessionStore>,dbName:string,clock:{value:number})=>Promise<void>,options:SessionStoreOptions={}) {
  const dbName=`reproduction-session-test-${crypto.randomUUID()}`,clock={value:10_000};
  const store=createReproductionSessionStore({dbName,ownerId:'owner-a',now:()=>clock.value,...options});
  try{await work(store,dbName,clock);}finally{await req(indexedDB.deleteDatabase(dbName));}
}
const seal=(store:ReturnType<typeof createReproductionSessionStore>,id:string,status:'complete'|'partial'|'failed'='complete')=>
  store.sealSession(id,{status,summary:{status:'ended',completed:status==='complete',result:{read:2,expected:3,cards:[{id:'a'},{id:'b'}]},images:[]},
    metadata:{type:'video/webm;codecs=vp8',completed:status==='complete',seed:[]}});

test('a v1 database upgrades without erasing legacy recent data',async()=>{
  const dbName=`reproduction-upgrade-test-${crypto.randomUUID()}`;
  const opening=indexedDB.open(dbName,1);opening.onupgradeneeded=()=>opening.result.createObjectStore('recent');
  const db=await req(opening);await new Promise<void>((resolve,reject)=>{
    const tx=db.transaction('recent','readwrite');tx.objectStore('recent').put({legacy:true},'file');tx.oncomplete=()=>resolve();tx.onabort=()=>reject(tx.error);
  });db.close();
  try{
    const store=createReproductionSessionStore({dbName});assert.deepEqual(await store.listSessions(),[]);
    const upgraded=await rawDatabase(dbName);
    assert.equal(upgraded.version,REPRODUCTION_DATABASE_VERSION);
    assert.deepEqual(await req(upgraded.transaction('recent').objectStore('recent').get('file')),{legacy:true});
    assert.ok(upgraded.objectStoreNames.contains('sessions'));assert.ok(upgraded.objectStoreNames.contains('chunks'));
    upgraded.close();
  }finally{await req(indexedDB.deleteDatabase(dbName));}
});

test('sessions accumulate independently; final details and media compose without reading an entire video',async()=>{
  await fixture(async store=>{
    const first=start('first'),second=start('second',1);
    await store.beginSession(first);await store.beginSession(second);
    await store.appendChunk('first','video',0,new Blob(['webm-']));
    await store.appendChunk('first','video',1,new Blob(['one']));
    await store.appendChunk('first','exact',0,new Blob(['exact-one']));
    await store.appendChunk('second','video',0,new Blob(['webm-two']));
    await seal(store,'second');await seal(store,'first','partial');
    const list=await store.listSessions();assert.deepEqual(list.map(row=>row.id),['second','first']);
    assert.equal(list[1].read,2);assert.equal(list[1].expected,3);assert.equal(list[1].cards,2);
    assert.equal(list[1].hasInput,true);assert.deepEqual(list[1].chunkCounts,{video:2,exact:1});
    assert.ok(list[1].bytes>list[1].chunkBytes.video+list[1].chunkBytes.exact);
    assert.equal('seed' in list[1],false);assert.equal('summary' in list[1],false);assert.equal('metadata' in list[1],false);
    const original=Blob.prototype.arrayBuffer;Blob.prototype.arrayBuffer=()=>{throw Error('Full source read is forbidden');};
    let loaded:Awaited<ReturnType<typeof store.getSession>>;
    try{loaded=await store.getSession('first');assert.equal((await store.listSessions()).length,2);}finally{Blob.prototype.arrayBuffer=original;}
    assert.equal(await loaded!.video.text(),'webm-one');assert.equal(loaded!.video.type,'video/webm;codecs=vp8');
    assert.equal(await loaded!.exact!.text(),'exact-one');assert.deepEqual(loaded!.initial,first.initial);
    assert.equal(loaded!.index.status,'partial');assert.equal(loaded!.index.leaseUntil,null);
    const another=await store.getSession('second');assert.equal(await another!.video.text(),'webm-two');
  });
});

test('list reads only small session indexes and never accesses detailed crop or chunk stores',async()=>{
  await fixture(async store=>{
    await store.beginSession(start('one'));await store.appendChunk('one','video',0,new Blob(['video']));await seal(store,'one');
    const get=IDBObjectStore.prototype.get,getAll=IDBObjectStore.prototype.getAll;
    IDBObjectStore.prototype.get=function(...args:Parameters<typeof get>){if(this.name!=='sessions')throw Error('Unexpected detailed read');return get.apply(this,args);};
    IDBObjectStore.prototype.getAll=function(...args:Parameters<typeof getAll>){if(this.name!=='sessions')throw Error('Unexpected detailed read');return getAll.apply(this,args);};
    try{assert.equal((await store.listSessions())[0].id,'one');}finally{IDBObjectStore.prototype.get=get;IDBObjectStore.prototype.getAll=getAll;}
  });
});

test('getSessionDetails retrieves summary and initial context without reading media chunks',async()=>{
  await fixture(async store=>{
    await store.beginSession(start('one'));await store.appendChunk('one','video',0,new Blob(['private-video']));await seal(store,'one');
    const get=IDBObjectStore.prototype.get,getAll=IDBObjectStore.prototype.getAll;
    IDBObjectStore.prototype.get=function(...args:Parameters<typeof get>){if(this.name==='chunks')throw Error('Unexpected chunk read');return get.apply(this,args);};
    IDBObjectStore.prototype.getAll=function(...args:Parameters<typeof getAll>){if(this.name==='chunks')throw Error('Unexpected chunk read');return getAll.apply(this,args);};
    try{
      const value=(await store.getSessionDetails('one'))!;
      assert.deepEqual(value.initial,start('one').initial);assert.equal(value.index.read,2);
      assert.equal((value.summary as {result:{read:number}}).result.read,2);
      assert.equal('video' in value,false);assert.equal('exact' in value,false);
      assert.equal(await store.getSessionDetails('missing'),undefined);
    }finally{IDBObjectStore.prototype.get=get;IDBObjectStore.prototype.getAll=getAll;}
  });
});

test('chunk sequence and SHA-256 reject gaps, conflicting duplicates and forged digests atomically',async()=>{
  await fixture(async store=>{
    await store.beginSession(start('one'));
    await assert.rejects(store.appendChunk('one','video',1,new Blob(['a'])),/연속/);
    await assert.rejects(store.appendChunk('one','video',0,new Blob(['a']),{sha256:'0'.repeat(64)}),/해시/);
    const first=await store.appendChunk('one','video',0,new Blob(['same']));
    const duplicate=await store.appendChunk('one','video',0,new Blob(['same']));
    assert.equal(duplicate.bytes,first.bytes);assert.equal(duplicate.chunkCounts.video,1);
    await assert.rejects(store.appendChunk('one','video',0,new Blob(['diff'])),/다른 기록 청크/);
    await store.appendChunk('one','exact',0,new Blob(['independent-exact']));
    const loaded=await store.getSession('one');assert.equal(await loaded!.video.text(),'same');assert.equal(await loaded!.exact!.text(),'independent-exact');
    assert.equal(loaded!.index.chunkCounts.video,1);
  });
});

test('concurrent same-sequence retries are idempotent while conflicting races commit only one payload',async()=>{
  await fixture(async store=>{
    await store.beginSession(start('one'));
    const retries=await Promise.all([store.appendChunk('one','video',0,new Blob(['same'])),store.appendChunk('one','video',0,new Blob(['same']))]);
    assert.equal(retries[0].bytes,retries[1].bytes);
    const conflict=await Promise.allSettled([store.appendChunk('one','video',1,new Blob(['left'])),store.appendChunk('one','video',1,new Blob(['right']))]);
    assert.equal(conflict.filter(value=>value.status==='fulfilled').length,1);
    const loaded=await store.getSession('one');assert.equal(loaded!.index.chunkCounts.video,2);
    assert.ok(['sameleft','sameright'].includes(await loaded!.video.text()));
  });
});

test('retention evicts oldest sealed unpinned sessions, preserving open and pinned recordings',async()=>{
  await fixture(async store=>{
    await store.beginSession(start('pinned',0));await store.appendChunk('pinned','video',0,new Blob(['pin']));await seal(store,'pinned');await store.pinSession('pinned',true);
    await store.beginSession(start('old',1));await store.appendChunk('old','video',0,new Blob(['old']));await seal(store,'old','failed');
    await store.beginSession(start('live',2));
    await store.beginSession(start('new',3));
    assert.deepEqual((await store.listSessions()).map(row=>row.id),['new','live','pinned']);
    assert.equal(await store.getSession('old'),undefined);assert.equal((await store.getSession('pinned'))!.index.pinned,true);
  },{limits:{maxSessions:3}});
});

test('byte retention is atomic with appends and removes media and details together',async()=>{
  await fixture(async store=>{
    await store.beginSession({...start('old'),initial:undefined});await store.appendChunk('old','video',0,new Blob(['O'.repeat(600)]));
    await store.sealSession('old',{status:'complete'});
    await store.beginSession({...start('new',1),initial:undefined});await store.appendChunk('new','video',0,new Blob(['N'.repeat(600)]));
    assert.equal(await store.getSession('old'),undefined);
    const loaded=await store.getSession('new');assert.equal(await loaded!.video.text(),'N'.repeat(600));assert.ok(loaded!.index.bytes<800);
  },{limits:{maxBytes:800,detailsReserveBytes:0}});
});

test('protected-capacity failure leaves a small partial marker without deleting useful old input',async()=>{
  await fixture(async store=>{
    await store.beginSession(start('protected'));await store.appendChunk('protected','video',0,new Blob(['protected']));
    await assert.rejects(store.beginSession(start('blocked',1)),SessionStorageLimitError);
    const failure=(await store.getSession('blocked'))!;
    assert.equal(failure.index.status,'partial');assert.equal(failure.index.sealed,true);assert.equal(failure.index.hasInput,false);assert.match(failure.index.reason!,/한도/);
    await assert.rejects(store.beginSession(start('blocked-again',2)),SessionStorageLimitError);
    assert.deepEqual((await store.listSessions()).map(row=>row.id),['blocked-again','protected']);
    assert.equal(await (await store.getSession('protected'))!.video.text(),'protected');
  },{limits:{maxSessions:1}});
});

test('append byte-limit loss preserves the prefix and cannot later be promoted to complete',async()=>{
  await fixture(async store=>{
    await store.beginSession({...start('one'),initial:undefined});await store.appendChunk('one','exact',0,new Blob(['first']));
    await assert.rejects(store.appendChunk('one','exact',1,new Blob(['X'.repeat(200)])),SessionStorageLimitError);
    const failed=(await store.getSession('one'))!;assert.equal(failed.index.status,'partial');assert.equal(await failed.exact!.text(),'first');
    await assert.rejects(store.appendChunk('one','exact',1,new Blob(['last'])),/손실/);
    const ended=await store.sealSession('one',{status:'complete'});assert.equal(ended!.status,'partial');assert.equal(ended!.sealed,true);
  },{limits:{maxBytes:80,detailsReserveBytes:0}});
});

test('media admission reserves final diagnostic space without reporting virtual reservations as stored bytes',async()=>{
  await fixture(async store=>{
    const initial=await store.beginSession(start('one'));
    assert.ok(initial.bytes<1024);assert.equal(initial.bytes,initial.detailsBytes);
    const raw='X'.repeat(3072);await store.appendChunk('one','exact',0,new Blob([raw]));
    // Current details plus remaining reservation use exactly 1024 bytes;
    // media uses the other 3072. The 4097th effective byte must be rejected.
    await assert.rejects(store.appendChunk('one','exact',1,new Blob(['x'])),SessionStorageLimitError);
    const summary={status:'확인 필요',result:{read:0,expected:1,cards:[{id:'one',extraCopies:null}]},
      images:[{image:'failed-crop'.repeat(30)}],fieldIssues:[{id:'one',reason:'장수 확인'}]};
    const metadata={seed:[{id:'one',nameEvidence:['proof'.repeat(20)]}],complete:false};
    const final=await store.sealSession('one',{status:'partial',summary,metadata});
    assert.equal(final!.status,'partial');assert.equal(final!.sealed,true);assert.ok(final!.detailsBytes<=1024);
    assert.equal(final!.bytes,raw.length+final!.detailsBytes);assert.ok(final!.bytes<=4096);
    const loaded=(await store.getSession('one'))!;
    assert.deepEqual(loaded.summary,summary);assert.deepEqual(loaded.metadata,metadata);
    assert.equal(await loaded.exact!.text(),raw);assert.equal(loaded.index.read,0);assert.equal(loaded.index.expected,1);
  },{limits:{maxBytes:4096,detailsReserveBytes:1024}});
});

test('each active session has independent reserved details space and sealing releases only its own headroom',async()=>{
  await fixture(async store=>{
    await store.beginSession({...start('one'),initial:undefined});await store.pinSession('one',true);
    await store.beginSession({...start('two',1),initial:undefined});
    await store.appendChunk('one','exact',0,new Blob(['A'.repeat(1024)]));
    // 1024 media + 2*512 active reservations leaves only 256 bytes.
    await assert.rejects(store.beginSession({...start('blocked',2),initial:undefined}),SessionStorageLimitError);
    assert.equal((await store.getSession('one'))!.index.pinned,true);
    const first=await store.sealSession('one',{status:'complete',summary:{result:{read:1,expected:1,cards:[{id:'one'}]}}});
    assert.ok(first!.detailsBytes<256);
    // Closing one returns its unused reservation, without freeing two's.
    await store.beginSession({...start('three',3),initial:undefined});
    await store.sealSession('two',{status:'partial',summary:{result:{read:0,expected:1,cards:[]},images:['B'.repeat(200)]}});
    const second=(await store.getSessionDetails('two'))!;
    assert.equal(second.index.status,'partial');assert.equal((second.summary as {images:string[]}).images[0].length,200);
    assert.equal(await (await store.getSession('one'))!.exact!.text(),'A'.repeat(1024));
    assert.ok((await store.listSessions()).some(index=>index.id==='three'&&!index.sealed));
  },{limits:{maxBytes:2304,detailsReserveBytes:512,maxSessions:4}});
});

test('the default reservation covers the full allowed details size and retains a multi-megabyte failed diagnostic at the media boundary',async()=>{
  await fixture(async store=>{
    assert.equal(store.limits.detailsReserveBytes,MAX_SESSION_DETAILS_BYTES);
    const initial=await store.beginSession(start('one'));
    const payload=new Blob(['P'.repeat(1024)]);await store.appendChunk('one','video',0,payload);
    await assert.rejects(store.appendChunk('one','video',1,new Blob(['over-boundary'])),SessionStorageLimitError);
    const summary={result:{read:393,expected:394,cards:[]},images:['crop'.repeat(512*1024)]};
    const metadata={seed:[{nameEvidence:['observed-proof'.repeat(200_000)]}]};
    await store.sealSession('one',{status:'partial',summary,metadata});
    const loaded=(await store.getSessionDetails('one'))!;
    assert.deepEqual(loaded.summary,summary);assert.deepEqual(loaded.metadata,metadata);
    assert.ok(loaded.index.detailsBytes>4*1024*1024);assert.ok(loaded.index.detailsBytes<=MAX_SESSION_DETAILS_BYTES);
    assert.equal(loaded.index.bytes,loaded.index.detailsBytes+payload.size);
    assert.ok(initial.bytes<store.limits.detailsReserveBytes);
  },{limits:{maxBytes:MAX_SESSION_DETAILS_BYTES+1024}});
});

test('details larger than an explicit smaller reservation remain partial without deleting the saved source prefix',async()=>{
  await fixture(async store=>{
    await store.beginSession({...start('one'),initial:undefined});await store.appendChunk('one','exact',0,new Blob(['X'.repeat(896)]));
    const final=await store.sealSession('one',{status:'complete',summary:{images:['too-large'.repeat(80)]}});
    assert.equal(final!.status,'partial');assert.match(final!.reason!,/정보.*공간/);
    const loaded=(await store.getSession('one'))!;assert.equal(await loaded.exact!.text(),'X'.repeat(896));
    assert.equal(loaded.summary,undefined);assert.equal(loaded.metadata,undefined);
  },{limits:{maxBytes:1024,detailsReserveBytes:128}});
});

test('reservation defaults clamp to a small custom byte budget and explicit invalid values are rejected',()=>{
  assert.equal(DEFAULT_SESSION_LIMITS.detailsReserveBytes,MAX_SESSION_DETAILS_BYTES);
  assert.equal(createReproductionSessionStore({limits:{maxBytes:128}}).limits.detailsReserveBytes,128);
  assert.equal(createReproductionSessionStore({limits:{maxBytes:128,detailsReserveBytes:0}}).limits.detailsReserveBytes,0);
  for(const reserve of [-1,1.5,129,Infinity,NaN])assert.throws(()=>createReproductionSessionStore({limits:{maxBytes:128,detailsReserveBytes:reserve}}),/한도/);
});

test('lease recovery never claims another active tab; expired prefixes remain usable and old owners cannot resume writing',async()=>{
  await fixture(async(store,dbName,clock)=>{
    const other=createReproductionSessionStore({dbName,ownerId:'owner-b',now:()=>clock.value});
    await store.beginSession(start('one'));await store.appendChunk('one','exact',0,new Blob(['prefix']));
    assert.deepEqual(await other.recoverInterrupted(),[]);
    await assert.rejects(other.appendChunk('one','exact',1,new Blob(['wrong-owner'])),/소유/);
    clock.value+=SESSION_LEASE_MS-1;await store.heartbeat('one');
    clock.value+=2;assert.deepEqual(await other.recoverInterrupted(),[]);
    clock.value+=SESSION_LEASE_MS;
    const recovered=await other.recoverInterrupted();assert.equal(recovered.length,1);assert.equal(recovered[0].status,'partial');
    assert.equal(recovered[0].sealed,true);assert.match(recovered[0].reason!,/접두/);
    assert.equal(await (await other.getSession('one'))!.exact!.text(),'prefix');
    await assert.rejects(store.appendChunk('one','exact',1,new Blob(['late'])),/닫혔/);
    assert.deepEqual(await other.recoverInterrupted(),[]);
  });
});

test('active deletion is explicit and owner-only, and late append or seal never recreates a deleted session',async()=>{
  await fixture(async(store,dbName,clock)=>{
    const other=createReproductionSessionStore({dbName,ownerId:'owner-b',now:()=>clock.value});
    await store.beginSession(start('one'));await store.appendChunk('one','video',0,new Blob(['before-delete']));
    await assert.rejects(store.deleteSession('one'),/진행 중/);
    await assert.rejects(other.deleteSession('one',{cancelOwned:true}),/진행 중/);
    assert.equal(await store.deleteSession('one',{cancelOwned:true}),true);
    await assert.rejects(store.appendChunk('one','video',1,new Blob(['late'])),/찾을/);
    assert.equal(await seal(store,'one'),undefined);assert.equal(await store.pinSession('one',true),undefined);
    assert.equal(await store.deleteSession('one'),false);assert.deepEqual(await store.listSessions(),[]);
  });
});

test('caller metadata and returned indexes cannot mutate stored evidence after an await',async()=>{
  await fixture(async store=>{
    const initial={seed:[{id:'a',image:'private-image'}]},input={...start('one'),initial};
    const opening=store.beginSession(input);initial.seed[0].id='mutated';const index=await opening;
    index.chunkCounts.video=99;index.environment.build='changed';
    const summary={result:{read:0,expected:1,cards:[{id:'a',extraCopies:null}]},images:[{image:'private-crop'}]};
    const closing=store.sealSession('one',{status:'partial',summary});summary.result.cards[0].extraCopies=0 as never;
    const final=await closing;final!.read=999;
    const loaded=(await store.getSession('one'))!;
    assert.deepEqual(loaded.initial,{seed:[{id:'a',image:'private-image'}]});
    assert.equal((loaded.summary as typeof summary).result.cards[0].extraCopies,null);
    assert.equal(loaded.index.read,0);assert.equal(loaded.index.environment.build,'test-build');assert.equal(loaded.index.chunkCounts.video,0);
  });
});

test('cancelled operations do not commit, remove sessions or resurrect a cancelled append',async()=>{
  await fixture(async store=>{
    await store.beginSession(start('one'));
    const abort=new AbortController();abort.abort();
    for(const task of [()=>store.appendChunk('one','video',0,new Blob(['no']),{signal:abort.signal}),
      ()=>store.sealSession('one',{status:'complete'},{signal:abort.signal}),()=>store.deleteSession('one',{signal:abort.signal,cancelOwned:true}),
      ()=>store.beginSession(start('two'),{signal:abort.signal}),()=>store.listSessions({signal:abort.signal}),()=>store.getSession('one',{signal:abort.signal})])
      await assert.rejects(task(),{name:'AbortError'});
    const original=Blob.prototype.arrayBuffer;let finish!:()=>void,entered!:()=>void;
    const waiting=new Promise<void>(resolve=>{entered=resolve;});
    const gate=new Promise<void>(resolve=>{finish=resolve;});
    Blob.prototype.arrayBuffer=async function(){entered();await gate;return original.call(this);};
    const during=new AbortController();let pending:Promise<unknown>;
    try{pending=store.appendChunk('one','video',0,new Blob(['cancel-me']),{signal:during.signal});await waiting;during.abort();finish();await assert.rejects(pending,{name:'AbortError'});}
    finally{Blob.prototype.arrayBuffer=original;finish?.();}
    const one=(await store.getSession('one'))!;assert.equal(one.index.chunkCounts.video,0);assert.equal(one.index.status,'open');
    assert.equal(await store.getSession('two'),undefined);
  });
});

test('a quota error rolls back the chunk and leaves a partial loss marker where the index can still be saved',async()=>{
  await fixture(async store=>{
    await store.beginSession(start('one'));await store.appendChunk('one','video',0,new Blob(['prefix']));
    const add=IDBObjectStore.prototype.add;
    IDBObjectStore.prototype.add=function(...args:Parameters<typeof add>){if(this.name==='chunks')throw new DOMException('Quota','QuotaExceededError');return add.apply(this,args);};
    try{await assert.rejects(store.appendChunk('one','video',1,new Blob(['lost'])),{name:'QuotaExceededError'});}finally{IDBObjectStore.prototype.add=add;}
    const loaded=(await store.getSession('one'))!;assert.equal(loaded.index.status,'partial');assert.match(loaded.index.reason!,/공간/);
    assert.equal(loaded.index.chunkCounts.video,1);assert.equal(await loaded.video.text(),'prefix');
  });
});

test('aborting an actual queued IDB write rolls back both the chunk and its index counters',async()=>{
  await fixture(async store=>{
    await store.beginSession(start('one'));await store.appendChunk('one','video',0,new Blob(['prefix']));
    const abort=new AbortController(),add=IDBObjectStore.prototype.add;
    IDBObjectStore.prototype.add=function(...args:Parameters<typeof add>){const queued=add.apply(this,args);if(this.name==='chunks')abort.abort();return queued;};
    try{await assert.rejects(store.appendChunk('one','video',1,new Blob(['must-rollback']),{signal:abort.signal}),{name:'AbortError'});}
    finally{IDBObjectStore.prototype.add=add;}
    const value=(await store.getSession('one'))!;assert.equal(value.index.chunkCounts.video,1);assert.equal(await value.video.text(),'prefix');
  });
});

test('transaction timeout aborts a blocked writer and no late commit appears after its blocker releases',async()=>{
  await fixture(async(store,dbName,clock)=>{
    await store.beginSession(start('one'));
    const impatient=createReproductionSessionStore({dbName,ownerId:'owner-a',now:()=>clock.value,transactionTimeoutMs:15});
    const db=await rawDatabase(dbName),blocking=db.transaction(['sessions','chunks','session-details'],'readwrite');
    let keeping=true;const keepAlive=()=>{
      const pending=blocking.objectStore('sessions').get('one');pending.onsuccess=()=>{if(keeping)keepAlive();};
    };keepAlive();
    try{await assert.rejects(impatient.appendChunk('one','video',0,new Blob(['must-not-commit'])),/제한 시간|시간 초과/);}
    finally{keeping=false;await new Promise<void>(resolve=>{blocking.oncomplete=()=>resolve();blocking.onabort=()=>resolve();});db.close();}
    const loaded=(await store.getSession('one'))!;assert.equal(loaded.index.chunkCounts.video,0);assert.equal(loaded.video.size,0);
  });
});

test('invalid, oversized or binary metadata is rejected before altering session storage',async()=>{
  await fixture(async store=>{
    await assert.rejects(store.beginSession({...start('one'),initial:new Blob(['not-json'])}),/JSON/);
    await assert.rejects(store.beginSession({...start('one'),initial:'가'.repeat(Math.floor(MAX_SESSION_DETAILS_BYTES/3)+1)}),/용량/);
    assert.deepEqual(await store.listSessions(),[]);
    await store.beginSession(start('one'));
    await assert.rejects(store.appendChunk('one','video',0,new Blob([new Uint8Array(MAX_SESSION_CHUNK_BYTES+1)])),/청크/);
    await assert.rejects(store.appendChunk('one','video',0,new Blob()),/청크/);
    await assert.rejects(store.beginSession(start('one')),/이미/);
    await assert.rejects(store.sealSession('one',{status:'complete',metadata:{bad:Infinity}}),/숫자/);
    assert.equal((await store.getSession('one'))!.index.status,'open');
  });
  for(const options of [{limits:{maxSessions:0}},{limits:{maxBytes:-1}},{limits:{maxChunkBytes:MAX_SESSION_CHUNK_BYTES+1}},{transactionTimeoutMs:0}])
    assert.throws(()=>createReproductionSessionStore(options),/한도|시간/);
});

test('corrupted indexes, missing chunks or changed details are rejected instead of composing an apparently complete recording',async()=>{
  for(const damage of ['index','missing-chunk','details'] as const)await fixture(async(store,dbName)=>{
    await store.beginSession(start('one'));await store.appendChunk('one','video',0,new Blob(['source']));await seal(store,'one');
    const db=await rawDatabase(dbName);
    try{await new Promise<void>((resolve,reject)=>{
      const tx=db.transaction(['sessions','chunks','session-details'],'readwrite');
      if(damage==='index'){
        const get=tx.objectStore('sessions').get('one');get.onsuccess=()=>tx.objectStore('sessions').put({...get.result,bytes:0});
      }else if(damage==='missing-chunk')tx.objectStore('chunks').delete(['one','video',0]);
      else tx.objectStore('session-details').put({id:'one',summary:{changed:true}});
      tx.oncomplete=()=>resolve();tx.onabort=()=>reject(tx.error);
    });}finally{db.close();}
    await assert.rejects(store.getSession('one'),/일치|누락|손상/);
    if(damage==='index')await assert.rejects(store.beginSession(start('new')),/일치/);
  });
});
