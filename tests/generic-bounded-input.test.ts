import test from 'node:test';
import assert from 'node:assert/strict';
import {fastCompress,packPixels} from '../src/features/card-scanner/exact-recording-codec';
import {createGenericBoundedInput} from '../src/features/card-scanner/generic-bounded-input';
import type {BoundedReadSource,GenericInputSpec} from '../src/features/card-scanner/generic-bounded-input';
import {decodeFastPixelPatchFromSource} from '../src/features/card-scanner/streaming-delta-source';

const noWait=async()=>{};
const tick=()=>new Promise<void>(resolve=>setImmediate(resolve));
function noise(length:number,seed=17):Uint8Array<ArrayBuffer> {
  const bytes=new Uint8Array(length);let state=seed;
  for(let i=0;i<length;i++){state^=state<<13;state^=state>>>17;state^=state<<5;bytes[i]=state&255;}
  return bytes;
}
function raw(packed:Uint8Array):Uint8Array<ArrayBuffer> {
  const result=new Uint8Array(packed.length+5);new DataView(result.buffer).setUint32(1,packed.length,true);result.set(packed,5);return result;
}
function range(bytes:Uint8Array<ArrayBuffer>,options:{start?:number;short?:number;async?:boolean}={}){
  const start=options.start??0,requests:{offset:number;length:number}[]=[];
  const source:BoundedReadSource={snapshot:()=>({byteLength:start+bytes.length,revision:'immutable-fixture-v1'}),
    read:(offset,length)=>{
      requests.push({offset,length});assert.ok(length>0&&length<=32768);assert.ok(offset>=start&&offset+length<=start+bytes.length);
      const take=Math.min(length,options.short??length),result=bytes.slice(offset-start,offset-start+take);
      return options.async?Promise.resolve(result):result;
    }};
  const spec:GenericInputSpec={kind:'range',source,start,length:bytes.length};
  return {spec,source,requests};
}
function deferred<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(settle=>{resolve=settle;});return {promise,resolve};}

