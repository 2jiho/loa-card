import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer,request as httpRequest} from 'node:http';
import {mkdir,mkdtemp,readdir,rm,stat,symlink,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {serveCorpusRequest} from '../dev/corpus-server';
import {MAX_REPLAY_ARCHIVE_BYTES} from '../dev/replay-archive';
import type {ReplayReader} from '../dev/replay-archive';
import {createReproductionBundle} from '../src/features/card-scanner/reproduction/scan-reproduction';
import type {ReproductionFile} from '../src/features/card-scanner/reproduction/scan-reproduction';
import {verifyCorpus} from '../scripts/scan-corpus-core.mjs';
import {corpusServerPlugin} from '../dev/corpus-server';
import {createServer as createViteServer} from 'vite';
import {createRawSessionArchive} from '../src/features/card-scanner/reproduction/raw-session-archive';

async function fixture(fn:(value:{directory:string;root:string;url:string;pending:Set<Promise<unknown>>})=>Promise<void>,rootPath='corpus',sourceRoot=process.cwd(),readReplay?:ReplayReader){
 const directory=await mkdtemp(join(tmpdir(),'loa-replay-http-')),root=join(directory,rootPath);
 const pending=new Set<Promise<unknown>>();
 const server=createServer((request,response)=>{
  const task=serveCorpusRequest(request,response,root,sourceRoot,readReplay).then(handled=>{if(!handled){response.statusCode=404;response.end();}});
  pending.add(task);void task.finally(()=>pending.delete(task));
 });
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 const address=server.address();assert.ok(address&&typeof address!=='string');
 try{await fn({directory,root,url:`http://127.0.0.1:${address.port}`,pending});}
 finally{server.closeAllConnections();await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));await Promise.all(pending);await rm(directory,{recursive:true,force:true});}
}
function replay(partial=false){
 const file:ReproductionFile={video:new Blob(['video']),metadata:{version:1,createdAt:'2026-10-01',browser:'test',catalog:'test',build:'test',
   completed:!partial,...(partial?{recordState:'partial' as const}:{}),warnings:[],duration:2,type:'video/webm',bytes:5,seed:[],result:null}};
 return createReproductionBundle(file);
}
const headers=(url:string)=>({'Content-Type':'application/octet-stream','Origin':url,'Sec-Fetch-Site':'same-origin','Connection':'close'});

test('raw partial session is verified and archived separately from replay, including rejection of corruption',async()=>{
 const chunk=new Blob(['tail!']),sha256=createHash('sha256').update('tail!').digest('hex');
 const blob=await createRawSessionArchive({index:{version:1,id:'raw-test',createdAt:'2026-10-01',updatedAt:'2026-10-01',
   environment:{browser:'test',catalog:'test',build:'test'},record:true,status:'partial',sealed:true,pinned:false,ownerId:'owner',leaseUntil:null,
   bytes:5,detailsBytes:0,chunkCounts:{video:0,exact:1},chunkBytes:{video:0,exact:5},hasInput:true,read:null,expected:null,cards:null,
   generation:'generation',archiveRevision:'revision',archive:{state:'pending'}},
   chunks:[{kind:'exact',seq:0,bytes:5,sha256,blob:chunk}]},new AbortController().signal);
 await fixture(async({root,url})=>{
  const send=(body:Blob,extra:Record<string,string>={})=>fetch(`${url}/__corpus/raw-session`,{method:'POST',headers:{...headers(url),...extra},body});
  assert.equal((await send(blob,{Origin:'https://example.com'})).status,403);
  const bytes=new Uint8Array(await blob.arrayBuffer());bytes[bytes.length-1]^=1;
  assert.equal((await send(new Blob([bytes]))).status,400);
  const result=await send(blob);assert.equal(result.status,201);const receipt=await result.json();
  assert.equal(receipt.recordedCoverage,'partial');assert.equal((await verifyCorpus({root,id:receipt.caseId})).verified,true);
  const manifest=await (await fetch(`${url}/__corpus/cases/${receipt.caseId}`)).json();
  assert.equal(manifest.kind,'raw-session');assert.equal(manifest.inputs[0].type,'application/octet-stream');
  const again=await send(blob);assert.equal(again.status,200);assert.equal((await again.json()).created,false);
 });
});

