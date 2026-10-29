import test from 'node:test';
import assert from 'node:assert/strict';
import {createBoundedBlobInput,type BoundedInputMode} from '../src/features/card-scanner/bounded-blob-input';
import {decodeFastPixelPatchFromSource,type SourceStreamPatchOptions} from '../src/features/card-scanner/streaming-delta-source';
import {fastCompress,packPixels} from '../src/features/card-scanner/exact-recording-codec';

const decodeBlobPatch=(blob:Blob,target:Uint8Array<ArrayBuffer>,options:SourceStreamPatchOptions & {inputMode?:BoundedInputMode}={})=>{
  const {inputMode,...decodeOptions}=options;
  return decodeFastPixelPatchFromSource({kind:'blob',blob,inputMode},target,decodeOptions);
};
const noWait=async()=>{};
const bytes=(size:number)=>Uint8Array.from({length:size},(_,i)=>(i*73+i*i*3)&255);
class NonByteBlob extends Blob {
  calls=0;
  override stream(){this.calls++;return new ReadableStream<Uint8Array>({start(controller){controller.close();}});}
}

test('native Node BYOB reuses one fixed backing by detaching the preceding loan and validates EOF',async()=>{
  const input=bytes(83),source=await createBoundedBlobInput(new Blob([input]),{mode:'byob',chunkBytes:7}),actual:number[]=[];
  let previous:ArrayBuffer|undefined;
  try{
    while(true){
      const chunk=await source.next();
      if(previous)assert.equal(previous.byteLength,0,'next BYOB read transferred the previous backing');
      if(!chunk)break;
      assert.equal(chunk.byteOffset,0);assert.equal(chunk.buffer.byteLength,7);previous=chunk.buffer;actual.push(...chunk);
    }
  }finally{await source.dispose();}
  assert.deepEqual(actual,[...input]);const stats=source.stats;
  assert.equal(stats.actual,'byob');assert.equal(stats.byobAvailable,true);assert.equal(stats.fallbackReason,null);
  assert.equal(stats.peakBackingBytes,7);assert.equal(stats.bytes,83);assert.equal(stats.eof,true);
  assert.equal(stats.disposed,true);assert.equal(stats.lockReleased,true);assert.equal(stats.readPending,false);
});

test('native BYOB and explicit slice preserve raw/LZ4 bytes at1/7/32768-byte chunk boundaries',async()=>{
  for(const input of [bytes(512),new Uint8Array(32775)]){
    const encoded=fastCompress(packPixels(input));
    for(const inputMode of ['auto','byob','slice']as const)for(const chunkBytes of [1,7,32768]){
      const result=await decodeBlobPatch(new Blob([encoded]),new Uint8Array(input.length),{inputMode,chunkBytes,yieldTask:noWait});
      assert.deepEqual(result.pixels,input);assert.equal(result.stats.input.blob!.actual,inputMode==='slice'?'slice':'byob');
      assert.ok(result.stats.peakInputBackingBytes<=chunkBytes);assert.equal(result.stats.input.bytes,encoded.length);
      assert.equal(result.stats.input.eof,true);assert.equal(result.stats.input.disposed,true);
      if(inputMode!=='slice')assert.equal(result.stats.input.blob!.lockReleased,true);
      for(const timing of Object.values(result.stats.timing))assert.ok(Number.isFinite(timing)&&timing>=0);
    }
  }
});

test('unavailable BYOB negotiates an explicit auto fallback and strict BYOB rejects it',async()=>{
  const input=bytes(129),blob=new NonByteBlob([fastCompress(packPixels(input))]);
  const result=await decodeBlobPatch(blob,new Uint8Array(input.length),{inputMode:'auto',yieldTask:noWait});
  assert.deepEqual(result.pixels,input);assert.equal(result.stats.input.blob!.actual,'slice');
  assert.equal(result.stats.input.blob!.byobAvailable,false);assert.equal(result.stats.input.blob!.fallbackReason,'byob-unavailable');
  await assert.rejects(createBoundedBlobInput(blob,{mode:'byob'}),/BYOB unavailable/);
  const explicit=new NonByteBlob([fastCompress(packPixels(input))]);
  const sliced=await decodeBlobPatch(explicit,new Uint8Array(input.length),{inputMode:'slice',yieldTask:noWait});
  assert.deepEqual(sliced.pixels,input);assert.equal(explicit.calls,0);assert.equal(sliced.stats.input.blob!.fallbackReason,null);
});

test('a BYOB read error does not silently re-read the payload through slices',async()=>{
  let stream:ReadableStream<Uint8Array>|undefined,slices=0;
  class FailingBlob extends Blob {
    override stream(){stream=new ReadableStream({type:'bytes',pull(controller){controller.error(Error('injected read failure'));}});return stream;}
    override slice(start=0,end=this.size,type=''){slices++;return super.slice(start,end,type);}
  }
  const blob=new FailingBlob([new Uint8Array(20)]),source=await createBoundedBlobInput(blob,{mode:'auto'});
  await assert.rejects(source.next(),/injected read failure/);await source.dispose();
  assert.equal(slices,0);assert.equal(source.stats.actual,'byob');assert.equal(source.stats.fallbackReason,null);
  assert.equal(source.stats.lockReleased,true);assert.equal(stream!.locked,false);
});

