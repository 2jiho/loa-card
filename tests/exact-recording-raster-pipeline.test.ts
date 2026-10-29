import test from 'node:test';
import assert from 'node:assert/strict';
import {exactEntries,exactPixels} from '../src/features/card-scanner/exact-recording-codec';

async function harness(run:(h:any)=>Promise<void>){
 const names=['self','navigator','OffscreenCanvas','Worker'],previous=names.map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)] as const);
 let bytes=new Uint8Array(1_048_576),length=0,removed=0,closed=0;
 const messages:any[]=[],sourceMessages:any[]=[],timeline:any[]=[];
 const view=(value:BufferSource)=>ArrayBuffer.isView(value)?new Uint8Array(value.buffer,value.byteOffset,value.byteLength):new Uint8Array(value);
 const sync={write(value:BufferSource,{at}:{at:number}){const data=view(value);bytes.set(data,at);length=Math.max(length,at+data.length);return data.length;},
  read(value:BufferSource,{at}:{at:number}){const data=view(value);data.set(bytes.subarray(at,at+data.length));return data.length;},flush(){},close(){closed++;}};
 const directory={async *keys(){},async removeEntry(){removed++;},async getFileHandle(){return {
  async createSyncAccessHandle(){return sync;},async getFile(){return new Blob([bytes.slice(0,length)]);},
 };}};
 const scope={onmessage:null as any,postMessage(value:any){messages.push(value);timeline.push(value);}};
 const port={onmessage:null as any,start(){},postMessage(value:any){sourceMessages.push(value);timeline.push(value);}};
 let child:Child;
 class Child{
  onmessage:any;onerror:any;onmessageerror:any;requests:any[]=[];terminated=0;owned=new Map<number,any>();
  constructor(){child=this;}
  postMessage(value:any,transfer?:Transferable[]){
   if(value.kind==='init')queueMicrotask(()=>this.onmessage?.({data:{kind:'ready'}}));
   if(value.kind==='raster'){assert.deepEqual(transfer,[value.bitmap]);this.requests.push(value);this.owned.set(value.id,value.bitmap);}
   if(value.kind==='dispose'){for(const bitmap of this.owned.values())bitmap.close();this.owned.clear();queueMicrotask(()=>this.onmessage?.({data:{kind:'disposed'}}));}
  }
  terminate(){this.terminated++;for(const bitmap of this.owned.values())bitmap.close();this.owned.clear();}
  respond(id:number,error?:string){
   const request=this.requests.find(value=>value.id===id),bitmap=this.owned.get(id);assert.ok(bitmap);bitmap.close();this.owned.delete(id);
   const pixels=bitmap.pixels.slice().buffer;
   this.onmessage?.({data:error?{kind:'raster-error',id,error}:{kind:'raster',id,width:request.width,height:request.height,pixels,readbackMs:2,queueMs:1}});
  }
 }
 Object.defineProperty(globalThis,'self',{configurable:true,value:scope});
 Object.defineProperty(globalThis,'Worker',{configurable:true,value:Child});
 Object.defineProperty(globalThis,'OffscreenCanvas',{configurable:true,value:class{getContext(){assert.fail('nested topology must not raster on parent');}}});
 Object.defineProperty(globalThis,'navigator',{configurable:true,value:{storage:{async getDirectory(){return {async getDirectoryHandle(){return directory;}};}}}});
 const until=async(predicate:()=>boolean)=>{const deadline=Date.now()+3000;while(!predicate()){if(Date.now()>deadline)throw Error('nested integration deadline');await new Promise<void>(resolve=>setImmediate(resolve));}};
 try{
  const address=new URL('../src/features/card-scanner/exact-recording-worker.ts',import.meta.url);address.searchParams.set('nested-test',crypto.randomUUID());
  await import(address.href);await scope.onmessage({data:{kind:'init',port}});
  await run({source:(data:any)=>port.onmessage({data}),send:(data:any)=>scope.onmessage({data}),child:child!,messages,sourceMessages,timeline,until,
   removed:()=>removed,closed:()=>closed});
 }finally{
  if(!messages.some(value=>value.kind==='disposed'))await scope.onmessage?.({data:{kind:'dispose'}});
  for(const [key,value]of previous)if(value)Object.defineProperty(globalThis,key,value);else Reflect.deleteProperty(globalThis,key);
 }
}
function input(id:number){
 const pixels=Uint8Array.from({length:32},(_,i)=>(i*37+id*59)%256),bitmap={width:4,height:2,pixels,closed:0,close(){this.closed++;}};
 return {pixels,bitmap,message:{kind:'frame',canonical:true,role:'input',id,time:20-id,width:4,height:2,phase:'input',bitmap}};
}
function thenCallsDuring(run:()=>void){
 const descriptor=Object.getOwnPropertyDescriptor(Promise.prototype,'then')!,original=Promise.prototype.then;let calls=0;
 Object.defineProperty(Promise.prototype,'then',{...descriptor,value:function(this:Promise<unknown>,...args:any[]){calls++;return Reflect.apply(original,this,args);}});
 try{run();}finally{Object.defineProperty(Promise.prototype,'then',descriptor);}
 return calls;
}