test('a replay upload is streamed into a private immutable case and identical bytes deduplicate',async()=>{
 await fixture(async({directory,root,url})=>{
  const blob=replay(),hash=createHash('sha256').update(Buffer.from(await blob.arrayBuffer())).digest('hex');
  const send=()=>fetch(`${url}/__corpus/replay`,{method:'POST',headers:headers(url),body:blob});
  const first=await send();assert.equal(first.status,201);const value=await first.json();
  assert.equal(value.created,true);assert.match(value.caseId,/^[a-f0-9]{64}$/);assert.deepEqual(value.input,{sha256:hash,bytes:blob.size});
  assert.equal(value.recordedCoverage,'unknown','legacy video only is never labelled complete');
  const second=await send();assert.equal(second.status,200);assert.deepEqual(await second.json(),{...value,created:false});
  assert.equal((await verifyCorpus({root,id:value.caseId})).verified,true);
  assert.deepEqual(await readdir(join(directory,'.loacard-replay-incoming')),[]);
 });
});

test('a modified staged file is rejected before any case or object is committed',async()=>{
 let directory='';
 const reader:ReplayReader=async(_blob,signal)=>{
  signal.throwIfAborted();const incoming=join(directory,'.loacard-replay-incoming');
  const [stage]=await readdir(incoming);assert.ok(stage);
  await writeFile(join(incoming,stage,'input.loareplay'),'changed during verification');
  return {metadata:{recordState:'partial'}};
 };
 await fixture(async value=>{
  directory=value.directory;
  const result=await fetch(`${value.url}/__corpus/replay`,{method:'POST',headers:headers(value.url),body:replay()});
  assert.equal(result.status,500);
  assert.deepEqual(await readdir(join(value.root,'cases')),[]);
  assert.deepEqual(await readdir(join(value.root,'objects')),[]);
 },'corpus',process.cwd(),reader);
});

test('a fresh workspace can create the missing local corpus parent safely',async()=>{
 await fixture(async({root,url})=>{
  const response=await fetch(`${url}/__corpus/replay`,{method:'POST',headers:headers(url),body:replay()});
  assert.equal(response.status,201);const value=await response.json();
  assert.equal((await verifyCorpus({root,id:value.caseId})).verified,true);
 },join('new','local','corpus'));
});

test('partial recordings stay partial; invalid containers and content type leave no case',async()=>{
 await fixture(async({directory,root,url})=>{
  const invalid=await fetch(`${url}/__corpus/replay`,{method:'POST',headers:headers(url),body:new Blob(['not a replay'])});
  assert.equal(invalid.status,400);
  const type=await fetch(`${url}/__corpus/replay`,{method:'POST',headers:{...headers(url),'Content-Type':'application/json'},body:'{}'});assert.equal(type.status,415);
  const partial=await fetch(`${url}/__corpus/replay`,{method:'POST',headers:headers(url),body:replay(true)});assert.equal(partial.status,201);
  const result=await partial.json();assert.equal(result.recordedCoverage,'partial');
  assert.equal((await verifyCorpus({root,id:result.caseId})).verified,true);
  assert.deepEqual(await readdir(join(directory,'.loacard-replay-incoming')),[]);
 });
});

test('an unavailable parser is reported as a server failure, not as an invalid user replay',async()=>{
 await fixture(async({directory,url})=>{
  const response=await fetch(`${url}/__corpus/replay`,{method:'POST',headers:headers(url),body:replay()});
  assert.equal(response.status,503);assert.deepEqual(await readdir(join(directory,'.loacard-replay-incoming')),[]);
 },'corpus',join(tmpdir(),'loacard-nonexistent-parser-root'));
});

test('replay writes require an explicit local same origin and reject oversized bodies before reading',async()=>{
 await fixture(async({url})=>{
  for(const extra of [{Origin:'https://example.com'},{Origin:'null'},{Origin:url.replace('http:','https:')},{Host:'attacker.example:80',Origin:'http://attacker.example:80'}]){
   const response=await fetch(`${url}/__corpus/replay`,{method:'POST',headers:{...headers(url),...extra},body:replay()});assert.equal(response.status,403);
  }
  const missing=await fetch(`${url}/__corpus/replay`,{method:'POST',headers:{'Content-Type':'application/octet-stream'},body:replay()});assert.equal(missing.status,403);
  const status=await new Promise<number>((resolve,reject)=>{
   const req=httpRequest(`${url}/__corpus/replay`,{method:'POST',headers:{...headers(url),'Content-Length':String(MAX_REPLAY_ARCHIVE_BYTES+1)}},res=>{
    res.resume();res.on('end',()=>resolve(res.statusCode??0));});req.on('error',reject);req.end();
  });assert.equal(status,413);
 });
});

test('a disconnected upload releases its private staging and rejects a concurrent writer',async()=>{
 await fixture(async({directory,url,pending})=>{
  const req=httpRequest(`${url}/__corpus/replay`,{method:'POST',headers:{...headers(url),'Content-Length':'1000'}});
  req.on('error',()=>{});req.write(Buffer.from('partial replay'));
  const incoming=join(directory,'.loacard-replay-incoming');let ready=false;
  for(let i=0;i<100;i++){try{if((await readdir(incoming)).length){ready=true;break;}}catch{}await new Promise(resolve=>setTimeout(resolve,10));}
  assert.equal(ready,true,'first upload owns a staging directory');
  const other=await fetch(`${url}/__corpus/replay`,{method:'POST',headers:headers(url),body:replay()});assert.equal(other.status,409);
  req.destroy();await Promise.allSettled([...pending]);
  assert.deepEqual(await readdir(incoming),[],'the interrupted writer cleans only its staging directory');
 });
});

