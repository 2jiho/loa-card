import test from 'node:test';
import assert from 'node:assert/strict';
import {createNativeYuvTransformWorkerRuntime} from '../dev/native-yuv-transform-worker';
import type {NativeYuvTransformFrame,NativeYuvTransformPlatform} from '../dev/native-yuv-transform-worker';
import {pixelHash} from '../src/features/card-scanner/exact-recording-codec';
import {nativeYuvDescriptorJson} from '../dev/native-yuv-recipe';
import {describeNativeYuvTransformFrame} from '../dev/native-yuv-transform';

function deferred<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(yes=>{resolve=yes;});return {promise,resolve};}
const tick=()=>new Promise<void>(resolve=>setImmediate(resolve));
class Frame implements NativeYuvTransformFrame {
 format:string|null='I420';codedWidth=2;codedHeight=2;displayWidth=2;displayHeight=2;rotation:number|undefined=0;flip:boolean|undefined=false;
 visibleRect:{x:number;y:number;width:number;height:number}|null={x:0,y:0,width:2,height:2};timestamp=0;duration:number|null=40_000;
 color:VideoColorSpaceInit={primaries:'bt709',transfer:'bt709',matrix:'bt709',fullRange:false};colorSpace={toJSON:()=>this.color};
 bytes=new Uint8Array([16,235,81,145,128,128]);allocation=6;planes:PlaneLayout[]=[{offset:0,stride:2},{offset:4,stride:1},{offset:5,stride:1}];
 closed=0;copied=0;closeFailure=false;copyFailure=false;gate:Promise<void>|undefined;buffer:Uint8Array<ArrayBuffer>|undefined;options:VideoFrameCopyToOptions[]=[];
 allocationSize(options:VideoFrameCopyToOptions){this.options.push(structuredClone(options));return this.allocation;}
 async copyTo(target:Uint8Array<ArrayBuffer>,options:VideoFrameCopyToOptions){this.copied++;this.buffer=target;this.options.push(structuredClone(options));target.set(this.bytes);await this.gate;if(this.copyFailure)throw Error('copy failed');return this.planes;}
 close(){this.closed++;if(this.closeFailure)throw Error('native close failed');}
}
function fixture(overrides:Partial<NativeYuvTransformPlatform>={},postFailure=false){
 const replies:Record<string,unknown>[]=[],transfers:Transferable[][]=[],hashes:{buffer:ArrayBuffer;length:number}[]=[];
 const platform:NativeYuvTransformPlatform={isFrame:(value):value is NativeYuvTransformFrame=>value instanceof Frame,
  hash:async bytes=>{hashes.push({buffer:bytes.buffer,length:bytes.length});return pixelHash(bytes);},...overrides};
 const runtime=createNativeYuvTransformWorkerRuntime({postMessage(value,transfer=[]){
  const message=value as Record<string,unknown>;
  if(message.kind==='frame'&&postFailure)throw Error('transfer failed');
  transfers.push(transfer);replies.push(structuredClone(message,{transfer}));
 }},platform);
 return {runtime,replies,transfers,hashes};
}

