import test from 'node:test';
import assert from 'node:assert/strict';
import {CanonicalFrameIndex} from '../src/features/card-scanner/canonical-frame-index';
import {readCanonicalFrame} from '../src/features/card-scanner/canonical-frame-reader';
import {entryParts,packPixels,fastCompress,pixelHash} from '../src/features/card-scanner/exact-recording-codec';

async function archive(){
 const index=new CanonicalFrameIndex(),parts:BlobPart[]=[],originals:Uint8Array<ArrayBuffer>[]=[];
 let bytes=0,previous:Uint8Array<ArrayBuffer>|undefined;
 for(let id=1;id<=10;id++){
  const pixels=Uint8Array.from({length:16*16*4},(_,i)=>(i*17+id*13)%256),hash=await pixelHash(pixels);
  const key=index.keyRequired(16,16),payload=fastCompress(packPixels(pixels,key?undefined:previous,true));
  const body=new Blob(entryParts({kind:'frame',id,width:16,height:16,time:11-id,key,hash,codec:'lz4',xor:true,phase:id===10?'recovery':'input'},payload));
  const offset=bytes;parts.push(body);bytes+=body.size;
  index.append({sourceFrameId:id,frameId:id,width:16,height:16,captureTime:11-id,arrivalOrder:id,offset,endOffset:bytes,key,pixelHash:hash,role:'input'});
  previous=pixels;originals.push(pixels);
  // Event gaps are not part of any pixel descriptor and must not be read.
  const gap=new Blob(entryParts({kind:'event',seq:id,time:id,type:'test',value:{id}}));parts.push(gap);bytes+=gap.size;
 }
 return {index,blob:new Blob(parts),originals};
}

test('bounded random reads start at the nearest key and verify all visited source hashes',async()=>{
 const {index,blob,originals}=await archive();
 for(const id of [10,3,9,1]){
  const range=index.decodeRange(id),reads:{offset:number;length:number}[]=[];
  const result=await readCanonicalFrame({frames:range.frameIds.map(frameId=>index.get(frameId)!),read:async(offset,length)=>{
   reads.push({offset,length});return new Uint8Array(await blob.slice(offset,offset+length).arrayBuffer());
  }});
  assert.deepEqual(new Uint8Array(result.pixels.buffer),originals[id-1]);assert.equal(result.id,id);assert.equal(result.time,11-id);
  assert.equal(reads[0].offset,range.offset);assert.ok(reads.every(read=>read.offset>=range.offset&&read.offset+read.length<=range.endOffset));
  assert.equal(reads.length,range.frameIds.length*3);assert.ok(Math.max(...reads.map(read=>read.length))<blob.size);
 }
});

test('random read corruption, index disagreement and short reads cannot return trusted pixels',async()=>{
 const {index,blob}=await archive(),descriptor=index.get(1)!;
 const read=async(offset:number,length:number)=>new Uint8Array(await blob.slice(offset,offset+length).arrayBuffer());
 await assert.rejects(readCanonicalFrame({frames:[{...descriptor,pixelHash:'0'.repeat(64)}],read}),/색인 불일치/);
 await assert.rejects(readCanonicalFrame({frames:[descriptor],read:async(offset,length)=>(await read(offset,length)).subarray(1)}),/일부 읽기/);
 await assert.rejects(readCanonicalFrame({frames:[descriptor],read:async(offset,length)=>{
  const bytes=await read(offset,length);if(offset>descriptor.offset+8)bytes[bytes.length-1]^=1;return bytes;
 }}));
});

test('decode budgets and cancellation are checked before further allocation or reads',async()=>{
 const {index,blob}=await archive();let calls=0;
 const read=async(offset:number,length:number)=>{calls++;return new Uint8Array(await blob.slice(offset,offset+length).arrayBuffer());};
 await assert.rejects(readCanonicalFrame({frames:Array.from({length:9},()=>index.get(1)!),read}),/범위/);assert.equal(calls,0);
 const frames=[1,2].map(id=>({...index.get(id)!,width:1024,height:4097,key:id===1}));
 await assert.rejects(readCanonicalFrame({frames,read}),/예산/);assert.equal(calls,0);
 const controller=new AbortController();
 await assert.rejects(readCanonicalFrame({frames:[index.get(1)!],signal:controller.signal,read:async(offset,length)=>{
  const bytes=await read(offset,length);controller.abort(new Error('cancelled'));return bytes;
 }}),/cancelled/);assert.equal(calls,1);
});
