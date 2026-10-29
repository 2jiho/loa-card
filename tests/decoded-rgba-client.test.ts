import test from 'node:test';
import assert from 'node:assert/strict';
import {decodedRgbaFrames,DecodedRgbaError,DECODED_RGBA_RECIPE} from '../src/features/card-scanner/decoded-rgba-client';
import type {DecodedRgbaMetadata,DecodedRgbaOptions,DecodedRgbaWorker} from '../src/features/card-scanner/decoded-rgba-client';

type Message={kind:string;id:number;[key:string]:unknown};
const source=new Blob(['encoded']),hash='a'.repeat(64);
const color={primaries:'bt709',transfer:'bt709',matrix:'bt709',fullRange:false};
const ticks=async()=>{for(let index=0;index<12;index++)await Promise.resolve();};
function frame(id:number,ordinal=1,time=(ordinal-1)*.04,duration=.04):Message {
 const decoded:DecodedRgbaMetadata={recipe:DECODED_RGBA_RECIPE,ordinal,pts:time,duration,trackId:1,decoderPreference:'no-preference',rgbaSha256:hash,
  geometry:{codedWidth:2,codedHeight:2,displayWidth:2,displayHeight:2,visibleRect:{x:0,y:0,width:2,height:2},rotation:0,flip:false,pixelAspectRatio:{num:1,den:1}},
  nativeFormat:'I420',nativeColorSpace:{...color},sampleColorSpace:{...color},nativeTimestampMicroseconds:Math.round(time*1e6),nativeDurationMicroseconds:duration?Math.round(duration*1e6):null,
  rgbaLayout:{format:'RGBA',colorSpace:'srgb',offset:0,stride:8,bytes:16}};
 return {kind:'frame',id,width:2,height:2,time,percent:ordinal*40,decoded,pixels:Uint8Array.from({length:16},(_,index)=>index+ordinal).buffer};
}
class FakeWorker {
 onmessage:((event:MessageEvent)=>void)|null=null;onerror:((event:ErrorEvent)=>void)|null=null;onmessageerror:((event:MessageEvent)=>void)|null=null;
 sent:Message[]=[];terminated=0;nextOrdinal=0;holdInit=false;holdNext=false;holdDispose=false;
 transform:((message:Message)=>Message)|undefined;
 postMessage(message:Message){
  this.sent.push(message);
  if(message.kind==='init'&&!this.holdInit)this.emit({kind:'ready',id:message.id,recipe:DECODED_RGBA_RECIPE,trackId:1,duration:.08,width:2,height:2,sourceBytes:(message.blob as Blob).size,decoderPreference:message.decoderPreference});
  if(message.kind==='next'&&!this.holdNext){
   const ordinal=++this.nextOrdinal;
   this.emit(ordinal<=2?this.transform?.(frame(message.id,ordinal,(ordinal-1)*.04,ordinal===2?0:.04))??frame(message.id,ordinal,(ordinal-1)*.04,ordinal===2?0:.04):{kind:'end',id:message.id,trackId:1,frames:2});
  }
  if(message.kind==='dispose'&&!this.holdDispose)this.emit({kind:'disposed',id:message.id});
 }
 emit(message:unknown){this.onmessage?.({data:message} as MessageEvent);}
 terminate(){this.terminated++;}
}
function platform(worker:FakeWorker){
 const paints:{pixels:number[];width:number;height:number;x:number;y:number}[]=[];
 const canvas={width:0,height:0,getContext:()=>({putImageData:(image:ImageData,x:number,y:number)=>paints.push({pixels:[...image.data],width:image.width,height:image.height,x,y})})};
 const options:DecodedRgbaOptions={workerFactory:()=>worker as unknown as DecodedRgbaWorker,canvasFactory:()=>canvas as unknown as HTMLCanvasElement,
  imageDataFactory:(data,width,height)=>({data,width,height}) as ImageData,initTimeoutMs:100,nextTimeoutMs:100,disposeTimeoutMs:20};
 return {canvas,paints,options};
}
const errorCode=(code:string)=>(error:unknown)=>error instanceof DecodedRgbaError&&error.code===code;

