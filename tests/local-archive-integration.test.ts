import {test} from 'node:test';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import {createServer} from 'node:http';
import {mkdtemp,rm} from 'node:fs/promises';
import {openAsBlob} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,relative,isAbsolute,sep} from 'node:path';
import {createReproductionSessionStore} from '../src/features/card-scanner/reproduction/reproduction-session-store';
import {createReproductionArchiveAccess,createReproductionSessionAccess,openReproduction} from '../src/features/card-scanner/reproduction/scan-reproduction';
import {entryParts,packPixels,fastCompress,pixelHash,exactPixels} from '../src/features/card-scanner/reproduction/exact-recording-codec';
import {archivePendingReplaySessions,archiveReplayLocally,archiveRawLocally} from '../src/features/card-scanner/reproduction/dev-replay-archive';
import {openRawSessionArchive} from '../src/features/card-scanner/reproduction/raw-session-archive';
import {hashBlobChunks,hashBlobListChunks} from '../src/features/card-scanner/reproduction/dev-blob-hash-core';
import {serveCorpusRequest} from '../dev/corpus-server';
import {verifyCorpus} from '../scripts/scan-corpus-core.mjs';
import {validateArchiveExact} from '../src/features/card-scanner/reproduction/archive-exact-validation';
import {createCanonicalFinalizationFixture} from './helpers/canonical-finalization-fixture';

test('a protected sealed session is hashed, archived locally and acknowledged without erasing a partial record',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'loacard-archive-integration-'));
 const root=join(directory,'corpus'),dbName=`archive-integration-${crypto.randomUUID()}`;
 const store=createReproductionSessionStore({dbName,ownerId:'owner'});
 const server=createServer((req,res)=>void serveCorpusRequest(req,res,root,process.cwd())
  .then(handled=>{if(!handled){res.statusCode=404;res.end();}}).catch(()=>res.destroy()));
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 try{
  const address=server.address();assert.ok(address&&typeof address!=='string');const origin=`http://127.0.0.1:${address.port}`;
  const id='scan-one',video=new Blob(['video']);
  const metadata={version:1 as const,createdAt:'2026-10-01T00:00:00Z',browser:'test',catalog:'test',build:'test',completed:false,
   recordState:'partial' as const,warnings:[],duration:1,type:'video/webm',bytes:video.size,seed:[],result:null};
  await store.beginSession({id,createdAt:metadata.createdAt,environment:{browser:'test',catalog:'test',build:'test'},record:true,protectForArchive:true});
  await store.appendChunk(id,'video',0,video);
  await store.sealSession(id,{status:'partial',metadata});
  const access=createReproductionArchiveAccess(store),events:string[]=[];
  const send:typeof fetch=async(url,options)=>fetch(`${origin}${String(url)}`,{...options,headers:{...options?.headers,Origin:origin}});
  const dependencies={list:createReproductionSessionAccess(store).list,load:access.load,acknowledge:access.acknowledge,
   upload:(file:Parameters<typeof archiveReplayLocally>[0],options:Parameters<typeof archiveReplayLocally>[1])=>
    archiveReplayLocally(file,{...options,send,hash:hashBlobChunks}),
   uploadRaw:(raw:Parameters<typeof archiveRawLocally>[0],options:Parameters<typeof archiveRawLocally>[1])=>
    archiveRawLocally(raw,{...options,send,hash:hashBlobChunks,hashChunks:hashBlobListChunks})};
  await archivePendingReplaySessions(new AbortController().signal,event=>events.push(event.state),dependencies);
  assert.deepEqual(events,['saving','stored']);
  const saved=await store.getSession(id);assert.ok(saved);assert.equal(saved.index.status,'partial');
  assert.equal(saved.index.archive?.state,'stored');
  if(saved.index.archive?.state!=='stored')throw Error('Missing archive receipt');
  assert.equal(saved.index.archive.coverage,'partial');
  assert.equal(saved.index.archive.kind,'raw-session');
  const replayId=saved.index.archive.replayCaseId;assert.ok(replayId);
  assert.equal((await verifyCorpus({root,id:saved.index.archive.caseId})).verified,true);
  assert.equal((await verifyCorpus({root,id:replayId})).verified,true);
  const raw=await openRawSessionArchive(await openAsBlob(join(root,'cases',saved.index.archive.caseId,'input','0001.loaraw')),new AbortController().signal);
  assert.equal(raw.metadata.replayCaseId,replayId);assert.equal(await raw.chunks[0].blob.text(),'video');
  assert.equal(await saved.video.text(),'video');
 }finally{
  server.closeAllConnections();await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));
  await new Promise<void>((resolve,reject)=>{const request=indexedDB.deleteDatabase(dbName);request.onsuccess=()=>resolve();request.onerror=()=>reject(request.error);});
  const rel=relative(tmpdir(),directory);if(!rel||isAbsolute(rel)||rel==='..'||rel.startsWith(`..${sep}`))throw Error('Unsafe temporary directory');
  await rm(directory,{recursive:true,force:true});
 }
});

