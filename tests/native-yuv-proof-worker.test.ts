import test from 'node:test';
import assert from 'node:assert/strict';
import {createNativeYuvProofRuntime,MAX_NATIVE_YUV_SOURCE_BYTES,compareNativeYuvPasses} from '../dev/native-yuv-proof-worker';
import type {NativeYuvProofFrame,NativeYuvProofSample,NativeYuvProofPlatform,NativeYuvProofTrack,NativeYuvProofReport} from '../dev/native-yuv-proof-worker';
import {pixelHash} from '../src/features/card-scanner/exact-recording-codec';
import {nativeYuvDescriptorJson} from '../dev/native-yuv-recipe';

function deferred<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(yes=>{resolve=yes;});return {promise,resolve};}
const pause=(ms:number)=>new Promise<void>(resolve=>setTimeout(resolve,ms));
async function until(check:()=>boolean){for(let index=0;index<1000;index++){if(check())return;await pause(1);}throw Error('Fake platform checkpoint did not arrive.');}
class Frame implements NativeYuvProofFrame {
 format:string|null='I420';codedWidth=2;codedHeight=2;displayWidth=2;displayHeight=2;
 visibleRect:{x:number;y:number;width:number;height:number}|null={x:0,y:0,width:2,height:2};timestamp=0;duration:number|null=40_000;
 rotation:number|undefined=0;flip:boolean|undefined=false;
 colorInit:VideoColorSpaceInit={primaries:'bt709',transfer:'bt709',matrix:'bt709',fullRange:false};
 colorSpace={toJSON:()=>({...this.colorInit})};closed=0;copied=0;allocation=6;
 options:VideoFrameCopyToOptions[]=[];returned:PlaneLayout[]=[{offset:0,stride:2},{offset:4,stride:1},{offset:5,stride:1}];
 bytes=new Uint8Array([16,235,81,145,128,128]);copyGate:Promise<void>|undefined;copyError:unknown;closeError=false;copyBuffer:ArrayBuffer|undefined;
 allocationSize(options:VideoFrameCopyToOptions){this.options.push(structuredClone(options));return this.allocation;}
 async copyTo(target:Uint8Array<ArrayBuffer>,options:VideoFrameCopyToOptions){
  this.options.push(structuredClone(options));this.copied++;this.copyBuffer=target.buffer;target.set(this.bytes);
  if(this.copyGate)await this.copyGate;if(this.copyError)throw this.copyError;return this.returned;
 }
 close(){this.closed++;if(this.closeError)throw Error('native close failed');}
}
class Sample implements NativeYuvProofSample {
 timestamp=0;duration=.04;rotation=0;flip=false;pixelAspectRatio={num:1,den:1};closed=0;cloned=0;cloneError=false;
 frame=new Frame();colorSpace={toJSON:()=>({primaries:'bt709' as const,transfer:'bt709' as const,matrix:'bt709' as const,fullRange:false})};
 toVideoFrame(){this.cloned++;if(this.cloneError)throw Error('clone failed');return this.frame;}
 close(){this.closed++;}
}
async function fixture(options:{frames?:number;change?:(sample:Sample,pass:number,index:number)=>void;limits?:NativeYuvProofPlatform['limits']}={}){
 const blob=new Blob(['owned encoded fixture'],{type:'video/mp4'}),samples:Sample[][]=[],inputs:{disposed:number;returned:number;next:number}[]=[];
 const outputs:Record<string,unknown>[]=[],hashBuffers:{bytes:number;buffer:ArrayBuffer}[]=[];
 let creations=0,sinks=0;
 const track:NativeYuvProofTrack={id:7,canDecode:async()=>true,computeDuration:async()=>.2,getDisplayWidth:async()=>2,getDisplayHeight:async()=>2};
 const platform:NativeYuvProofPlatform={
  createInput(){const stats={disposed:0,returned:0,next:0};inputs.push(stats);creations++;
   return {getPrimaryVideoTrack:async()=>track,dispose(){stats.disposed++;}};},
  createSamples(){const pass=++sinks,stats=inputs[pass-1],list=Array.from({length:options.frames??2},(_,index)=>{
   const sample=new Sample();sample.timestamp=index*.04;sample.frame.timestamp=Math.round(sample.timestamp*1_000_000);
   options.change?.(sample,pass,index);return sample;
  });samples.push(list);let index=0;
  return {next:async()=>{stats.next++;const sample=list[index++];return sample?{done:false as const,value:sample}:{done:true as const,value:undefined};},
   return:async()=>{stats.returned++;return {done:true as const,value:undefined};}};},
  hash:async bytes=>{hashBuffers.push({bytes:bytes.byteLength,buffer:bytes.buffer});return pixelHash(bytes);},now:()=>performance.now(),limits:options.limits,
 };
 const runtime=createNativeYuvProofRuntime({postMessage(message){
  const value=message as Record<string,unknown>;
  if(value.kind==='progress'&&value.phase==='decode'){
   const pass=value.pass as number,ordinal=value.frames as number,sample=samples[pass-1][ordinal-1];
   assert.equal(sample.closed,1);assert.equal(sample.frame.closed,1,'close both owners before publishing metadata');
  }
  outputs.push(structuredClone(value));
 }},platform);
 const source={caseId:'a'.repeat(64),index:0,sha256:await pixelHash(new Uint8Array(await blob.arrayBuffer())),bytes:blob.size,type:blob.type};
 const request={kind:'run',id:1,blob,source};
 return {runtime,platform,track,blob,source,request,outputs,samples,inputs,hashBuffers,creations:()=>creations,run:()=>runtime.handle(request)};
}
function report(output:Record<string,unknown>){return output.report as unknown as NativeYuvProofReport;}
function noPixels(value:unknown):boolean{
 if(value instanceof ArrayBuffer||ArrayBuffer.isView(value)||value instanceof Blob)return false;
 if(Array.isArray(value))return value.every(noPixels);
 return !value||typeof value!=='object'||Object.values(value).every(noPixels);
}