test('abort cancels a pending BYOB request and releases its reader lock',async()=>{
  const controller=new AbortController();let cancelled=0,stream:ReadableStream<Uint8Array>|undefined;
  class PendingBlob extends Blob {override stream(){stream=new ReadableStream({type:'bytes',pull(){return new Promise(()=>{});},cancel(){cancelled++;}});return stream;}}
  const source=await createBoundedBlobInput(new PendingBlob([new Uint8Array(10)]),{mode:'byob',signal:controller.signal});
  const reading=source.next();controller.abort();await assert.rejects(reading,{name:'AbortError'});await source.dispose();
  assert.equal(cancelled,1);assert.equal(stream!.locked,false);assert.equal(source.stats.cancelRequested,true);
  assert.equal(source.stats.cancelSettled,true);assert.equal(source.stats.lockReleased,true);assert.equal(source.stats.readPending,false);
});

test('a stalled source cancellation has bounded cleanup and never prevents abort completion',async()=>{
  const controller=new AbortController();let stream:ReadableStream<Uint8Array>|undefined;
  class StalledBlob extends Blob {override stream(){stream=new ReadableStream({type:'bytes',pull(){return new Promise(()=>{});},cancel(){return new Promise(()=>{});}});return stream;}}
  const source=await createBoundedBlobInput(new StalledBlob([new Uint8Array(10)]),{mode:'byob',signal:controller.signal});
  const reading=source.next();controller.abort();await assert.rejects(reading,{name:'AbortError'});await source.dispose();
  assert.equal(source.stats.cleanupTimedOut,true);assert.equal(source.stats.cancelSettled,false);
  assert.equal(source.stats.lockReleased,true);assert.equal(stream!.locked,false);
});

test('slice fallback abort does not wait forever on an uncancellable underlying arrayBuffer',async()=>{
  const controller=new AbortController();
  class StalledSlice extends Blob {override slice(start=0,end=this.size,type=''){
    const result=super.slice(start,end,type);Object.defineProperty(result,'arrayBuffer',{value:()=>new Promise(()=>{})});return result;
  }}
  const source=await createBoundedBlobInput(new StalledSlice([new Uint8Array(10)]),{mode:'slice',signal:controller.signal});
  const reading=source.next();await Promise.resolve();controller.abort();await assert.rejects(reading,{name:'AbortError'});await source.dispose();
  assert.equal(source.stats.disposed,true);assert.equal(source.stats.readPending,true,'the native slice operation has no cancellation API');
});

function fakeReaderBlob(read:(view:Uint8Array<ArrayBuffer>)=>Promise<ReadableStreamReadResult<Uint8Array<ArrayBuffer>>>):Blob {
  class FakeBlob extends Blob {override stream(){return {getReader:()=>({read,cancel:async()=>{},releaseLock(){},closed:Promise.resolve()})} as never;}}
  return new FakeBlob([new Uint8Array(10)]);
}
test('a32KiB view on64KiB backing is rejected and a provider must transfer its loan',async()=>{
  const oversized=await createBoundedBlobInput(fakeReaderBlob(async view=>{
    structuredClone(view.buffer,{transfer:[view.buffer]});return {done:false,value:new Uint8Array(new ArrayBuffer(65536),0,32768)};
  }),{mode:'byob'});
  await assert.rejects(oversized.next(),/BYOB returned backing/);await oversized.dispose();
  const duplicated=await createBoundedBlobInput(fakeReaderBlob(async()=>({done:false,value:new Uint8Array(32768)})),{mode:'byob'});
  await assert.rejects(duplicated.next(),/BYOB loan not transferred/);await duplicated.dispose();
});

test('truncated and extra stream bytes cannot hide behind the Blob size or an expected-size read',async()=>{
  for(const extra of [false,true]){
    class WrongSize extends Blob {override stream(){return new ReadableStream({type:'bytes',start(controller){
      controller.enqueue(new Uint8Array(extra?11:9));controller.close();
    }});}}
    const source=await createBoundedBlobInput(new WrongSize([new Uint8Array(10)]),{mode:'byob'});
    try{
      if(extra)await assert.rejects(source.next(),/extra input/);
      else{assert.equal((await source.next())!.length,9);await assert.rejects(source.next(),/truncated input/);}
    }finally{await source.dispose();}
  }
});

test('concurrent reads and invalid chunk/mode requests cannot create a second input loan',async()=>{
  class Waiting extends Blob {override stream(){return new ReadableStream({type:'bytes',pull(){return new Promise(()=>{});}});}}
  const source=await createBoundedBlobInput(new Waiting([new Uint8Array(10)]),{mode:'byob'});
  const reading=source.next();await assert.rejects(source.next(),/concurrent read/);
  const rejected=assert.rejects(reading);await source.dispose();await rejected;
  for(const options of [{chunkBytes:0},{chunkBytes:32769},{mode:'wrong'}])
    await assert.rejects(createBoundedBlobInput(new Blob(),options as never),/options/);
});

test('a target detached while input negotiation awaits is rejected and the created reader is released',async()=>{
  const target=new Uint8Array(32);let stream:ReadableStream<Uint8Array>|undefined;
  class TransferTarget extends Blob {override stream(){structuredClone(target.buffer,{transfer:[target.buffer]});stream=super.stream();return stream;}}
  const encoded=fastCompress(packPixels(new Uint8Array(32)));
  await assert.rejects(decodeBlobPatch(new TransferTarget([encoded]),target,{inputMode:'byob'}),/owned target/);
  assert.equal(stream!.locked,false);
});