test('one native source produces a closed-source, transferred opaque RGBA receipt with separate hashes',async()=>{
 for(const profile of ['bt709','smpte170m'] as const)for(const format of ['I420','NV12'] as const){
  const f=fixture(),frame=new Frame();frame.color={primaries:profile,transfer:profile,matrix:profile,fullRange:false};frame.format=format;
  if(format==='NV12')frame.planes=[{offset:0,stride:2},{offset:4,stride:2}];
  const {native}=describeNativeYuvTransformFrame(frame),expectedNative=await pixelHash(frame.bytes);
  await f.runtime.handle({kind:'convert',id:1,frame});
  assert.equal(frame.closed,1);assert.equal(frame.copied,1);assert.equal(f.replies.length,1);
  const reply=f.replies[0],metadata=reply.metadata as Record<string,unknown>,pixels=new Uint8Array(reply.pixels as ArrayBuffer);
  assert.equal(reply.kind,'frame');assert.deepEqual([...pixels],[0,0,0,255,255,255,255,255,76,76,76,255,150,150,150,255]);
  assert.equal(metadata.nativeSha256,expectedNative);assert.equal(metadata.generatedRgbaSha256,await pixelHash(pixels));
  assert.equal(metadata.descriptorSha256,await pixelHash(new TextEncoder().encode(nativeYuvDescriptorJson(native,frame.planes))));
  assert.equal(metadata.frameClosed,true);assert.deepEqual(metadata.native,native);
  assert.ok(f.transfers[0][0] instanceof ArrayBuffer);assert.equal((f.transfers[0][0] as ArrayBuffer).byteLength,0,'postMessage transfers ownership');
  assert.deepEqual(frame.options,[{layout:frame.planes},{layout:frame.planes}]);
 }
});

test('packed scratch reuse cannot alias or later mutate a previously transferred RGBA result',async()=>{
 const f=fixture(),first=new Frame(),second=new Frame();
 await f.runtime.handle({kind:'convert',id:1,frame:first});const snapshot=new Uint8Array(f.replies[0].pixels as ArrayBuffer).slice();
 second.bytes[0]=235;await f.runtime.handle({kind:'convert',id:2,frame:second});
 assert.equal(first.buffer?.buffer,second.buffer?.buffer);assert.notEqual(first.buffer?.buffer,f.replies[0].pixels);
 assert.deepEqual(new Uint8Array(f.replies[0].pixels as ArrayBuffer),snapshot);
 assert.notDeepEqual(new Uint8Array(f.replies[1].pixels as ArrayBuffer),snapshot);assert.equal(first.closed,1);assert.equal(second.closed,1);
});

test('unknown color, orientation, geometry and overlarge inputs are rejected before pixel copying',async()=>{
 const changes:((frame:Frame)=>void)[]=[
  frame=>{frame.format='I420A';},frame=>{frame.color={...frame.color,matrix:undefined};},frame=>{frame.color={...frame.color,fullRange:true};},
  frame=>{frame.rotation=180;},frame=>{frame.rotation=undefined;},frame=>{frame.flip=true;},frame=>{frame.flip=undefined;},
  frame=>{frame.codedWidth=3;},frame=>{frame.visibleRect={x:2,y:0,width:2,height:2};},frame=>{frame.displayWidth=4;},
  frame=>{frame.codedWidth=frame.displayWidth=100_000;frame.codedHeight=frame.displayHeight=100_000;frame.visibleRect={x:0,y:0,width:100_000,height:100_000};},
  frame=>{frame.timestamp=NaN;},frame=>{frame.duration=-1;},
 ];
 for(const change of changes){const f=fixture(),frame=new Frame();change(frame);await f.runtime.handle({kind:'convert',id:1,frame});
  assert.equal(f.replies[0].code,'unsupported');assert.equal(frame.copied,0);assert.equal(frame.closed,1);assert.equal(f.hashes.length,0);}
});

test('native timestamp is signed provenance while duration null is retained, never a capture-time ID',async()=>{
 const f=fixture(),frame=new Frame();frame.timestamp=-12;frame.duration=null;
 await f.runtime.handle({kind:'convert',id:1,frame});const metadata=f.replies[0].metadata as {native:Record<string,unknown>};
 assert.equal(metadata.native.timestampMicroseconds,-12);assert.equal(metadata.native.durationMicroseconds,null);
 assert.equal('captureTime' in metadata,false);assert.equal('sourceFrameId' in metadata,false);
});