test('two sequential native passes use only packed layout, hash full RGBA and close before posting metadata',async()=>{
 const f=await fixture({frames:5,change(sample,_pass,index){if(index===4){sample.duration=0;sample.frame.duration=null;}}});
 await f.run();const terminal=f.outputs.at(-1)!;assert.equal(terminal.kind,'done');const result=report(terminal);
 assert.equal(result.complete,true);assert.equal(result.sourceVerified,true);assert.equal(result.comparison?.matchedAll,true);
 assert.equal(result.comparison?.trackMetadataMatch,true);assert.equal(f.creations(),2);assert.equal(result.passes[1].stats.jitterCount,1);
 const expected=[{offset:0,stride:2},{offset:4,stride:1},{offset:5,stride:1}];
 const rgba=new Uint8Array([0,0,0,255,255,255,255,255,76,76,76,255,150,150,150,255]);
 for(const [index,pass]of result.passes.entries()){
  assert.equal(pass.frames.length,5);assert.equal(pass.cleanup.inputDisposed,true);assert.equal(pass.cleanup.iteratorReturnJoined,true);
  assert.equal(pass.stats.samplesClosed,5);assert.equal(pass.stats.nativeFramesClosed,5);
  assert.equal(pass.stats.maxPackedBytes,6);assert.equal(pass.stats.maxRgbaBytes,16);assert.equal(pass.stats.maxApplicationPixelBytes,22);
  assert.equal(pass.stats.pixelBufferPairAllocations,1,'equal geometry reuses one owned buffer pair per pass');
  assert.equal(pass.frames[4].sample.duration,0);assert.equal(pass.frames[4].native.durationMicroseconds,null);
  for(const [ordinal,row]of pass.frames.entries()){
   assert.equal(row.ordinal,ordinal+1);assert.deepEqual(row.planes,expected);assert.equal(row.profile.profile,'bt709-limited');
   assert.equal(row.generatedRgbaSha256,await pixelHash(rgba));assert.equal(row.nativeSha256,await pixelHash(f.samples[index][ordinal].frame.bytes));
   assert.equal(row.descriptorSha256,await pixelHash(new TextEncoder().encode(nativeYuvDescriptorJson(row.native,row.planes))));
  }
  assert.deepEqual(f.inputs[index],{disposed:1,returned:1,next:6});
 }
 for(const list of f.samples)for(const sample of list){assert.equal(sample.closed,1);assert.equal(sample.frame.closed,1);
  assert.deepEqual(sample.frame.options,[{layout:expected},{layout:expected}]);}
 for(const list of f.samples)assert.equal(new Set(list.map(sample=>sample.frame.copyBuffer)).size,1);
 assert.notEqual(f.samples[0][0].frame.copyBuffer,f.samples[1][0].frame.copyBuffer,'passes own different buffers');
 const packedBuffers=new Set(f.hashBuffers.filter(entry=>entry.bytes===6).map(entry=>entry.buffer));
 const rgbaBuffers=new Set(f.hashBuffers.filter(entry=>entry.bytes===16).map(entry=>entry.buffer));
 assert.equal(rgbaBuffers.size,2);assert.equal([...packedBuffers].some(value=>rgbaBuffers.has(value)),false,'native and RGBA may never alias');
 assert.equal(f.outputs.filter(value=>value.phase==='decode').length,2,'progress is first/every-ten metadata only');
 assert.equal(f.outputs.filter(value=>value.phase==='decode').every(value=>!('profile' in value)&&typeof value.profileId==='string'),true);
 assert.equal(f.outputs.every(noPixels),true,'no raw buffers or Blob escape to the parent');
});

