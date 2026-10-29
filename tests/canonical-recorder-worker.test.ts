import test from 'node:test';
import assert from 'node:assert/strict';
import {exactPixels} from '../src/features/card-scanner/exact-recording-codec';

async function runWorker(syncEnabled:boolean,run:(h:any)=>Promise<void>){
 const previous=['self','navigator','OffscreenCanvas'].map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)] as const);
 let bytes=new Uint8Array(1024*1024),size=0,removed=0,closed=0;
 const reads:number[]=[],messages:any[]=[],sourceMessages:any[]=[];
 const view=(value:BufferSource)=>ArrayBuffer.isView(value)?new Uint8Array(value.buffer,value.byteOffset,value.byteLength):new Uint8Array(value);
 const write=(value:BufferSource,at:number)=>{const data=view(value);if(at+data.length>bytes.length){const copy=new Uint8Array((at+data.length)*2);copy.set(bytes);bytes=copy;}bytes.set(data,at);size=Math.max(size,at+data.length);return data.length;};
 const sync={write:(value:BufferSource,options:{at:number})=>write(value,options.at),
  read(value:BufferSource,{at}:{at:number}){const target=view(value);reads.push(target.length);target.set(bytes.subarray(at,at+target.length));return target.length;},flush(){},close(){closed++;}};
 const directory={async *keys(){},async removeEntry(){removed++;},async getFileHandle(){return {
  ...(syncEnabled?{async createSyncAccessHandle(){return sync;}}:{}),
  async createWritable(){return {async write(blob:Blob){write(await blob.arrayBuffer(),size);},async close(){closed++;},async abort(){closed++;}};},
  async getFile(){return new Blob([bytes.slice(0,size)]);},
 };}};
 const port={onmessage:null as any,start(){},postMessage(message:any){sourceMessages.push(message);}};
 const scope={onmessage:null as any,postMessage(message:any){messages.push(message);}};
 class Canvas {
  private pixels=new Uint8ClampedArray();
  constructor(public width:number,public height:number){}
  getContext(){return {drawImage:(bitmap:any)=>{this.pixels=new Uint8ClampedArray(bitmap.pixels);},getImageData:()=>({data:this.pixels.slice()})};}
 }
 Object.defineProperty(globalThis,'self',{configurable:true,value:scope});
 Object.defineProperty(globalThis,'navigator',{configurable:true,value:{storage:{async getDirectory(){return {async getDirectoryHandle(){return directory;}};}}}});
 Object.defineProperty(globalThis,'OffscreenCanvas',{configurable:true,value:Canvas});
 const until=async(predicate:()=>boolean)=>{const deadline=Date.now()+5000;while(!predicate()){if(Date.now()>deadline)throw Error('canonical Worker deadline');await new Promise<void>(resolve=>setImmediate(resolve));}};
 try{
  const address=new URL('../src/features/card-scanner/exact-recording-worker.ts',import.meta.url);address.searchParams.set('canonical-test',crypto.randomUUID());
  await import(address.href);
  const send=(data:any)=>scope.onmessage({data});
  await send({kind:'init',port});
  await run({send,source:(data:any)=>port.onmessage({data}),messages,sourceMessages,reads,until,
   stored:()=>bytes.slice(0,size),removed:()=>removed,closed:()=>closed,
   corrupt:(at:number)=>{bytes[at]^=1;},
  });
 }finally{
  for(const [key,value]of previous)if(value)Object.defineProperty(globalThis,key,value);else Reflect.deleteProperty(globalThis,key);
 }
}
function input(id:number){
 const pixels=Uint8Array.from({length:320*240*4},(_,i)=>(i*137+id*47+Math.floor(i/13))%256);
 const bitmap={width:320,height:240,pixels,closed:0,close(){this.closed++;}};
 return {pixels,bitmap,message:{kind:'frame',canonical:true,role:'backup',id,time:20-id,width:320,height:240,phase:'input',bitmap}};
}