test('sync/async range input, positive short reads and 1/7/32768 boundaries preserve copy/XOR pixels',async()=>{
  for(const length of [0,1,16383,16384,16385,65539]){
    const previous=noise(length),current=previous.slice();if(length){current[0]^=117;current[length-1]^=13;}
    for(const xor of [false,true])for(const chunkBytes of [1,7,32768])for(const async of [false,true]){
      const encoded=fastCompress(packPixels(current,previous,xor));
      const {spec,requests}=range(encoded,{start:1_000_000_000,async,short:chunkBytes===32768?997:undefined});
      const target=previous.slice(),result=await decodeFastPixelPatchFromSource(spec,target,{xor,chunkBytes,yieldTask:noWait});
      assert.equal(result.pixels,target);assert.deepEqual(result.pixels,current);
      assert.equal(result.stats.input.bytes,encoded.length);assert.equal(result.stats.input.eof,true);
      assert.equal(result.stats.input.disposed,true);assert.equal(result.stats.input.readPending,false);
      assert.equal(requests[0].offset,1_000_000_000);assert.ok(requests.every(read=>read.length<=chunkBytes));
    }
  }
});
test('range decoder requests only bounded subranges, without constructing a payload Blob',async()=>{
  const current=noise(256*1024),encoded=raw(packPixels(current)),input=range(encoded,{start:8193});
  const result=await decodeFastPixelPatchFromSource(input.spec,new Uint8Array(current.length),{yieldTask:noWait});
  assert.deepEqual(result.pixels,current);assert.ok(input.requests.length>8);
  assert.equal(result.stats.peakInputBackingBytes,32768);
  assert.equal(result.stats.peakExplicitOwnedBytes,current.length+32768+13);
  assert.equal(input.requests.at(-1)!.offset+input.requests.at(-1)!.length,8193+encoded.length);
});
test('Blob BYOB, auto and explicit slice adapters retain byte parity',async()=>{
  const pixels=noise(32769),encoded=fastCompress(packPixels(pixels));
  for(const inputMode of ['byob','auto','slice'] as const){
    const result=await decodeFastPixelPatchFromSource({kind:'blob',blob:new Blob([encoded]),inputMode},new Uint8Array(pixels.length),{yieldTask:noWait});
    assert.deepEqual(result.pixels,pixels);assert.equal(result.stats.input.blob!.actual,inputMode==='slice'?'slice':'byob');
    assert.ok(result.stats.input.blob!.peakBackingBytes<=32768);assert.equal(result.stats.input.blob!.disposed,true);
  }
});
test('source bounds and metadata are checked before any native read',async()=>{
  let reads=0;const source:BoundedReadSource={snapshot:()=>({byteLength:100,revision:'r1'}),read:()=>{reads++;throw Error('must not read');}};
  for(const [start,length] of [[-1,9],[0,-1],[0,NaN],[0,Infinity],[0,101],[99,2],[Number.MAX_SAFE_INTEGER,1],[0.5,9]])
    await assert.rejects(createGenericBoundedInput({kind:'range',source,start,length}));
  for(const changed of [{revision:''},{revision:1},{byteLength:NaN},{byteLength:1.5},{extra:true}]){
    const broken={...source,snapshot:()=>({byteLength:100,revision:'r1',...changed})};
    await assert.rejects(createGenericBoundedInput({kind:'range',source:broken as never,start:0,length:9}));
  }
  assert.equal(reads,0);
});
test('zero, extra, shared, resizable and large-backing read results fail before publication',async()=>{
  const bytes=raw(packPixels(new Uint8Array(1))),invalid=[new Uint8Array(0),new Uint8Array(8),
    new Uint8Array(new ArrayBuffer(65536),0,1),new Uint8Array(new ArrayBuffer(16),1,1),
    new Uint8Array(new SharedArrayBuffer(1)),new Uint8Array(new ArrayBuffer(1,{maxByteLength:2}))];
  for(const result of invalid){
    const source:BoundedReadSource={snapshot:()=>({byteLength:bytes.length,revision:'r1'}),read:()=>result as Uint8Array<ArrayBuffer>};
    let published=false;
    await assert.rejects(async()=>{await decodeFastPixelPatchFromSource({kind:'range',source,start:0,length:bytes.length},new Uint8Array(1),{chunkBytes:7,yieldTask:noWait});published=true;});
    assert.equal(published,false);
  }
});
test('reported source length, revision or read-function changes invalidate the owned partial target',async()=>{
  const bytes=raw(packPixels(new Uint8Array(32769).fill(31)));
  for(const mutation of ['length','revision','read'] as const){
    let revision='r1',byteLength=bytes.length;
    const source:BoundedReadSource={snapshot:()=>({byteLength,revision}),read:(offset,length)=>{
      if(mutation==='length')byteLength++;else if(mutation==='revision')revision='r2';else source.read=()=>{throw Error('replacement read');};
      return bytes.slice(offset,offset+length);
    }};
    await assert.rejects(decodeFastPixelPatchFromSource({kind:'range',source,start:0,length:bytes.length},new Uint8Array(32769),
      {chunkBytes:7,yieldTask:noWait}),/changed/);
  }
});
test('source mutation during a yield is detected before continued patch application',async()=>{
  const current=new Uint8Array(32769).fill(23),bytes=raw(packPixels(current));let revision='r1';
  const source:BoundedReadSource={snapshot:()=>({byteLength:bytes.length,revision}),read:(offset,length)=>bytes.slice(offset,offset+length)};
  let yields=0;
  await assert.rejects(decodeFastPixelPatchFromSource({kind:'range',source,start:0,length:bytes.length},new Uint8Array(current.length),
    {yieldAfterBytes:32,yieldTask:async()=>{yields++;revision='r2';}}),/changed/);
  assert.equal(yields,1);
});
test('read failures, truncation, output alias and malformed body never publish a prefix result',async()=>{
  const pixels=noise(64),bytes=raw(packPixels(pixels));
  const failing:BoundedReadSource={snapshot:()=>({byteLength:bytes.length,revision:'r1'}),read:()=>{throw Error('I/O injected');}};
  await assert.rejects(decodeFastPixelPatchFromSource({kind:'range',source:failing,start:0,length:bytes.length},new Uint8Array(64)),/I\/O/);
  for(let end=0;end<bytes.length;end++){
    const input=range(bytes.slice(0,end));
    await assert.rejects(decodeFastPixelPatchFromSource(input.spec,new Uint8Array(64),{chunkBytes:7,yieldTask:noWait}));
  }
  const target=new Uint8Array(64),alias:BoundedReadSource={snapshot:()=>({byteLength:9,revision:'r1'}),read:()=>target.subarray(0,7)};
  await assert.rejects(decodeFastPixelPatchFromSource({kind:'range',source:alias,start:0,length:9},target,{chunkBytes:64}),/input backing/);
});
test('abort wins an outstanding range read; late settlement does not resume or mutate target',async()=>{
  const bytes=raw(packPixels(new Uint8Array(64).fill(55))),pending=deferred<Uint8Array<ArrayBuffer>>(),posted=deferred<void>();
  let reads=0;const controller=new AbortController(),target=new Uint8Array(64);
  const source:BoundedReadSource={snapshot:()=>({byteLength:bytes.length,revision:'r1'}),read:(offset,length)=>{
    reads++;if(reads===1)return bytes.slice(offset,offset+length);posted.resolve();return pending.promise;
  }};
  let published=false;
  const decoding=decodeFastPixelPatchFromSource({kind:'range',source,start:0,length:bytes.length},target,{chunkBytes:7,signal:controller.signal,yieldTask:noWait})
    .then(()=>{published=true;});
  await posted.promise;controller.abort();await assert.rejects(decoding,{name:'AbortError'});
  const afterAbort=target.slice();pending.resolve(bytes.slice(7,14));await tick();
  assert.deepEqual(target,afterAbort);assert.equal(published,false);assert.equal(reads,2);
});
test('outstanding range read stays explicit after disposal, without closing the shared source',async()=>{
  const pending=deferred<Uint8Array<ArrayBuffer>>(),posted=deferred<void>(),controller=new AbortController();let closed=0;
  const source={snapshot:()=>({byteLength:9,revision:'r1'}),read:()=>{posted.resolve();return pending.promise;},close:()=>{closed++;}};
  const input=await createGenericBoundedInput({kind:'range',source,start:0,length:9},{signal:controller.signal});
  const reading=input.next();await posted.promise;controller.abort();await assert.rejects(reading,{name:'AbortError'});
  await input.dispose();assert.equal(input.stats.readPending,true);assert.equal(closed,0);
  pending.resolve(new Uint8Array(9));await tick();assert.equal(input.stats.readPending,false);assert.equal(input.stats.bytes,0);
});
test('disposal before queued native read prevents that read from being posted',async()=>{
  let calls=0;const source={snapshot:()=>({byteLength:9,revision:'r1'}),read:()=>{calls++;return new Uint8Array(9);}};
  const input=await createGenericBoundedInput({kind:'range',source,start:0,length:9});
  const pending=input.next();await input.dispose();await assert.rejects(pending,/disposed/);
  assert.equal(calls,0);assert.equal(input.stats.readPending,false);
});
test('concurrent reads and concurrent decoder use of one target are rejected',async()=>{
  const bytes=raw(packPixels(new Uint8Array(4))),pending=deferred<Uint8Array<ArrayBuffer>>(),posted=deferred<void>();
  const source:BoundedReadSource={snapshot:()=>({byteLength:bytes.length,revision:'r1'}),read:()=>{posted.resolve();return pending.promise;}};
  const controller=new AbortController(),spec:GenericInputSpec={kind:'range',source,start:0,length:bytes.length},target=new Uint8Array(4);
  const decoding=decodeFastPixelPatchFromSource(spec,target,{signal:controller.signal});await posted.promise;
  await assert.rejects(decodeFastPixelPatchFromSource(spec,target),/active decoder/);
  controller.abort();await assert.rejects(decoding,{name:'AbortError'});pending.resolve(bytes);await tick();
  const second=deferred<Uint8Array<ArrayBuffer>>(),again=deferred<void>();source.read=()=>{again.resolve();return second.promise;};
  const input=await createGenericBoundedInput(spec);const reading=input.next();await again.promise;
  await assert.rejects(input.next(),/concurrent/);second.resolve(bytes);await reading;await input.dispose();
});
test('abort also wins a custom stalled yield without publishing or continuing afterwards',async()=>{
  const current=new Uint8Array(1024).fill(7),input=range(raw(packPixels(current))),target=new Uint8Array(current.length);
  const paused=deferred<void>(),posted=deferred<void>(),controller=new AbortController();let resumed=0;
  const decoding=decodeFastPixelPatchFromSource(input.spec,target,{signal:controller.signal,yieldAfterBytes:1,
    yieldTask:()=>{posted.resolve();return paused.promise;}}).then(()=>{resumed++;});
  await posted.promise;controller.abort();await assert.rejects(decoding,{name:'AbortError'});
  const before=target.slice();paused.resolve();await tick();assert.equal(resumed,0);assert.deepEqual(target,before);
});
test('input specs/snapshots reject accessors without invoking them',async()=>{
  let invoked=0;
  const spec=Object.defineProperty({kind:'blob'},'blob',{get(){invoked++;return new Blob();},enumerable:true});
  await assert.rejects(createGenericBoundedInput(spec as never));
  const source={snapshot:()=>Object.defineProperty({revision:'r1'},'byteLength',{get(){invoked++;return 9;},enumerable:true}),read:()=>new Uint8Array(9)};
  await assert.rejects(createGenericBoundedInput({kind:'range',source:source as never,start:0,length:9}));
  assert.equal(invoked,0);
});
