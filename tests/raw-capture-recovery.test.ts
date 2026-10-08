import { test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createCaptureEncoder } from '../src/features/card-scanner/capture-encoder';

function setup(t: TestContext, bitmapFactory?: () => Promise<ImageBitmap>) {
  const drawn: number[][] = [];
  const canvas = { width: 0, height: 0, getContext: () => ({ putImageData: (image: {data: Uint8ClampedArray}) => drawn.push([...image.data]) }) };
  const oldDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const oldImage = Object.getOwnPropertyDescriptor(globalThis, 'ImageData');
  Object.defineProperty(globalThis, 'document', {configurable:true,value:{createElement:()=>canvas}});
  Object.defineProperty(globalThis, 'ImageData', {configurable:true,value:class { constructor(public data:Uint8ClampedArray, public width:number, public height:number){} }});
  t.after(()=>{
    if(oldDocument)Object.defineProperty(globalThis,'document',oldDocument);else delete (globalThis as {document?:unknown}).document;
    if(oldImage)Object.defineProperty(globalThis,'ImageData',oldImage);else delete (globalThis as {ImageData?:unknown}).ImageData;
  });
  const messages: Record<string,unknown>[] = [], reports:string[]=[];
  const worker={onmessage:null as ((event:MessageEvent)=>void)|null,onerror:null,terminated:false,
    postMessage(message:unknown){messages.push(message as Record<string,unknown>); if((message as {discard?:boolean}).discard)queueMicrotask(()=>this.onmessage?.({data:{done:true}} as MessageEvent));},
    terminate(){this.terminated=true;}};
  const reply=(data:unknown)=>worker.onmessage?.({data} as MessageEvent);
  const encoder=createCaptureEncoder(()=>assert.fail('raw recovery must not export PNG'),message=>reports.push(message),worker,1024,bitmapFactory);
  const source={width:1,height:1,getContext:()=>({getImageData:()=>({data:new Uint8ClampedArray([12,34,56,255])})})} as unknown as HTMLCanvasElement;
  const raw=(id:number,time=id)=>reply({id,raw:{width:1,height:1,time,pixels:new Uint8ClampedArray([id,34,56,255])}});
  return {encoder,source,worker,messages,reports,reply,raw,drawn,canvas};
}
const tick=async()=>{for(let i=0;i<12;i++)await Promise.resolve();};

test('raw recovery pulls one exact frame at a time, retaining timestamps and releasing storage', async t=>{
  const s=setup(t);
  for(let i=1;i<=2;i++){s.encoder.submit(s.source,i*0.25,i*250);s.reply({id:i,stored:true});}
  const frames=s.encoder.frames(new AbortController().signal);
  const first=frames.next();await tick();
  assert.deepEqual(s.messages.slice(2),[{read:1}]);
  s.raw(1,.25);assert.equal((await first).value?.time,.25);
  await tick();assert.equal(s.messages.length,3,'no prefetch or PNG backlog while consumer works');
  const second=frames.next();await tick();s.raw(2,.5);assert.equal((await second).value?.percent,100);
  assert.deepEqual(s.drawn,[[1,34,56,255],[2,34,56,255]]);
  assert.equal((await frames.next()).done,true);await s.encoder.finish();
  assert.deepEqual(s.messages.slice(2),[{read:1},{read:2},{discard:true}]);
  assert.equal(s.worker.terminated,true);assert.equal(s.canvas.width,0);assert.deepEqual(s.reports,[]);
});
test('early exit disposes remaining raw frames without converting them',async t=>{
  const s=setup(t);s.encoder.submit(s.source,1,1);s.reply({id:1,stored:true});
  const frames=s.encoder.frames(new AbortController().signal),first=frames.next();await tick();s.raw(1);await first;
  await frames.return();assert.equal(s.worker.terminated,true);assert.deepEqual(s.messages.at(-1),{discard:true});
});
test('abort interrupts an outstanding raw read and cleans storage',async t=>{
  const s=setup(t),controller=new AbortController();s.encoder.submit(s.source,1,1);s.reply({id:1,stored:true});
  const frames=s.encoder.frames(controller.signal),first=frames.next();const rejected=assert.rejects(first,{name:'AbortError'});
  await tick();controller.abort();await rejected;
  assert.equal(s.worker.terminated,true);assert.equal(s.canvas.width,0);assert.deepEqual(s.reports,[]);
});
test('wrong frame order fails instead of silently certifying missing observations',async t=>{
  const s=setup(t);s.encoder.submit(s.source,1,1);s.reply({id:1,stored:true});
  const first=s.encoder.frames(new AbortController().signal).next(),rejected=assert.rejects(first,/순서/);
  await tick();s.raw(2);await rejected;assert.equal(s.worker.terminated,true);assert.equal(s.reports.length,1);
});
test('raw recovery cannot replace an explicit PNG export',async t=>{
  const s=setup(t),finish=s.encoder.finish();
  await assert.rejects(s.encoder.frames(new AbortController().signal).next(),/한 번/);
  s.reply({done:true});await finish;assert.deepEqual(s.messages,[{finish:true}]);
});

test('abort during bitmap transfer unblocks recovery and closes the late bitmap',async t=>{
  let release!: (bitmap:ImageBitmap)=>void, closed=0;
  const s=setup(t,()=>new Promise(resolve=>{release=resolve;})),controller=new AbortController();
  s.encoder.submit(s.source,1,1);
  const next=s.encoder.frames(controller.signal).next();
  const rejected=assert.rejects(next,{name:'AbortError'});
  await tick();controller.abort();await rejected;
  release({close(){closed++;}} as ImageBitmap);await tick();
  assert.equal(closed,1);assert.equal(s.worker.terminated,true);
  assert.deepEqual(s.messages,[{discard:true}]);assert.deepEqual(s.reports,[]);
});

test('incomplete raw pixel buffers fail without yielding a corrupted source image',async t=>{
  const s=setup(t);s.encoder.submit(s.source,1,1);s.reply({id:1,stored:true});
  const next=s.encoder.frames(new AbortController().signal).next(),rejected=assert.rejects(next,/크기/);
  await tick();s.reply({id:1,raw:{width:2,height:1,time:1,pixels:new Uint8ClampedArray(4)}});await rejected;
  assert.deepEqual(s.drawn,[]);assert.equal(s.worker.terminated,true);assert.equal(s.reports.length,1);
});