test('actual exact Worker starts raster jobs ahead of codec and preserves source order across out-of-order results',async()=>{
 await harness(async(h:any)=>{
  const frames=[input(1),input(2),input(3)];for(const frame of frames)h.source(frame.message);
  assert.equal(h.child.requests.length,3,'all raster jobs start without waiting for first codec slot');
  h.child.respond(3);h.child.respond(2);await new Promise<void>(resolve=>setImmediate(resolve));
  assert.equal(h.sourceMessages.some((value:any)=>value.kind==='stored'),false);
  h.child.respond(1);h.source({kind:'drain'});await h.until(()=>h.sourceMessages.some((value:any)=>value.kind==='drained'));
  assert.deepEqual(h.sourceMessages.filter((value:any)=>value.kind==='stored').map((value:any)=>value.id),[1,2,3]);
  assert.equal(h.sourceMessages.filter((value:any)=>value.kind==='credit').length,3);
  h.source({kind:'end'});await h.send({kind:'finish',noSource:false});await h.until(()=>h.messages.some((value:any)=>value.kind==='done'));
  const result=h.messages.find((value:any)=>value.kind==='done');assert.equal(result.stats.rasterEngine,'nested-worker');
  assert.equal(result.stats.raster.dispatched,3);assert.equal(result.stats.raster.pendingBytes,0);assert.equal(result.stats.complete,true);
  const decoded=[];for await(const frame of exactPixels(result.blob,new AbortController().signal))decoded.push({...frame,pixels:frame.pixels.slice()});
  assert.deepEqual(decoded.map(frame=>[frame.id,frame.time]),[[1,19],[2,18],[3,17]]);
  for(const [index,frame]of decoded.entries())assert.deepEqual(frame.pixels,frames[index].pixels);
  for(const frame of frames)assert.equal(frame.bitmap.closed,1);
 });
});

test('a failed earlier codec slot still joins and releases already-started future raster jobs before drain',async()=>{
 await harness(async(h:any)=>{
  const frames=[input(1),input(2),input(3)];for(const frame of frames)h.source(frame.message);
  h.child.respond(2);h.child.respond(1,'conversion failed');h.source({kind:'drain'});
  await h.until(()=>h.sourceMessages.filter((value:any)=>value.kind==='credit').length===2);
  assert.equal(h.sourceMessages.some((value:any)=>value.kind==='drained'),false,'drain cannot overtake the skipped but transferred job3');
  h.child.respond(3);await h.until(()=>h.sourceMessages.some((value:any)=>value.kind==='drained'));
  assert.equal(h.sourceMessages.filter((value:any)=>value.kind==='credit').length,3);
  assert.equal(h.sourceMessages.some((value:any)=>value.kind==='stored'),false);
  h.source({kind:'end'});await h.send({kind:'finish',noSource:false});await h.until(()=>h.messages.some((value:any)=>value.kind==='done'));
  const result=h.messages.find((value:any)=>value.kind==='done');assert.equal(result.stats.complete,false);assert.match(result.stats.error,/conversion failed/);
  assert.equal(result.stats.raster.pending,0);assert.equal(result.stats.raster.pendingBytes,0);
  for(const frame of frames)assert.equal(frame.bitmap.closed,1);
 });
});

