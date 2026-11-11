import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {build} from 'esbuild';
import type {createAcquisitionClient as CreateClient} from '../src/features/card-scanner/acquisition/acquisition-client';

// Node/tsx does not populate Vite's import.meta.env. Bundle the actual client
// with an explicit DEV constant to exercise its real gate and message handler.
// This mock Worker test does not establish browser transfer/pixel behaviour.
test('invalid reduced replies fail closed, release bitmaps and reject later acquisitions',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'loa-reduced-client-'));
 const names=['Worker','OffscreenCanvas','createImageBitmap','document'];
 const previous=Object.fromEntries(names.map(name=>[name,Object.getOwnPropertyDescriptor(globalThis,name)]));
 const clients:ReturnType<typeof CreateClient>[]=[];
 let worker:any,closedBitmaps=0,createdCanvases=0;
 try{
  const bundled=await build({entryPoints:[resolve('src/features/card-scanner/acquisition/acquisition-client.ts')],
   bundle:true,platform:'node',format:'esm',write:false,define:{'import.meta.env':'__testEnvironment'},
   banner:{js:'const __testEnvironment={DEV:true,BASE_URL:"/"};'}});
  const file=join(dir,'client.mjs');await writeFile(file,bundled.outputFiles[0].contents);
  const {createAcquisitionClient}=await import(pathToFileURL(file).href) as {createAcquisitionClient:typeof CreateClient};
  for(const [name,value] of Object.entries({
   Worker:class{onmessage:any;onerror:any;sent:any;terminated=false;constructor(){worker=this;}postMessage(m:any){this.sent=m;}terminate(){this.terminated=true;}},
   OffscreenCanvas:class{},createImageBitmap:async()=>({width:100,height:100,close(){}}),
   document:{createElement:()=>{createdCanvases++;throw Error('malformed response must not paint a canvas');}},
  }))Object.defineProperty(globalThis,name,{value,configurable:true});
  const bitmap=()=>({width:140,height:210,close(){closedBitmaps++;}});
  const cell={slot:0,quality:{usable:false,reason:'empty',sharpness:0},cropState:'omitted-rejected',originalWidth:140,originalHeight:210,
   art:new Uint8Array(648),feature:new Uint8Array(3240),content:{x:0,y:0,width:140,height:210},preview:{x:0,y:0,width:140,height:210},
   alignment:1,intact:true,complete:true,labelVisible:false,borderSides:[1,1,1,1],pixelKey:'test'};
  for(const kind of ['malformed','worker-error'] as const){
   const control=new AbortController(),client=createAcquisitionClient(control.signal,{experimentalRejectedTransport:true});clients.push(client);
   const current=worker,pending=client.detectAndAcquireReduced!({} as HTMLCanvasElement);
   await Promise.resolve();assert.equal(current.sent.experimentalRejectedTransport,true);
   const rejected=assert.rejects(pending,kind==='malformed'?/생략 카드 픽셀/:/worker error/);
   current.onmessage({data:kind==='malformed'?{id:current.sent.id,layout:{cells:[{}]},cells:[{...cell,bitmap:bitmap(),previewBitmap:bitmap()}]}:
    {id:current.sent.id,error:'worker error',cells:[{bitmap:bitmap(),previewBitmap:bitmap()}]}});
   await rejected;assert.equal(current.terminated,true);
   await assert.rejects(client.detectAndAcquire({} as HTMLCanvasElement),/카드 수집 종료/);
   await assert.rejects(client.detectAndAcquireReduced!({} as HTMLCanvasElement),/카드 수집 종료/);
   current.onmessage({data:{id:current.sent.id,cells:[{bitmap:bitmap()}]}});
  }
  assert.equal(closedBitmaps,6,'both response bitmaps and late bitmaps are closed');
  assert.equal(createdCanvases,0);
  // Existing non-reduced error semantics remain unchanged.
  const normal=createAcquisitionClient(new AbortController().signal);clients.push(normal);const current=worker;
  const bad=normal.detectAndAcquire({} as HTMLCanvasElement);await Promise.resolve();
  const rejected=assert.rejects(bad,/ordinary error/);current.onmessage({data:{id:current.sent.id,error:'ordinary error'}});await rejected;
  assert.equal(current.terminated,false);
  const again=normal.detectAndAcquire({} as HTMLCanvasElement);await Promise.resolve();
  current.onmessage({data:{id:current.sent.id,cells:[],layout:null}});assert.deepEqual((await again).cells,[]);
 }finally{
  for(const client of clients)client.dispose();
  for(const [name,descriptor] of Object.entries(previous))if(descriptor)Object.defineProperty(globalThis,name,descriptor);else Reflect.deleteProperty(globalThis,name);
  await rm(dir,{recursive:true,force:true});
 }
});
