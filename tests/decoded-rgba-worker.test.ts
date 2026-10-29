import test from 'node:test';
import assert from 'node:assert/strict';
import {createDecodedRgbaWorkerRuntime} from '../src/features/card-scanner/decoded-rgba-worker';
import type {RgbaDecodeInput,RgbaDecodePlatform,RgbaDecodeSample,RgbaDecodeTrack,RgbaNativeFrame} from '../src/features/card-scanner/decoded-rgba-worker';
import {pixelHash} from '../src/features/card-scanner/exact-recording-codec';

const ticks=async()=>{for(let index=0;index<8;index++)await Promise.resolve();};
function deferred<T>(){let resolve!:(value:T)=>void,reject!:(error:unknown)=>void;const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};}
class Frame implements RgbaNativeFrame {
 format='I420';codedWidth=2;codedHeight=2;displayWidth=2;displayHeight=2;visibleRect={x:0,y:0,width:2,height:2};timestamp=0;duration:number|null=40000;
 colorSpace={toJSON:()=>({primaries:'bt709' as const,transfer:'bt709' as const,matrix:'bt709' as const,fullRange:false})};
 closed=0;allocation=16;layout=[{offset:0,stride:8}];options:VideoFrameCopyToOptions[]=[];
 copyWait:Promise<PlaneLayout[]>|undefined;copyError:unknown;writtenBuffer:ArrayBuffer|undefined;
 allocationSize(options:VideoFrameCopyToOptions){this.options.push({...options});return this.allocation;}
 async copyTo(pixels:Uint8Array<ArrayBuffer>,options:VideoFrameCopyToOptions){
  this.options.push({...options});this.writtenBuffer=pixels.buffer;pixels.set([1,2,3,0,5,6,7,127,9,10,11,255,13,14,15,255]);
  if(this.copyError)throw this.copyError;return this.copyWait?await this.copyWait:this.layout;
 }
 close(){this.closed++;}
}
class Sample implements RgbaDecodeSample {
 timestamp=0;duration=.04;rotation=0;flip=false;pixelAspectRatio={num:1,den:1};
 colorSpace={toJSON:()=>({primaries:'bt709' as const,transfer:'bt709' as const,matrix:'bt709' as const,fullRange:false})};
 closed=0;toFrameCalls=0;toFrameError:unknown;frame=new Frame();
 toVideoFrame(){this.toFrameCalls++;if(this.toFrameError)throw this.toFrameError;return this.frame;}
 close(){this.closed++;}
}
function fixture(samples:Sample[]=[new Sample()]){
 let disposed=0,nextCalls=0,returned=0;
 const track:RgbaDecodeTrack={id:1,canDecode:async()=>true,computeDuration:async()=>.08,getDisplayWidth:async()=>2,getDisplayHeight:async()=>2};
 const input:RgbaDecodeInput={getPrimaryVideoTrack:async()=>track,dispose(){disposed++;}};
 const outputs:Record<string,unknown>[]=[],preferences:string[]=[];
 const iterator:AsyncIterator<RgbaDecodeSample>={next:async()=>{const value=samples[nextCalls++];return value?{done:false,value}:{done:true,value:undefined};},return:async()=>{returned++;return {done:true,value:undefined};}};
 const platform:RgbaDecodePlatform={createInput:()=>input,createSamples:(_track,preference)=>{preferences.push(preference);return iterator;},hash:pixelHash};
 const runtime=createDecodedRgbaWorkerRuntime({postMessage(message,transfer){
  const record=message as Record<string,unknown>;
  if(record.kind==='frame'){const sample=samples[(record.decoded as {ordinal:number}).ordinal-1];assert.equal(sample.closed,1);assert.equal(sample.frame.closed,1);assert.equal(transfer?.[0],record.pixels);}
  outputs.push(transfer?.length?structuredClone(record,{transfer}):structuredClone(record));
 }},platform);
 const init=()=>runtime.handle({kind:'init',id:1,blob:new Blob(['encoded']),decoderPreference:'prefer-software'});
 return {runtime,init,outputs,platform,input,iterator,track,preferences,stats:()=>({disposed,nextCalls,returned})};
}

test('worker decodes only on pull, uses explicit RGBA/srgb, hashes full bytes and closes before transfer',async()=>{
 const first=new Sample(),last=new Sample();last.timestamp=.04;last.duration=0;last.frame.timestamp=40000;last.frame.duration=null;
 const test=fixture([first,last]);await test.init();assert.equal(test.stats().nextCalls,0);assert.deepEqual(test.preferences,['prefer-software']);
 assert.equal(test.outputs[0].kind,'ready');await test.runtime.handle({kind:'next',id:2});
 const reply=test.outputs.at(-1)!;assert.equal(reply.kind,'frame');assert.equal((reply.decoded as {ordinal:number}).ordinal,1);
 const pixels=new Uint8Array(reply.pixels as ArrayBuffer);assert.deepEqual([...pixels],[1,2,3,0,5,6,7,127,9,10,11,255,13,14,15,255]);
 assert.equal((reply.decoded as {rgbaSha256:string}).rgbaSha256,await pixelHash(pixels));assert.equal(first.frame.writtenBuffer!.byteLength,0,'the sender relinquishes the buffer');
 assert.deepEqual(first.frame.options,[{format:'RGBA',colorSpace:'srgb'},{format:'RGBA',colorSpace:'srgb'}]);
 assert.equal(test.stats().nextCalls,1);await ticks();assert.equal(test.stats().nextCalls,1);
 await test.runtime.handle({kind:'next',id:3});assert.equal((test.outputs.at(-1)!.decoded as {duration:number}).duration,0);
 await test.runtime.handle({kind:'next',id:4});assert.deepEqual(test.outputs.at(-1),{kind:'end',id:4,frames:2,trackId:1});
 await test.runtime.handle({kind:'dispose',id:5});assert.equal(test.outputs.at(-1)!.kind,'disposed');assert.equal(test.stats().returned,1);assert.ok(test.stats().disposed>=1);
});

