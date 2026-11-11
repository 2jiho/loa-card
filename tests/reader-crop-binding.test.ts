import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createReaderCropBinding,createReaderCropBindingObserver} from '../dev/reader-crop-binding';
import {pixelHash} from '../src/features/card-scanner/reproduction/recording-frame-integrity';
import type {RecognitionInputMeta,ReaderCropClaim,RecognitionInputObserver} from '../src/features/card-scanner/recognition/recognition-input-observer';

const signal=()=>new AbortController().signal;
async function fixture(){
 const bytes=Uint8ClampedArray.from([1,2,3,255,4,5,6,255]);
 const meta:RecognitionInputMeta={diagnosticReadId:1,processingFrame:3,slot:2,group:5,trace:1,pixelKey:'hint-only',
  source:{sessionId:'s',frameId:7,observationId:'o',captureOrder:4,captureTime:2,phase:'recovery',slot:2},
  stage:'full',stable:true,borderAlignment:1,sourceBox:{x:3,y:4,width:2,height:1},sourceWidth:10,sourceHeight:10,cropWidth:2,cropHeight:1};
 const claim:ReaderCropClaim={frame:{version:1,kind:'measured',sourceFrameId:9,acquisitionFrameId:7,captureTime:2,width:10,height:10,hash:'a'.repeat(64)},
  crop:{slot:2,content:{...meta.sourceBox},sha256:await pixelHash(new Uint8Array(bytes))}};
 let reads=0;
 const canvas={width:2,height:1,getContext:()=>({getImageData:()=>{reads++;return {data:bytes};}})} as unknown as HTMLCanvasElement;
 return {bytes,meta,claim,canvas,reads:()=>reads};
}
const defer=<T>()=>{let resolve!:(value:T)=>void;const promise=new Promise<T>(yes=>{resolve=yes;});return {promise,resolve};};

test('synchronous snapshot compares bound reader canvas with worker claim only',async()=>{
 const f=await fixture(),binding=createReaderCropBinding('s');
 const pending=binding.observe(f.meta,f.claim,f.canvas,signal());assert.equal(f.reads(),1,'snapshot occurs before returning');
 f.bytes[0]=99;f.meta.sourceBox.x=8;
 const result=await pending;
 assert.equal(result.status,'match');assert.equal(result.actualSha256,f.claim.crop.sha256);
 assert.equal(result.sourceFrameId,9);assert.equal(result.invocationId,1);assert.equal(result.source?.frameId,7);
 assert.equal(result.modelExecutionVerified,false);assert.equal(result.independentObservation,false);assert.equal(result.completionEvidence,false);
 assert.equal(binding.stats().pending,0);assert.equal(binding.stats().pendingBytes,0);
});

test('changed canvas is a mismatch and one invocation cannot be reused',async()=>{
 const f=await fixture(),binding=createReaderCropBinding('s');f.bytes[0]=77;
 assert.equal((await binding.observe(f.meta,f.claim,f.canvas,signal())).status,'mismatch');
 const repeated=await binding.observe(f.meta,f.claim,f.canvas,signal());assert.equal(repeated.reason,'duplicate-invocation');
 assert.equal(f.reads(),1);
});

test('claim is required and foreign frame, slot, time or geometry never becomes a match',async()=>{
 const f=await fixture(),binding=createReaderCropBinding('s');
 assert.equal((await binding.observe(f.meta,undefined,f.canvas,signal())).reason,'claim-missing');
 const cases:ReaderCropClaim[]=[
  {...f.claim,frame:{...f.claim.frame,acquisitionFrameId:8}},
  {...f.claim,frame:{...f.claim.frame,captureTime:3}},
  {...f.claim,frame:{...f.claim.frame,width:11}},
  {...f.claim,crop:{...f.claim.crop,slot:1}},
  {...f.claim,crop:{...f.claim.crop,content:{...f.claim.crop.content,x:3.5}}},
  {...f.claim,crop:{...f.claim.crop,sha256:'not-a-hash'}},
 ];
 for(const claim of cases)assert.equal((await binding.observe(f.meta,claim,f.canvas,signal())).status,'unsupported');
 assert.equal(f.reads(),0);assert.equal(binding.stats().attempts,0);
 const other=createReaderCropBinding('other');assert.equal((await other.observe(f.meta,f.claim,f.canvas,signal())).status,'unsupported');
});

test('fractional geometry, resized, transparent or unreadable canvas is not accepted',async()=>{
 const f=await fixture(),binding=createReaderCropBinding('s');
 const run=(id:number,canvas:HTMLCanvasElement,meta:Partial<RecognitionInputMeta>={})=>binding.observe({...f.meta,...meta,diagnosticReadId:id},f.claim,canvas,signal());
 assert.equal((await run(1,f.canvas,{sourceBox:{...f.meta.sourceBox,x:3.5}})).status,'unsupported');
 const wrong={...f.canvas,width:3} as HTMLCanvasElement;
 assert.equal((await run(2,wrong)).reason,'canvas-size');
 f.bytes[3]=0;assert.equal((await run(3,f.canvas)).reason,'nonopaque');
 const tainted={width:2,height:1,getContext:()=>({getImageData:()=>{throw Error('security');}})} as unknown as HTMLCanvasElement;
 assert.equal((await run(4,tainted)).reason,'canvas-readback');
});