test('a complete declaration with discarded comparison input is archived raw and kept protected',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'loacard-archive-scope-')),root=join(directory,'corpus');
 const dbName=`archive-scope-${crypto.randomUUID()}`;
 const store=createReproductionSessionStore({dbName,ownerId:'owner',limits:{maxSessions:1}});
 const server=createServer((req,res)=>void serveCorpusRequest(req,res,root,process.cwd())
  .then(handled=>{if(!handled){res.statusCode=404;res.end();}}).catch(()=>res.destroy()));
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 try{
  const address=server.address();assert.ok(address&&typeof address!=='string');const origin=`http://127.0.0.1:${address.port}`;
  const pixels=new Uint8Array(16).fill(27),payload=fastCompress(packPixels(pixels,undefined,true));
  const frame={kind:'frame' as const,id:1,time:0,width:2,height:2,key:true,hash:await pixelHash(pixels),codec:'lz4' as const,xor:true};
  const stamp={inputId:1,captureTime:0.1,observedAtMs:1};
  const facts=[{type:'input-admission',value:{kind:'consider',stamp,gates:{capturing:true,checkingCompletion:true},expected:'verification'}},
   {type:'input-recovery',value:{version:1,seq:1,kind:'retained',stamp}},
   {type:'input-recovery',value:{version:1,seq:2,kind:'verified',inputId:1}},
   {type:'input-recovery',value:{version:1,seq:3,kind:'released',inputId:1,failed:false,reason:'compared'}}];
  const exact=new Blob([...entryParts(frame,payload),...facts.flatMap((fact,index)=>entryParts({kind:'event',seq:index+1,time:0.1,...fact}))]);
  const metadata={version:3 as const,createdAt:'2026-10-01T00:00:00Z',browser:'test',catalog:'test',build:'test',completed:true,
   recordState:'complete' as const,warnings:[],duration:1,type:'',bytes:0,seed:[],result:null,
   exact:{bytes:exact.size,frames:1,events:facts.length,dropped:0,peakQueuedBytes:0,peakWorkingBytes:0,readbackMs:0,encodeMs:0,complete:true,error:''}};
  await store.beginSession({id:'legacy',createdAt:metadata.createdAt,environment:{browser:'test',catalog:'test',build:'test'},record:true,protectForArchive:true});
  await store.appendChunk('legacy','exact',0,exact);await store.sealSession('legacy',{status:'complete',metadata});
  const access=createReproductionArchiveAccess(store),candidate=await access.load('legacy');assert.ok(candidate?.file);
  assert.equal(await validateArchiveExact(candidate.file,new AbortController().signal),false);
  const send:typeof fetch=async(url,options)=>fetch(`${origin}${String(url)}`,{...options,headers:{...options?.headers,Origin:origin}});
  const events:string[]=[];
  await archivePendingReplaySessions(new AbortController().signal,event=>events.push(event.state),{
   list:createReproductionSessionAccess(store).list,load:access.load,acknowledge:access.acknowledge,validateExact:validateArchiveExact,
   upload:(file,options)=>archiveReplayLocally(file,{...options,send,hash:hashBlobChunks}),
   uploadRaw:(raw,options)=>archiveRawLocally(raw,{...options,send,hash:hashBlobChunks,hashChunks:hashBlobListChunks}),
  });
  assert.deepEqual(events,['saving','stored']);
  const saved=await store.getSession('legacy');assert.ok(saved?.index.archive?.state==='stored');
  assert.equal(saved.index.archive.kind,'raw-session');assert.equal(saved.index.archive.coverage,'unknown');
  assert.ok(saved.index.archive.replayCaseId);assert.equal((await verifyCorpus({root,id:saved.index.archive.caseId})).verified,true);
  await assert.rejects(store.beginSession({id:'next',createdAt:metadata.createdAt,environment:{browser:'test',catalog:'test',build:'test'},record:true}),/한도|용량/);
 }finally{
  server.closeAllConnections();await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));
  await new Promise<void>((resolve,reject)=>{const request=indexedDB.deleteDatabase(dbName);request.onsuccess=()=>resolve();request.onerror=()=>reject(request.error);});
  const rel=relative(tmpdir(),directory);if(!rel||isAbsolute(rel)||rel==='..'||rel.startsWith(`..${sep}`))throw Error('Unsafe temporary directory');
  await rm(directory,{recursive:true,force:true});
 }
});

