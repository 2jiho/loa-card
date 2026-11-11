import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createServer} from 'node:http';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,relative,isAbsolute,sep} from 'node:path';
import {archiveDirectInputs,classifyDirectInputs,createDirectInputSelection,hashDirectFiles} from '../dev/direct-input-client';
import {serveCorpusRequest} from '../dev/corpus-server';
import {readCorpusCase,verifyCorpus} from '../scripts/scan-corpus-core.mjs';

const hash=(data:Uint8Array|string)=>createHash('sha256').update(data).digest('hex');
const signal=()=>new AbortController().signal;
const file=(content:string,name:string)=>new File([content],name);
const hashes=async(files:readonly Blob[],s:AbortSignal,onProgress:(index:number,bytes:number)=>void)=>{
 const out:string[]=[];for(let i=0;i<files.length;i++){s.throwIfAborted();const bytes=new Uint8Array(await files[i].arrayBuffer());
  onProgress(i,bytes.length);out.push(hash(bytes));}return out;
};
const mockReceipt=(header:any,created=true)=>{
 const caseId=hash(JSON.stringify({version:1,kind:header.kind,inputs:header.inputs.map((item:{sha256:string})=>item.sha256)}));
 const selectionHash=hash(`${JSON.stringify({version:1,caseId,kind:header.kind,selection:header.selection,inputs:header.inputs,captureTime:null})}\n`);
 return {created,caseId,kind:header.kind,inputs:header.inputs,selection:{id:header.selection.id,sha256:selectionHash}};
};

test('archives ordered repeated images and validates the exact server receipt and input envelope',async()=>{
 const files=[file('first','a.PNG'),file('second','b.jpg'),file('first','a.PNG')],phases:string[]=[];
 const response=await archiveDirectInputs(files,{signal:signal(),hashFiles:hashes,onProgress:value=>phases.push(value.phase),
  send:async(input,init)=>{
   assert.equal(input,'/__corpus/direct-input');assert.equal(init?.method,'POST');assert.equal(init?.credentials,'same-origin');
   const body=new Uint8Array(await (init?.body as Blob).arrayBuffer()),prefix=new TextDecoder().decode(body.subarray(0,8));
   assert.equal(prefix,'LOAINP1\0');const length=new DataView(body.buffer).getUint32(8,true);
   const header=JSON.parse(new TextDecoder().decode(body.subarray(12,12+length)));
   assert.equal(header.kind,'images');assert.deepEqual(header.inputs.map((item:{extension:string})=>item.extension),['.png','.jpg','.png']);
   assert.equal(new TextDecoder().decode(body.subarray(12+length)),'firstsecondfirst');
   return Response.json(mockReceipt(header),{status:201});
  }});
 assert.equal(response.kind,'images');assert.equal(response.inputs.length,3);assert.equal(response.inputs[0].sha256,response.inputs[2].sha256);
 assert.deepEqual(phases,['hashing','hashing','hashing','uploading']);
});

test('rejects invalid files and does not transmit when receipt digest, order, or case id differs',async()=>{
 let sent=0;
 await assert.rejects(archiveDirectInputs([file('x','test.png'),file('v','test.mp4')],{signal:signal(),send:async()=>{sent++;return new Response();}}));
 await assert.rejects(archiveDirectInputs([file('','test.png')],{signal:signal()}));
 assert.equal(sent,0);
 const f=[file('x','test.mp4')];
 for(const mutate of [
  (row:any)=>{row.caseId='0'.repeat(64);},(row:any)=>{row.inputs[0].bytes++;},(row:any)=>{row.inputs[0].extension='.jpg';},
 ])await assert.rejects(archiveDirectInputs(f,{signal:signal(),hashFiles:hashes,send:async(_input,init)=>{
   const body=new Uint8Array(await (init?.body as Blob).arrayBuffer()),length=new DataView(body.buffer).getUint32(8,true);
   const header=JSON.parse(new TextDecoder().decode(body.subarray(12,12+length)));
   const row=mockReceipt(header);
   mutate(row);return Response.json(row);
 }}),/일치하지/);
});

test('a selected replay is archived as replay instead of being treated as a video',async()=>{
 const f=file('replay-bytes','session.LOAREPLAY');
 const receipt=await archiveDirectInputs([f],{signal:signal(),hashFiles:hashes,send:async(_input,init)=>{
  const body=new Uint8Array(await (init?.body as Blob).arrayBuffer()),length=new DataView(body.buffer).getUint32(8,true);
  const header=JSON.parse(new TextDecoder().decode(body.subarray(12,12+length)));
  assert.equal(header.kind,'replay');assert.equal(header.inputs[0].extension,'.loareplay');
  return Response.json(mockReceipt(header,false));
 }});
 assert.equal(receipt.kind,'replay');assert.equal(receipt.created,false);
});