test('allocation, returned layout, copy/hash and close errors stay explicit and close the owner once',async()=>{
 for(const kind of ['allocation','layout','copy','hash','close'] as const){
  const f=fixture(kind==='hash'?{hash:async()=>{throw Error('hash failed');}}:{}),frame=new Frame();
  if(kind==='allocation')frame.allocation=7;if(kind==='layout')frame.planes=[{offset:0,stride:4},{offset:4,stride:1},{offset:5,stride:1}];
  if(kind==='copy')frame.copyFailure=true;if(kind==='close')frame.closeFailure=true;
  await f.runtime.handle({kind:'convert',id:1,frame});assert.equal(f.replies[0].kind,'error');assert.equal(frame.closed,1);
  assert.equal(f.replies[0].code,kind==='allocation'||kind==='layout'?'unsupported':kind==='close'?'cleanup':'runtime');
  assert.equal(f.replies[0].frameClosed,kind!=='close');
 }
});

test('malformed, busy and duplicate requests close their incoming source without reusing active pixels',async()=>{
 const f=fixture(),malformed=new Frame();await f.runtime.handle({kind:'convert',id:1,frame:malformed,extra:true});assert.equal(malformed.closed,1);assert.equal(f.replies[0].code,'protocol');
 const invalidId=new Frame();await f.runtime.handle({kind:'convert',id:0,frame:invalidId});assert.equal(invalidId.closed,1);
 const gate=deferred<void>(),active=new Frame();active.gate=gate.promise;
 const processing=f.runtime.handle({kind:'convert',id:2,frame:active});await tick();
 const busy=new Frame();await f.runtime.handle({kind:'convert',id:3,frame:busy});assert.equal(busy.closed,1);assert.equal(active.closed,0);
 gate.resolve();await processing;assert.equal(active.closed,1);assert.equal(f.replies.at(-1)?.kind,'frame');
 const duplicate=new Frame();await f.runtime.handle({kind:'convert',id:3,frame:duplicate});assert.equal(duplicate.closed,1);assert.equal(f.replies.at(-1)?.code,'protocol');
});

test('disposal waits for an in-flight native copy and closes before the acknowledgement',async()=>{
 const f=fixture(),gate=deferred<void>(),frame=new Frame();frame.gate=gate.promise;
 const processing=f.runtime.handle({kind:'convert',id:1,frame});await tick();
 const disposing=f.runtime.handle({kind:'dispose',id:2});await tick();assert.equal(frame.closed,0);assert.equal(f.replies.length,0);
 gate.resolve();await Promise.all([processing,disposing]);assert.equal(frame.closed,1);
 assert.deepEqual(f.replies.map(message=>message.kind),['error','disposed']);assert.equal(f.replies[0].code,'cancelled');assert.equal(f.replies[1].error,null);
 const late=new Frame();await f.runtime.handle({kind:'convert',id:3,frame:late});assert.equal(late.closed,1);assert.equal(late.copied,0);
});

test('disposal retains pending native SHA bytes until it settles and never starts an RGBA hash afterwards',async()=>{
 const gate=deferred<void>(),seen=deferred<Uint8Array<ArrayBuffer>>();let hashes=0;
 const f=fixture({hash:async bytes=>{hashes++;if(bytes.length===6){seen.resolve(bytes);await gate.promise;}return pixelHash(bytes);}}),frame=new Frame();
 const processing=f.runtime.handle({kind:'convert',id:1,frame}),held=await seen.promise,snapshot=held.slice();
 const disposing=f.runtime.handle({kind:'dispose',id:2});await tick();assert.equal(frame.closed,0);assert.deepEqual(held,snapshot);
 gate.resolve();await Promise.all([processing,disposing]);assert.equal(hashes,1);assert.equal(frame.closed,1);assert.equal(f.replies.some(message=>message.kind==='frame'),false);
});

test('postMessage failure cannot leave a native source open or report a successful transfer',async()=>{
 const f=fixture({},true),frame=new Frame();await f.runtime.handle({kind:'convert',id:1,frame});
 assert.equal(frame.closed,1);assert.equal(f.replies.length,1);assert.equal(f.replies[0].kind,'error');assert.equal(f.replies[0].code,'runtime');assert.equal(f.replies[0].frameClosed,true);
});