test('parent disposal aborts a stalled nested raster before waiting for its codec chain',async()=>{
 await harness(async(h:any)=>{
  const frame=input(1);h.source(frame.message);assert.equal(h.child.requests.length,1);
  const started=performance.now(),first=h.send({kind:'dispose'}),repeated=[];
  for(let i=0;i<100;i++)repeated.push(h.send({kind:'dispose'}));
  await first;await Promise.all(repeated);
  assert.ok(performance.now()-started<1000,'dispose must not wait for the30second raster deadline');
  assert.equal(h.messages.some((value:any)=>value.kind==='disposed'),true);assert.equal(h.messages.some((value:any)=>value.kind==='done'),false);
  assert.equal(h.sourceMessages.filter((value:any)=>value.kind==='credit').length,1);assert.equal(frame.bitmap.closed,1);
  assert.equal(h.closed(),1);assert.equal(h.removed(),1);assert.equal(h.child.terminated,1);
  assert.equal(h.messages.filter((value:any)=>value.kind==='disposed').length,1,'a repeated dispose burst owns one cleanup barrier');
 });
});

test('actual writer alternates event batches with frames and read barriers stop later work overtaking',async()=>{
 await harness(async(h:any)=>{
  const frames=[input(1),input(2),input(3),input(4)];for(const frame of frames.slice(0,3))h.source(frame.message);
  const event=(seq:number)=>({kind:'event',seq,time:seq,type:'configuration',value:{seq}});
  await h.send({kind:'events',events:[event(1)]});await h.send({kind:'events',events:[event(2)]});
  await h.send({kind:'read-frame',requestId:1,id:3});
  await h.send({kind:'events',events:[event(3)]});h.source(frames[3].message);
  h.child.respond(4);h.child.respond(3);h.child.respond(2);await new Promise<void>(resolve=>setImmediate(resolve));
  assert.equal(h.messages.some((value:any)=>value.kind==='events-written'),false,'no receipt ACK while the first append owner is held');
  h.child.respond(1);h.source({kind:'drain'});
  await h.until(()=>h.sourceMessages.some((value:any)=>value.kind==='drained'));
  const order=h.timeline.filter((value:any)=>['stored','events-written','read-frame','drained'].includes(value.kind));
  assert.deepEqual(order.map((value:any)=>value.kind==='stored'?`frame${value.id}`:value.kind),
   ['frame1','events-written','frame2','events-written','frame3','read-frame','events-written','frame4','drained']);
  assert.deepEqual(new Uint8Array(h.messages.find((value:any)=>value.kind==='read-frame').raw.pixels.buffer),frames[2].pixels);
  h.source({kind:'end'});await h.send({kind:'finish',noSource:false});await h.until(()=>h.messages.some((value:any)=>value.kind==='done'));
  const result=h.messages.find((value:any)=>value.kind==='done');assert.equal(result.stats.complete,true);assert.equal(result.stats.events,3);
  const entries=[];for await(const {header}of exactEntries(result.blob,new AbortController().signal))entries.push(header.kind==='frame'?`f${header.id}`:`e${header.seq}`);
  assert.deepEqual(entries,['f1','e1','f2','e2','f3','e3','f4']);
  const decoded=[];for await(const frame of exactPixels(result.blob,new AbortController().signal))decoded.push(frame.pixels.slice());
  assert.deepEqual(decoded,frames.map(frame=>frame.pixels));
  assert.equal(h.sourceMessages.filter((value:any)=>value.kind==='credit').length,4);
  for(const frame of frames)assert.equal(frame.bitmap.closed,1);
 });
});

test('event append failure has one error and no success ACK; partial finish still joins a late raster release',async()=>{
 await harness(async(h:any)=>{
  const frames=[input(1),input(2)];for(const frame of frames)h.source(frame.message);
  const circular:any={};circular.self=circular;
  await h.send({kind:'events',events:[{kind:'event',seq:1,time:1,type:'failure',value:circular}]});
  await h.send({kind:'events',events:[{kind:'event',seq:2,time:2,type:'skipped',value:{}}]});
  h.child.respond(1);h.source({kind:'drain'});
  await h.until(()=>h.messages.some((value:any)=>value.kind==='events-error'));
  assert.match(h.messages.find((value:any)=>value.kind==='events-error').error,/circular/i);
  assert.equal(h.messages.filter((value:any)=>value.kind==='events-error').length,1);
  assert.equal(h.messages.some((value:any)=>value.kind==='events-written'),false);
  assert.equal(h.sourceMessages.some((value:any)=>value.kind==='drained'),false);
  assert.equal(h.sourceMessages.filter((value:any)=>value.kind==='credit').length,1);
  h.source({kind:'end'});await h.send({kind:'finish',noSource:false});
  assert.equal(h.messages.some((value:any)=>value.kind==='done'),false);
  h.child.respond(2);await h.until(()=>h.messages.some((value:any)=>value.kind==='done'));
  const result=h.messages.find((value:any)=>value.kind==='done');
  assert.equal(result.stats.complete,false);assert.equal(result.stats.frames,1);assert.equal(result.stats.events,0);assert.match(result.stats.error,/circular/i);
  assert.equal(h.messages.filter((value:any)=>value.kind==='events-error').length,1);
  assert.equal(h.messages.some((value:any)=>value.kind==='events-written'),false);
  assert.equal(h.sourceMessages.filter((value:any)=>value.kind==='credit').length,2);assert.equal(result.stats.raster.pendingBytes,0);
  const decoded=[];for await(const frame of exactPixels(result.blob,new AbortController().signal))decoded.push(frame.pixels.slice());
  assert.deepEqual(decoded,[frames[0].pixels]);for(const frame of frames)assert.equal(frame.bitmap.closed,1);
 });
});

