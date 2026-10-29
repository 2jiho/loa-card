import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {setImmediate} from 'node:timers/promises';
import {createComparisonFrames,COMPARISON_FRAME_LIMITS} from '../dev/native-yuv-frames';
import type {ComparisonFramesPlatform,ComparisonNativeSample,ComparisonCanvasSample} from '../dev/native-yuv-frames';
import type {NativeYuvTransformMetadata,NativeYuvTransformResult} from '../dev/native-yuv-transform';
import {planNativeYuvFrame,nativeYuvDescriptorJson} from '../dev/native-yuv-recipe';

const digest=(value:Uint8Array|string)=>createHash('sha256').update(value).digest('hex');
const rgba=(value=35,width=2,height=2)=>Uint8Array.from({length:width*height*4},(_,index)=>index%4===3?255:(value+index)%256);
class Canvas {
 width=0;height=0;pixels=new Uint8ClampedArray(0);reads=0;paints=0;corrupt=false;
 readonly context={
  putImageData:(image:ImageData)=>{this.paints++;this.pixels=new Uint8ClampedArray(image.data);},
  getImageData:(_x:number,_y:number,width:number,height:number)=>{
   this.reads++;assert.equal(width,this.width);assert.equal(height,this.height);
   const data=new Uint8ClampedArray(this.pixels);if(this.corrupt)data[0]^=1;return {data,width,height} as ImageData;
  },
 };
 getContext(){return this.context;}
}
class Frame {closed=0;constructor(readonly sample:Sample){}close(){this.closed++;}}
class Sample implements ComparisonNativeSample {
 timestamp=0;duration=.04;rotation=0;flip=false;pixelAspectRatio={num:1,den:1};closed=0;frames:Frame[]=[];
 pixels=rgba();width=2;height=2;
 toVideoFrame(){const frame=new Frame(this);this.frames.push(frame);return frame as unknown as VideoFrame;}
 close(){this.closed++;}
}
function receipt(sample:Sample):NativeYuvTransformMetadata {
 const native={format:'I420',codedWidth:sample.width,codedHeight:sample.height,displayWidth:sample.width,displayHeight:sample.height,
  visibleRect:{x:0,y:0,width:sample.width,height:sample.height},rotation:0,flip:false,
  colorSpace:{primaries:'bt709',transfer:'bt709',matrix:'bt709',fullRange:false},
  timestampMicroseconds:Math.round(sample.timestamp*1e6),durationMicroseconds:Math.round(sample.duration*1e6)};
 const plan=planNativeYuvFrame(native);
 return {version:1,native,recipeId:plan.recipe.id,planes:plan.layout,nativeByteLength:plan.nativeByteLength,rgbaByteLength:plan.rgbaByteLength,
  nativeSha256:digest(new Uint8Array(plan.nativeByteLength)),descriptorSha256:digest(nativeYuvDescriptorJson(native,plan.layout)),
  generatedRgbaSha256:digest(sample.pixels),frameClosed:true};
}
function deferred<T>(){let resolve!:(value:T)=>void,reject!:(reason:unknown)=>void;const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};}
async function settled(){for(let i=0;i<8;i++)await setImmediate();}
function fixture(count=2){
 const samples=Array.from({length:count},(_,i)=>{const sample=new Sample();sample.timestamp=i*.04;sample.pixels=rgba(35+i*20);return sample;});
 const canvases=samples.map(sample=>{const canvas=new Canvas();canvas.width=sample.width;canvas.height=sample.height;canvas.pixels=new Uint8ClampedArray(sample.pixels);return canvas;});
 const ownedCanvas=new Canvas(),counts={input:0,dispose:0,returned:0,next:0,transformers:0,transforms:0,transformDispose:0,canvasSamples:0,nativeSamples:0,yields:0};
 let nativeIndex=0,canvasIndex=0,nextGate:ReturnType<typeof deferred<IteratorResult<ComparisonNativeSample>>>|undefined;
 let hashGate:ReturnType<typeof deferred<string>>|undefined,transformGate:ReturnType<typeof deferred<NativeYuvTransformResult>>|undefined;
 const platform:ComparisonFramesPlatform={
  createInput:()=>{counts.input++;return {getPrimaryVideoTrack:async()=>({id:9,canDecode:async()=>true,computeDuration:async()=>count*.04}),dispose(){counts.dispose++;}};},
  canvasSamples:()=>{counts.canvasSamples++;return {async next(){counts.next++;const index=canvasIndex++;return index<count?
   {done:false,value:{canvas:canvases[index],timestamp:samples[index].timestamp,duration:samples[index].duration} as unknown as ComparisonCanvasSample}:{done:true,value:undefined};},
   async return(){counts.returned++;return {done:true,value:undefined};}};},
  nativeSamples:()=>{counts.nativeSamples++;return {async next(){counts.next++;if(nextGate)return nextGate.promise;const sample=samples[nativeIndex++];return sample?{done:false,value:sample}:{done:true,value:undefined};},
   async return(){counts.returned++;return {done:true,value:undefined};}};},
  createTransformer:()=>{counts.transformers++;return {cleanup:{workerTerminated:true,acknowledged:true},async transform(value){
   counts.transforms++;const frame=value as unknown as Frame;frame.close();if(transformGate)return transformGate.promise;
   return {width:frame.sample.width,height:frame.sample.height,pixels:frame.sample.pixels.slice(),metadata:receipt(frame.sample)};
  },async dispose(){counts.transformDispose++;}};},
  createCanvas:()=>ownedCanvas as unknown as HTMLCanvasElement,
  imageData:(data,width,height)=>({data,width,height}) as ImageData,
  hash:async data=>hashGate?hashGate.promise:digest(data),yieldTask:async()=>{counts.yields++;},now:()=>0,
 };
 return {samples,canvases,ownedCanvas,counts,platform,
  nextGate:()=>nextGate=deferred<IteratorResult<ComparisonNativeSample>>(),
  hashGate:()=>hashGate=deferred<string>(),transformGate:()=>transformGate=deferred<NativeYuvTransformResult>()};
}
const source=new Blob(['small preserved source']);
const use=(frame:number,time:number)=>({frame,sourceFrameId:frame+100,time,phase:'input'});