test('canonical Worker reads committed key chains while recording and preserves its compression predecessor',async()=>{
 await runWorker(true,async(h:any)=>{
  assert.equal(h.messages[0].supportsSourceReads,true);
  const inputs=Array.from({length:11},(_,i)=>input(i+1));
  for(const item of inputs.slice(0,8))h.source(item.message);
  h.source({kind:'drain'});
  await h.until(()=>h.sourceMessages.some((m:any)=>m.kind==='drained'));
  assert.equal(h.sourceMessages.filter((m:any)=>m.kind==='stored').length,8,'drain joins all preceding source writes');
  await h.until(()=>h.sourceMessages.filter((m:any)=>m.kind==='stored').length===8);
  await h.send({kind:'read-frame',requestId:1,id:7});await h.until(()=>h.messages.some((m:any)=>m.kind==='read-frame'&&m.requestId===1));
  const first=h.messages.find((m:any)=>m.kind==='read-frame'&&m.requestId===1).raw;
  assert.deepEqual(new Uint8Array(first.pixels.buffer),inputs[6].pixels);assert.equal(first.time,13);
  const readsBefore=h.reads.length;
  for(const item of inputs.slice(8))h.source(item.message);
  await h.until(()=>h.sourceMessages.filter((m:any)=>m.kind==='stored').length===11);
  await h.send({kind:'read-frame',requestId:2,id:10});await h.until(()=>h.messages.some((m:any)=>m.kind==='read-frame'&&m.requestId===2));
  assert.deepEqual(new Uint8Array(h.messages.find((m:any)=>m.kind==='read-frame'&&m.requestId===2).raw.pixels.buffer),inputs[9].pixels);
  assert.equal(h.reads.length-readsBefore,6,'second independent key chain visits only frames9and10');
  await h.send({kind:'read-frame',requestId:3,id:8});await h.send({kind:'read-cancel',requestId:3});
  await h.until(()=>h.messages.some((m:any)=>m.kind==='read-error'&&m.requestId===3));
  assert.equal(h.messages.some((m:any)=>m.kind==='read-frame'&&m.requestId===3),false);
  await h.send({kind:'read-frame',requestId:4,id:999});await h.until(()=>h.messages.some((m:any)=>m.kind==='read-error'&&m.requestId===4));
  h.source({kind:'end'});await h.send({kind:'finish',noSource:false});await h.until(()=>h.messages.some((m:any)=>m.kind==='done'));
  const done=h.messages.find((m:any)=>m.kind==='done');assert.equal(done.stats.complete,true);assert.equal(done.stats.canonical,true);
  const decoded=[];for await(const frame of exactPixels(done.blob,new AbortController().signal))decoded.push({...frame,pixels:frame.pixels.slice()});
  assert.deepEqual(decoded.map(frame=>frame.key),[true,false,false,false,false,false,false,false,true,false,false]);
  for(const [i,frame]of decoded.entries())assert.deepEqual(frame.pixels,inputs[i].pixels);
  assert.equal(h.sourceMessages.filter((m:any)=>m.kind==='credit').length,11);
  for(const item of inputs)assert.equal(item.bitmap.closed,1);
  for(const [i,message]of h.sourceMessages.entries())if(message.kind==='stored')assert.equal(h.sourceMessages[i+1].kind,'credit');
  await h.send({kind:'dispose'});assert.equal(h.removed(),1);assert.equal(h.closed(),1);
 });
});

test('unsupported live files report capability and canonical source errors without leaking bitmaps',async()=>{
 await runWorker(false,async(h:any)=>{
  assert.equal(h.messages[0].supportsSourceReads,false);
  const item=input(1);h.source(item.message);
  await h.until(()=>h.sourceMessages.some((m:any)=>m.kind==='source-error'));
  assert.equal(item.bitmap.closed,1);assert.equal(h.sourceMessages.filter((m:any)=>m.kind==='credit').length,1);
  await h.send({kind:'read-frame',requestId:1,id:1});await h.until(()=>h.messages.some((m:any)=>m.kind==='read-error'));
  await h.send({kind:'dispose'});assert.equal(h.removed(),1);
 });
});