test('timed out digest retains its memory credit until the real operation settles',async()=>{
 const f=await fixture(),gate=defer<string>(),binding=createReaderCropBinding('s',{maxPending:1,maxPendingBytes:8,timeoutMs:5,hash:()=>gate.promise});
 const timed=binding.observe(f.meta,f.claim,f.canvas,signal());
 assert.equal((await timed).status,'timeout');assert.deepEqual(binding.stats(),{attempts:1,pending:1,pendingBytes:8,closed:false});
 const blocked=await binding.observe({...f.meta,diagnosticReadId:2},f.claim,f.canvas,signal());assert.equal(blocked.status,'capacity');
 gate.resolve(f.claim.crop.sha256);await new Promise(resolve=>setImmediate(resolve));
 assert.equal(binding.stats().pendingBytes,0);assert.equal(binding.stats().pending,0);
});

test('abort and close resolve outstanding diagnostics without allowing late matches',async()=>{
 const f=await fixture(),gate=defer<string>(),binding=createReaderCropBinding('s',{hash:()=>gate.promise}),controller=new AbortController();
 const pending=binding.observe(f.meta,f.claim,f.canvas,controller.signal);controller.abort();
 assert.equal((await pending).status,'cancelled');assert.equal(binding.stats().pending,1);
 binding.close();assert.equal((await binding.observe({...f.meta,diagnosticReadId:2},f.claim,f.canvas,signal())).status,'cancelled');
 gate.resolve(f.claim.crop.sha256);await new Promise(resolve=>setImmediate(resolve));assert.equal(binding.stats().pending,0);
});

test('observer composes existing diagnostics and never emits after close',async()=>{
 const f=await fixture(),out:string[]=[],legacy:string[]=[];
 const other:RecognitionInputObserver={begin:()=>({captureInput:()=>{legacy.push('input');},captureCard:()=>legacy.push('card'),
  captureLabel:()=>legacy.push('label'),finish:()=>legacy.push('finish')})};
 const gate=defer<string>(),wrapper=createReaderCropBindingObserver(null,signal(),r=>out.push(r.status),{hash:()=>gate.promise},other);
 const inspection=wrapper.observer.begin(f.meta)!;inspection.captureInput?.(f.canvas,f.claim);inspection.captureCard(f.canvas);
 assert.deepEqual(legacy,['input','card']);assert.equal(wrapper.stats().pending,1);assert.equal(wrapper.stats().captures,1);
 const closing=wrapper.close();assert.equal(closing.pending,1);assert.equal(closing.accountingComplete,false);
 gate.resolve(f.claim.crop.sha256);await new Promise(resolve=>setImmediate(resolve));
 assert.deepEqual(out,[]);assert.equal(wrapper.stats().closed,true);assert.equal(wrapper.stats().pending,0);
 assert.equal(wrapper.stats().delivered,0);assert.equal(wrapper.stats().accountingComplete,false);
 const second=createReaderCropBindingObserver(null,signal(),r=>out.push(r.reason??''));
 second.observer.begin(f.meta)!.captureInput?.(f.canvas);await Promise.resolve();
 assert.deepEqual(out,['claim-missing']);assert.equal(second.stats().captures,1);assert.equal(second.stats().delivered,1);
 assert.equal(second.close().accountingComplete,true,'a delivered unavailable result is complete accounting, not a pixel match');
});

test('observer reports callback failures, rejected metadata and bounded accounting loss',async()=>{
 const f=await fixture(),legacy:string[]=[];
 const throwing=createReaderCropBindingObserver(null,signal(),()=>{throw Error('consumer');});
 throwing.observer.begin(f.meta)!.captureInput?.(f.canvas);await Promise.resolve();
 assert.equal(throwing.stats().captures,1);assert.equal(throwing.stats().delivered,0);assert.equal(throwing.stats().failures,1);
 assert.equal(throwing.close().accountingComplete,false);
 const other:RecognitionInputObserver={begin:()=>({captureInput:()=>legacy.push('input'),captureCard:()=>{},captureLabel:()=>{},finish:()=>{}})};
 const broken=createReaderCropBindingObserver(null,signal(),()=>{}, {},other);
 broken.observer.begin({...f.meta,source:{...f.meta.source,sessionId:''}})!.captureInput?.(f.canvas,f.claim);
 assert.equal(broken.stats().internalFailures,1);assert.equal(broken.stats().failures,1);assert.deepEqual(legacy,['input']);
 assert.equal(broken.close().accountingComplete,false);
 const limited=createReaderCropBindingObserver(null,signal(),()=>{}, {maxCaptureEvents:1},other);
 limited.observer.begin(f.meta)!.captureInput?.(f.canvas);
 limited.observer.begin({...f.meta,diagnosticReadId:2})!.captureInput?.(f.canvas);
 await Promise.resolve();assert.equal(limited.stats().captures,1);assert.equal(limited.stats().delivered,1);
 assert.equal(limited.stats().countersTruncated,true);assert.equal(limited.close().accountingComplete,false);
 assert.deepEqual(legacy,['input','input','input'],'diagnostic cap does not suppress the existing observer');
 assert.throws(()=>createReaderCropBindingObserver(null,signal(),()=>{},{maxCaptureEvents:0}),/capture limit/);
});

test('invalid limits and failed digest never become positive evidence',async()=>{
 assert.throws(()=>createReaderCropBinding('s',{maxPending:0}),/limits/);
 const f=await fixture(),bad=createReaderCropBinding('s',{hash:async()=>{throw Error('digest');}});
 const result=await bad.observe(f.meta,f.claim,f.canvas,signal());assert.equal(result.status,'unavailable');assert.equal(result.reason,'digest-error');
});
