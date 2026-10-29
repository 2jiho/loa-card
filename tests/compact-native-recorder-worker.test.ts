import test from 'node:test';
import assert from 'node:assert/strict';
import {exactEntries,exactPixels,pixelHash,executionSummary,entryParts} from '../src/features/card-scanner/exact-recording-codec';
import {prepareNativeStorage} from '../src/features/card-scanner/native-frame-storage';
import type {NativeYuvFrameMetadata} from '../src/features/card-scanner/native-yuv-recipe';
import {MessageChannel} from 'node:worker_threads';
import type {PreparedNativeAttestation} from '../src/features/card-scanner/prepared-native-attestation';

async function runWorker(storageVersion:unknown,run:(h:any)=>Promise<void>,attestation?:unknown){
 const previous=['self','navigator','OffscreenCanvas'].map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)] as const);
 let bytes=new Uint8Array(1024*1024),size=0,removed=0,closed=0,canvasDraws=0;
 const messages:any[]=[],sourceMessages:any[]=[],journal:Blob[]=[];
 const view=(value:BufferSource)=>ArrayBuffer.isView(value)?new Uint8Array(value.buffer,value.byteOffset,value.byteLength):new Uint8Array(value);
 const write=(value:BufferSource,at:number)=>{const data=view(value);if(at+data.length>bytes.length){const copy=new Uint8Array((at+data.length)*2);copy.set(bytes);bytes=copy;}
  bytes.set(data,at);size=Math.max(size,at+data.length);return data.length;};
 const sync={write:(value:BufferSource,options:{at:number})=>write(value,options.at),
  read(value:BufferSource,{at}:{at:number}){const target=view(value);target.set(bytes.subarray(at,at+target.length));return target.length;},flush(){},close(){closed++;}};
 const directory={async *keys(){},async removeEntry(){removed++;},async getFileHandle(){return {
  async createSyncAccessHandle(){return sync;},async getFile(){return new Blob([bytes.slice(0,size)]);},
 };}};
 const port={onmessage:null as any,start(){},postMessage(message:any){sourceMessages.push(message);}};
 const scope={onmessage:null as any,postMessage(message:any){messages.push(message);
  if(message.kind==='journal-chunk'){journal.push(message.blob);assert.equal(message.sequence,journal.length-1);
   queueMicrotask(()=>void scope.onmessage({data:{kind:'journal-credit',sequence:message.sequence,bytes:message.blob.size}}));}
 }};
 class Canvas {
  private pixels=new Uint8ClampedArray();
  constructor(public width:number,public height:number){}
  getContext(){return {drawImage:(bitmap:any)=>{canvasDraws++;this.pixels=new Uint8ClampedArray(bitmap.pixels);},getImageData:()=>({data:this.pixels.slice()})};}
 }
 Object.defineProperty(globalThis,'self',{configurable:true,value:scope});
 Object.defineProperty(globalThis,'navigator',{configurable:true,value:{storage:{async getDirectory(){return {async getDirectoryHandle(){return directory;}};}}}});
 Object.defineProperty(globalThis,'OffscreenCanvas',{configurable:true,value:Canvas});
 const until=async(predicate:()=>boolean)=>{const deadline=Date.now()+5000;while(!predicate()){if(Date.now()>deadline)throw Error('compact Worker deadline');await new Promise<void>(resolve=>setImmediate(resolve));}};
 try{
  const address=new URL('../src/features/card-scanner/exact-recording-worker.ts',import.meta.url);address.searchParams.set('compact-native-test',crypto.randomUUID());await import(address.href);
  const send=(data:any)=>scope.onmessage({data});await send({kind:'init',port,...(storageVersion===undefined?{}:{storageVersion}),
   ...(attestation?{attestation}:{})});
  await run({send,source:(data:any)=>port.onmessage({data}),messages,sourceMessages,journal,until,
   stored:()=>bytes.slice(0,size),removed:()=>removed,closed:()=>closed,canvasDraws:()=>canvasDraws});
 }finally{for(const [key,value]of previous)if(value)Object.defineProperty(globalThis,key,value);else Reflect.deleteProperty(globalThis,key);}
}
function metadata(format:'I420'|'NV12'='I420',matrix:'smpte170m'|'bt709'='smpte170m',width=16,height=16):NativeYuvFrameMetadata {
 return {format,codedWidth:width,codedHeight:height,displayWidth:width,displayHeight:height,
  visibleRect:{x:0,y:0,width,height},rotation:0,flip:false,colorSpace:{primaries:matrix,transfer:matrix,matrix,fullRange:false}};
}
async function nativeInput(id:number,descriptor=metadata()){
 const width=descriptor.codedWidth,height=descriptor.codedHeight,
  packed=Uint8Array.from({length:width*height*3/2},(_,index)=>(index*29+id*17)%256);
 const expected=await prepareNativeStorage(descriptor,packed);
 return {packed,expected:expected.pixels,credit:packed.length+width*height*4,
  message:{kind:'frame',canonical:true,role:'backup',id,time:20-id,width,height,phase:'input',native:{descriptor,pixels:packed}}};
}
const finish=async(h:any)=>{h.source({kind:'end'});await h.send({kind:'finish',noSource:false});await h.until(()=>h.messages.some((m:any)=>m.kind==='done'));return h.messages.find((m:any)=>m.kind==='done');};