test('a validated sealed exact stream can be acknowledged without raw fallback',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'loacard-archive-verified-')),root=join(directory,'corpus');
 const dbName=`archive-verified-${crypto.randomUUID()}`,store=createReproductionSessionStore({dbName,ownerId:'owner'});
 const server=createServer((req,res)=>void serveCorpusRequest(req,res,root,process.cwd())
  .then(handled=>{if(!handled){res.statusCode=404;res.end();}}).catch(()=>res.destroy()));
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 try{
  const address=server.address();assert.ok(address&&typeof address!=='string');const origin=`http://127.0.0.1:${address.port}`;
  const fixture=await createCanonicalFinalizationFixture();
  const metadata={version:4 as const,createdAt:'2026-10-01T00:00:00Z',browser:'test',catalog:'test',build:'test',completed:true,
   recordState:'complete' as const,warnings:[],duration:1,type:'',bytes:0,seed:[],result:null,exact:fixture.recording.stats};
  await store.beginSession({id:'verified',createdAt:metadata.createdAt,environment:{browser:'test',catalog:'test',build:'test'},record:true,protectForArchive:true});
  await store.appendChunk('verified','exact',0,fixture.recording.blob);await store.sealSession('verified',{status:'complete',metadata});
  const access=createReproductionArchiveAccess(store);
  const send:typeof fetch=async(url,options)=>fetch(`${origin}${String(url)}`,{...options,headers:{...options?.headers,Origin:origin}});
  let rawSent=false;const events:string[]=[];
  await archivePendingReplaySessions(new AbortController().signal,event=>events.push(event.state),{
   list:createReproductionSessionAccess(store).list,load:access.load,acknowledge:access.acknowledge,validateExact:validateArchiveExact,
   upload:(file,options)=>archiveReplayLocally(file,{...options,send,hash:hashBlobChunks}),
   uploadRaw:async()=>{rawSent=true;throw Error('validated input does not need raw fallback');},
  });
  assert.deepEqual(events,['saving','stored']);assert.equal(rawSent,false);
  const saved=await store.getSession('verified');assert.ok(saved?.index.archive?.state==='stored');
  assert.equal(saved.index.archive.kind,undefined);assert.equal(saved.index.archive.coverage,'declared-complete');
  assert.equal(saved.index.archive.exactVerified,true);assert.equal((await verifyCorpus({root,id:saved.index.archive.caseId})).verified,true);
 }finally{
  server.closeAllConnections();await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));
  await new Promise<void>((resolve,reject)=>{const request=indexedDB.deleteDatabase(dbName);request.onsuccess=()=>resolve();request.onerror=()=>reject(request.error);});
  const rel=relative(tmpdir(),directory);if(!rel||isAbsolute(rel)||rel==='..'||rel.startsWith(`..${sep}`))throw Error('Unsafe temporary directory');
  await rm(directory,{recursive:true,force:true});
 }
});