test('classifies supported extensions even when the browser supplies no MIME type',()=>{
 const mkv=new File(['video'],'clip.MKV',{type:''}),bmp=new File(['bitmap'],'card.BMP',{type:''});
 assert.equal(classifyDirectInputs([mkv]).kind,'video');assert.equal(classifyDirectInputs([bmp]).kind,'images');
 assert.throws(()=>classifyDirectInputs([mkv,bmp]));
});

test('accepts a canonical existing extension only within the same kind, with unchanged bytes and identity',async()=>{
 const f=file('same','card.jpg');
 const send=async(_input:RequestInfo|URL,init?:RequestInit)=>{
  const body=new Uint8Array(await (init?.body as Blob).arrayBuffer()),length=new DataView(body.buffer).getUint32(8,true);
  const header=JSON.parse(new TextDecoder().decode(body.subarray(12,12+length)));
  const inputs=header.inputs.map((item:object)=>({...item,extension:'.png'}));
  return Response.json({...mockReceipt(header,false),inputs});
 };
 const receipt=await archiveDirectInputs([f],{signal:signal(),hashFiles:hashes,send});
 assert.equal(receipt.created,false);assert.equal(receipt.inputs[0].extension,'.png');assert.equal(receipt.inputs[0].sha256,hash('same'));
});

test('one selection preserves its event identity and timestamps across retries without assuming capture time',async()=>{
 const files=[new File(['x'],'card.png',{lastModified:123})],selection=createDirectInputSelection(files,'2026-10-30T01:02:03.000Z');
 const headers:any[]=[];
 const send=async(_url:RequestInfo|URL,init?:RequestInit)=>{
  const body=new Uint8Array(await (init!.body as Blob).arrayBuffer()),length=new DataView(body.buffer).getUint32(8,true);
  const header=JSON.parse(new TextDecoder().decode(body.subarray(12,12+length)));headers.push(header);
  return Response.json(mockReceipt(header,headers.length===1));
 };
 const first=await archiveDirectInputs(files,{signal:signal(),selection,hashFiles:hashes,send});
 const second=await archiveDirectInputs(files,{signal:signal(),selection,hashFiles:hashes,send});
 assert.deepEqual(headers[0].selection,headers[1].selection);
 assert.equal(headers[0].selection.id,selection.id);assert.equal(headers[0].selection.selectedAt,'2026-10-30T01:02:03.000Z');
 assert.deepEqual(headers[0].selection.lastModifiedMs,[123]);assert.equal(first.selection.sha256,second.selection.sha256);
 assert.ok(!('captureTime' in headers[0].selection));
 await assert.rejects(archiveDirectInputs([new File(['different'],'card.png',{lastModified:123})],{signal:signal(),selection,hashFiles:hashes,send}),/변경/);
 await assert.rejects(archiveDirectInputs([new File(['y'],'card.png',{lastModified:123})],{signal:signal(),selection,hashFiles:hashes,send}),/내용이 변경/);
 assert.equal(headers.length,2,'changed bytes are rejected before a new upload');
});

test('unobserved selection time stays null and changed selection receipt is rejected',async()=>{
 const files=[file('a','card.png')],selection=createDirectInputSelection(files);
 await assert.rejects(archiveDirectInputs(files,{signal:signal(),selection,hashFiles:hashes,send:async(_url,init)=>{
  const body=new Uint8Array(await (init!.body as Blob).arrayBuffer()),length=new DataView(body.buffer).getUint32(8,true);
  const header=JSON.parse(new TextDecoder().decode(body.subarray(12,12+length)));assert.equal(header.selection.selectedAt,null);
  const row=mockReceipt(header);row.selection.sha256='0'.repeat(64);return Response.json(row);
 }}),/일치하지/);
});

class FakeWorker extends EventTarget {
  terminated=false;posted:number[]=[];auto=true;bad=false;
  postMessage(value:{index:number;blob:Blob}){
   this.posted.push(value.index);if(!this.auto)return;
   queueMicrotask(async()=>{
    const digest=hash(new Uint8Array(await value.blob.arrayBuffer()));
    this.dispatchEvent(new MessageEvent('message',{data:{kind:'progress',index:value.index,bytes:value.blob.size}}));
    this.dispatchEvent(new MessageEvent('message',{data:{kind:'done',index:this.bad?value.index+1:value.index,bytes:value.blob.size,sha256:digest}}));
   });
  }
  terminate(){this.terminated=true;}
}