async function attestedInput(id:number,sessionId='session',producerId='preparation'){
 const input=await nativeInput(id),prepared=await prepareNativeStorage(input.message.native.descriptor,input.packed),ticketId=crypto.randomUUID();
 const tuple:PreparedNativeAttestation={version:1,kind:'prepared-native-conversion',sessionId,producerId,requestId:id,sourceFrameId:id,
  captureTime:input.message.time,width:input.message.width,height:input.message.height,nativeByteLength:input.packed.byteLength,rgbaByteLength:input.expected.byteLength,
  descriptorSha256:prepared.storage.descriptorSha256,recipeId:prepared.storage.recipeId,recipeSha256:prepared.storage.recipeSha256,
  nativeSha256:prepared.storage.nativeSha256,generatedRgbaSha256:prepared.rgbaHash,ticketId};
 return {...input,tuple,message:{...input.message,native:{...input.message.native,ticketId}}};
}

test('actual writer consumes private native tickets once and independently restores stored pixels through both readers',async()=>{
 const channel=new MessageChannel();
 try{await runWorker(1,async(h:any)=>{
  const one=await attestedInput(1),two=await attestedInput(2);
  assert.deepEqual(h.messages[0].attestation,{version:1,sessionId:'session',producerId:'preparation'});
  channel.port1.postMessage(one.tuple);channel.port1.postMessage(two.tuple);
  h.source(one.message);h.source(two.message);h.source({kind:'drain'});
  await h.until(()=>h.sourceMessages.some((m:any)=>m.kind==='drained'));
  const emittedAcks=h.sourceMessages.filter((m:any)=>m.kind==='stored-attested');
  await h.send({kind:'events',events:[{kind:'event',seq:1,time:0,type:'canonical-storage-contract',
   value:{version:1,mode:'prepared-native-attestation-v1',sessionId:'session',producerId:'preparation'}},
   ...emittedAcks.map((ack:any,i:number)=>({kind:'event',seq:i+2,time:ack.time,type:'canonical-storage-attestation',value:ack.attestation}))]});
  const done=await finish(h);
  assert.equal(done.stats.complete,true);assert.equal(done.stats.frames,2);assert.equal(done.stats.nativeAttestedFrames,2);
  assert.equal(done.stats.nativeAttestationBudget,'native-owned-v1');
  assert.equal(done.stats.peakQueuedBytes,one.tuple.nativeByteLength+two.tuple.nativeByteLength);
  assert.deepEqual(h.sourceMessages.filter((m:any)=>m.kind==='credit').map((m:any)=>m.bytes),[one.tuple.nativeByteLength,two.tuple.nativeByteLength]);
  assert.equal(done.stats.raster.submitted,0);assert.equal(h.canvasDraws(),0);
  const acks=h.sourceMessages.filter((m:any)=>m.kind==='stored-attested');
  assert.deepEqual(acks.map((m:any)=>m.attestation),[one.tuple,two.tuple]);assert.equal(h.sourceMessages.some((m:any)=>m.kind==='stored'),false);
  assert.equal(one.packed.byteLength,0);assert.equal(two.packed.byteLength,0,'verifier consumes the old alias, writer must use returned bytes');
  const decoded=[];for await(const frame of exactPixels(done.blob,new AbortController().signal))decoded.push(frame);
  assert.deepEqual(decoded.map(frame=>frame.hash),[one.tuple.generatedRgbaSha256,two.tuple.generatedRgbaSha256]);
  assert.deepEqual(decoded[0].pixels,one.expected);assert.deepEqual(decoded[1].pixels,two.expected);
  const summary=await executionSummary(done.blob,new AbortController().signal,done.stats);
  assert.equal(summary.storageAttestationProof?.matches,true);assert.equal(summary.storageAttestationProof?.verified,2);
  assert.equal(summary.storageAttestationProof?.payloadIntegrityVerified,false,'metadata joins do not replace the independent readers above');
  const damaged:BlobPart[]=[];
  for await(const {header,payload}of exactEntries(done.blob,new AbortController().signal)){
   if(header.kind==='event'&&header.seq===3)continue;
   damaged.push(...entryParts(header,new Uint8Array(await payload.arrayBuffer())));
  }
  const damagedBlob=new Blob(damaged),damagedStats={...done.stats,events:2};
  await assert.rejects(executionSummary(damagedBlob,new AbortController().signal,damagedStats),/missing source attestations/);
  const partial=await executionSummary(damagedBlob,new AbortController().signal,{...damagedStats,complete:false});
  assert.equal(partial.storageAttestationProof?.complete,false);assert.equal(partial.storageAttestationProof?.matches,null);
  await h.send({kind:'read-frame',requestId:1,id:2});await h.until(()=>h.messages.some((m:any)=>m.kind==='read-frame'));
  assert.deepEqual(new Uint8Array(h.messages.find((m:any)=>m.kind==='read-frame').raw.pixels.buffer),two.expected);
  await h.send({kind:'dispose'});
 },{version:1,sessionId:'session',producerId:'preparation',port:channel.port2});}
 finally{channel.port1.close();channel.port2.close();}
});

