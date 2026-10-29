import test from 'node:test';
import assert from 'node:assert/strict';
import {createNativeYuvTransform,describeNativeYuvTransformFrame,NativeYuvTransformError} from '../dev/native-yuv-transform';
import type {NativeYuvTransformWorker,NativeYuvTransformMetadata} from '../dev/native-yuv-transform';
import {convertNativeYuvToRgba,nativeYuvDescriptorJson} from '../dev/native-yuv-recipe';
import {pixelHash} from '../src/features/card-scanner/exact-recording-codec';

class Frame {
 format='I420';codedWidth=2;codedHeight=2;displayWidth=2;displayHeight=2;rotation:number|undefined=0;flip:boolean|undefined=false;
 visibleRect={x:0,y:0,width:2,height:2};timestamp=0;duration:number|null=40_000;
 color:VideoColorSpaceInit={primaries:'bt709',transfer:'bt709',matrix:'bt709',fullRange:false};colorSpace={toJSON:()=>this.color};closed=0;
 close(){this.closed++;}
}
const asFrame=(frame:Frame)=>frame as unknown as VideoFrame;
const tick=()=>new Promise<void>(resolve=>setImmediate(resolve));
async function until(check:()=>boolean){for(let i=0;i<100&&!check();i++)await tick();assert.ok(check(),'fake Worker checkpoint did not arrive');}
class FakeWorker {
 onmessage:((event:{data:unknown})=>void)|null=null;onerror:((event:{message:string})=>void)|null=null;onmessageerror:(()=>void)|null=null;
 requests:Record<string,unknown>[]=[];transfers:Transferable[][]=[];terminated=0;ack=true;throwConvert=false;current:Frame|undefined;
 postMessage(value:Record<string,unknown>,transfer:Transferable[]=[]){
  if(value.kind==='convert'&&this.throwConvert)throw Error('transfer refused');
  this.requests.push(value);this.transfers.push(transfer);
  if(value.kind==='convert')this.current=value.frame as unknown as Frame;
  if(value.kind==='dispose'&&this.ack){if(this.current&&!this.current.closed)this.current.close();this.current=undefined;
   queueMicrotask(()=>this.emit({kind:'disposed',id:value.id,error:null}));}
 }
 terminate(){this.terminated++;if(this.current&&!this.current.closed)this.current.close();this.current=undefined;}
 emit(data:unknown){this.onmessage?.({data});}
 factory=()=>this as unknown as NativeYuvTransformWorker;
}
async function replyFor(frame:Frame,id:number,value=16){
 const {native,plan}=describeNativeYuvTransformFrame(frame),bytes=new Uint8Array([value,235,81,145,128,128]);
 const {rgba}=convertNativeYuvToRgba(native,bytes,plan.layout);
 const metadata:NativeYuvTransformMetadata={version:1,recipeId:plan.recipe.id,native,planes:plan.layout,nativeByteLength:6,rgbaByteLength:16,
  nativeSha256:await pixelHash(bytes),descriptorSha256:await pixelHash(new TextEncoder().encode(nativeYuvDescriptorJson(native,plan.layout))),
  generatedRgbaSha256:await pixelHash(rgba),frameClosed:true};
 return {kind:'frame',id,width:2,height:2,pixels:rgba.buffer,metadata};
}
async function sendFrame(worker:FakeWorker,frame:Frame,id:number,value=16){const reply=await replyFor(frame,id,value);frame.close();worker.current=undefined;worker.emit(reply);return reply;}

test('client transfers an owned frame, binds its descriptor and returns an exclusively owned RGBA result',async()=>{
 const worker=new FakeWorker(),client=createNativeYuvTransform({workerFactory:worker.factory}),frame=new Frame();
 const pending=client.transform(asFrame(frame),new AbortController().signal);
 assert.equal(frame.closed,0);assert.deepEqual(worker.transfers[0],[frame]);assert.equal(worker.requests[0].kind,'convert');
 const reply=await sendFrame(worker,frame,1),result=await pending;
 assert.equal(result.pixels.buffer,reply.pixels);assert.equal(result.metadata.generatedRgbaSha256,await pixelHash(result.pixels));
 assert.equal(Object.isFrozen(result.metadata),true);assert.equal(Object.isFrozen(result.metadata.native.colorSpace),true);
 assert.equal(frame.closed,1);assert.equal(client.cleanup,null);assert.equal(worker.terminated,0);
 const other=new Frame();other.timestamp=123;const second=client.transform(asFrame(other),new AbortController().signal);
 await sendFrame(worker,other,2,235);const next=await second;assert.notEqual(next.pixels.buffer,result.pixels.buffer);
 assert.equal(result.pixels[0],0);assert.equal(next.pixels[0],255);assert.equal(worker.requests.filter(value=>value.kind==='convert').length,2);
 await client.dispose();assert.equal(worker.terminated,1);assert.deepEqual(client.cleanup,{acknowledged:true,forced:false,workerTerminated:true,error:null});
});