test('event lane overflow is bounded and preserves all admitted writes before the failure barrier',async()=>{
 await harness(async(h:any)=>{
  const frames=[input(1),input(2),input(3)];for(const frame of frames.slice(0,2))h.source(frame.message);
  for(let seq=1;seq<=5;seq++)await h.send({kind:'events',events:[{kind:'event',seq,time:seq,type:'configuration',value:{seq}}]});
  const rejectedThenCalls=thenCallsDuring(()=>{
   for(let seq=6;seq<=105;seq++)void h.send({kind:'events',events:[{kind:'event',seq,time:seq,type:'rejected',value:{seq}}]});
  });
  assert.equal(rejectedThenCalls,0,'later rejected batches create neither per-job handlers nor failure-barrier catch callbacks');
  assert.equal(h.messages.filter((value:any)=>value.kind==='events-error').length,1);
  assert.equal(h.messages.some((value:any)=>value.kind==='events-written'),false);
  h.source(frames[2].message);assert.equal(h.child.requests.length,2,'overflow closes admission without another transferred raster');
  assert.equal(frames[2].bitmap.closed,1);h.child.respond(2);h.child.respond(1);
  h.source({kind:'drain'});await h.until(()=>h.sourceMessages.some((value:any)=>value.kind==='drained'));
  assert.equal(h.messages.filter((value:any)=>value.kind==='events-written').length,4,'only the four admitted and appended batches receive ACKs');
  assert.deepEqual(h.sourceMessages.filter((value:any)=>value.kind==='stored').map((value:any)=>value.id),[1,2]);
  h.source({kind:'end'});await h.send({kind:'finish',noSource:false});await h.until(()=>h.messages.some((value:any)=>value.kind==='done'));
  const result=h.messages.find((value:any)=>value.kind==='done');assert.equal(result.stats.complete,false);assert.equal(result.stats.frames,2);assert.equal(result.stats.events,4);
  const entries=[];for await(const {header}of exactEntries(result.blob,new AbortController().signal))entries.push(header.kind==='frame'?`f${header.id}`:`e${header.seq}`);
  assert.deepEqual(entries,['f1','e1','f2','e2','e3','e4']);assert.equal(h.sourceMessages.filter((value:any)=>value.kind==='credit').length,3);
  for(const frame of frames)assert.equal(frame.bitmap.closed,1);
 });
});

test('canonical inputs arriving after an event failure receive the global failure and immediate credit once',async()=>{
 await harness(async(h:any)=>{
  const frames=[input(1),input(2),input(3)];h.source(frames[0].message);h.child.respond(1);
  await h.until(()=>h.sourceMessages.some((value:any)=>value.kind==='stored'));
  const circular:any={};circular.self=circular;
  await h.send({kind:'events',events:[{kind:'event',seq:1,time:1,type:'failure',value:circular}]});
  await h.until(()=>h.messages.some((value:any)=>value.kind==='events-error'));
  for(const frame of frames.slice(1))h.source(frame.message);
  assert.equal(h.child.requests.length,1);assert.equal(h.sourceMessages.filter((value:any)=>value.kind==='credit').length,3);
  assert.equal(h.sourceMessages.filter((value:any)=>value.kind==='source-error').length,1);
  assert.equal(h.sourceMessages.filter((value:any)=>value.kind==='stored').length,1);
  for(const frame of frames)assert.equal(frame.bitmap.closed,1);
  h.source({kind:'end'});await h.send({kind:'finish',noSource:false});await h.until(()=>h.messages.some((value:any)=>value.kind==='done'));
  const result=h.messages.find((value:any)=>value.kind==='done');assert.equal(result.stats.complete,false);assert.equal(result.stats.frames,1);
 });
});