test('attested writer permits explicit RGBA fallback without manufacturing a native ticket or attested ACK',async()=>{
 const channel=new MessageChannel();
 try{await runWorker(1,async(h:any)=>{
  const pixels=Uint8Array.from({length:16*16*4},(_,i)=>i%256);
  h.source({kind:'frame',canonical:true,role:'input',id:1,time:3,width:16,height:16,pixels:pixels.buffer});
  const done=await finish(h);assert.equal(done.stats.complete,true);assert.equal(done.stats.nativeAttestedFrames,0);
  assert.equal(done.stats.rgbaFrames,1);assert.equal(h.sourceMessages.filter((m:any)=>m.kind==='stored').length,1);
  assert.equal(h.sourceMessages.some((m:any)=>m.kind==='stored-attested'),false);await h.send({kind:'dispose'});
 },{version:1,sessionId:'session',producerId:'preparation',port:channel.port2});}
 finally{channel.port1.close();channel.port2.close();}
});

test('native ticket cannot opt an unconfigured writer into trusting a JSON tuple',async()=>{
 await runWorker(1,async(h:any)=>{
  const input=await attestedInput(1);h.source({...input.message,attestation:input.tuple});
  const done=await finish(h);assert.equal(done.stats.complete,false);assert.equal(done.stats.frames,0);
  assert.match(done.stats.error,/티켓/);assert.equal(h.sourceMessages.some((m:any)=>m.kind==='stored-attested'),false);await h.send({kind:'dispose'});
 });
});

for(const fault of ['missing-ticket','native-hash','capture-binding','replayed-ticket'] as const)test(`attested writer rejects ${fault} without a successful extra stored ACK`,async()=>{
 const channel=new MessageChannel();
 try{await runWorker(1,async(h:any)=>{
  const first=await attestedInput(1);let input:any=first;
  if(fault==='missing-ticket')input={...first,message:{...first.message,native:{descriptor:first.message.native.descriptor,pixels:first.packed}}};
  else if(fault==='native-hash')input.packed[0]^=1;
  else if(fault==='capture-binding')input.message.time++;
  else{
   channel.port1.postMessage(first.tuple);h.source(first.message);h.source({kind:'drain'});await h.until(()=>h.sourceMessages.some((m:any)=>m.kind==='drained'));
   input=await attestedInput(2);input.message.native.ticketId=first.tuple.ticketId;
  }
  if(fault!=='missing-ticket'&&fault!=='replayed-ticket')channel.port1.postMessage(first.tuple);
  h.source(input.message);const done=await finish(h);
  assert.equal(done.stats.complete,false);assert.equal(done.stats.frames,fault==='replayed-ticket'?1:0);
  assert.equal(h.sourceMessages.filter((m:any)=>m.kind==='stored-attested').length,fault==='replayed-ticket'?1:0);
  assert.match(done.stats.error,/티켓|hash mismatch|binding|already taken/);await h.send({kind:'dispose'});
 },{version:1,sessionId:'session',producerId:'preparation',port:channel.port2});}
 finally{channel.port1.close();channel.port2.close();}
});

