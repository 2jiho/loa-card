import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {createRecordingCompression} from '../src/features/card-scanner/recording-compression';
import {fastInflate,packPixels,unpackPixels} from '../src/features/card-scanner/exact-recording-codec';

async function realWasm(){
 const binary=await readFile('node_modules/lz4-wasm/lz4_wasm_bg.wasm');
 assert.equal(createHash('sha256').update(binary).digest('hex'),'c858f9884d964ec49294b0c09d3330d6b0a640da850dbeb5f9c491e1a3dd58cb');
 const {instance}=await WebAssembly.instantiate(binary,{'./lz4_wasm_bg.js':{
  __wbindgen_string_new(){throw Error('Unexpected WASM string error');},
 }});
 const wasm=instance.exports as any;
 return {compress(data:Uint8Array){
  const ret=wasm.__wbindgen_add_to_stack_pointer(-16);
  try{
   const input=wasm.__wbindgen_malloc(data.length);new Uint8Array(wasm.memory.buffer).set(data,input);
   wasm.compress(ret,input,data.length);
   const words=new Int32Array(wasm.memory.buffer),ptr=words[ret/4],length=words[ret/4+1];
   const result=new Uint8Array(wasm.memory.buffer,ptr,length).slice();wasm.__wbindgen_free(ptr,length);return result;
  }finally{wasm.__wbindgen_add_to_stack_pointer(16);}
 }};
}
function random(length:number){let seed=0x54816721;return Uint8Array.from({length},()=>{seed^=seed<<13;seed^=seed>>>17;seed^=seed<<5;return seed>>>24;});}

test('installed pinned WASM round trips empty, random and compressible bytes through the existing decoder',async()=>{
 let loads=0;const compression=await createRecordingCompression(async()=>{loads++;return realWasm();});
 assert.equal(compression.engine,'wasm-lz4');assert.equal(loads,1);
 const inputs=[new Uint8Array(),random(17),random(65_536),new Uint8Array(100_000).fill(37)];
 const encoded=inputs.map(input=>compression.compress(input));
 for(const [index,input]of inputs.entries())assert.deepEqual(fastInflate(encoded[index],input.length),input);
 assert.equal(encoded[2][0],0);assert.equal(encoded[3][0],1);
 // Later calls and heap reuse cannot mutate already-owned output blocks.
 compression.compress(new Uint8Array(150_000).fill(12));
 assert.deepEqual(fastInflate(encoded[3],inputs[3].length),inputs[3]);assert.equal(loads,1);
});

test('WASM key and XOR deltas preserve full RGBA hashes without changing replay format',async()=>{
 const compression=await createRecordingCompression(realWasm);
 const current=random(192*128*4),next=current.slice();next.fill(122,1000,12_000);
 const key=packPixels(current,undefined,true),delta=packPixels(next,current,true),restored=new Uint8Array(current.length);
 unpackPixels(fastInflate(compression.compress(key),key.length),restored,true);assert.deepEqual(restored,current);
 unpackPixels(fastInflate(compression.compress(delta),delta.length),restored,true);assert.deepEqual(restored,next);
 assert.equal(createHash('sha256').update(restored).digest('hex'),createHash('sha256').update(next).digest('hex'));
});

test('module load failure and unusable initialization fall back to the same JS wire format',async()=>{
 const broken=[async()=>{throw Error('No WebAssembly');},async()=>({} as any),async()=>({compress(){return new Uint8Array(3);}})];
 for(const loader of broken){const compression=await createRecordingCompression(loader);assert.equal(compression.engine,'js-lz4');
  const bytes=random(4096);assert.deepEqual(fastInflate(compression.compress(bytes),bytes.length),bytes);}
});

test('runtime corruption and exceptions propagate after successful initialization',async()=>{
 for(const defect of ['prefix','short','throw']){
  const real=await realWasm();let ready=false;
  const compression=await createRecordingCompression(async()=>({compress(data){
   if(!ready){ready=true;return real.compress(data);}
   if(defect==='throw')throw Error('WASM runtime failed');
   if(defect==='short')return new Uint8Array(4);
   const result=real.compress(data);new DataView(result.buffer).setUint32(0,data.length+1,true);return result;
  }}));
  assert.equal(compression.engine,'wasm-lz4');assert.throws(()=>compression.compress(random(1024)),/WASM/);
 }
});