test('NV12 and exact SMPTE170M native profile are supported, DOMRect getters and plane property order are preserved semantically',async()=>{
 const f=await fixture({change(sample){
  sample.frame.format='NV12';sample.frame.returned=[{stride:2,offset:0},{stride:2,offset:4}];
  sample.frame.colorInit={primaries:'smpte170m',transfer:'smpte170m',matrix:'smpte170m',fullRange:false};
  sample.frame.visibleRect=Object.create({get x(){return 0;},get y(){return 0;},get width(){return 2;},get height(){return 2;}});
 }});await f.run();const terminal=f.outputs.at(-1)!;assert.equal(terminal.kind,'done');const result=report(terminal);
 assert.equal(result.comparison?.matchedAll,true);assert.equal(result.passes[0].frames[0].profile.profile,'bt601-smpte170m-limited');
 assert.deepEqual(result.passes[0].frames[0].native.visibleRect,{x:0,y:0,width:2,height:2});
 assert.equal(result.passes[0].frames[0].sample.colorSpace.matrix,'bt709','sample metadata never fills native color');
});

test('request key scope, source identity, MIME, empty and oversized blobs are rejected before decoding',async()=>{
 const f=await fixture();
 const cases:unknown[]=[{...f.request,url:'https://example.invalid/private'}, {...f.request,source:{...f.source,url:'no'}},
  {...f.request,source:{...f.source,index:-1}}, {...f.request,source:{...f.source,caseId:'a'}},
  {...f.request,source:{...f.source,bytes:f.source.bytes+1}}, {...f.request,source:{...f.source,type:'application/json'}},
  {...f.request,blob:new Blob(),source:{...f.source,bytes:0}},
  {...f.request,source:{...f.source,bytes:MAX_NATIVE_YUV_SOURCE_BYTES+1}},
  {...f.request,decoderPreference:'prefer-software'}, {kind:'cancel',id:1,blob:f.blob}];
 for(const request of cases){await f.runtime.handle(request);assert.equal(f.outputs.at(-1)!.kind,'error');assert.equal(f.outputs.at(-1)!.code,'protocol');}
 assert.equal(f.creations(),0);
 const count=f.outputs.length;await f.runtime.handle({kind:'run',id:0});await f.runtime.handle(null);assert.equal(f.outputs.length,count);
});

test('encoded Blob SHA failure opens no decoder and still returns explicit incomplete evidence',async()=>{
 const f=await fixture();await f.runtime.handle({...f.request,source:{...f.source,sha256:'0'.repeat(64)}});
 const terminal=f.outputs.at(-1)!;assert.equal(terminal.code,'integrity');assert.equal(report(terminal).sourceVerified,false);
 assert.equal(report(terminal).complete,false);assert.equal(f.creations(),0);
});