test('dispose cancels a writer awaiting missing private authority; an ordinary JSON tuple cannot grant it',async()=>{
 const channel=new MessageChannel();
 try{await runWorker(1,async(h:any)=>{
  const input=await attestedInput(1);h.source({...input.message,attestation:input.tuple});
  await new Promise<void>(resolve=>setImmediate(resolve));
  assert.equal(h.sourceMessages.some((m:any)=>m.kind==='stored-attested'),false);
  await h.send({kind:'dispose'});
  assert.equal(h.messages.some((m:any)=>m.kind==='disposed'),true);
  assert.equal(h.sourceMessages.some((m:any)=>m.kind==='stored-attested'),false);
  assert.equal(h.sourceMessages.filter((m:any)=>m.kind==='credit').length,1);
 },{version:1,sessionId:'session',producerId:'preparation',port:channel.port2});}
 finally{channel.port1.close();channel.port2.close();}
});

test('compact actual Worker stores native bytes, explicit fallback and profile resets with identical open reads and journal',async()=>{
 await runWorker(1,async(h:any)=>{
  assert.equal(h.messages[0].storageVersion,1);assert.equal(h.messages[0].supportsSourceReads,true);
  await h.send({kind:'journal-start'});
  const one=await nativeInput(1),two=await nativeInput(2),four=await nativeInput(4),five=await nativeInput(5),
   six=await nativeInput(6,metadata('NV12')),seven=await nativeInput(7,metadata('NV12','bt709')),eight=await nativeInput(8,metadata('NV12','bt709',8,8));
  const rgba=Uint8Array.from({length:16*16*4},(_,index)=>(index*3)%256),bitmap={width:16,height:16,pixels:rgba,closed:0,close(){this.closed++;}};
  const fallback={kind:'frame',canonical:true,role:'input',id:3,time:17,width:16,height:16,phase:'recovery',bitmap};
  const inputs=[one,two,{expected:rgba,credit:rgba.length,message:fallback},four,five,six,seven,eight];
  for(const input of inputs)h.source(input.message);
  h.source({kind:'drain'});await h.until(()=>h.sourceMessages.some((m:any)=>m.kind==='drained'));
  assert.equal(h.sourceMessages.filter((m:any)=>m.kind==='stored').length,8);
  await h.send({kind:'read-frame',requestId:1,id:5});await h.until(()=>h.messages.some((m:any)=>m.kind==='read-frame'&&m.requestId===1));
  assert.deepEqual(new Uint8Array(h.messages.find((m:any)=>m.kind==='read-frame'&&m.requestId===1).raw.pixels.buffer),five.expected);
  await h.send({kind:'read-frame',requestId:2,id:2});await h.send({kind:'read-cancel',requestId:2});
  await h.until(()=>h.messages.some((m:any)=>m.kind==='read-error'&&m.requestId===2));
  assert.equal(h.messages.some((m:any)=>m.kind==='read-frame'&&m.requestId===2),false);
  const done=await finish(h);await h.until(()=>h.messages.some((m:any)=>m.kind==='journal-done'));
  assert.equal(done.stats.complete,true);assert.equal(done.stats.storageVersion,1);assert.equal(done.stats.canonical,true);
  assert.equal(done.stats.nativeFrames,7);assert.equal(done.stats.rgbaFrames,1);assert.equal(done.stats.frames,8);
  assert.equal(done.stats.raster.submitted,1,'native buffers bypass the Canvas raster queue');assert.equal(h.canvasDraws(),1);assert.equal(bitmap.closed,1);
  assert.deepEqual(h.sourceMessages.filter((m:any)=>m.kind==='credit').map((m:any)=>m.bytes),inputs.map(input=>input.credit));
  assert.equal(done.stats.peakQueuedBytes,inputs.reduce((sum,input)=>sum+input.credit,0),'native plus generated RGBA reservations are counted');
  const raw=new Uint8Array(await done.blob.arrayBuffer()),journalBytes=new Uint8Array(await new Blob(h.journal).arrayBuffer());assert.deepEqual(raw,journalBytes);
  const headers=[];for await(const entry of exactEntries(done.blob,new AbortController().signal))if(entry.header.kind==='frame')headers.push(entry.header);
  assert.deepEqual(headers.map(frame=>frame.key),[true,false,true,true,false,true,true,true]);
  assert.deepEqual(headers.map(frame=>frame.storage?.kind),['native-yuv420','native-yuv420','rgba8','native-yuv420','native-yuv420','native-yuv420','native-yuv420','native-yuv420']);
  assert.equal(headers[0].storage?.byteLength,one.packed.length);assert.notEqual(headers[0].storage?.byteLength,one.expected.length);
  const decoded=[];for await(const frame of exactPixels(done.blob,new AbortController().signal))decoded.push({...frame,pixels:frame.pixels.slice()});
  for(const [index,frame]of decoded.entries()){assert.deepEqual(frame.pixels,inputs[index].expected);assert.equal(frame.hash,await pixelHash(inputs[index].expected));}
  assert.deepEqual(decoded.map(frame=>frame.time),[19,18,17,16,15,14,13,12]);
  for(const [index,message]of h.sourceMessages.entries())if(message.kind==='stored')assert.equal(h.sourceMessages[index+1].kind,'credit');
  await h.send({kind:'dispose'});assert.equal(h.removed(),1);assert.equal(h.closed(),1);
 });
});