test('an incomplete exact fragment is archived as raw without inventing replay or unprotecting the browser copy',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'loacard-archive-fragment-')),root=join(directory,'corpus');
 const dbName=`archive-fragment-${crypto.randomUUID()}`;
 const store=createReproductionSessionStore({dbName,ownerId:'owner'});
 const server=createServer((req,res)=>void serveCorpusRequest(req,res,root,process.cwd())
  .then(handled=>{if(!handled){res.statusCode=404;res.end();}}).catch(()=>res.destroy()));
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 try{
  const address=server.address();assert.ok(address&&typeof address!=='string');const origin=`http://127.0.0.1:${address.port}`;
  const send:typeof fetch=async(url,options)=>fetch(`${origin}${String(url)}`,{...options,headers:{...options?.headers,Origin:origin}});
  const id='fragment',fragment=new Blob(['incomplete-entry']);
  await store.beginSession({id,createdAt:'2026-10-01T00:00:00Z',environment:{browser:'test',catalog:'test',build:'test'},initial:{seed:[]},record:true,protectForArchive:true});
  await store.appendChunk(id,'exact',0,fragment);
  await store.sealSession(id,{status:'partial'});
  const access=createReproductionArchiveAccess(store),events:string[]=[];
  const dependencies={list:createReproductionSessionAccess(store).list,load:access.load,acknowledge:access.acknowledge,
   upload:async()=>{throw Error('a non-replay fragment must not be uploaded as a replay');},
   uploadRaw:(raw:Parameters<typeof archiveRawLocally>[0],options:Parameters<typeof archiveRawLocally>[1])=>
    archiveRawLocally(raw,{...options,send,hash:hashBlobChunks,hashChunks:hashBlobListChunks})};
  await archivePendingReplaySessions(new AbortController().signal,event=>events.push(event.state),dependencies);
  assert.deepEqual(events,['saving','stored']);
  const saved=await store.getSession(id);assert.ok(saved);
  assert.equal(saved.index.archive?.state,'stored');
  if(saved.index.archive?.state!=='stored')throw Error('Missing raw receipt');
  assert.equal(saved.index.archive.kind,'raw-session');assert.equal(saved.index.archive.replayCaseId,undefined);
  assert.equal(saved.index.archive.coverage,'partial');
  const raw=await openRawSessionArchive(await openAsBlob(join(root,'cases',saved.index.archive.caseId,'input','0001.loaraw')),new AbortController().signal);
  assert.equal(await raw.chunks[0].blob.text(),'incomplete-entry');
  assert.equal(await saved.exact?.text(),'incomplete-entry');
 }finally{
  server.closeAllConnections();await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));
  await new Promise<void>((resolve,reject)=>{const request=indexedDB.deleteDatabase(dbName);request.onsuccess=()=>resolve();request.onerror=()=>reject(request.error);});
  const rel=relative(tmpdir(),directory);if(!rel||isAbsolute(rel)||rel==='..'||rel.startsWith(`..${sep}`))throw Error('Unsafe temporary directory');
  await rm(directory,{recursive:true,force:true});
 }
});

