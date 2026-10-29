import test from 'node:test';
import assert from 'node:assert/strict';
import {exactPixels} from '../src/features/card-scanner/exact-recording-codec';

test('actual exact Worker appends identical journal bytes, bounded chunks and original input/recovery pixel hashes',async()=>{
 const oldSelf=Object.getOwnPropertyDescriptor(globalThis,'self'),oldNavigator=Object.getOwnPropertyDescriptor(globalThis,'navigator'),oldCanvas=Object.getOwnPropertyDescriptor(globalThis,'OffscreenCanvas');
 const sent:any[]=[],chunks:Blob[]=[],credits:number[]=[];let disposed=0,size=0,file=new Uint8Array(1_048_576);
 const sync={
  write(value:BufferSource,{at}:{at:number}){const bytes=ArrayBuffer.isView(value)?new Uint8Array(value.buffer,value.byteOffset,value.byteLength):new Uint8Array(value);
   if(at+bytes.length>file.length){const larger=new Uint8Array((at+bytes.length)*2);larger.set(file);file=larger;}file.set(bytes,at);size=Math.max(size,at+bytes.length);return bytes.length;},
  read(value:BufferSource,{at}:{at:number}){const target=ArrayBuffer.isView(value)?new Uint8Array(value.buffer,value.byteOffset,value.byteLength):new Uint8Array(value);target.set(file.subarray(at,at+target.length));return target.length;},
  flush(){},close(){},
 };
 const directory={async *keys(){},async removeEntry(){disposed++;},async getFileHandle(){return {async createSyncAccessHandle(){return sync;},async getFile(){return new Blob([file.slice(0,size)]);}};}};
 const port={onmessage:null as any,start(){},postMessage(value:any){if(value.kind==='credit')credits.push(value.bytes);}};
 const scope={onmessage:null as any,postMessage(value:any){
  sent.push(value);
  if(value.kind==='journal-chunk'){
   chunks.push(value.blob);assert.equal(value.sequence,chunks.length-1);assert.ok(value.blob.size<=256*1024);
   queueMicrotask(()=>void scope.onmessage({data:{kind:'journal-credit',sequence:value.sequence,bytes:value.blob.size}}));
  }
 }};
 class Canvas {
  private rgba=new Uint8ClampedArray();
  constructor(public width:number,public height:number){}
  getContext(){return {drawImage:(bitmap:any)=>{this.rgba=new Uint8ClampedArray(bitmap.rgba);},getImageData:()=>({data:this.rgba.slice()})};}
 }
 const until=async(predicate:()=>boolean)=>{const deadline=Date.now()+2000;while(!predicate()){if(Date.now()>deadline)throw Error('Worker test deadline');await new Promise<void>(resolve=>setImmediate(resolve));}};
 Object.defineProperty(globalThis,'self',{configurable:true,value:scope});
 Object.defineProperty(globalThis,'OffscreenCanvas',{configurable:true,value:Canvas});
 Object.defineProperty(globalThis,'navigator',{configurable:true,value:{storage:{async getDirectory(){return {async getDirectoryHandle(){return directory;}};}}}});
 try{
  await import('../src/features/card-scanner/exact-recording-worker');
  await scope.onmessage({data:{kind:'init',port}});assert.equal(sent[0].kind,'ready');
  await scope.onmessage({data:{kind:'journal-start'}});
  await scope.onmessage({data:{kind:'events',events:[{kind:'event',seq:1,time:0,type:'configuration',value:{source:'screen'}}]}});
  const first=Uint8Array.from({length:320*240*4},(_,index)=>(Math.imul(index,137)+Math.floor(index/13)*47)%256),second=first.slice();
  for(let index=0;index<second.length;index+=101)second[index]^=255;
  const firstBitmap={width:320,height:240,rgba:first,closed:0,close(){this.closed++;}},secondFrame={displayWidth:320,displayHeight:240,rgba:second,closed:0,close(){this.closed++;}};
  port.onmessage({data:{kind:'frame',id:1,time:1,width:320,height:240,phase:'input',bitmap:firstBitmap}});
  port.onmessage({data:{kind:'frame',id:2,time:.5,width:320,height:240,phase:'recovery',bitmap:secondFrame}});
  port.onmessage({data:{kind:'end',peakInFlightBytes:first.length+second.length}});
  await scope.onmessage({data:{kind:'finish',noSource:false}});
  await until(()=>sent.some(value=>value.kind==='done')&&sent.some(value=>value.kind==='journal-done'));
  const raw=sent.find(value=>value.kind==='done'),journal=new Blob(chunks);
  assert.equal(raw.stats.complete,true);assert.equal(raw.stats.frames,2);assert.equal(raw.stats.events,1);assert.equal(credits.length,2);
  assert.equal(firstBitmap.closed,1);assert.equal(secondFrame.closed,1);assert.ok(Number.isFinite(raw.stats.readbackMs));
  assert.deepEqual(new Uint8Array(await journal.arrayBuffer()),new Uint8Array(await raw.blob.arrayBuffer()));
  const decoded=[];for await(const frame of exactPixels(journal,new AbortController().signal))decoded.push({...frame,pixels:frame.pixels.slice()});
  assert.deepEqual(decoded.map(value=>[value.id,value.time,value.phase]),[[1,1,'input'],[2,.5,'recovery']]);
  assert.equal(Buffer.from(decoded[0].pixels).equals(Buffer.from(first)),true);assert.equal(Buffer.from(decoded[1].pixels).equals(Buffer.from(second)),true);
  const journalDone=sent.find(value=>value.kind==='journal-done');
  assert.ok(journalDone.stats.peakPendingBytes<=8*1024*1024);assert.deepEqual(journalDone.mirror,journalDone.stats);
  for(const message of sent.filter(value=>value.kind==='journal-chunk'||value.kind==='journal-done')){
   const mirror=message.mirror;
   assert.deepEqual(Object.keys(mirror).sort(),['acknowledgedBytes','availableBytes','chunks','complete','error','peakPendingBytes','pendingBytes','sentBytes']);
   for(const key of ['availableBytes','sentBytes','acknowledgedBytes','pendingBytes','peakPendingBytes','chunks'])assert.ok(Number.isSafeInteger(mirror[key])&&mirror[key]>=0);
   assert.equal(mirror.pendingBytes,mirror.sentBytes-mirror.acknowledgedBytes);assert.ok(mirror.sentBytes<=mirror.availableBytes);
   assert.ok(mirror.peakPendingBytes<=8*1024*1024);assert.equal(typeof mirror.complete,'boolean');assert.equal(mirror.error,'');
   if(message.kind==='journal-chunk'){assert.ok(mirror.pendingBytes>=message.blob.size);assert.equal(mirror.chunks,message.sequence+1);}
  }
  assert.equal(journalDone.mirror.complete,true);assert.equal(journalDone.mirror.pendingBytes,0);
  assert.equal(journalDone.mirror.availableBytes,journal.size);assert.equal(journalDone.mirror.acknowledgedBytes,journal.size);
  await scope.onmessage({data:{kind:'journal-start'}});
  const duplicate=sent.at(-1);assert.equal(duplicate.kind,'journal-error');assert.match(duplicate.error,/이미/);
  assert.deepEqual(duplicate.mirror,journalDone.mirror,'even protocol errors expose only the current bounded diagnostic snapshot');
  await scope.onmessage({data:{kind:'dispose'}});assert.equal(disposed,1);
 }finally{
  if(oldSelf)Object.defineProperty(globalThis,'self',oldSelf);else Reflect.deleteProperty(globalThis,'self');
  if(oldNavigator)Object.defineProperty(globalThis,'navigator',oldNavigator);else Reflect.deleteProperty(globalThis,'navigator');
  if(oldCanvas)Object.defineProperty(globalThis,'OffscreenCanvas',oldCanvas);else Reflect.deleteProperty(globalThis,'OffscreenCanvas');
 }
});