test('native payload is rejected without opt-in and never enters Canvas or emits stored ACK',async()=>{
 await runWorker(undefined,async(h:any)=>{
  assert.equal(Object.hasOwn(h.messages[0],'storageVersion'),false);const input=await nativeInput(1);
  h.source(input.message);const done=await finish(h);
  assert.equal(done.stats.frames,0);assert.equal(done.stats.complete,false);assert.equal(Object.hasOwn(done.stats,'storageVersion'),false);
  assert.match(done.stats.error,/compact/);assert.equal(h.canvasDraws(),0);
  assert.equal(h.sourceMessages.some((m:any)=>m.kind==='stored'),false);
  assert.equal(h.sourceMessages.filter((m:any)=>m.kind==='source-error').length,1);
  assert.deepEqual(h.sourceMessages.filter((m:any)=>m.kind==='credit').map((m:any)=>m.bytes),[input.credit]);await h.send({kind:'dispose'});
 });
});

test('invalid native input freezes admission and releases later fallback ownership without queueing it',async()=>{
 await runWorker(1,async(h:any)=>{
  const input=await nativeInput(1),bad={...input.message,native:{...input.message.native,descriptor:{...input.message.native.descriptor,extra:'unexpected'}}};
  const bitmap={width:16,height:16,pixels:new Uint8Array(16*16*4),closed:0,close(){this.closed++;}};
  h.source(bad);assert.equal(bad.native,undefined,'uncharged invalid buffers are released before waiting for the codec');
  h.source({kind:'frame',canonical:true,role:'input',id:2,time:2,width:16,height:16,bitmap});
  const done=await finish(h);assert.equal(done.stats.frames,0);assert.equal(done.stats.complete,false);
  assert.match(done.stats.error,/unexpected/);assert.equal(done.stats.peakQueuedBytes,0,'invalid native and subsequent fallback bytes are not admitted');
  assert.equal(bitmap.closed,1);assert.equal(h.sourceMessages.filter((m:any)=>m.kind==='credit').length,2);
  assert.equal(h.sourceMessages.some((m:any)=>m.kind==='stored'),false);await h.send({kind:'dispose'});
 });
});

test('compact native queue has a finite job budget and drains every preceding committed job before failure',async()=>{
 await runWorker(1,async(h:any)=>{
  const descriptor=metadata(),packed=new Uint8Array(16*16*3/2);
  for(let id=1;id<=129;id++)h.source({kind:'frame',canonical:true,role:'backup',id,time:id,width:16,height:16,
   native:{descriptor,pixels:packed.slice()}});
  h.source({kind:'drain'});await h.until(()=>h.sourceMessages.some((m:any)=>m.kind==='drained'));
  const done=await finish(h);assert.equal(done.stats.frames,128);assert.equal(done.stats.nativeFrames,128);assert.equal(done.stats.rgbaFrames,0);
  assert.equal(done.stats.complete,false);assert.match(done.stats.error,/한도/);assert.equal(done.stats.peakQueuedBytes,128*(16*16*3/2+16*16*4));
  assert.equal(h.sourceMessages.filter((m:any)=>m.kind==='stored').length,128);assert.equal(h.sourceMessages.filter((m:any)=>m.kind==='credit').length,129);
  assert.equal(h.sourceMessages.filter((m:any)=>m.kind==='source-error').length,1);await h.send({kind:'dispose'});
 });
});

