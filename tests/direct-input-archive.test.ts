import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createServer,request as httpRequest} from 'node:http';
import {mkdir,mkdtemp,readdir,rm,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {serveCorpusRequest} from '../dev/corpus-server';
import {MAX_DIRECT_TOTAL_BYTES,MAX_DIRECT_HEADER_BYTES} from '../dev/direct-input-archive';
import {readCorpusCase,verifyCorpus} from '../scripts/scan-corpus-core.mjs';
import {createReproductionBundle} from '../src/features/card-scanner/reproduction/scan-reproduction';
import type {ReplayReader} from '../dev/replay-archive';

const sha=(data:Buffer)=>createHash('sha256').update(data).digest('hex');
function envelope(kind:'video'|'images'|'replay',data:Buffer[],extensions:string[]){
 const inputs=data.map((item,index)=>({index,extension:extensions[index],bytes:item.length,sha256:sha(item)}));
 const header=Buffer.from(JSON.stringify({version:1,kind,inputs}));const prefix=Buffer.alloc(12);prefix.write('LOAINP1\0','ascii');prefix.writeUInt32LE(header.length,8);
 return {inputs,body:Buffer.concat([prefix,header,...data])};
}
async function fixture(fn:(input:{url:string;root:string;directory:string;pending:Set<Promise<unknown>>})=>Promise<void>,readReplay?:ReplayReader){
 const directory=await mkdtemp(join(tmpdir(),'loa-direct-')),root=join(directory,'corpus'),pending=new Set<Promise<unknown>>();
 const server=createServer((req,res)=>{const task=serveCorpusRequest(req,res,root,process.cwd(),readReplay).then(ok=>{if(!ok){res.statusCode=404;res.end();}});pending.add(task);void task.finally(()=>pending.delete(task));});
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const address=server.address();assert.ok(address&&typeof address!=='string');
 try{await fn({url:`http://127.0.0.1:${address.port}`,root,directory,pending});}
 finally{server.closeAllConnections();await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));await Promise.allSettled([...pending]);await rm(directory,{recursive:true,force:true});}
}
const headers=(url:string)=>({'Origin':url,'Content-Type':'application/octet-stream','Connection':'close'});

test('ordered images including repeats are atomically registered and identical uploads deduplicate',async()=>{
 await fixture(async({url,root,directory})=>{
  const a=Buffer.from('first image'),b=Buffer.from('second image'),payload=envelope('images',[a,b,a],['.png','.jpg','.png']);
  const send=()=>fetch(`${url}/__corpus/direct-input`,{method:'POST',headers:headers(url),body:payload.body});
  const first=await send();assert.equal(first.status,201);const receipt=await first.json();
  assert.equal(receipt.kind,'images');assert.deepEqual(receipt.inputs,payload.inputs);
  const manifest=await readCorpusCase({root,id:receipt.caseId});assert.deepEqual(manifest.inputs.map(value=>value.sha256),payload.inputs.map(value=>value.sha256));
  assert.equal((await verifyCorpus({root,id:receipt.caseId})).verified,true);
  const second=await send();assert.equal(second.status,200);assert.equal((await second.json()).created,false);
  const renamed=envelope('images',[a,b,a],['.jpg','.png','.jpg']);
  const existing=await fetch(`${url}/__corpus/direct-input`,{method:'POST',headers:headers(url),body:renamed.body});
  assert.equal(existing.status,200);const canonical=await existing.json();
  assert.equal(canonical.caseId,receipt.caseId);assert.deepEqual(canonical.inputs,payload.inputs,
   'reused case reports stored extensions, not those of the later upload');
  assert.deepEqual(await readdir(join(directory,'.loacard-direct-incoming')),[]);
 });
});

test('direct replay preserves its bytes and invalid replay containers are rejected',async()=>{
 const replay=createReproductionBundle({video:new Blob(['video']),metadata:{version:1,createdAt:'2026-10-01',browser:'test',catalog:'test',build:'test',
  completed:false,recordState:'partial',warnings:[],duration:1,type:'video/webm',bytes:5,seed:[],result:null}});
 await fixture(async({url,root})=>{
  const target=`${url}/__corpus/direct-input`,payload=envelope('replay',[Buffer.from(await replay.arrayBuffer())],['.loareplay']);
  const invalid=envelope('replay',[Buffer.from('invalid')],['.loareplay']);
  assert.equal((await fetch(target,{method:'POST',headers:headers(url),body:invalid.body})).status,400);
  const result=await fetch(target,{method:'POST',headers:headers(url),body:payload.body});assert.equal(result.status,201);
  const receipt=await result.json();assert.equal(receipt.kind,'replay');assert.deepEqual(receipt.inputs,payload.inputs);
  assert.equal((await verifyCorpus({root,id:receipt.caseId})).verified,true);
  const image=envelope('images',[Buffer.from(await replay.arrayBuffer())],['.png']);
  const other=await fetch(target,{method:'POST',headers:headers(url),body:image.body});assert.equal(other.status,201);
  const imageReceipt=await other.json();assert.equal(imageReceipt.kind,'images');assert.notEqual(imageReceipt.caseId,receipt.caseId,
   'identical bytes in different input kinds are separate cases');
 });
});

