import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createServer} from 'node:http';
import {mkdir,mkdtemp,readFile,readdir,rename,rm,writeFile,unlink,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {serveCorpusRequest} from '../dev/corpus-server';
import {corpusCaseId,readCorpusInputSelection,verifyCorpus} from '../scripts/scan-corpus-core.mjs';

const sha=(data:Uint8Array)=>createHash('sha256').update(data).digest('hex');
const selection={id:'12345678-1234-4234-8234-123456789abc',selectedAt:'2026-10-30T00:00:00.000Z',
 registrationStartedAt:'2026-10-30T00:00:01.000Z',lastModifiedMs:[null,123]};
function envelope(data:Buffer[],metadata:unknown=selection,extensions=['.png','.jpg']){
 const inputs=data.map((item,index)=>({index,extension:extensions[index],bytes:item.length,sha256:sha(item)}));
 const kind='images',head=Buffer.from(JSON.stringify({version:2,kind,inputs,selection:metadata}));
 const prefix=Buffer.alloc(12);prefix.write('LOAINP1\0','ascii');prefix.writeUInt32LE(head.length,8);
 const caseId=corpusCaseId(kind,inputs.map(input=>input.sha256));
 const content=Buffer.from(`${JSON.stringify({version:1,caseId,kind,selection:metadata,inputs,captureTime:null})}\n`);
 return {inputs,caseId,content,body:Buffer.concat([prefix,head,...data])};
}
async function fixture(fn:(input:{url:string;root:string})=>Promise<void>){
 const directory=await mkdtemp(join(tmpdir(),'loa-selection-')),root=join(directory,'corpus');
 const pending=new Set<Promise<unknown>>();
 const server=createServer((req,res)=>{const promise=serveCorpusRequest(req,res,root,process.cwd()).then(ok=>{if(!ok){res.statusCode=404;res.end();}});pending.add(promise);void promise.finally(()=>pending.delete(promise));});
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const address=server.address();assert.ok(address&&typeof address!=='string');
 try{await fn({url:`http://127.0.0.1:${address.port}`,root});}
 finally{server.closeAllConnections();await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));await Promise.allSettled([...pending]);await rm(directory,{recursive:true,force:true});}
}
const send=(url:string,body:Buffer)=>fetch(`${url}/__corpus/direct-input`,{method:'POST',headers:{Origin:url,'Content-Type':'application/octet-stream','Connection':'close'},body});

test('v2 registers immutable ordered selection with new and reused cases and exact retries',async()=>{
 await fixture(async({url,root})=>{
  const source=[Buffer.from('a'),Buffer.from('b')],payload=envelope(source);
  const response=await send(url,payload.body);assert.equal(response.status,201);const receipt=await response.json();
  assert.equal(receipt.caseId,payload.caseId);assert.deepEqual(receipt.selection,{id:selection.id,sha256:sha(payload.content)});
  const path=join(root,'cases',payload.caseId,'selections',`${selection.id}-${sha(payload.content)}.json`);
  assert.deepEqual(await readFile(path),payload.content);assert.deepEqual(await readFile(join(root,'selections',`${selection.id}-${sha(payload.content)}.json`)),payload.content);
  const checked=await readCorpusInputSelection({root,id:payload.caseId,selectionId:selection.id});
  assert.equal(checked.sha256,receipt.selection.sha256);assert.equal(checked.record.captureTime,null);
  assert.equal((await verifyCorpus({root,id:payload.caseId})).verified,true);
  const again=await send(url,payload.body);assert.equal(again.status,200);assert.deepEqual((await again.json()).selection,receipt.selection);
  const second={...selection,id:'22345678-1234-4234-8234-123456789abc',selectedAt:null};
  const another=envelope(source,second),reused=await send(url,another.body);assert.equal(reused.status,200);
  assert.deepEqual(await readFile(join(root,'cases',payload.caseId,'selections',`${second.id}-${sha(another.content)}.json`)),another.content);
  const changed=envelope([Buffer.from('different'),source[1]]),conflict=await send(url,changed.body);assert.ok(conflict.status>=400);
  assert.deepEqual(await readdir(join(root,'cases')),[payload.caseId]);
  assert.deepEqual(await readFile(path),payload.content);
 });
});

test('a previously orphaned global selection claim permits only byte-identical retry',async()=>{
 await fixture(async({url,root})=>{
  const payload=envelope([Buffer.from('a'),Buffer.from('b')]);
  await mkdir(join(root,'selections'),{recursive:true});await writeFile(join(root,'selections',`${selection.id}-${sha(payload.content)}.json`),payload.content);
  const changed=envelope([Buffer.from('changed'),Buffer.from('b')]);
  assert.ok((await send(url,changed.body)).status>=400);
  const result=await send(url,payload.body);assert.equal(result.status,201);
  assert.deepEqual(await readFile(join(root,'cases',payload.caseId,'selections',`${selection.id}-${sha(payload.content)}.json`)),payload.content);
 });
});