test('decoder pulls only after consumption, paints exact RGBA and keeps duration0 plus immutable metadata',async()=>{
 const worker=new FakeWorker(),view=platform(worker),iterator=decodedRgbaFrames(source,new AbortController().signal,view.options);
 const first=await iterator.next();assert.equal(first.done,false);assert.equal(first.value!.element,view.canvas);
 assert.equal(worker.sent.filter(message=>message.kind==='next').length,1);await ticks();
 assert.equal(worker.sent.filter(message=>message.kind==='next').length,1,'no eager next while the consumer holds a frame');
 assert.deepEqual(view.paints[0],{pixels:[1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16],width:2,height:2,x:0,y:0});
 assert.equal(first.value!.decoded.ordinal,1);assert.ok(Object.isFrozen(first.value!.decoded.geometry.visibleRect));
 const second=await iterator.next();assert.equal(second.value!.element,first.value!.element);assert.equal(second.value!.time,.04);
 assert.equal(second.value!.decoded.duration,0);assert.equal(second.value!.decoded.nativeDurationMicroseconds,null);
 assert.equal(first.value!.decoded.ordinal,1,'later samples cannot mutate previous provenance');
 const ended=await iterator.next();assert.equal(ended.done,true);assert.equal(worker.terminated,1);assert.equal(view.canvas.width,0);assert.equal(view.canvas.height,0);
 assert.deepEqual(worker.sent.map(message=>message.kind),['init','next','next','next','dispose']);
});

test('malformed pixels, geometry, times, recipe and sample identity are rejected before painting',async()=>{
 const changes:((reply:Message)=>void)[]=[
  reply=>{reply.pixels=new ArrayBuffer(15);},reply=>{reply.width=0;},reply=>{reply.width=99999;},reply=>{reply.time=-1;},reply=>{reply.percent=101;},
  reply=>{(reply.decoded as unknown as {ordinal:number}).ordinal=2;},
  reply=>{(reply.decoded as unknown as {recipe:string}).recipe='future';},
  reply=>{(reply.decoded as unknown as {trackId:number}).trackId=2;},
  reply=>{(reply.decoded as unknown as {pts:number}).pts=.1;},
  reply=>{(reply.decoded as unknown as {duration:number}).duration=NaN;},
  reply=>{(reply.decoded as unknown as {rgbaSha256:string}).rgbaSha256='A'.repeat(64);},
  reply=>{(reply.decoded as unknown as {geometry:{rotation:number}}).geometry.rotation=90;},
  reply=>{(reply.decoded as unknown as {rgbaLayout:{stride:number}}).rgbaLayout.stride=12;},
  reply=>{(reply.decoded as unknown as {geometry:{visibleRect:{x:number}}}).geometry.visibleRect.x=1;},
  reply=>{(reply.decoded as unknown as {geometry:{pixelAspectRatio:{num:number}}}).geometry.pixelAspectRatio.num=2;},
  reply=>{reply.id=99;},
 ];
 if(typeof SharedArrayBuffer!=='undefined')changes.push(reply=>{reply.pixels=new SharedArrayBuffer(16);});
 for(const change of changes){
  const worker=new FakeWorker(),view=platform(worker);worker.transform=reply=>{change(reply);return reply;};
  await assert.rejects(decodedRgbaFrames(source,new AbortController().signal,view.options).next(),errorCode('protocol'));
  assert.equal(view.paints.length,0);assert.equal(worker.terminated,1);
 }
});

test('duplicate old replies are ignored but new ordinals and PTS remain ordered',async()=>{
 const worker=new FakeWorker(),view=platform(worker),iterator=decodedRgbaFrames(source,new AbortController().signal,view.options);
 await iterator.next();worker.holdNext=true;const second=iterator.next();await ticks();
 const current=worker.sent.at(-1)!;assert.equal(current.kind,'next');worker.emit(frame(current.id-1,1));await ticks();assert.equal(view.paints.length,1);
 worker.emit(frame(current.id,2,0,0));const read=await second;assert.equal(read.value!.decoded.ordinal,2);assert.equal(read.value!.time,0,'equal PTS is valid');
 await iterator.return();assert.equal(worker.terminated,1);
 const backwards=new FakeWorker(),bad=platform(backwards),other=decodedRgbaFrames(source,new AbortController().signal,bad.options);
 backwards.transform=reply=>{if((reply.decoded as DecodedRgbaMetadata).ordinal===1){reply.time=.04;(reply.decoded as unknown as {pts:number}).pts=.04;}else{reply.time=.01;(reply.decoded as unknown as {pts:number}).pts=.01;}return reply;};
 await other.next();await assert.rejects(other.next(),errorCode('protocol'));assert.equal(bad.paints.length,1);
});