test('invalid digest, extension, extra bytes, and cross-origin requests do not commit cases',async()=>{
 await fixture(async({url,root})=>{
  const target=`${url}/__corpus/direct-input`,valid=envelope('video',[Buffer.from('input')],['.mp4']);
  const corrupt=Buffer.from(valid.body);corrupt[corrupt.length-1]^=1;
  for(const body of [corrupt,Buffer.concat([valid.body,Buffer.from('x')]),envelope('video',[Buffer.from('x')],['.exe']).body]){
   const res=await fetch(target,{method:'POST',headers:headers(url),body});assert.equal(res.status,400);
  }
  assert.equal((await fetch(target,{method:'POST',headers:{...headers(url),Origin:'https://bad.invalid'},body:valid.body})).status,403);
  assert.equal((await fetch(target,{method:'POST',headers:{'Content-Type':'application/octet-stream'},body:valid.body})).status,403);
  const duplicate=Buffer.from('{"version":1,"kind":"video","kind":"video","inputs":[]}');
  const prefix=Buffer.alloc(12);prefix.write('LOAINP1\0','ascii');prefix.writeUInt32LE(duplicate.length,8);
  assert.equal((await fetch(target,{method:'POST',headers:headers(url),body:Buffer.concat([prefix,duplicate])})).status,400);
  try{assert.deepEqual(await readdir(join(root,'cases')),[]);}catch(error){assert.equal((error as NodeJS.ErrnoException).code,'ENOENT');}
 });
});

test('oversized declared bodies are rejected before upload',async()=>{
 await fixture(async({url})=>{
  const status=await new Promise<number>((resolve,reject)=>{
   const req=httpRequest(`${url}/__corpus/direct-input`,{method:'POST',headers:{...headers(url),
    'Content-Length':String(MAX_DIRECT_TOTAL_BYTES+MAX_DIRECT_HEADER_BYTES+13)}},res=>{res.resume();res.on('end',()=>resolve(res.statusCode??0));});
   req.on('error',reject);req.end();
  });assert.equal(status,413);
 });
});

test('disconnected uploads clean owned staging and another direct writer is rejected while busy',async()=>{
 await fixture(async({url,directory,pending})=>{
  const req=httpRequest(`${url}/__corpus/direct-input`,{method:'POST',headers:{...headers(url),'Content-Length':'1000'}});
  req.on('error',()=>{});req.write(Buffer.from('LOAINP1\0'));
  const path=join(directory,'.loacard-direct-incoming');let ready=false;
  for(let n=0;n<100;n++){try{if((await readdir(path)).length){ready=true;break;}}catch{}await new Promise(resolve=>setTimeout(resolve,10));}
  assert.equal(ready,true);
  const body=envelope('video',[Buffer.from('x')],['.mp4']).body;
  assert.equal((await fetch(`${url}/__corpus/direct-input`,{method:'POST',headers:headers(url),body})).status,409);
  req.destroy();await Promise.allSettled([...pending]);assert.deepEqual(await readdir(path),[]);
 });
});

test('staging junction is refused without writing to the linked directory',async t=>{
 await fixture(async({url,directory})=>{
  const external=join(directory,'external');await mkdir(external);
  try{await symlink(external,join(directory,'.loacard-direct-incoming'),'junction');}
  catch(error){if(['EPERM','EACCES','ENOTSUP'].includes((error as NodeJS.ErrnoException).code??'')){t.skip('junction unavailable');return;}throw error;}
  const body=envelope('video',[Buffer.from('x')],['.mp4']).body;
  assert.equal((await fetch(`${url}/__corpus/direct-input`,{method:'POST',headers:headers(url),body})).status,500);
  assert.deepEqual(await readdir(external),[]);
 });
});

test('disconnect after receipt aborts replay validation before any corpus commit',async()=>{
 let entered!:()=>void,seenAbort!:()=>void;
 const reading=new Promise<void>(resolve=>entered=resolve),aborted=new Promise<void>(resolve=>seenAbort=resolve);
 const reader:ReplayReader=async(_blob,signal)=>{
  entered();await new Promise<void>(resolve=>signal.addEventListener('abort',()=>{seenAbort();resolve();},{once:true}));
  signal.throwIfAborted();throw Error('unexpected');
 };
 await fixture(async({url,root,directory,pending})=>{
  const body=envelope('replay',[Buffer.from('test')],['.loareplay']).body;
  const req=httpRequest(`${url}/__corpus/direct-input`,{method:'POST',headers:{...headers(url),'Content-Length':String(body.length)}});
  req.on('error',()=>{});req.end(body);await reading;req.destroy();await aborted;await Promise.allSettled([...pending]);
  assert.deepEqual(await readdir(join(directory,'.loacard-direct-incoming')),[]);
  try{assert.deepEqual(await readdir(join(root,'cases')),[]);}catch(error){assert.equal((error as NodeJS.ErrnoException).code,'ENOENT');}
 },reader);
});
