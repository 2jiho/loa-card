import test from 'node:test';
import assert from 'node:assert/strict';
import {fastCompress,fastInflate,packPixels,unpackPixels} from '../src/features/card-scanner/exact-recording-codec';
import {decodeFastPixelPatchFromSource,STREAM_PATCH_SOURCE_LIMITS as STREAM_PATCH_LIMITS,type SourceStreamPatchOptions} from '../src/features/card-scanner/streaming-delta-source';
// Byte-level regression cases cover the explicit bounded slice input path.
// Separate tests exercise native BYOB, so these expectations remain identical.
const decodeFastPixelPatch=(blob:Blob,target:Uint8Array<ArrayBuffer>,options:SourceStreamPatchOptions={})=>{
  return decodeFastPixelPatchFromSource({kind:'blob',blob,inputMode:'slice'},target,options);
};

const BLOCK=16_384;
function noise(length:number,seed=0x12345678):Uint8Array<ArrayBuffer> {
  const bytes=new Uint8Array(length);let state=seed;
  for(let i=0;i<length;i++){state^=state<<13;state^=state>>>17;state^=state<<5;bytes[i]=state&255;}
  return bytes;
}
function raw(packed:Uint8Array):Uint8Array<ArrayBuffer> {
  const result=new Uint8Array(packed.length+5);new DataView(result.buffer).setUint32(1,packed.length,true);result.set(packed,5);return result;
}
function compressed(body:readonly number[]|Uint8Array,size:number):Uint8Array<ArrayBuffer> {
  const result=new Uint8Array(body.length+5);result[0]=1;new DataView(result.buffer).setUint32(1,size,true);result.set(body,5);return result;
}
function packed(records:readonly {from:number;bytes:Uint8Array;length?:number}[],count=records.length):Uint8Array<ArrayBuffer> {
  const result=new Uint8Array(4+records.reduce((sum,record)=>sum+8+record.bytes.length,0));
  const view=new DataView(result.buffer);view.setUint32(0,count,true);let offset=4;
  for(const record of records){view.setUint32(offset,record.from,true);view.setUint32(offset+4,record.length??record.bytes.length,true);
    result.set(record.bytes,offset+8);offset+=8+record.bytes.length;}
  return result;
}
const maximum=(target:Uint8Array)=>target.length+Math.ceil(target.length/BLOCK)*8+4;
function legacy(encoded:Uint8Array,target:Uint8Array<ArrayBuffer>,xor=false):Uint8Array<ArrayBuffer> {
  unpackPixels(fastInflate(encoded,maximum(target)),target,xor);return target;
}
const noWait=async()=>{};

class ReadSpy extends Blob {
  readonly reads:{start:number;end:number}[]=[];
  override arrayBuffer():Promise<ArrayBuffer>{throw Error('whole payload read forbidden');}
  override stream():ReadableStream<Uint8Array<ArrayBuffer>>{throw Error('implicit native stream chunk size is not bounded by this experiment');}
  override slice(start=0,end=this.size,type=''):Blob {
    this.reads.push({start,end});return super.slice(start,end,type);
  }
}

test('zero/tiny/16KiB boundaries and sparse copy/XOR match the current codec byte for byte',async()=>{
  for(const length of [0,1,4,BLOCK-1,BLOCK,BLOCK+1,BLOCK*2+11,200_000]){
    const previous=noise(length),current=previous.slice();
    if(length){current[0]^=123;current[length-1]^=9;if(length>BLOCK)current[BLOCK]^=51;}
    for(const xor of [false,true]){
      const encoded=fastCompress(packPixels(current,previous,xor));
      const target=previous.slice(),expected=legacy(encoded,previous.slice(),xor);
      const result=await decodeFastPixelPatch(new Blob([encoded]),target,{xor,yieldTask:noWait});
      assert.equal(result.pixels,target,'decoder returns only the consumed private target');
      assert.deepEqual(result.pixels,expected);assert.deepEqual(result.pixels,current);
      assert.equal(result.stats.scope,'explicit-decoder-buffers-only');
    }
  }
});