test('native admission charges packed bytes plus generated RGBA before any conversion allocation',async()=>{
 await runWorker(1,async(h:any)=>{
  const descriptor=metadata('I420','smpte170m',4096,4096),nativeBytes=4096*4096*3/2,
   reservation=nativeBytes+4096*4096*4;
  // The first invalid ID fails before conversion, so this admission-boundary
  // test does not allocate two 64MiB generated rasters or run a huge converter.
  h.source({kind:'frame',canonical:true,role:'backup',id:0,time:1,width:4096,height:4096,
   native:{descriptor,pixels:new Uint8Array(nativeBytes)}});
  h.source({kind:'frame',canonical:true,role:'backup',id:2,time:2,width:4096,height:4096,
   native:{descriptor,pixels:new Uint8Array(nativeBytes)}});
  const done=await finish(h);assert.equal(done.stats.complete,false);assert.equal(done.stats.frames,0);
  assert.equal(done.stats.peakQueuedBytes,reservation);assert.ok(done.stats.peakQueuedBytes<=128*1024*1024);
  assert.equal(done.stats.raster.submitted,0);assert.equal(h.canvasDraws(),0);
  assert.deepEqual(h.sourceMessages.filter((m:any)=>m.kind==='credit').map((m:any)=>m.bytes),[reservation,reservation]);
  assert.equal(h.sourceMessages.some((m:any)=>m.kind==='stored'),false);await h.send({kind:'dispose'});
 });
});

test('native payload arriving after the ordered end marker is released without a new commit',async()=>{
 await runWorker(1,async(h:any)=>{
  const first=await nativeInput(1),late=await nativeInput(2);h.source(first.message);h.source({kind:'end'});h.source(late.message);
  await h.send({kind:'finish',noSource:false});await h.until(()=>h.messages.some((m:any)=>m.kind==='done'));
  const done=h.messages.find((m:any)=>m.kind==='done');assert.equal(done.stats.frames,1);assert.equal(done.stats.complete,false);
  assert.match(done.stats.error,/종료된/);assert.deepEqual(h.sourceMessages.filter((m:any)=>m.kind==='stored').map((m:any)=>m.id),[1]);
  assert.equal(h.sourceMessages.filter((m:any)=>m.kind==='credit').length,2);await h.send({kind:'dispose'});
 });
});

test('dispose during native preparation joins ownership without publishing a late stored ACK',async()=>{
 await runWorker(1,async(h:any)=>{
  const input=await nativeInput(1),descriptor=Object.getOwnPropertyDescriptor(globalThis,'crypto'),original=crypto;
  let started=false,release!:()=>void;
  const barrier=new Promise<void>(resolve=>{release=resolve;});
  Object.defineProperty(globalThis,'crypto',{configurable:true,value:{randomUUID:()=>original.randomUUID(),subtle:{
   digest:(algorithm:AlgorithmIdentifier,data:BufferSource)=>{
    if(!started){started=true;return barrier.then(()=>original.subtle.digest(algorithm,data));}
    return original.subtle.digest(algorithm,data);
   },
  }}});
  try{
   h.source(input.message);await h.until(()=>started);
   const disposing=h.send({kind:'dispose'});release();await disposing;
   assert.equal(h.sourceMessages.some((m:any)=>m.kind==='stored'),false);
   assert.equal(h.sourceMessages.filter((m:any)=>m.kind==='source-error').length,1);
   assert.deepEqual(h.sourceMessages.filter((m:any)=>m.kind==='credit').map((m:any)=>m.bytes),[input.credit]);
   assert.equal(h.removed(),1);assert.equal(h.closed(),1);assert.ok(h.messages.some((m:any)=>m.kind==='disposed'));
  }finally{release();if(descriptor)Object.defineProperty(globalThis,'crypto',descriptor);else Reflect.deleteProperty(globalThis,'crypto');}
 });
});