test('control preserves CanvasSink ordering, duration zero, explicit missing native hashes and actual-use links',async()=>{
 const f=fixture();f.samples[1].duration=0;
 const comparison=createComparisonFrames(source,'canvas-control',new AbortController().signal,f.platform);
 assert.equal(f.counts.input,0,'constructing before model preparation must remain lazy');
 const first=await comparison.frames.next();assert.equal(first.value?.element,f.canvases[0]);assert.equal(first.value?.time,0);
 assert.equal(first.value?.provenance,undefined);assert.equal(f.counts.next,1);
 comparison.noteConsumed(use(1,0));comparison.noteConsumed(use(1,0));
 const second=await comparison.frames.next();assert.equal(second.value?.time,.04);comparison.noteConsumed(use(2,.04));
 assert.equal((await comparison.frames.next()).done,true);await comparison.dispose();
 const result=comparison.snapshot();assert.equal(result.complete,true);assert.equal(result.produced,2);assert.equal(result.consumed,2);
 assert.equal(result.receipts[1].duration,0);assert.equal(result.receipts[0].postPaintRgbaSha256,digest(f.samples[0].pixels));
 for(const item of result.receipts){assert.equal(item.native,null);assert.equal(item.nativeSha256,null);assert.equal(item.recipeId,null);assert.equal(item.generatedRgbaSha256,null);}
 assert.equal(f.counts.canvasSamples,1);assert.equal(f.counts.nativeSamples,0);assert.equal(f.counts.transformers,0);
 assert.equal(f.counts.dispose,1);assert.equal(f.counts.returned,1);assert.equal(result.cleanup.pendingOperations,0);
 assert.equal(result.cleanup.sourceReferenceReleased,true);
 assert.equal(result.actualAcquisitionRgbaHashMeasured,false);assert.match(result.hashScope,/before scanner copying/);
 result.receipts[0].pts=99;assert.equal(comparison.snapshot().receipts[0].pts,0,'callers must not mutate stored receipts');
});

test('native closes sample and transferred frame before yielding, reuses one canvas, and matches generated/post-paint bytes',async()=>{
 const f=fixture(),comparison=createComparisonFrames(source,'native-yuv',new AbortController().signal,f.platform);
 for(let index=0;index<2;index++){
  const next=await comparison.frames.next();assert.equal(next.value?.element,f.ownedCanvas);assert.equal(next.value?.provenance,undefined);
  assert.equal(f.samples[index].closed,1);assert.equal(f.samples[index].frames[0].closed,1);
  assert.equal(comparison.stats.cleanup.canvasCleared,false);comparison.noteConsumed(use(index+1,f.samples[index].timestamp));
 }
 assert.equal((await comparison.frames.next()).done,true);await comparison.dispose();
 const result=comparison.snapshot();assert.equal(result.complete,true);assert.equal(result.produced,2);assert.equal(result.nativeSamplesClosed,2);
 assert.equal(f.counts.transformers,1);assert.equal(f.counts.transformDispose,1);assert.equal(f.counts.nativeSamples,1);assert.equal(f.counts.canvasSamples,0);
 assert.equal(f.ownedCanvas.width,0);assert.equal(f.ownedCanvas.height,0);assert.equal(result.cleanup.canvasCleared,true);
 assert.equal(result.cleanup.sourceReferenceReleased,true);
 assert.equal(result.maxApplicationPixelArrayBytes,32);assert.equal(result.cleanup.transformerDisposed,true);
 for(const item of result.receipts){assert.equal(item.generatedRgbaSha256,item.postPaintRgbaSha256);assert.equal(item.native?.frameClosed,true);assert.ok(item.processingUse);}
});