test('abort before creation and while init/next are pending yields no late frame',async()=>{
 const early=new AbortController();early.abort(new DOMException('early','AbortError'));let created=0;
 await assert.rejects(decodedRgbaFrames(source,early.signal,{workerFactory:()=>{created++;throw Error('not reached');}}).next(),{name:'AbortError'});assert.equal(created,0);
 for(const stage of ['init','next']){
  const worker=new FakeWorker(),view=platform(worker),abort=new AbortController();worker.holdInit=stage==='init';worker.holdNext=stage==='next';
  const iterator=decodedRgbaFrames(source,abort.signal,view.options),waiting=iterator.next();await ticks();
  assert.equal(worker.sent.at(-1)!.kind,stage);const late=worker.onmessage;
  abort.abort(new DOMException('cancelled','AbortError'));await assert.rejects(waiting,{name:'AbortError'});
  late?.({data:frame(2)} as MessageEvent);assert.equal(view.paints.length,0);assert.equal(worker.terminated,1);
 }
});

test('abort releases the worker while a consumer is paused at the borrowed canvas',async()=>{
 const worker=new FakeWorker(),view=platform(worker),abort=new AbortController(),iterator=decodedRgbaFrames(source,abort.signal,view.options);
 await iterator.next();abort.abort(new DOMException('held frame','AbortError'));await ticks();
 assert.equal(worker.terminated,1);assert.equal(worker.sent.filter(message=>message.kind==='next').length,1);
 await iterator.return();assert.equal(worker.terminated,1);assert.equal(view.canvas.width,0);
});

test('init/next/dispose deadlines terminate the worker and cancellation during dispose stays aborted',async()=>{
 for(const stage of ['init','next']){
  const worker=new FakeWorker(),view=platform(worker);worker.holdInit=stage==='init';worker.holdNext=stage==='next';
  await assert.rejects(decodedRgbaFrames(source,new AbortController().signal,{...view.options,initTimeoutMs:5,nextTimeoutMs:5}).next(),errorCode('timeout'));
  assert.equal(worker.terminated,1);
 }
 const worker=new FakeWorker(),view=platform(worker),abort=new AbortController(),iterator=decodedRgbaFrames(source,abort.signal,view.options);
 await iterator.next();await iterator.next();worker.holdDispose=true;
 const ended=iterator.next();await ticks();assert.equal(worker.sent.at(-1)!.kind,'dispose');abort.abort(new DOMException('during dispose','AbortError'));
 worker.emit({kind:'disposed',id:worker.sent.at(-1)!.id});await assert.rejects(ended,{name:'AbortError'});assert.equal(worker.terminated,1);
 const timeoutWorker=new FakeWorker(),timeoutView=platform(timeoutWorker),timeoutIterator=decodedRgbaFrames(source,new AbortController().signal,{...timeoutView.options,disposeTimeoutMs:5});
 await timeoutIterator.next();await timeoutIterator.next();timeoutWorker.holdDispose=true;
 await assert.rejects(timeoutIterator.next(),errorCode('cleanup'));assert.equal(timeoutWorker.terminated,1);
});

test('an idle worker failure is remembered and prevents another pixel request',async()=>{
 const worker=new FakeWorker(),view=platform(worker),iterator=decodedRgbaFrames(source,new AbortController().signal,view.options);
 await iterator.next();worker.onerror?.({message:'decoder stopped'} as ErrorEvent);
 await ticks();assert.equal(worker.terminated,1,'an idle failed worker is released even while the consumer holds its last canvas');
 await assert.rejects(iterator.next(),errorCode('runtime'));assert.equal(worker.sent.filter(message=>message.kind==='next').length,1);assert.equal(worker.terminated,1);
});

test('unsupported replies stay explicit and source/options errors never start a worker',async()=>{
 const worker=new FakeWorker(),view=platform(worker);worker.holdInit=true;
 const waiting=decodedRgbaFrames(source,new AbortController().signal,view.options).next();await ticks();
 worker.emit({kind:'error',id:1,code:'unsupported',error:'RGBA copyTo unsupported'});await assert.rejects(waiting,errorCode('unsupported'));assert.equal(worker.terminated,1);
 let calls=0;const factory=()=>{calls++;return worker as unknown as DecodedRgbaWorker;};
 await assert.rejects(decodedRgbaFrames(new Blob(),new AbortController().signal,{workerFactory:factory}).next(),errorCode('unsupported'));
 await assert.rejects(decodedRgbaFrames(source,new AbortController().signal,{workerFactory:factory,disposeTimeoutMs:2001}).next(),RangeError);assert.equal(calls,0);
});