test('unsupported format/color/geometry, packed allocation and returned layout fail closed without RGB fallback',async()=>{
 const changes:((sample:Sample)=>void)[]=[
  sample=>{sample.frame.format='RGBA';},sample=>{sample.frame.colorInit={matrix:'bt709'};},
  sample=>{sample.frame.colorInit={primaries:'bt709',transfer:'bt709',matrix:'smpte170m',fullRange:false};},
  sample=>{sample.frame.colorInit.fullRange=true;},sample=>{sample.frame.visibleRect!.x=1;},sample=>{sample.frame.displayWidth=3;},
  sample=>{sample.rotation=90;},sample=>{sample.flip=true;},sample=>{sample.pixelAspectRatio.num=2;},
  sample=>{sample.frame.rotation=180;},sample=>{sample.frame.flip=true;},sample=>{sample.frame.rotation=undefined;},sample=>{sample.frame.flip=undefined;},
  sample=>{sample.frame.allocation=8;},sample=>{sample.frame.returned=[{offset:0,stride:3},{offset:4,stride:1},{offset:5,stride:1}];},
  sample=>{sample.frame.timestamp=.5;},sample=>{sample.duration=-1;},
 ];
 for(const change of changes){
  const f=await fixture({change});await f.run();const terminal=f.outputs.at(-1)!;assert.equal(terminal.kind,'error');assert.equal(terminal.code,'unsupported');
  const sample=f.samples[0][0];assert.equal(sample.closed,1);assert.equal(sample.frame.closed,sample.cloned);
  assert.equal(f.inputs[0].disposed,1);assert.equal(f.inputs[0].returned,1);assert.equal(report(terminal).complete,false);
  assert.equal(f.outputs.filter(message=>message.phase==='decode').length,0);
 }
});

test('clone, native copy, hash and close errors clean owned samples/frames exactly once',async()=>{
 for(const kind of ['clone','copy','native-hash','rgba-hash','close']){
  const f=await fixture({change(sample){if(kind==='clone')sample.cloneError=true;if(kind==='copy')sample.frame.copyError=Error('native copy failed');if(kind==='close')sample.frame.closeError=true;}});
  if(kind.endsWith('hash'))f.platform.hash=async bytes=>{if(bytes.byteLength===(kind==='native-hash'?6:16))throw Error('hash failed');return pixelHash(bytes);};
  await f.run();assert.equal(f.outputs.at(-1)!.kind,'error');const sample=f.samples[0][0];
  assert.equal(sample.closed,1);assert.equal(sample.frame.closed,kind==='clone'?0:1);assert.equal(f.inputs[0].disposed,1);assert.equal(f.inputs[0].returned,1);
 }
});

test('cancel during pending native copy waits for copy settlement, closes owners, joins iterator, and posts no late frame',async()=>{
 const copy=deferred<void>(),f=await fixture({change(sample,pass,index){if(pass===1&&index===0)sample.frame.copyGate=copy.promise;}});
 const run=f.run();await until(()=>f.samples[0]?.[0]?.frame.copied===1);
 const cancelled=f.runtime.handle({kind:'cancel',id:1});await pause(2);
 assert.equal(f.samples[0][0].frame.closed,0);assert.equal(f.outputs.some(message=>message.kind==='error'),false);
 copy.resolve();await Promise.all([run,cancelled]);
 assert.equal(f.samples[0][0].frame.closed,1);assert.equal(f.samples[0][0].closed,1);
 assert.equal(f.outputs.at(-1)!.code,'cancelled');assert.equal(f.outputs.filter(message=>message.phase==='decode').length,0);
 assert.equal(f.inputs[0].disposed,1);assert.equal(f.inputs[0].returned,1);
});

