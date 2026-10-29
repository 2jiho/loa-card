import test from 'node:test';
import assert from 'node:assert/strict';
import {deflate,entryParts,exactPixels,fastCompress,packPixels,pixelHash,type ExactFrame} from '../src/features/card-scanner/exact-recording-codec';
import {prepareNativeStorage,rgbaFrameStorage,type FrameStorage} from '../src/features/card-scanner/native-frame-storage';
import type {NativeYuvFrameMetadata} from '../src/features/card-scanner/native-yuv-recipe';

type Domain='legacy-rgba'|'rgba8'|'native-I420'|'native-NV12';
type Codec='deflate'|'lz4';
interface Sample {
 readonly stored:Uint8Array<ArrayBuffer>;readonly rgba:Uint8Array<ArrayBuffer>;readonly hash:string;readonly storage?:FrameStorage;
}
const width=8,height=8,signal=()=>new AbortController().signal;
async function archive(domain:Domain,codec:Codec){
 const samples:Sample[]=[],headers:ExactFrame[]=[],payloads:Uint8Array<ArrayBuffer>[]=[],parts:BlobPart[]=[];
 for(let i=0;i<5;i++){
  let sample:Sample;
  if(domain==='legacy-rgba'||domain==='rgba8'){
   const pixels=Uint8Array.from({length:width*height*4},(_,index)=>(index*13+i*17)%256);
   sample={stored:pixels,rgba:pixels,hash:await pixelHash(pixels),...(domain==='rgba8'?{storage:rgbaFrameStorage(width,height)}:{})};
  }else{
   const stored=Uint8Array.from({length:width*height*3/2},(_,index)=>16+(index*7+i*23)%220);
   const descriptor:NativeYuvFrameMetadata={format:domain==='native-I420'?'I420':'NV12',codedWidth:width,codedHeight:height,
    displayWidth:width,displayHeight:height,visibleRect:{x:0,y:0,width,height},rotation:0,flip:false,
    colorSpace:{primaries:'bt709',transfer:'bt709',matrix:'bt709',fullRange:false}};
   const prepared=await prepareNativeStorage(descriptor,stored);
   sample={stored,rgba:prepared.pixels,hash:prepared.rgbaHash,storage:prepared.storage};
  }
  const key=i===0||i===3,delta=packPixels(sample.stored,key?undefined:samples[i-1].stored,true),
   payload=codec==='lz4'?fastCompress(delta):await deflate(delta);
  const header:ExactFrame={kind:'frame',id:i+1,time:i/10,width,height,key,hash:sample.hash,xor:true,
   ...(codec==='lz4'?{codec:'lz4' as const}:{}),...(sample.storage?{canonical:true as const,storage:sample.storage}:{})};
  samples.push(sample);headers.push(header);payloads.push(payload);parts.push(...entryParts(header,payload));
 }
 return {blob:new Blob(parts),samples,headers,payloads,version:domain==='legacy-rgba'?0 as const:1 as const};
}
async function read(iterator:ReturnType<typeof exactPixels>,sample:Sample){
 const next=await iterator.next();assert.equal(next.done,false);assert.ok(next.value);
 const frame=next.value;assert.deepEqual(frame.pixels,sample.rgba);assert.equal(frame.hash,sample.hash);
 assert.equal(await pixelHash(frame.pixels),sample.hash);assert.equal(frame.pixels.byteOffset,0);
 assert.equal(frame.pixels.byteLength,width*height*4);assert.equal(frame.pixels.buffer.byteLength,width*height*4);
 return frame;
}

for(const domain of ['legacy-rgba','rgba8','native-I420','native-NV12']as const){
 for(const codec of ['deflate','lz4']as const){
  test(`exactPixels ${domain}/${codec} retains independent snapshots across consecutive deltas and a new key`,async()=>{
   const data=await archive(domain,codec),iterator=exactPixels(data.blob,signal(),data.version),retained=[];
   assert.deepEqual(data.headers.map(header=>header.key),[true,false,false,true,false]);
   for(const sample of data.samples){
    const frame=await read(iterator,sample);
    assert.ok(retained.every(previous=>previous.pixels.buffer!==frame.pixels.buffer));retained.push(frame);
    for(const [index,previous]of retained.entries()){
     assert.deepEqual(previous.pixels,data.samples[index].rgba);assert.equal(await pixelHash(previous.pixels),data.samples[index].hash);
    }
   }
   assert.equal((await iterator.next()).done,true);
  });

  test(`exactPixels ${domain}/${codec} consumers may mutate each yielded frame without corrupting the next delta`,async()=>{
   const data=await archive(domain,codec),iterator=exactPixels(data.blob,signal(),data.version);
   for(const sample of data.samples){const frame=await read(iterator,sample);frame.pixels.fill(0xee);}
   assert.equal((await iterator.next()).done,true);
  });

  test(`exactPixels ${domain}/${codec} consumers may transfer every key and delta without detaching the decoder predecessor`,async()=>{
   const data=await archive(domain,codec),iterator=exactPixels(data.blob,signal(),data.version),transported:Uint8Array<ArrayBuffer>[]=[];
   for(const sample of data.samples){
    const frame=await read(iterator,sample),pixels=structuredClone(frame.pixels,{transfer:[frame.pixels.buffer]});
    assert.equal(frame.pixels.byteLength,0);assert.equal(frame.pixels.buffer.byteLength,0);assert.deepEqual(pixels,sample.rgba);
    transported.push(pixels);
   }
   assert.equal((await iterator.next()).done,true);
   for(const [index,pixels]of transported.entries()){
    assert.deepEqual(pixels,data.samples[index].rgba);assert.equal(await pixelHash(pixels),data.samples[index].hash);
   }
  });
 }

 test(`exactPixels ${domain} still verifies the next delta hash after yielding a transferable predecessor`,async()=>{
  const data=await archive(domain,'lz4'),bad=new Blob(data.headers.flatMap((header,index)=>
   entryParts(index===1?{...header,hash:'0'.repeat(64)}:header,data.payloads[index]))),iterator=exactPixels(bad,signal(),data.version);
  const first=await read(iterator,data.samples[0]);structuredClone(first.pixels,{transfer:[first.pixels.buffer]});
  await assert.rejects(iterator.next(),/입력 픽셀 불일치: 프레임 2/);
 });
}