test('no-change patch count leaves the target unchanged without retaining a delta buffer',async()=>{
  const previous=noise(BLOCK*2+17),encoded=fastCompress(packPixels(previous,previous,true));
  const result=await decodeFastPixelPatch(new Blob([encoded]),previous.slice(),{xor:true,yieldTask:noWait});
  assert.deepEqual(result.pixels,previous);assert.equal(result.stats.patches,0);
  assert.equal(result.stats.decodedBytes,4);assert.equal(result.stats.codec,'raw');
  assert.equal(result.stats.historyBytes,0);assert.equal(result.stats.matchScratchBytes,0);
});

test('raw fallback and compressed overlap copies work across1/7/32768-byte input boundaries',async()=>{
  const inputs=[{input:noise(512),rawMode:true},{input:new Uint8Array(BLOCK*2+7),rawMode:false}];
  const modes=new Set<string>();
  for(const {input,rawMode} of inputs){
    // Even random pixels can compress through their patch header. Select the
    // valid raw wrapper explicitly so this test always covers both wire modes.
    const encoded=rawMode?raw(packPixels(input)):fastCompress(packPixels(input));
    for(const chunkBytes of [1,7,32768]){
      const result=await decodeFastPixelPatch(new Blob([encoded]),new Uint8Array(input.length),{chunkBytes,yieldTask:noWait});
      assert.deepEqual(result.pixels,input);assert.ok(result.stats.peakInputBackingBytes<=chunkBytes);modes.add(result.stats.codec);
    }
  }
  assert.deepEqual([...modes].sort(),['lz4','raw']);
});

test('an explicit distance1 overlapping LZ4 match reconstructs patch data',async()=>{
  // Twelve literal bytes encode one 512-byte patch header. One zero byte is
  // literal; distance1 then repeats it. The final literals are permitted by
  // the current structural reader even though this is a hand-written block.
  const header=[1,0,0,0,0,0,0,0,0,2,0,0,0];
  const body=[0xdf,...header,1,0,255,237]; //13 literals +511-byte match =524 packed bytes.
  const encoded=compressed(body,524);
  const expected=legacy(encoded,new Uint8Array(512));
  for(const chunkBytes of [1,7,32768]){
    const result=await decodeFastPixelPatch(new Blob([encoded]),new Uint8Array(512),{chunkBytes,yieldTask:noWait});
    assert.deepEqual(result.pixels,expected);assert.deepEqual(result.pixels,new Uint8Array(512));
  }
});

test('distance65535 crosses the rolling-history wrap without reading overwritten bytes',async()=>{
  const pixels=noise(BLOCK*4),delta=packPixels(pixels),literalLength=65535,matchLength=delta.length-literalLength;
  assert.equal(delta.length,65572);assert.equal(matchLength,37);
  // The final37 bytes are pixel payload, so repeating the first packed bytes
  // still produces a valid patch stream with a deliberately distant match.
  delta.set(delta.subarray(0,matchLength),literalLength);
  const body=new Uint8Array(1+257+literalLength+2+1);body[0]=0xff;
  body.fill(255,1,257);body[257]=240;body.set(delta.subarray(0,literalLength),258);
  const offset=258+literalLength;body[offset]=255;body[offset+1]=255;body[offset+2]=18;
  const encoded=compressed(body,delta.length),expected=legacy(encoded,new Uint8Array(pixels.length));
  for(const chunkBytes of [8191,32768]){
    const result=await decodeFastPixelPatch(new Blob([encoded]),new Uint8Array(pixels.length),{chunkBytes,yieldTask:noWait});
    assert.deepEqual(result.pixels,expected);assert.equal(result.stats.codec,'lz4');
  }
});

test('every Blob read is bounded and backing buffers are charged instead of small views',async()=>{
  const input=noise(1024*1024),encoded=raw(packPixels(input)),spy=new ReadSpy([encoded]);
  const result=await decodeFastPixelPatch(spy,new Uint8Array(input.length),{chunkBytes:32768,yieldTask:noWait});
  assert.deepEqual(result.pixels,input);assert.ok(spy.reads.length>32);
  assert.equal(spy.reads[0].start,0);assert.equal(spy.reads.at(-1)!.end,spy.size);
  for(const read of spy.reads)assert.ok(read.end-read.start<=32768);
  assert.equal(result.stats.peakInputBackingBytes,32768);
  assert.equal(result.stats.peakExplicitOwnedBytes,input.length+32768+13);
  assert.equal(result.stats.decodedBytes,packPixels(input).length);
});