test('pre-aborted, unsupported and busy calls consume their local frame without taking the active source',async()=>{
 const worker=new FakeWorker(),client=createNativeYuvTransform({workerFactory:worker.factory});
 const aborted=new AbortController();aborted.abort();const early=new Frame();
 await assert.rejects(client.transform(asFrame(early),aborted.signal),(error:NativeYuvTransformError)=>error.code==='cancelled');assert.equal(early.closed,1);assert.equal(worker.requests.length,0);
 const unsupported=new Frame();unsupported.rotation=undefined;
 await assert.rejects(client.transform(asFrame(unsupported),new AbortController().signal),(error:NativeYuvTransformError)=>error.code==='unsupported');assert.equal(unsupported.closed,1);assert.equal(worker.requests.length,0);
 const active=new Frame(),abort=new AbortController(),pending=client.transform(asFrame(active),abort.signal),rejected=new Frame();
 await assert.rejects(client.transform(asFrame(rejected),new AbortController().signal),(error:NativeYuvTransformError)=>error.code==='protocol');assert.equal(rejected.closed,1);assert.equal(active.closed,0);
 const stopped=assert.rejects(pending,(error:NativeYuvTransformError)=>error.code==='cancelled'&&error.cleanup?.workerTerminated===true);
 abort.abort();await stopped;assert.equal(active.closed,1);assert.equal(worker.terminated,1);
 const late=new Frame();await assert.rejects(client.transform(asFrame(late),new AbortController().signal));assert.equal(late.closed,1);await client.dispose();assert.equal(worker.terminated,1);
});

test('transfer failure closes the still-local source and terminates the Worker before rejecting',async()=>{
 const worker=new FakeWorker();worker.throwConvert=true;
 const client=createNativeYuvTransform({workerFactory:worker.factory}),frame=new Frame();
 await assert.rejects(client.transform(asFrame(frame),new AbortController().signal),(error:NativeYuvTransformError)=>error.code==='runtime'&&error.cleanup?.workerTerminated===true);
 assert.equal(frame.closed,1);assert.equal(worker.terminated,1);assert.equal(worker.requests[0].kind,'dispose');
});

test('deadline and abort use bounded forced termination when the Worker cannot acknowledge disposal',async()=>{
 for(const reason of ['timeout','abort'] as const){
  const worker=new FakeWorker();worker.ack=false;
  const client=createNativeYuvTransform({workerFactory:worker.factory,timeoutMs:reason==='timeout'?5:1000,disposeTimeoutMs:5}),frame=new Frame(),signal=new AbortController();
  const pending=client.transform(asFrame(frame),signal.signal),rejected=assert.rejects(pending,(error:NativeYuvTransformError)=>
   error.code===(reason==='timeout'?'timeout':'cancelled')&&error.cleanup?.forced===true&&error.cleanup?.workerTerminated===true);
  if(reason==='abort')signal.abort();await rejected;assert.equal(worker.terminated,1);assert.equal(frame.closed,1);
  assert.equal(client.cleanup?.acknowledged,false);assert.match(client.cleanup?.error??'',/timed out/);
  const late=worker.onmessage;late?.({data:{kind:'frame',id:1}});await client.dispose();assert.equal(worker.terminated,1);
 }
});