test('pre-start dispose owns no decoder or worker and refuses later iteration',async()=>{
 const f=fixture(),comparison=createComparisonFrames(source,'native-yuv',new AbortController().signal,f.platform);
 await comparison.dispose();await comparison.dispose();assert.equal(f.counts.input,0);assert.equal(f.counts.transformers,0);
 assert.equal(comparison.stats.finished,true);assert.equal(comparison.stats.complete,false);
 assert.equal((await comparison.frames.next()).done,true);
});

test('advancing without an actual use fails and retains an explicitly unconsumed receipt',async()=>{
 const f=fixture(),comparison=createComparisonFrames(source,'native-yuv',new AbortController().signal,f.platform);
 await comparison.frames.next();await assert.rejects(comparison.frames.next(),/actual scanner use/);await comparison.dispose();
 assert.equal(comparison.stats.unconsumed,1);assert.equal(comparison.stats.complete,false);assert.equal(comparison.stats.consumed,0);
 assert.equal(f.counts.next,1);assert.equal(f.counts.dispose,1);assert.equal(f.counts.transformDispose,1);assert.equal(f.samples[0].closed,1);
});

test('early consumer return is partial, releases resources and does not invent consumption',async()=>{
 const f=fixture(),comparison=createComparisonFrames(source,'native-yuv',new AbortController().signal,f.platform);
 await comparison.frames.next();await comparison.frames.return(undefined);await comparison.dispose();
 assert.equal(comparison.stats.streamCompleted,false);assert.equal(comparison.stats.complete,false);assert.equal(comparison.stats.unconsumed,1);
 assert.equal(f.counts.dispose,1);assert.equal(f.counts.returned,1);assert.equal(f.counts.transformDispose,1);assert.equal(f.ownedCanvas.width,0);
});

test('wrong time/phase, conflicting duplicate, and stale IDs cannot become successful input links',async()=>{
 for(const wrong of [{...use(1,0),time:.04},{...use(1,0),phase:'recovery'},{...use(1,0),sourceFrameId:0}]){
  const f=fixture(),comparison=createComparisonFrames(source,'canvas-control',new AbortController().signal,f.platform);
  await comparison.frames.next();assert.throws(()=>comparison.noteConsumed(wrong),/does not match/);await comparison.dispose();
  assert.equal(comparison.stats.linkErrors,1);assert.equal(comparison.stats.complete,false);
  assert.equal(comparison.stats.recoveryUseEvents,wrong.phase==='recovery'?1:0);
 }
 const f=fixture();f.samples[1].timestamp=0;
 const comparison=createComparisonFrames(source,'canvas-control',new AbortController().signal,f.platform);
 await comparison.frames.next();comparison.noteConsumed(use(1,0));
 assert.throws(()=>comparison.noteConsumed(use(2,0)),/conflicting/);
 await comparison.frames.next();assert.throws(()=>comparison.noteConsumed(use(1,0)),/stale/);await comparison.dispose();
 assert.equal(comparison.stats.consumed,1);assert.equal(comparison.stats.linkErrors,2);
});

test('post-paint mismatch is rejected before yield, while native owners and canvas still release',async()=>{
 const f=fixture();f.ownedCanvas.corrupt=true;
 const comparison=createComparisonFrames(source,'native-yuv',new AbortController().signal,f.platform);
 await assert.rejects(comparison.frames.next(),/post-paint RGBA do not match/);await comparison.dispose();
 assert.equal(comparison.stats.produced,0);assert.equal(f.samples[0].closed,1);assert.equal(f.samples[0].frames[0].closed,1);
 assert.equal(f.counts.dispose,1);assert.equal(f.counts.transformDispose,1);assert.equal(f.ownedCanvas.width,0);
});

