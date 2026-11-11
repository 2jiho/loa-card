import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createNameReader} from '../src/features/card-scanner/recognition/name-reader';
import {createNeuralReader} from '../src/features/card-scanner/recognition/neural-reader';
import {CardReadBudget,CardReadTimeout} from '../src/features/card-scanner/recognition/card-read-budget';

function withWorker<T>(worker:unknown,run:()=>T):T{
 const previous=Object.getOwnPropertyDescriptor(globalThis,'Worker');
 Object.defineProperty(globalThis,'Worker',{configurable:true,writable:true,value:worker});
 try{return run();}finally{if(previous)Object.defineProperty(globalThis,'Worker',previous);else Reflect.deleteProperty(globalThis,'Worker');}
}
async function withWorkerAsync<T>(worker:unknown,run:()=>Promise<T>):Promise<T>{
 const previous=Object.getOwnPropertyDescriptor(globalThis,'Worker');
 Object.defineProperty(globalThis,'Worker',{configurable:true,writable:true,value:worker});
 try{return await run();}finally{if(previous)Object.defineProperty(globalThis,'Worker',previous);else Reflect.deleteProperty(globalThis,'Worker');}
}
test('second neural worker creation failure disposes the first and preserves the original error',()=>{
 const original=Error('second worker failed');let created=0,terminated=0;
 class WorkerStub {onerror=null;onmessage=null;constructor(){if(++created===2)throw original;}terminate(){terminated++;}postMessage(){}}
 withWorker(WorkerStub,()=>assert.throws(()=>createNameReader([]),error=>error===original));
 assert.equal(created,2);assert.equal(terminated,1);
});
test('a first worker disposal failure is reported without masking the second creation error',()=>{
 const original=Error('second worker failed'),cleanup=Error('first termination failed');let created=0,reported:unknown;
 class WorkerStub {onerror=null;onmessage=null;constructor(){if(++created===2)throw original;}terminate(){throw cleanup;}postMessage(){}}
 withWorker(WorkerStub,()=>assert.throws(()=>createNameReader([],undefined,undefined,{onInitializationCleanupError:error=>{reported=error;}}),error=>error===original));
 assert.equal(reported,cleanup);
});
test('partially initialized second worker is disposed and cleanup failure is reported',()=>{
 const original=Error('handler assignment failed'),cleanup=Error('second termination failed');let created=0,firstTerminated=0,reported:unknown;
 class WorkerStub {
  id=++created;onmessage=null;
  set onerror(_value:unknown){if(this.id===2)throw original;}
  terminate(){if(this.id===2)throw cleanup;firstTerminated++;}
  postMessage(){}
 }
 withWorker(WorkerStub,()=>assert.throws(()=>createNameReader([],undefined,undefined,{onInitializationCleanupError:error=>{reported=error;}}),error=>error===original));
 assert.equal(created,2);assert.equal(firstTerminated,1);assert.equal(reported,cleanup);
});
test('reader rejects pending calls even if worker termination fails',async()=>{
 const cleanup=Error('termination failed');
 class WorkerStub {onerror=null;onmessage=null;terminate(){throw cleanup;}postMessage(){}}
 let reader!:ReturnType<typeof createNeuralReader>;withWorker(WorkerStub,()=>{reader=createNeuralReader();});
 const pending=reader.ready();assert.throws(()=>reader.dispose(),error=>error===cleanup);await assert.rejects(pending,/OCR 종료/);
});
test('worker error settles pending ready and reports termination failure separately',async()=>{
 const cleanup=Error('termination failed');let instance!:WorkerStub,reported:unknown;
 class WorkerStub {
  onerror:((event:{message:string})=>void)|null=null;onmessage=null;
  constructor(){instance=this;}terminate(){throw cleanup;}postMessage(){}
 }
 let reader!:ReturnType<typeof createNeuralReader>;
 withWorker(WorkerStub,()=>{reader=createNeuralReader('korean',undefined,undefined,error=>{reported=error;});});
 const pending=reader.ready();instance.onerror!({message:'engine error'});
 await assert.rejects(pending,/engine error/);assert.equal(reported,cleanup);
 await assert.rejects(reader.ready(),/engine error/);
});
test('ready timeout settles pending request even when native termination throws',async(t)=>{
 t.mock.timers.enable({apis:['setTimeout']});
 const cleanup=Error('termination failed');let reported:unknown;
 class WorkerStub {onerror=null;onmessage=null;terminate(){throw cleanup;}postMessage(){}}
 let reader!:ReturnType<typeof createNeuralReader>;
 withWorker(WorkerStub,()=>{reader=createNeuralReader('korean',undefined,undefined,error=>{reported=error;});});
 const pending=reader.ready(),rejected=assert.rejects(pending,/준비 시간이 초과/);
 t.mock.timers.tick(120000);await rejected;assert.equal(reported,cleanup);
});
test('budget restart failure settles pending OCR and records cleanup uncertainty',async()=>{
 const cleanup=Error('restart termination failed');let reported:unknown;
 class WorkerStub {
  onerror:((event:unknown)=>void)|null=null;onmessage:((event:{data:unknown})=>void)|null=null;
  terminate(){throw cleanup;}
  postMessage(message:{id:number;type:string}){if(message.type==='ready')queueMicrotask(()=>this.onmessage?.({data:{id:message.id,result:null}}));}
 }
 let reader!:ReturnType<typeof createNeuralReader>;
 withWorker(WorkerStub,()=>{reader=createNeuralReader('korean',undefined,undefined,error=>{reported=error;});});
 const canvas={width:1,height:1,getContext:()=>({getImageData:()=>({data:new Uint8ClampedArray([0,0,0,255])})})} as unknown as HTMLCanvasElement;
 const budget=new CardReadBudget(15,()=>performance.now(),true);
 await assert.rejects(reader.recognize(canvas,false,undefined,budget),CardReadTimeout);
 assert.equal(reported,cleanup);assert.equal(await budget.waitForQuiescence(100),false);
});
test('a late error from the retired worker cannot terminate the replacement',async()=>{
 const workers:WorkerStub[]=[];
 class WorkerStub {
  onerror:((event:{message:string})=>void)|null=null;onmessage:((event:{data:unknown})=>void)|null=null;terminations=0;
  constructor(){workers.push(this);}terminate(){this.terminations++;}
  postMessage(message:{id:number;type:string}){if(message.type==='ready')queueMicrotask(()=>this.onmessage?.({data:{id:message.id,result:null}}));}
 }
 const previous=Object.getOwnPropertyDescriptor(globalThis,'Worker');
 Object.defineProperty(globalThis,'Worker',{configurable:true,writable:true,value:WorkerStub});
 try{
  const reader=createNeuralReader(),oldError=workers[0].onerror!;
  const canvas={width:1,height:1,getContext:()=>({getImageData:()=>({data:new Uint8ClampedArray([0,0,0,255])})})} as unknown as HTMLCanvasElement;
  await assert.rejects(reader.recognize(canvas,false,undefined,new CardReadBudget(15)),CardReadTimeout);
  assert.equal(workers.length,2);assert.equal(workers[0].terminations,1);
  oldError({message:'late old error'});assert.equal(workers[1].terminations,0);
  await reader.ready();reader.dispose();assert.equal(workers[1].terminations,1);
 }finally{if(previous)Object.defineProperty(globalThis,'Worker',previous);else Reflect.deleteProperty(globalThis,'Worker');}
});
async function syncFailureDoesNotStopLaterRead(t:import('node:test').TestContext,kind:'image'|'post'){
 t.mock.timers.enable({apis:['setTimeout']});
 const original=Error(`${kind} failed`);let worker!:WorkerStub,recognitions=0,lastId=0;
 class WorkerStub {
  onerror:((event:{message:string})=>void)|null=null;onmessage:((event:{data:unknown})=>void)|null=null;terminations=0;
  constructor(){worker=this;}terminate(){this.terminations++;}
  postMessage(message:{id:number;type:string}){
   if(message.type==='ready')queueMicrotask(()=>this.onmessage?.({data:{id:message.id,result:null}}));
   else {recognitions++;if(kind==='post'&&recognitions===1)throw original;lastId=message.id;}
  }
 }
 await withWorkerAsync(WorkerStub,async()=>{
  const reader=createNeuralReader();await reader.ready();
  const good={width:1,height:1,getContext:()=>({getImageData:()=>({data:new Uint8ClampedArray([0,0,0,255])})})} as unknown as HTMLCanvasElement;
  const broken={width:1,height:1,getContext:()=>({getImageData:()=>{throw original;}})} as unknown as HTMLCanvasElement;
  await assert.rejects(reader.recognize(kind==='image'?broken:good),error=>error===original);
  t.mock.timers.tick(1000);const later=reader.recognize(good);void later.catch(()=>{});await Promise.resolve();await Promise.resolve();
  assert.ok(lastId>0,'second request reached the worker');t.mock.timers.tick(29000);
  assert.equal(worker.terminations,0,'failed request timer cannot stop the active worker');
  worker.onmessage!({data:{id:lastId,result:{text:'ok',confidence:1}}});assert.equal((await later).text,'ok');
  t.mock.timers.tick(1000);assert.equal(worker.terminations,0);reader.dispose();
 });
}
test('synchronous postMessage failure removes its pending entry and timer',async(t)=>syncFailureDoesNotStopLaterRead(t,'post'));
test('synchronous getImageData failure removes its pending entry and timer',async(t)=>syncFailureDoesNotStopLaterRead(t,'image'));
test('failed replacement worker creation does not reuse the terminated previous worker',async()=>{
 const creation=Error('replacement creation failed');let created=0,cleanupReported=false;
 class WorkerStub {
  onerror:((event:{message:string})=>void)|null=null;onmessage:((event:{data:unknown})=>void)|null=null;
  constructor(){if(++created===2)throw creation;}terminate(){}
  postMessage(message:{id:number;type:string}){if(message.type==='ready')queueMicrotask(()=>this.onmessage?.({data:{id:message.id,result:null}}));}
 }
 await withWorkerAsync(WorkerStub,async()=>{
  const reader=createNeuralReader('korean',undefined,undefined,()=>{cleanupReported=true;});
  const canvas={width:1,height:1,getContext:()=>({getImageData:()=>({data:new Uint8ClampedArray([0,0,0,255])})})} as unknown as HTMLCanvasElement;
  try{
   await assert.rejects(reader.recognize(canvas,false,undefined,new CardReadBudget(15)),CardReadTimeout);
   const result=await Promise.race([reader.ready().then(()=>({status:'resolved'}),error=>({status:'rejected',error})),
    new Promise<{status:string}>(resolve=>setTimeout(()=>resolve({status:'pending'}),40))]);
   assert.equal(result.status,'rejected');assert.equal((result as {error?:unknown}).error,creation);assert.equal(cleanupReported,false);
  }finally{reader.dispose();}
 });
});