test('malformed buffers, metadata, descriptor hashes, extra fields and out-of-order IDs are protocol failures',async()=>{
 const changes:((reply:Awaited<ReturnType<typeof replyFor>>)=>void)[]=[
  reply=>{reply.id=2;},reply=>{reply.width=4;},reply=>{reply.pixels=new ArrayBuffer(15);},
  reply=>{reply.pixels=new ArrayBuffer(16,{maxByteLength:32});},
  reply=>{(reply.metadata as {recipeId:string}).recipeId='unknown';},
  reply=>{(reply.metadata as {descriptorSha256:string}).descriptorSha256='0'.repeat(64);},
  reply=>{(reply.metadata as {generatedRgbaSha256:string}).generatedRgbaSha256='not-sha';},
  reply=>{(reply.metadata as {native:Record<string,unknown>}).native={...reply.metadata.native,timestampMicroseconds:123};},
  reply=>{Object.assign(reply,{extra:true});},reply=>{Object.assign(reply.metadata,{captureTime:123});},
  reply=>{Object.assign(reply.metadata.native.colorSpace,{extra:'hidden'});},
 ];
 for(const change of changes){const worker=new FakeWorker(),client=createNativeYuvTransform({workerFactory:worker.factory}),frame=new Frame();
  const pending=client.transform(asFrame(frame),new AbortController().signal),rejected=assert.rejects(pending,(error:NativeYuvTransformError)=>error.code==='protocol');
  const reply=structuredClone(await replyFor(frame,1));change(reply);frame.close();worker.current=undefined;worker.emit(reply);await rejected;assert.equal(worker.terminated,1);}
});

test('error and unreadable Worker messages stop the request and preserve explicit failure codes',async()=>{
 for(const kind of ['unsupported','runtime','messageerror'] as const){
  const worker=new FakeWorker(),client=createNativeYuvTransform({workerFactory:worker.factory}),frame=new Frame();
  const pending=client.transform(asFrame(frame),new AbortController().signal),rejected=assert.rejects(pending,(error:NativeYuvTransformError)=>error.code===(kind==='messageerror'?'protocol':kind));
  if(kind==='unsupported'){frame.close();worker.current=undefined;worker.emit({kind:'error',id:1,code:'unsupported',error:'native format unsupported',frameClosed:true});}
  else if(kind==='runtime')worker.onerror?.({message:'Worker crashed'});else worker.onmessageerror?.();
  await rejected;assert.equal(worker.terminated,1);assert.equal(frame.closed,1);
 }
});

test('an abort while the client validates the descriptor cannot publish a late successful buffer',async()=>{
 const worker=new FakeWorker(),client=createNativeYuvTransform({workerFactory:worker.factory}),frame=new Frame(),signal=new AbortController();
 const reply=await replyFor(frame,1),expectedHash=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(nativeYuvDescriptorJson(reply.metadata.native,reply.metadata.planes)));
 const original=Object.getOwnPropertyDescriptor(globalThis,'crypto');let release!:(value:ArrayBuffer)=>void;
 const validating=new Promise<ArrayBuffer>(resolve=>{release=resolve;});let digestCalls=0;
 try{
  Object.defineProperty(globalThis,'crypto',{configurable:true,value:{subtle:{digest:()=>{digestCalls++;return validating;}}}});
  const pending=client.transform(asFrame(frame),signal.signal),rejected=assert.rejects(pending,(error:NativeYuvTransformError)=>error.code==='cancelled');
  frame.close();worker.current=undefined;worker.emit(reply);await until(()=>digestCalls===1);signal.abort();await rejected;
  assert.equal(worker.terminated,1);release(expectedHash);await tick();assert.equal(client.cleanup?.workerTerminated,true);
 }finally{release?.(expectedHash);if(original)Object.defineProperty(globalThis,'crypto',original);else Reflect.deleteProperty(globalThis,'crypto');await client.dispose();}
});

test('duplicate replies during descriptor validation and terminal late replies cannot complete a different request',async()=>{
 const worker=new FakeWorker(),client=createNativeYuvTransform({workerFactory:worker.factory}),frame=new Frame();
 const pending=client.transform(asFrame(frame),new AbortController().signal),rejected=assert.rejects(pending,(error:NativeYuvTransformError)=>error.code==='protocol');
 const reply=await replyFor(frame,1);frame.close();worker.current=undefined;
 worker.emit(reply);worker.emit(reply);await rejected;assert.equal(worker.terminated,1);
});

test('configuration bounds reject before creating a Worker or accepting a frame',()=>{
 let created=0;
 for(const option of [{timeoutMs:0},{timeoutMs:30_001},{disposeTimeoutMs:0},{disposeTimeoutMs:2001},{timeoutMs:NaN}])assert.throws(()=>createNativeYuvTransform({...option,workerFactory:()=>{created++;return new FakeWorker() as unknown as NativeYuvTransformWorker;}}),RangeError);
 assert.equal(created,0);
});