test('v2 rejects invalid selection metadata and untrusted fields before case commit',async()=>{
 await fixture(async({url,root})=>{
  const data=[Buffer.from('a'),Buffer.from('b')];
  for(const bad of [{...selection,id:'../../unsafe'}, {...selection,selectedAt:'yesterday'},
   {...selection,lastModifiedMs:[1]}, {...selection,lastModifiedMs:[0,-1]}, {...selection,extra:'bad'}]){
   assert.equal((await send(url,envelope(data,bad).body)).status,400);
  }
  await assert.rejects(readdir(join(root,'cases')),{code:'ENOENT'});
 });
});

test('selection verification rejects wrong IDs, cases and cancellation',async()=>{
 await fixture(async({url,root})=>{
  const payload=envelope([Buffer.from('a'),Buffer.from('b')]);assert.equal((await send(url,payload.body)).status,201);
  const other={...selection,id:'22345678-1234-4234-8234-123456789abc'};
  const otherCase=envelope([Buffer.from('c'),Buffer.from('b')],other);assert.equal((await send(url,otherCase.body)).status,201);
  await assert.rejects(readCorpusInputSelection({root,id:payload.caseId,selectionId:'../../bad'}));
  await assert.rejects(readCorpusInputSelection({root,id:payload.caseId,selectionId:other.id}));
  await assert.rejects(readCorpusInputSelection({root,id:otherCase.caseId,selectionId:selection.id}));
  const abort=new AbortController();abort.abort();
  await assert.rejects(readCorpusInputSelection({root,id:payload.caseId,selectionId:selection.id,signal:abort.signal}),{name:'AbortError'});
 });
});

test('selection checksum detects in-place edits shared by case and global hardlinks',async()=>{
 await fixture(async({url,root})=>{
  const payload=envelope([Buffer.from('a'),Buffer.from('b')]);assert.equal((await send(url,payload.body)).status,201);
  const name=`${selection.id}-${sha(payload.content)}.json`,path=join(root,'cases',payload.caseId,'selections',name);
  const changed=JSON.parse(payload.content.toString());changed.selection.selectedAt='2026-10-30T00:00:02.000Z';
  await writeFile(path,`${JSON.stringify(changed)}\n`);
  assert.deepEqual(await readFile(path),await readFile(join(root,'selections',name)),'in-place edit affects both hardlinks');
  await assert.rejects(readCorpusInputSelection({root,id:payload.caseId,selectionId:selection.id}),/checksum claim/);
 });
});

test('replacing one claim detects changed bytes; byte-identical replacement is still equivalent content',async()=>{
 await fixture(async({url,root})=>{
  const payload=envelope([Buffer.from('a'),Buffer.from('b')]);assert.equal((await send(url,payload.body)).status,201);
  const name=`${selection.id}-${sha(payload.content)}.json`,local=join(root,'cases',payload.caseId,'selections',name),global=join(root,'selections',name);
  await unlink(local);await writeFile(local,payload.content);
  assert.equal((await readCorpusInputSelection({root,id:payload.caseId,selectionId:selection.id})).sha256,sha(payload.content),
   'same bytes need not remain a hardlink');
  await unlink(global);await writeFile(global,'different');
  await assert.rejects(readCorpusInputSelection({root,id:payload.caseId,selectionId:selection.id}),/do not match/);
 });
});

test('selection verification refuses a replaced directory junction',async t=>{
 await fixture(async({url,root})=>{
  const payload=envelope([Buffer.from('a'),Buffer.from('b')]);assert.equal((await send(url,payload.body)).status,201);
  const directory=join(root,'cases',payload.caseId,'selections'),moved=join(root,'cases',payload.caseId,'selections-original');
  await rename(directory,moved);
  try{await symlink(moved,directory,'junction');}
  catch(error){if(['EPERM','EACCES','ENOTSUP'].includes((error as NodeJS.ErrnoException).code??'')){t.skip('junction unavailable');return;}throw error;}
  await assert.rejects(readCorpusInputSelection({root,id:payload.caseId,selectionId:selection.id}),/Symlinks and junctions/);
 });
});

test('legacy UUID-only claim becomes verifiable only after a byte-identical resubmission',async()=>{
 await fixture(async({url,root})=>{
  const payload=envelope([Buffer.from('a'),Buffer.from('b')]);assert.equal((await send(url,payload.body)).status,201);
  const name=`${selection.id}-${sha(payload.content)}.json`,localDir=join(root,'cases',payload.caseId,'selections'),globalDir=join(root,'selections');
  await rename(join(localDir,name),join(localDir,`${selection.id}.json`));await rename(join(globalDir,name),join(globalDir,`${selection.id}.json`));
  await assert.rejects(readCorpusInputSelection({root,id:payload.caseId,selectionId:selection.id}),/checksum claim/);
  assert.equal((await send(url,payload.body)).status,200);
  assert.equal((await readCorpusInputSelection({root,id:payload.caseId,selectionId:selection.id})).sha256,sha(payload.content));
 });
});