test('a linked staging path is rejected and no data is written through it',async t=>{
 await fixture(async({directory,url})=>{
  const external=join(directory,'external');await mkdir(external);
  try{await symlink(external,join(directory,'.loacard-replay-incoming'),'junction');}
  catch(error){if(['EPERM','EACCES','ENOTSUP'].includes((error as NodeJS.ErrnoException).code??'')){t.skip('symlink not available');return;}throw error;}
  const response=await fetch(`${url}/__corpus/replay`,{method:'POST',headers:headers(url),body:replay()});assert.equal(response.status,500);
  assert.deepEqual(await readdir(external),[]);
 });
});

test('the real Vite middleware loads the shared replay parser and archives a valid container',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'loa-replay-vite-')),root=join(directory,'corpus');
 const server=await createViteServer({configFile:false,root:directory,plugins:[corpusServerPlugin(root,process.cwd())],
   server:{host:'127.0.0.1',port:0,watch:{ignored:['**/corpus/**','**/.loacard-replay-incoming/**']}},logLevel:'silent'});
 try{
  await server.listen();const address=server.httpServer?.address();assert.ok(address&&typeof address!=='string');
  const url=`http://127.0.0.1:${address.port}`;
  const response=await fetch(`${url}/__corpus/replay`,{method:'POST',headers:headers(url),body:replay()});
  assert.equal(response.status,201);const result=await response.json();assert.equal(result.recordedCoverage,'unknown');
  assert.equal((await verifyCorpus({root,id:result.caseId})).verified,true);
 }finally{await server.close();await rm(directory,{recursive:true,force:true});}
});


test('disconnect after upload aborts parser and cleans staging before accepting a retry',async()=>{
 let enter!:()=>void,seenAbort!:()=>void;
 const entered=new Promise<void>(resolve=>enter=resolve),aborted=new Promise<void>(resolve=>seenAbort=resolve);
 const reader:ReplayReader=async(_blob,signal)=>{enter();await new Promise<void>(resolve=>signal.addEventListener('abort',()=>{seenAbort();resolve();},{once:true}));signal.throwIfAborted();throw Error('unreachable');};
 await fixture(async({directory,root,url,pending})=>{
  const bytes=Buffer.from(await replay().arrayBuffer());
  const req=httpRequest(`${url}/__corpus/replay`,{method:'POST',headers:{...headers(url),'Content-Length':String(bytes.length)}});
  req.on('error',()=>{});req.end(bytes);await entered;req.destroy();await aborted;await Promise.allSettled([...pending]);
  assert.deepEqual(await readdir(join(directory,'.loacard-replay-incoming')),[]);
  await assert.rejects(readdir(join(root,'cases')),{code:'ENOENT'});
 },'corpus',process.cwd(),reader);
});

test('disconnect during archive copy aborts writer and never publishes an incomplete case',async()=>{
 await fixture(async({directory,root,url,pending})=>{
  // The parser only reads metadata; a large payload makes it possible to observe
  // the real corpus writer while its bounded copy is still in progress.
  const payload=Buffer.alloc(128*1024*1024,19);
  const raw=replay();const bytes=Buffer.concat([Buffer.from(await raw.arrayBuffer()),payload]);
  const req=httpRequest(`${url}/__corpus/replay`,{method:'POST',headers:{...headers(url),'Content-Length':String(bytes.length)}});
  req.on('error',()=>{});req.end(bytes);
  const staging=join(root,'.tmp');let copying=false;
  for(let i=0;i<3000;i++){
   try{for(const dir of await readdir(staging)){const file=join(staging,dir,'source-0');const size=(await stat(file)).size;if(size>0&&size<bytes.length){copying=true;break;}}}catch{}
   if(copying)break;await new Promise(resolve=>setTimeout(resolve,2));
  }
  assert.equal(copying,true,'observed real in-progress corpus copy');req.destroy();await Promise.allSettled([...pending]);
  assert.deepEqual(await readdir(staging),[]);assert.deepEqual(await readdir(join(root,'cases')),[]);
  assert.deepEqual(await readdir(join(root,'objects')),[]);assert.deepEqual(await readdir(join(directory,'.loacard-replay-incoming')),[]);
 },'corpus',process.cwd(),async()=>({metadata:{}} as Awaited<ReturnType<ReplayReader>>));
});