test('frame/metadata bounds reject extra work without accumulating pixel payloads',async()=>{
 for(const limits of [{maxFrames:1},{metadataBytes:200}]){
  const f=fixture();f.platform.limits=limits;
  const comparison=createComparisonFrames(source,'native-yuv',new AbortController().signal,f.platform);
  if('maxFrames'in limits){await comparison.frames.next();comparison.noteConsumed(use(1,0));}
  await assert.rejects(comparison.frames.next(),/bound exceeded/);await comparison.dispose();
  assert.ok(comparison.stats.produced<=1);assert.equal(comparison.stats.complete,false);
  assert.equal(f.counts.dispose,1);assert.equal(f.counts.transformDispose,1);
  assert.doesNotMatch(JSON.stringify(comparison.snapshot()),/"pixels"|"element"|"buffer"/);
 }
 const f=fixture();f.samples[0].width=20_000;f.samples[0].height=20_000;
 // Control canvas dimensions are independently bounded before readback/hash.
 f.canvases[0].width=20_000;f.canvases[0].height=20_000;
 const comparison=createComparisonFrames(source,'canvas-control',new AbortController().signal,f.platform);
 await assert.rejects(comparison.frames.next(),/frame size/);await comparison.dispose();assert.equal(f.canvases[0].reads,0);
});

test('aborted pending native next closes a late owned sample and never starts a transform',async()=>{
 const f=fixture(),gate=f.nextGate(),abort=new AbortController(),comparison=createComparisonFrames(source,'native-yuv',abort.signal,f.platform);
 const pending=comparison.frames.next();await settled();assert.equal(f.counts.next,1);abort.abort(new DOMException('stop','AbortError'));
 await assert.rejects(pending,/stop/);await comparison.dispose();
 assert.equal(f.counts.transforms,0);assert.equal(f.counts.dispose,1);assert.equal(comparison.stats.cleanup.pendingOperations,1);
 gate.resolve({done:false,value:f.samples[0]});await settled();assert.equal(f.samples[0].closed,1);
 assert.equal(comparison.stats.cleanup.pendingOperations,0);assert.equal(comparison.stats.produced,0);assert.equal(comparison.stats.complete,false);
});

test('abort during post-paint SHA does not yield stale pixels or retain the canvas',async()=>{
 const f=fixture(),gate=f.hashGate(),abort=new AbortController(),comparison=createComparisonFrames(source,'native-yuv',abort.signal,f.platform);
 const pending=comparison.frames.next();await settled();assert.equal(f.ownedCanvas.reads,1);abort.abort(new DOMException('stop hash','AbortError'));
 await assert.rejects(pending,/stop hash/);await comparison.dispose();assert.equal(f.samples[0].closed,1);assert.equal(f.counts.transformDispose,1);
 assert.equal(f.ownedCanvas.width,0);assert.equal(comparison.stats.produced,0);assert.equal(comparison.stats.cleanup.pendingOperations,1);
 gate.resolve(digest(f.samples[0].pixels));await settled();assert.equal(comparison.stats.cleanup.pendingOperations,0);
});

test('invalid sample order/metadata and cleanup failures remain failed rather than a complete run',async()=>{
 const f=fixture();f.samples[1].timestamp=-1;
 const comparison=createComparisonFrames(source,'native-yuv',new AbortController().signal,f.platform);
 await comparison.frames.next();comparison.noteConsumed(use(1,0));await assert.rejects(comparison.frames.next(),/sample order/);await comparison.dispose();
 assert.equal(f.samples[1].closed,1);assert.equal(f.samples[1].frames.length,0);assert.equal(comparison.stats.complete,false);
 const g=fixture(1);g.platform.createInput=()=>({getPrimaryVideoTrack:async()=>({id:9,canDecode:async()=>true,computeDuration:async()=>.04}),dispose(){throw Error('dispose failed');}});
 const failed=createComparisonFrames(source,'canvas-control',new AbortController().signal,g.platform);
 await failed.frames.next();failed.noteConsumed(use(1,0));await assert.rejects(failed.frames.next(),/cleanup failed/);await failed.dispose();
 assert.equal(failed.stats.complete,false);assert.equal(failed.stats.cleanup.inputDisposed,false);assert.match(failed.stats.cleanup.errors[0],/dispose failed/);
});

test('constructor rejects invalid source/mode/relaxed limits before opening anything',()=>{
 const f=fixture();assert.throws(()=>createComparisonFrames(new Blob([]),'native-yuv',new AbortController().signal,f.platform),/Invalid comparison input/);
 assert.throws(()=>createComparisonFrames(source,'other' as 'native-yuv',new AbortController().signal,f.platform),/Invalid comparison input/);
 f.platform.limits={maxFrames:COMPARISON_FRAME_LIMITS.maxFrames+1};assert.throws(()=>createComparisonFrames(source,'canvas-control',new AbortController().signal,f.platform),/Invalid comparison limits/);
 assert.equal(f.counts.input,0);
});