test('compressed working bytes are target plus fixed history/scratch and one bounded input buffer',async()=>{
  const current=new Uint8Array(2*1024*1024).fill(17),encoded=fastCompress(packPixels(current));
  assert.equal(encoded[0],1);
  const result=await decodeFastPixelPatch(new Blob([encoded]),new Uint8Array(current.length),{yieldTask:noWait});
  assert.deepEqual(result.pixels,current);
  assert.equal(result.stats.historyBytes,65536);assert.equal(result.stats.matchScratchBytes,16384);
  assert.equal(result.stats.fixedHeaderBytes,13);
  assert.equal(result.stats.peakExplicitOwnedBytes,current.length+65536+16384+Math.min(encoded.length,32768)+13);
  assert.ok(result.stats.peakExplicitOwnedBytes<current.length+128*1024);
});

test('small compressed inputs still yield while a long match expands output',async()=>{
  const current=new Uint8Array(512*1024),encoded=fastCompress(packPixels(current));let yields=0;
  const result=await decodeFastPixelPatch(new Blob([encoded]),new Uint8Array(current.length),{
    yieldAfterBytes:32768,yieldTask:async()=>{yields++;},
  });
  assert.ok(encoded.length<32768);assert.ok(yields>=16);assert.equal(result.stats.yields,yields);
  assert.deepEqual(result.pixels,current);
});

test('wrapper kind, length and advertised output bounds fail without oversized allocations',async()=>{
  const base=raw(new Uint8Array(4));
  const wrong=base.slice();wrong[0]=2;
  const huge=base.slice();new DataView(huge.buffer).setUint32(1,0xffff_ffff,true);
  const small=base.slice();new DataView(small.buffer).setUint32(1,3,true);
  for(const encoded of [new Uint8Array(4),wrong,huge,small,base.slice(0,-1),new Uint8Array([...base,0])])
    await assert.rejects(decodeFastPixelPatch(new Blob([encoded]),new Uint8Array(0),{yieldTask:noWait}));
});

test('truncated token extensions, offset bytes, impossible backrefs and output overflows reject',async()=>{
  const cases=[compressed([],4),compressed([0xf0,255],4),compressed([0],4),compressed([0,0,0],4),
    compressed([0x10,0,2,0],4),compressed([0x50,0,0,0,0,0],4),compressed([0x1f,0,1,0,255],4),
    compressed([0x10,0,1],4),compressed([0x40,0,0],4)];
  for(const encoded of cases){
    assert.throws(()=>legacy(encoded,new Uint8Array(0)));
    for(const chunkBytes of [1,7,32768])await assert.rejects(decodeFastPixelPatch(new Blob([encoded]),new Uint8Array(0),{chunkBytes,yieldTask:noWait}));
  }
});

test('patch count, aligned offsets, complete block lengths, overlap and trailing bytes reject',async()=>{
  const block=new Uint8Array(BLOCK),bad=[
    packed([],1),packed([{from:0,bytes:block}],2),packed([{from:1,bytes:block}]),
    packed([{from:0,bytes:new Uint8Array(BLOCK-1)}]),packed([{from:0,bytes:block},{from:0,bytes:block}]),
    packed([{from:BLOCK*3,bytes:block}]),new Uint8Array([...packed([]),0]),
    packed([{from:BLOCK,bytes:block},{from:0,bytes:block}]),
  ];
  for(const bytes of bad){
    const encoded=fastCompress(bytes);assert.throws(()=>legacy(encoded,new Uint8Array(BLOCK*2)));
    for(const chunkBytes of [7,32768])await assert.rejects(decodeFastPixelPatch(new Blob([encoded]),new Uint8Array(BLOCK*2),{chunkBytes,yieldTask:noWait}));
  }
});

test('valid final partial patch and skipped blocks preserve unchanged pixels',async()=>{
  const target=noise(BLOCK*2+3),bytes=packed([{from:BLOCK*2,bytes:new Uint8Array([4,5,6])}]);
  for(const xor of [false,true]){
    const encoded=fastCompress(bytes),expected=legacy(encoded,target.slice(),xor);
    const result=await decodeFastPixelPatch(new Blob([encoded]),target.slice(),{xor,chunkBytes:7,yieldTask:noWait});
    assert.deepEqual(result.pixels,expected);assert.deepEqual(result.pixels.subarray(0,BLOCK*2),target.subarray(0,BLOCK*2));
  }
});