test('legacy partial replay receipt is upgraded with the intact prefix and incomplete raw tail',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'loacard-archive-upgrade-')),root=join(directory,'corpus');
 const dbName=`archive-upgrade-${crypto.randomUUID()}`,store=createReproductionSessionStore({dbName,ownerId:'owner'});
 const server=createServer((req,res)=>void serveCorpusRequest(req,res,root,process.cwd())
  .then(handled=>{if(!handled){res.statusCode=404;res.end();}}).catch(()=>res.destroy()));
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 try{
  const address=server.address();assert.ok(address&&typeof address!=='string');const origin=`http://127.0.0.1:${address.port}`;
  const send:typeof fetch=async(url,options)=>fetch(`${origin}${String(url)}`,{...options,headers:{...options?.headers,Origin:origin}});
  const pixels=new Uint8Array(16).fill(27),payload=fastCompress(packPixels(pixels,undefined,true));
  const frame={kind:'frame' as const,id:1,time:3.5,width:2,height:2,key:true,hash:await pixelHash(pixels),codec:'lz4' as const,xor:true};
  const prefix=new Blob(entryParts(frame,payload)),tail=new Blob(entryParts({...frame,id:2,time:4},payload)).slice(0,-1);
  await store.beginSession({id:'old',createdAt:'2026-10-01T00:00:00Z',environment:{browser:'test',catalog:'test',build:'test'},initial:{seed:[]},record:true,protectForArchive:true});
  await store.appendChunk('old','exact',0,prefix);await store.appendChunk('old','exact',1,tail);await store.sealSession('old',{status:'partial'});
  const access=createReproductionArchiveAccess(store),candidate=await access.load('old');assert.ok(candidate?.file);
  const replay=await archiveReplayLocally(candidate.file,{send,hash:hashBlobChunks});
  await access.acknowledge('old',{generation:candidate.generation,revision:candidate.revision},
   {caseId:replay.caseId,sha256:replay.input.sha256,bytes:replay.input.bytes});
  const dependencies={list:createReproductionSessionAccess(store).list,load:access.load,acknowledge:access.acknowledge,
   upload:(file:Parameters<typeof archiveReplayLocally>[0],options:Parameters<typeof archiveReplayLocally>[1])=>
    archiveReplayLocally(file,{...options,send,hash:hashBlobChunks}),
   uploadRaw:(raw:Parameters<typeof archiveRawLocally>[0],options:Parameters<typeof archiveRawLocally>[1])=>
    archiveRawLocally(raw,{...options,send,hash:hashBlobChunks,hashChunks:hashBlobListChunks})};
  const events:string[]=[];await archivePendingReplaySessions(new AbortController().signal,event=>events.push(event.state),dependencies);
  assert.deepEqual(events,['saving','stored']);
  const saved=await store.getSession('old');assert.ok(saved?.index.archive?.state==='stored');
  assert.equal(saved.index.archive.kind,'raw-session');assert.equal(saved.index.archive.replayCaseId,replay.caseId);
  const raw=await openRawSessionArchive(await openAsBlob(join(root,'cases',saved.index.archive.caseId,'input','0001.loaraw')),new AbortController().signal);
  assert.deepEqual(raw.chunks.map(chunk=>chunk.seq),[0,1]);assert.deepEqual(await raw.chunks[0].blob.arrayBuffer(),await prefix.arrayBuffer());
  assert.deepEqual(await raw.chunks[1].blob.arrayBuffer(),await tail.arrayBuffer());
  const prefixFile=await openReproduction(await openAsBlob(join(root,'cases',replay.caseId,'input','0001.loareplay')),new AbortController().signal);
  assert.equal(prefixFile.exact?.size,prefix.size);assert.equal(prefixFile.metadata.recordState,'partial');
  const frames=[];for await(const item of exactPixels(prefixFile.exact!,new AbortController().signal))frames.push(item);
  assert.equal(frames.length,1);assert.deepEqual(frames[0].pixels,pixels);
 }finally{
  server.closeAllConnections();await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));
  await new Promise<void>((resolve,reject)=>{const request=indexedDB.deleteDatabase(dbName);request.onsuccess=()=>resolve();request.onerror=()=>reject(request.error);});
  const rel=relative(tmpdir(),directory);if(!rel||isAbsolute(rel)||rel==='..'||rel.startsWith(`..${sep}`))throw Error('Unsafe temporary directory');
  await rm(directory,{recursive:true,force:true});
 }
});