test('unsupported geometry, non-tight layouts and copy failures fail closed and release both owners',async()=>{
 const changes:((sample:Sample)=>void)[]=[
  sample=>{sample.rotation=90;},sample=>{sample.flip=true;},sample=>{sample.pixelAspectRatio.num=2;},
  sample=>{sample.frame.displayWidth=3;},sample=>{sample.frame.visibleRect.x=1;},sample=>{sample.frame.allocation=20;},
  sample=>{sample.frame.layout=[{offset:1,stride:8}];},sample=>{sample.frame.layout=[{offset:0,stride:12}];},
  sample=>{sample.frame.copyError=Error('copy unsupported');},sample=>{sample.timestamp=-1;},
 ];
 for(const change of changes){
  const sample=new Sample();change(sample);const test=fixture([sample]);await test.init();await test.runtime.handle({kind:'next',id:2});
  const error=test.outputs.at(-1)!;assert.equal(error.kind,'error');assert.equal(error.code,'unsupported');
  assert.equal(sample.closed,1);assert.equal(sample.frame.closed,1);assert.equal(test.outputs.filter(message=>message.kind==='frame').length,0);
  await test.runtime.handle({kind:'dispose',id:3});
 }
});

test('sample closes if native cloning throws and both close if hashing fails',async()=>{
 const noFrame=new Sample();noFrame.toFrameError=Error('clone failed');const first=fixture([noFrame]);await first.init();await first.runtime.handle({kind:'next',id:2});
 assert.equal(noFrame.closed,1);assert.equal(noFrame.frame.closed,0);assert.equal(first.outputs.at(-1)!.code,'runtime');await first.runtime.handle({kind:'dispose',id:3});
 const sample=new Sample(),base=fixture([sample]);base.platform.hash=async()=>{throw Error('hash failed');};
 await base.init();await base.runtime.handle({kind:'next',id:2});assert.equal(sample.closed,1);assert.equal(sample.frame.closed,1);assert.equal(base.outputs.at(-1)!.kind,'error');
 await base.runtime.handle({kind:'dispose',id:3});
});

test('dispose joins a pending native copy before closing and never publishes its frame',async()=>{
 const sample=new Sample(),copy=deferred<PlaneLayout[]>();sample.frame.copyWait=copy.promise;
 const test=fixture([sample]);await test.init();const pending=test.runtime.handle({kind:'next',id:2});await ticks();
 const disposing=test.runtime.handle({kind:'dispose',id:3});await ticks();assert.equal(sample.frame.closed,0);assert.equal(test.outputs.filter(message=>message.kind==='disposed').length,0);
 copy.resolve([{offset:0,stride:8}]);await Promise.all([pending,disposing]);assert.equal(sample.frame.closed,1);assert.equal(sample.closed,1);
 assert.equal(test.outputs.filter(message=>message.kind==='frame').length,0);assert.equal(test.outputs.at(-1)!.kind,'disposed');
});

test('dispose during iterator.next closes the yielded late sample without cloning it',async()=>{
 const sample=new Sample(),test=fixture([sample]),next=deferred<IteratorResult<RgbaDecodeSample>>();test.iterator.next=()=>next.promise;
 await test.init();const pending=test.runtime.handle({kind:'next',id:2});await ticks();const disposing=test.runtime.handle({kind:'dispose',id:3});
 next.resolve({done:false,value:sample});await Promise.all([pending,disposing]);assert.equal(sample.closed,1);assert.equal(sample.toFrameCalls,0);
 assert.equal(test.outputs.filter(message=>message.kind==='frame').length,0);assert.equal(test.outputs.at(-1)!.kind,'disposed');
});

test('concurrent next is rejected without an application queue or later publication',async()=>{
 const sample=new Sample(),test=fixture([sample]),next=deferred<IteratorResult<RgbaDecodeSample>>();let calls=0;test.iterator.next=()=>{calls++;return next.promise;};
 await test.init();const first=test.runtime.handle({kind:'next',id:2});await ticks();await test.runtime.handle({kind:'next',id:3});
 assert.equal(calls,1);assert.equal(test.outputs.at(-1)!.code,'protocol');next.resolve({done:false,value:sample});await first;
 assert.equal(test.outputs.filter(message=>message.kind==='frame').length,0);assert.equal(sample.closed,1);await test.runtime.handle({kind:'dispose',id:4});
});

test('dispose during init suppresses ready and invalid sources never open the decoder',async()=>{
 const sample=new Sample(),test=fixture([sample]),track=deferred<RgbaDecodeTrack|null>();test.input.getPrimaryVideoTrack=()=>track.promise;
 const init=test.init();await ticks();const disposing=test.runtime.handle({kind:'dispose',id:2});track.resolve(test.track);await Promise.all([init,disposing]);
 assert.equal(test.outputs.filter(message=>message.kind==='ready').length,0);assert.equal(test.outputs.at(-1)!.kind,'disposed');
 const bad=fixture();let created=0;bad.platform.createInput=()=>{created++;return bad.input;};
 await bad.runtime.handle({kind:'init',id:1,blob:new Blob(),decoderPreference:'no-preference'});assert.equal(created,0);assert.equal(bad.outputs.at(-1)!.code,'unsupported');
 await bad.runtime.handle({kind:'dispose',id:2});
});