test('an already aborted decode reads no input and leaves the owned target untouched',async()=>{
  const controller=new AbortController();controller.abort();const target=noise(64),before=target.slice(),spy=new ReadSpy([raw(packPixels(target))]);
  await assert.rejects(decodeFastPixelPatch(spy,target,{signal:controller.signal}),{name:'AbortError'});
  assert.deepEqual(target,before);assert.equal(spy.reads.length,0);
});

test('cancellation during match expansion rejects rather than publishing the partly mutated target',async()=>{
  const controller=new AbortController(),bytes=new Uint8Array(512*1024).fill(37),encoded=fastCompress(packPixels(bytes));
  let returned=false,yields=0;
  await assert.rejects(async()=>{
    await decodeFastPixelPatch(new Blob([encoded]),new Uint8Array(bytes.length),{signal:controller.signal,yieldAfterBytes:32768,
      yieldTask:async()=>{if(++yields===2)controller.abort();}});returned=true;
  },{name:'AbortError'});
  assert.equal(returned,false);assert.equal(yields,2);
});

test('yield failures never publish output and ownership is explicit for views/shared backing',async()=>{
  const encoded=fastCompress(packPixels(new Uint8Array(BLOCK*2)));
  await assert.rejects(decodeFastPixelPatch(new Blob([encoded]),new Uint8Array(BLOCK*2),{yieldAfterBytes:1,yieldTask:async()=>{throw Error('injected yield failure');}}),/injected/);
  await assert.rejects(decodeFastPixelPatch(new Blob([raw(new Uint8Array(4))]),new Uint8Array(new ArrayBuffer(1024),0,4)),/owned target backing/);
  await assert.rejects(decodeFastPixelPatch(new Blob([raw(new Uint8Array(4))]),new Uint8Array(new SharedArrayBuffer(4)) as Uint8Array<ArrayBuffer>),/owned target backing/);
  for(const options of [{chunkBytes:0},{chunkBytes:32769},{yieldAfterBytes:0},{yieldAfterBytes:1024*1024+1},{xor:1}])
    await assert.rejects(decodeFastPixelPatch(new Blob([raw(new Uint8Array(4))]),new Uint8Array(0),options as never),/options/);
});

test('a target transferred during yield cannot return a silently detached XOR result',async()=>{
  const current=new Uint8Array(BLOCK*2).fill(19),target=new Uint8Array(current.length),encoded=fastCompress(packPixels(current,undefined,true));
  let transfers=0;
  await assert.rejects(decodeFastPixelPatch(new Blob([encoded]),target,{xor:true,yieldAfterBytes:1024,
    yieldTask:async()=>{if(!transfers++){structuredClone(target.buffer,{transfer:[target.buffer]});}}}),/owned target/);
  assert.equal(target.byteLength,0);assert.equal(transfers,1);
  const detached=new Uint8Array(0);structuredClone(detached.buffer,{transfer:[detached.buffer]});
  await assert.rejects(decodeFastPixelPatch(new Blob([raw(new Uint8Array(4))]),detached),/owned target detached/);
});

test('oversized input slices and malformed backing providers are rejected at the read boundary',async()=>{
  class HugeBlob extends Blob {override get size(){return STREAM_PATCH_LIMITS.targetBytes+64_001;}override arrayBuffer():Promise<ArrayBuffer>{throw Error('must not read');}}
  await assert.rejects(decodeFastPixelPatch(new HugeBlob(),new Uint8Array(0)),/encoded input size/);
  class OversizedBacking extends Blob {override slice(start=0,end=this.size):Blob {
    const part=super.slice(start,end);Object.defineProperty(part,'arrayBuffer',{value:async()=>new ArrayBuffer(part.size+1)});return part;
  }}
  await assert.rejects(decodeFastPixelPatch(new OversizedBacking([raw(new Uint8Array(4))]),new Uint8Array(0),{chunkBytes:1}),/slice backing/);
});

test('every truncation of a small valid payload rejects instead of fabricating a prefix result',async()=>{
  const bytes=noise(64),encoded=fastCompress(packPixels(bytes));
  for(let end=0;end<encoded.length;end++)await assert.rejects(decodeFastPixelPatch(new Blob([encoded.subarray(0,end)]),new Uint8Array(bytes.length),{chunkBytes:7,yieldTask:noWait}));
});