test('hashes one file at a time in the worker and terminates on abort or invalid result',async()=>{
 const worker=new FakeWorker(),events:number[]=[];
 const result=await hashDirectFiles([new Blob(['x']),new Blob(['yz'])],signal(),{workerFactory:()=>worker as unknown as Worker,onProgress:index=>events.push(index)});
 assert.deepEqual(result,[hash('x'),hash('yz')]);assert.deepEqual(worker.posted,[0,1]);assert.deepEqual(events,[0,1]);assert.equal(worker.terminated,true);
 const bad=new FakeWorker();bad.bad=true;await assert.rejects(hashDirectFiles([new Blob(['x'])],signal(),{workerFactory:()=>bad as unknown as Worker}));assert.equal(bad.terminated,true);
 const held=new FakeWorker();held.auto=false;const controller=new AbortController();
 const pending=hashDirectFiles([new Blob(['x'])],controller.signal,{workerFactory:()=>held as unknown as Worker});controller.abort();
 await assert.rejects(pending,{name:'AbortError'});assert.equal(held.terminated,true);
});

test('cancelled or oversized local responses cannot yield an archive receipt',async()=>{
 const controller=new AbortController();controller.abort();let sent=false;
 await assert.rejects(archiveDirectInputs([file('x','a.png')],{signal:controller.signal,hashFiles:hashes,send:async()=>{sent=true;return new Response();}}),{name:'AbortError'});
 assert.equal(sent,false);
 await assert.rejects(archiveDirectInputs([file('x','a.png')],{signal:signal(),hashFiles:hashes,send:async()=>new Response('x'.repeat(512*1024+1))}),/너무 큽니다/);
});

test('client envelope and actual local server register a repeated ordered image sequence',async()=>{
 const base=tmpdir(),directory=await mkdtemp(join(base,'loa-direct-client-')),root=join(directory,'corpus');
 const tail=relative(base,directory);assert.ok(tail&&!isAbsolute(tail)&&tail!=='..'&&!tail.startsWith(`..${sep}`));
 const pending=new Set<Promise<unknown>>();
 const server=createServer((request,response)=>{
  const task=serveCorpusRequest(request,response,root,process.cwd()).then(handled=>{if(!handled){response.statusCode=404;response.end();}});
  pending.add(task);void task.finally(()=>pending.delete(task));
 });
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 const address=server.address();assert.ok(address&&typeof address!=='string');const origin=`http://127.0.0.1:${address.port}`;
 try{
  const files=[file('a','one.png'),file('b','two.jpg'),file('a','one.png')];
  const selection=createDirectInputSelection(files,'2026-10-30T01:02:03.000Z');
  const send:typeof fetch=(input,init)=>fetch(new URL(String(input),origin),{
   ...init,headers:{'Content-Type':'application/octet-stream',Origin:origin,'Sec-Fetch-Site':'same-origin','Connection':'close'},
  });
  const receipt=await archiveDirectInputs(files,{signal:signal(),selection,hashFiles:hashes,send});
  const manifest=await readCorpusCase({root,id:receipt.caseId});
  assert.equal(manifest.kind,'images');assert.deepEqual(manifest.inputs.map(input=>input.sha256),[hash('a'),hash('b'),hash('a')]);
  assert.equal((await verifyCorpus({root,id:receipt.caseId})).verified,true);
  const retried=await archiveDirectInputs(files,{signal:signal(),selection,hashFiles:hashes,send});
  assert.equal(retried.created,false);assert.deepEqual(retried.selection,receipt.selection);
  const bytes=await readFile(join(root,'cases',receipt.caseId,'selections',`${selection.id}-${receipt.selection.sha256}.json`));
  assert.equal(hash(bytes),receipt.selection.sha256);const provenance=JSON.parse(bytes.toString('utf8'));
  assert.equal(provenance.selection.selectedAt,'2026-10-30T01:02:03.000Z');assert.equal(provenance.captureTime,null);
  assert.deepEqual(provenance.inputs.map((input:{sha256:string})=>input.sha256),[hash('a'),hash('b'),hash('a')]);
  const original=await archiveDirectInputs([file('same','one.png')],{signal:signal(),hashFiles:hashes,send});
  const duplicate=await archiveDirectInputs([file('same','one.jpg')],{signal:signal(),hashFiles:hashes,send});
  assert.equal(duplicate.created,false);assert.equal(duplicate.caseId,original.caseId);
  assert.equal(duplicate.inputs[0].extension,'.png','the stored case extension is authoritative');
 }finally{
  server.closeAllConnections();await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));
  await Promise.allSettled([...pending]);await rm(directory,{recursive:true,force:true});
 }
});