test('cancel during pending native SHA retains its payload until settlement and starts no next sample or successful publication',async()=>{
 const f=await fixture(),hashGate=deferred<string>(),originalHash=f.platform.hash;
 let hashing:Uint8Array<ArrayBuffer>|undefined;
 const hashLengths:number[]=[],expectedBytes=[16,235,81,145,128,128];
 const expectedHash=await pixelHash(new Uint8Array(expectedBytes));
 f.platform.hash=async bytes=>{
  hashLengths.push(bytes.byteLength);
  if(bytes.byteLength===6&&!hashing){hashing=bytes;return hashGate.promise;}
  return originalHash(bytes);
 };
 const run=f.run();let cancel:Promise<void>|undefined;
 try{
  await until(()=>!!hashing);assert.equal(f.inputs[0].next,1);
  assert.deepEqual([...hashing!],expectedBytes);
  cancel=f.runtime.handle({kind:'cancel',id:1});await pause(2);
  assert.equal(hashing!.byteLength,6);assert.equal(hashing!.buffer.byteLength,6,'pending hash retains the owned native backing');
  assert.deepEqual([...hashing!],expectedBytes,'cancellation cannot overwrite bytes being hashed');
  assert.equal(f.samples[0][0].frame.closed,0);assert.equal(f.samples[0][0].closed,0);
  assert.equal(f.inputs[0].next,1,'no next sample is requested while this native hash is pending');
  assert.equal(f.outputs.some(message=>message.kind==='done'||message.kind==='error'||message.phase==='decode'),false);
  hashGate.resolve(expectedHash);await Promise.all([run,cancel]);
  assert.equal(f.samples[0][0].frame.closed,1);assert.equal(f.samples[0][0].closed,1);
  assert.deepEqual(f.inputs[0],{disposed:1,returned:1,next:1});
  const terminal=f.outputs.at(-1)!;assert.equal(terminal.kind,'error');assert.equal(terminal.code,'cancelled');
  assert.equal(report(terminal).complete,false);assert.equal(report(terminal).passes[0].frames.length,0);
  assert.equal(hashLengths.includes(16),false,'RGBA conversion/hash never starts after cancellation');
 }finally{hashGate.resolve(expectedHash);await Promise.allSettled([run,cancel??Promise.resolve()]);}
});

test('cancel during iterator.next closes a late sample without cloning it and wrong job cancellation is ignored',async()=>{
 const f=await fixture(),next=deferred<IteratorResult<NativeYuvProofSample>>();let calls=0,returned=0;
 const late=new Sample();f.platform.createSamples=()=>({next(){calls++;return next.promise;},return:async()=>{returned++;return {done:true,value:undefined};}});
 const run=f.run();await until(()=>calls===1);await f.runtime.handle({kind:'cancel',id:99});
 const cancel=f.runtime.handle({kind:'cancel',id:1});next.resolve({done:false,value:late});await Promise.all([run,cancel]);
 assert.equal(late.closed,1);assert.equal(late.cloned,0);assert.equal(returned,1);assert.equal(f.outputs.at(-1)!.code,'cancelled');
});

test('deadline is cooperative, joins an in-flight copy before close, and a concurrent run is never queued',async()=>{
 const copy=deferred<void>(),f=await fixture({limits:{deadlineMs:20},change(sample){sample.frame.copyGate=copy.promise;}});
 const run=f.run();await until(()=>f.samples[0]?.[0]?.frame.copied===1);
 await f.runtime.handle({...f.request,id:2});assert.equal(f.outputs.at(-1)!.code,'protocol');assert.equal(f.creations(),1);
 await pause(25);assert.equal(f.samples[0][0].frame.closed,0);copy.resolve();await run;
 assert.equal(f.outputs.at(-1)!.code,'timeout');assert.equal(f.samples[0][0].closed,1);assert.equal(f.samples[0][0].frame.closed,1);
});

test('frame and total metadata limits are explicit failures with all owners closed',async()=>{
 for(const limits of [{maxFramesPerPass:1},{maxMetadataBytes:1}]){
  const f=await fixture({limits});await f.run();const terminal=f.outputs.at(-1)!;assert.equal(terminal.code,'unsupported');
  assert.equal(f.inputs[0].disposed,1);assert.equal(f.inputs[0].returned,1);
  for(const sample of f.samples[0].filter(sample=>sample.closed))assert.equal(sample.closed,1);
  assert.equal(report(terminal).complete,false);
 }
});

test('byte/metadata changes between complete passes are reported as mismatches, never deterministic identity proof',async()=>{
 const f=await fixture({change(sample,pass){if(pass===2)sample.frame.bytes[0]=17;}});await f.run();
 const result=report(f.outputs.at(-1)!);assert.equal(result.complete,true);assert.equal(result.comparison?.matchedAll,false);
 assert.equal(result.comparison?.nativeDifferences,2);assert.equal(result.comparison?.rgbaDifferences,2);
 const first=result.passes[0].frames;
 const changed=structuredClone(first);changed[0].sample.duration=0;
 assert.equal(compareNativeYuvPasses(first,changed).metadataDifferences,1);
 assert.equal(compareNativeYuvPasses(first,changed).matchedAll,false);
 const descriptorChange=structuredClone(first);descriptorChange[0].descriptorSha256='0'.repeat(64);
 assert.equal(compareNativeYuvPasses(first,descriptorChange).descriptorDifferences,1);
});

