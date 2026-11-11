import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createVisualBatchClient} from '../src/features/card-scanner/recognition/visual-batch';

class FakeWorker {
  static all:FakeWorker[]=[];
  onmessage:((event:{data:unknown})=>void)|null=null;onerror:(()=>void)|null=null;
  sent:{id:number;bitmaps?:{tag:string}[]}[]=[];terminated=false;
  constructor(){FakeWorker.all.push(this);}
  postMessage(message:{id:number;bitmaps?:{tag:string}[]}){this.sent.push(message);}
  terminate(){this.terminated=true;}
  /** Answer the newest message the way the worker does: one result per bitmap, in order. */
  answer(result:(tag:string)=>unknown=tag=>({identity:{id:tag},fields:{},values:null})){
    const message=this.sent.at(-1)!;
    this.onmessage!({data:{id:message.id,results:(message.bitmaps??[]).map(bitmap=>result(bitmap.tag))}});
  }
}

async function withFakes(run:(closed:string[])=>Promise<void>) {
  const names=['Worker','OffscreenCanvas','createImageBitmap'];
  const previous=Object.fromEntries(names.map(name=>[name,Object.getOwnPropertyDescriptor(globalThis,name)]));
  const set=(name:string,value:unknown)=>Object.defineProperty(globalThis,name,{value,writable:true,configurable:true});
  const closed:string[]=[];
  FakeWorker.all=[];
  try{
    set('Worker',FakeWorker);set('OffscreenCanvas',class{});
    set('createImageBitmap',async(image:{tag:string;broken?:boolean})=>{
      if(image.broken)throw Error('released canvas');
      return {tag:image.tag,close(){closed.push(image.tag);}};
    });
    await run(closed);
  }finally{
    for(const [name,descriptor] of Object.entries(previous))if(descriptor)Object.defineProperty(globalThis,name,descriptor);else Reflect.deleteProperty(globalThis,name);
  }
}
const crops=(...tags:string[])=>tags.map(tag=>({tag})) as unknown as HTMLCanvasElement[];
const tick=()=>new Promise(resolve=>setTimeout(resolve,0));

test('a frame is one message per worker and each crop gets its own result, in the order given', () => withFakes(async()=>{
  const client=createVisualBatchClient(new AbortController().signal,{workers:2})!;
  const reads=client.read(crops('a','b','c','d','e'))!;
  assert.equal(reads.length,5);
  await tick();
  const [first,second]=FakeWorker.all;
  assert.deepEqual(first.sent.map(message=>message.bitmaps!.map(bitmap=>bitmap.tag)),[['a','c','e']]);
  assert.deepEqual(second.sent.map(message=>message.bitmaps!.map(bitmap=>bitmap.tag)),[['b','d']]);
  second.answer();first.answer();
  assert.deepEqual((await Promise.all(reads)).map(result=>result?.identity?.id),['a','b','c','d','e']);
  assert.deepEqual(client.stats().resolved,5);
  client.dispose();
}));

test('a batch is refused whole while too many crops wait, and taken again once they return', () => withFakes(async()=>{
  const client=createVisualBatchClient(new AbortController().signal,{workers:1,maxOutstanding:3})!;
  const reads=client.read(crops('a','b'))!;
  assert.equal(client.read(crops('c','d')),null);
  await tick();
  assert.equal(FakeWorker.all[0].sent.length,1);            // the refused crops were never sent
  FakeWorker.all[0].answer();await Promise.all(reads);
  assert.notEqual(client.read(crops('c','d')),null);
  assert.deepEqual({crops:client.stats().crops,declined:client.stats().declinedCrops},{crops:4,declined:2});
  client.dispose();
}));

test('no result is ever a rejection: an unread crop, a worker error and a stop all give null', () => withFakes(async()=>{
  const control=new AbortController();
  const client=createVisualBatchClient(control.signal,{workers:2})!;
  // One crop of a share could not be read by the worker; the others keep their results.
  const partial=client.read(crops('a','b','c','d'))!;await tick();
  FakeWorker.all[0].answer(tag=>tag==='c'?null:{identity:{id:tag},fields:{},values:null});FakeWorker.all[1].answer();
  assert.deepEqual((await Promise.all(partial)).map(result=>result?.identity?.id??null),['a','b',null,'d']);
  // The worker reports an error for the message, then one worker fails outright and is replaced.
  const errored=client.read(crops('e','f'))!;await tick();
  const [first,second]=FakeWorker.all;
  first.onmessage!({data:{id:first.sent.at(-1)!.id,error:'boom'}});second.onerror!();
  assert.deepEqual(await Promise.all(errored),[null,null]);
  assert.equal(second.terminated,true);assert.equal(FakeWorker.all.length,3);
  // Stopping resolves what is still waiting and takes nothing afterwards.
  const stopped=client.read(crops('g','h'))!;await tick();
  control.abort();
  assert.deepEqual(await Promise.all(stopped),[null,null]);
  assert.equal(client.read(crops('i')),null);
  assert.equal(client.stats().failed,5);
}));

test('a canvas that cannot be copied makes its worker share fall back and closes the copies made', () => withFakes(async closed=>{
  const client=createVisualBatchClient(new AbortController().signal,{workers:2})!;
  const images=[{tag:'a'},{tag:'b'},{tag:'c',broken:true},{tag:'d'}] as unknown as HTMLCanvasElement[];
  const reads=client.read(images)!;await tick();
  assert.equal(FakeWorker.all[0].sent.length,0);            // a + broken c: not sent
  assert.deepEqual(closed,['a']);
  FakeWorker.all[1].answer();
  assert.deepEqual((await Promise.all(reads)).map(result=>result?.identity?.id??null),[null,'b',null,'d']);
  client.dispose();
}));