test('a stalled admitted prefix and 10000 rejected frames retain only one ordered failure and drain barrier',async()=>{
 await runWorker(1,async(h:any)=>{
  const first=await nativeInput(1),second=await nativeInput(2),afterRejection=await nativeInput(3),
   cryptoDescriptor=Object.getOwnPropertyDescriptor(globalThis,'crypto'),originalCrypto=crypto,
   thenDescriptor=Object.getOwnPropertyDescriptor(Promise.prototype,'then')!,originalThen=Promise.prototype.then;
  let started=false,release!:()=>void,closedRejected=0,chainCalls=0;
  const barrier=new Promise<void>(resolve=>{release=resolve;});
  Object.defineProperty(globalThis,'crypto',{configurable:true,value:{randomUUID:()=>originalCrypto.randomUUID(),subtle:{
   digest:(algorithm:AlgorithmIdentifier,data:BufferSource)=>{
    if(!started){started=true;return barrier.then(()=>originalCrypto.subtle.digest(algorithm,data));}
    return originalCrypto.subtle.digest(algorithm,data);
   },
  }}});
  try{
   h.source(first.message);h.source(second.message);await h.until(()=>started);
   Object.defineProperty(Promise.prototype,'then',{...thenDescriptor,value:function(this:Promise<unknown>,...args:any[]){
    chainCalls++;return originalThen.apply(this,args as never);
   }});
   try{
    for(let index=0;index<10_000;index++){
     const rejected={kind:'frame',canonical:true,role:'backup',id:3+index,time:3+index,width:16,height:16,
      native:{descriptor:metadata(),pixels:new Uint8Array(16*16*3/2)},bitmap:{close(){closedRejected++;}}};
     h.source(rejected);assert.equal(rejected.native,undefined);assert.equal(rejected.bitmap,undefined);
     if(index%17===0)h.source({kind:'drain'});
    }
    h.source(afterRejection.message);
   }finally{Object.defineProperty(Promise.prototype,'then',thenDescriptor);}
   assert.ok(chainCalls<=4,`rejected burst created ${chainCalls} Promise.then calls instead of a constant barrier`);
   assert.equal(closedRejected,10_000);assert.equal(h.sourceMessages.filter((m:any)=>m.kind==='credit').length,10_001);
   assert.equal(h.sourceMessages.some((m:any)=>m.kind==='stored'||m.kind==='source-error'||m.kind==='drained'),false,
    'the admitted prefix is still stalled; its ACKs and failure/drain barrier must not be overtaken');
   release();await h.until(()=>h.sourceMessages.some((m:any)=>m.kind==='drained'));
   assert.deepEqual(h.sourceMessages.filter((m:any)=>m.kind==='stored').map((m:any)=>m.id),[1,2]);
   assert.equal(h.sourceMessages.filter((m:any)=>m.kind==='source-error').length,1);
   assert.equal(h.sourceMessages.filter((m:any)=>m.kind==='drained').length,1);
   const lastStored=h.sourceMessages.findLastIndex((m:any)=>m.kind==='stored'),
    failed=h.sourceMessages.findIndex((m:any)=>m.kind==='source-error'),drained=h.sourceMessages.findIndex((m:any)=>m.kind==='drained');
   assert.ok(lastStored<failed&&failed<drained);
   const done=await finish(h);assert.equal(done.stats.frames,2);assert.equal(done.stats.nativeFrames,2);assert.equal(done.stats.complete,false);
   assert.equal(done.stats.peakQueuedBytes,first.credit+second.credit);
   assert.equal(h.sourceMessages.filter((m:any)=>m.kind==='credit').length,10_003);
   await h.send({kind:'dispose'});assert.equal(h.removed(),1);
  }finally{
   release();Object.defineProperty(Promise.prototype,'then',thenDescriptor);
   if(cryptoDescriptor)Object.defineProperty(globalThis,'crypto',cryptoDescriptor);else Reflect.deleteProperty(globalThis,'crypto');
  }
 });
});

test('unsupported compact version fails initialization instead of guessing a native codec',async()=>{
 await runWorker(2,async(h:any)=>{assert.equal(h.messages[0].kind,'error');assert.match(h.messages[0].error,/버전/);assert.equal(h.sourceMessages.length,0);});
});