test('valid 2x2 to 4x2 to 2x4 to 2x2 geometry reuses equal-length pairs and reindexes descriptors and complete hashes',async()=>{
 const geometry=[[2,2],[4,2],[2,4],[2,2]] as const;
 const f=await fixture({frames:geometry.length,change(sample,_pass,index){
  const [width,height]=geometry[index],pixels=width*height,frame=sample.frame;
  frame.codedWidth=width;frame.codedHeight=height;frame.displayWidth=width;frame.displayHeight=height;
  frame.visibleRect={x:0,y:0,width,height};frame.allocation=pixels*3/2;
  frame.bytes=new Uint8Array(frame.allocation).fill(128);frame.bytes.fill(16+index*40,0,pixels);
  frame.returned=[{offset:0,stride:width},{offset:pixels,stride:width/2},{offset:pixels+pixels/4,stride:width/2}];
 }});
 await f.run();const terminal=f.outputs.at(-1)!;assert.equal(terminal.kind,'done');const result=report(terminal);
 assert.equal(result.comparison?.matchedAll,true);assert.equal(result.comparison?.descriptorDifferences,0);
 for(const [passIndex,pass]of result.passes.entries()){
  assert.equal(pass.stats.pixelBufferPairAllocations,3,'only native/RGBA length changes allocate a new pair');
  assert.equal(pass.stats.maxPackedBytes,12);assert.equal(pass.stats.maxRgbaBytes,32);assert.equal(pass.stats.maxApplicationPixelBytes,44);
  assert.equal(pass.stats.packedBytes,36);assert.equal(pass.stats.rgbaBytes,96);
  const buffers=f.samples[passIndex].map(sample=>sample.frame.copyBuffer);
  assert.notEqual(buffers[0],buffers[1]);assert.equal(buffers[1],buffers[2],'4x2 and 2x4 reuse the equal-length native backing');
  assert.notEqual(buffers[2],buffers[3]);assert.notEqual(buffers[0],buffers[3]);
  for(const [index,row]of pass.frames.entries()){
   const [width,height]=geometry[index],pixels=width*height,sample=f.samples[passIndex][index];
   assert.equal(row.ordinal,index+1);assert.equal(row.sample.pts,index*.04);
   assert.equal(row.native.codedWidth,width);assert.equal(row.native.codedHeight,height);
   assert.deepEqual(row.planes,sample.frame.returned);assert.equal(row.packedBytes,pixels*3/2);assert.equal(row.rgbaBytes,pixels*4);
   assert.equal(row.nativeSha256,await pixelHash(sample.frame.bytes));
   const gray=Math.floor(index*40*255/219+.5),expectedRgba=new Uint8Array(pixels*4);
   for(let pixel=0;pixel<pixels;pixel++)expectedRgba.set([gray,gray,gray,255],pixel*4);
   assert.equal(row.generatedRgbaSha256,await pixelHash(expectedRgba));
   assert.equal(row.descriptorSha256,await pixelHash(new TextEncoder().encode(nativeYuvDescriptorJson(row.native,row.planes))));
   assert.equal(sample.closed,1);assert.equal(sample.frame.closed,1);
  }
  assert.notEqual(pass.frames[1].descriptorSha256,pass.frames[2].descriptorSha256,'equal byte counts cannot conceal width/height or plane changes');
  assert.equal(pass.frames[0].descriptorSha256,pass.frames[3].descriptorSha256,'restored geometry has the same descriptor');
  assert.notEqual(pass.frames[0].nativeSha256,pass.frames[3].nativeSha256,'descriptor reuse does not reuse different frame pixels');
 }
 const rgbaBuffers=f.hashBuffers.filter(entry=>entry.bytes===16||entry.bytes===32).map(entry=>entry.buffer);
 for(let pass=0;pass<2;pass++){
  const [a,b,c,d]=rgbaBuffers.slice(pass*4,pass*4+4);assert.notEqual(a,b);assert.equal(b,c);assert.notEqual(c,d);assert.notEqual(a,d);
 }
 const nativeBuffers=new Set(f.samples.flat().map(sample=>sample.frame.copyBuffer));
 assert.equal(rgbaBuffers.some(value=>nativeBuffers.has(value)),false,'every replacement/reuse keeps native and RGBA targets distinct');
 assert.equal(f.outputs.every(noPixels),true);
});
