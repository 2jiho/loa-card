import {test} from 'node:test';import assert from 'node:assert/strict';
import {createVisualClient} from '../src/features/card-scanner/recognition/visual-client';

test('visual reader transfers one crop, returns evidence, and cancels pending work',async()=>{
 const previous=Object.fromEntries(['Worker','OffscreenCanvas','createImageBitmap','document'].map(k=>[k,Object.getOwnPropertyDescriptor(globalThis,k)]));
 let inputClosed=0;
 class FakeWorker{
  static current:FakeWorker;onmessage:((event:{data:unknown})=>void)|null=null;onerror:unknown;sent:any;terminated=false;
  constructor(){FakeWorker.current=this;}
  postMessage(message:unknown){this.sent=message;}
  terminate(){this.terminated=true;}
 }
 const set=(k:string,value:unknown)=>Object.defineProperty(globalThis,k,{value,writable:true,configurable:true});
 try{
  set('Worker',FakeWorker);set('OffscreenCanvas',class{});
  set('createImageBitmap',async()=>({width:100,height:100,close(){inputClosed++;}}));
  set('document',{createElement:()=>({width:0,height:0,getContext:()=>({drawImage(){}})})});
  const control=new AbortController(),client=createVisualClient(control.signal)!,worker=FakeWorker.current;
  const pending=client.read({} as HTMLCanvasElement);await Promise.resolve();
  assert.equal(worker.sent.id,1);
  worker.onmessage!({data:{id:1,result:{identity:{id:'test'},fields:{awakening:3},values:{extraCopies:2}}}});
  const result=await pending;assert.equal(result.identity?.id,'test');assert.equal(result.values?.extraCopies,2);
  const canceled=client.read({} as HTMLCanvasElement);await Promise.resolve();
  const rejected=assert.rejects(canceled,{name:'AbortError'});control.abort();await rejected;
  assert.equal(worker.terminated,true);
  assert.equal(inputClosed,0); // transferred ownership belongs to the Worker
  client.dispose();
 }finally{for(const [k,descriptor] of Object.entries(previous))if(descriptor)Object.defineProperty(globalThis,k,descriptor);else Reflect.deleteProperty(globalThis,k);}
});
test('abort while freezing closes the untransferred bitmap',async()=>{
 const previous=Object.fromEntries(['Worker','OffscreenCanvas','createImageBitmap'].map(k=>[k,Object.getOwnPropertyDescriptor(globalThis,k)]));
 let finish!:(bitmap:unknown)=>void,closed=0;
 try{
  Object.defineProperty(globalThis,'Worker',{value:class{terminate(){}},configurable:true});
  Object.defineProperty(globalThis,'OffscreenCanvas',{value:class{},configurable:true});
  Object.defineProperty(globalThis,'createImageBitmap',{value:()=>new Promise(resolve=>{finish=resolve;}),configurable:true});
  const control=new AbortController(),client=createVisualClient(control.signal)!;
  const pending=client.read({} as HTMLCanvasElement),rejected=assert.rejects(pending,{name:'AbortError'});
  control.abort();finish({close(){closed++;}});await rejected;assert.equal(closed,1);
 }finally{for(const [k,descriptor] of Object.entries(previous))if(descriptor)Object.defineProperty(globalThis,k,descriptor);else Reflect.deleteProperty(globalThis,k);}
});
test('visual client permits only one in-flight preparation or image read',async()=>{
 const previous=Object.fromEntries(['Worker','OffscreenCanvas','createImageBitmap'].map(k=>[k,Object.getOwnPropertyDescriptor(globalThis,k)]));
 let finish!:(bitmap:unknown)=>void;
 class FakeWorker {
  static current:FakeWorker;onmessage:((event:{data:any})=>void)|null=null;sent:any;
  constructor(){FakeWorker.current=this;}postMessage(message:unknown){this.sent=message;}terminate(){}
 }
 try{
  Object.defineProperty(globalThis,'Worker',{value:FakeWorker,configurable:true});
  Object.defineProperty(globalThis,'OffscreenCanvas',{value:class{},configurable:true});
  Object.defineProperty(globalThis,'createImageBitmap',{value:()=>new Promise(resolve=>{finish=resolve;}),configurable:true});
  const control=new AbortController(),client=createVisualClient(control.signal)!,worker=FakeWorker.current;
  const ready=client.ready();await assert.rejects(client.ready(),/동시 시각 판독 요청/);
  worker.onmessage!({data:{id:worker.sent.id,result:null}});await ready;
  const image=client.read({} as HTMLCanvasElement);
  await assert.rejects(client.read({} as HTMLCanvasElement),/동시 시각 판독 요청/);
  finish({width:10,height:10,close(){}});await Promise.resolve();
  await assert.rejects(client.ready(),/동시 시각 판독 요청/);
  worker.onmessage!({data:{id:worker.sent.id,result:{identity:null,fields:{},values:null}}});await image;
  client.dispose();
 }finally{for(const [k,descriptor] of Object.entries(previous))if(descriptor)Object.defineProperty(globalThis,k,descriptor);else Reflect.deleteProperty(globalThis,k);}
});
