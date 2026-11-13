import test from 'node:test';
import assert from 'node:assert/strict';
import {prepareNativeStorage,rgbaFrameStorage,frameDecodeWorkBytes} from '../src/features/card-scanner/reproduction/native-frame-storage';
import type {FrameStorage,NativeStorage} from '../src/features/card-scanner/reproduction/native-frame-storage';
import type {NativeYuvFrameMetadata} from '../src/features/card-scanner/acquisition/native-yuv-recipe';
import {CanonicalFrameIndex} from '../src/features/card-scanner/reproduction/canonical-frame-index';
import {readCanonicalFrame} from '../src/features/card-scanner/reproduction/canonical-frame-reader';
import {entryParts,exactEntries,exactPixels,exactReplayFrames,executionSummary,packPixels,fastCompress,pixelHash} from '../src/features/card-scanner/reproduction/exact-recording-codec';
import type {ExactFrame} from '../src/features/card-scanner/reproduction/exact-recording-codec';

const signal=()=>new AbortController().signal;
function metadata(format:'I420'|'NV12'='I420',profile:'bt709'|'smpte170m'='bt709',width=4,height=4):NativeYuvFrameMetadata {
  return {format,codedWidth:width,codedHeight:height,displayWidth:width,displayHeight:height,
    visibleRect:{x:0,y:0,width,height},rotation:0,flip:false,
    colorSpace:{primaries:profile,transfer:profile,matrix:profile,fullRange:false}};
}
interface Sample {readonly storage:FrameStorage;readonly stored:Uint8Array<ArrayBuffer>;readonly rgba:Uint8Array<ArrayBuffer>;readonly hash:string;readonly width:number;readonly height:number}
async function native(format:'I420'|'NV12'='I420',profile:'bt709'|'smpte170m'='bt709',change=0):Promise<Sample>{
  const stored=Uint8Array.from({length:24},(_,i)=>(17+i*11)%256);stored[0]^=change;
  const prepared=await prepareNativeStorage(metadata(format,profile),stored);
  return {storage:prepared.storage,stored,rgba:prepared.pixels,hash:prepared.rgbaHash,width:4,height:4};
}
async function rgba():Promise<Sample>{const stored=Uint8Array.from({length:64},(_,i)=>(i*31)%256);
  return {storage:rgbaFrameStorage(4,4),stored,rgba:stored,hash:await pixelHash(stored),width:4,height:4};}
async function archive(samples:readonly Sample[]){
  const index=new CanonicalFrameIndex(),parts:BlobPart[]=[],headers:ExactFrame[]=[],payloads:Uint8Array<ArrayBuffer>[]=[];
  let bytes=0,previous:Uint8Array<ArrayBuffer>|undefined;
  for(const [offset,sample]of samples.entries()){
    const id=offset+1,key=index.keyRequired(sample.width,sample.height,sample.storage),
      payload=fastCompress(packPixels(sample.stored,key?undefined:previous,true));
    const header:ExactFrame={kind:'frame',id,time:id/10,width:sample.width,height:sample.height,key,hash:sample.hash,
      codec:'lz4',xor:true,canonical:true,storage:sample.storage},body=new Blob(entryParts(header,payload)),from=bytes;
    headers.push(header);payloads.push(payload);parts.push(body);bytes+=body.size;
    index.append({sourceFrameId:id,frameId:id,offset:from,endOffset:bytes,width:sample.width,height:sample.height,
      captureTime:id/10,arrivalOrder:id,key,pixelHash:sample.hash,role:'input',storage:sample.storage});
    const use=new Blob(entryParts({kind:'event',seq:id,time:id/10,type:'canonical-source-use',
      value:{sourceFrameId:id,acquisitionFrameId:100+id,phase:'input',captureTime:id/10}}));parts.push(use);bytes+=use.size;
    previous=sample.stored;
  }
  return {index,blob:new Blob(parts),headers,payloads,samples};
}
const collect=async(blob:Blob,version?:0|1)=>{const result=[];
  for await(const frame of exactPixels(blob,signal(),version))result.push({...frame,pixels:frame.pixels.slice()});return result;};

test('native metadata and content hashes are checked at every visited delta, not just the requested target',async()=>{
  const first=await native(),second=await native('I420','bt709',5),data=await archive([first,second]);
  for(const field of ['nativeSha256','descriptorSha256','recipeSha256']as const){
    const badHeader={...data.headers[0],storage:{...first.storage,[field]:'0'.repeat(64)}as NativeStorage};
    const corrupt=new Blob([...entryParts(badHeader,data.payloads[0]),...entryParts(data.headers[1],data.payloads[1])]);
    await assert.rejects(collect(corrupt),/픽셀 불일치/);
  }
  const corruptRgba=new Blob(entryParts({...data.headers[0],hash:'0'.repeat(64)},data.payloads[0]));
  await assert.rejects(collect(corruptRgba),/RGBA hash mismatch/);
  const range=data.index.decodeRange(2),descriptors=range.frameIds.map(id=>data.index.get(id)!);
  let reads=0;
  await assert.rejects(readCanonicalFrame({frames:descriptors.map((value,i)=>i===0?{...value,
    storage:{...first.storage,nativeSha256:'0'.repeat(64)}as NativeStorage}:value),
    read:async(offset,length)=>{reads++;return new Uint8Array(await data.blob.slice(offset,offset+length).arrayBuffer());}}),/저장 정보와 색인 불일치/);
  assert.equal(reads,2,'descriptor disagreement fails before reading compressed payload');
});

test('strict storage envelopes reject unknown versions, descriptors, dimensions and unmarked native payloads',async()=>{
  const sample=await native(),data=await archive([sample]),header=data.headers[0];
  const invalid=[null,{},[],{...sample.storage,version:2},{...sample.storage,extra:true},
    {...sample.storage,descriptor:{...(sample.storage as NativeStorage).descriptor,extra:1}},
    {...sample.storage,byteLength:25},rgbaFrameStorage(2,4)];
  for(const storage of invalid){const blob=new Blob(entryParts({...header,storage}as ExactFrame,data.payloads[0]));
    await assert.rejects(async()=>{for await(const entry of exactEntries(blob,signal()))void entry;});}
  const {storage:_,...unmarked}=header;void _;
  await assert.rejects(collect(new Blob(entryParts(unmarked,data.payloads[0]))),/픽셀 블록/);
});

test('native chain budgets count stored bytes plus generated RGBA while legacy accounting stays unchanged',async()=>{
  const sample=await native(),index=new CanonicalFrameIndex({maxDecodeBytes:150});assert.equal(frameDecodeWorkBytes(sample.storage,4,4),88);
  const base={sourceFrameId:1,frameId:1,offset:0,endOffset:100,width:4,height:4,captureTime:0,arrivalOrder:1,key:true,pixelHash:sample.hash,role:'input'as const,storage:sample.storage};
  index.append(base);assert.equal(index.decodeRange(1).decodeBytes,88);assert.equal(index.keyRequired(4,4,sample.storage),true);
  assert.throws(()=>index.append({...base,sourceFrameId:2,frameId:2,offset:100,endOffset:200,key:false}),/bounded keyframe/);
  const old=new CanonicalFrameIndex({maxDecodeBytes:150}),{storage:_,...legacy}=base;void _;
  old.append(legacy);assert.equal(old.decodeRange(1).decodeBytes,64);assert.equal(old.keyRequired(4,4),false);
  const data=await archive([sample,await native('I420','bt709',1)]),range=data.index.decodeRange(2);
  const huge={...sample.storage,descriptor:metadata('I420','bt709',2560,1440),byteLength:2560*1440*3/2}as NativeStorage;
  let calls=0;
  await assert.rejects(readCanonicalFrame({frames:range.frameIds.map(id=>({...data.index.get(id)!,width:2560,height:1440,storage:huge})),
    read:()=>{calls++;return new Uint8Array();}}),/예산 초과/);assert.equal(calls,0);
});

test('compact index metadata and random-read validation detach mutable caller descriptors before awaiting I/O',async()=>{
  const sample=await native(),data=await archive([sample]),original=data.index.get(1)!;
  const supplied={...original,storage:structuredClone(sample.storage)};let reads=0;
  const restored=await readCanonicalFrame({frames:[supplied],read:async(offset,length)=>{
    if(++reads===1){supplied.width=2;
      if(supplied.storage.kind==='native-yuv420')supplied.storage.descriptor.colorSpace.matrix='unknown';}
    return new Uint8Array(await data.blob.slice(offset,offset+length).arrayBuffer());
  }});
  assert.deepEqual(restored.pixels,new Uint8ClampedArray(sample.rgba));assert.equal(restored.width,4);
  const inputStorage=structuredClone(sample.storage),index=new CanonicalFrameIndex();
  const committed=index.append({sourceFrameId:2,frameId:2,offset:0,endOffset:100,width:4,height:4,captureTime:0,
    arrivalOrder:2,key:true,pixelHash:sample.hash,role:'input',storage:inputStorage});
  if(inputStorage.kind==='native-yuv420')inputStorage.descriptor.colorSpace.matrix='unknown';
  assert.equal(committed.storage?.kind,'native-yuv420');assert.ok(committed.storage?.kind==='native-yuv420');
  assert.equal(committed.storage.descriptor.colorSpace.matrix,'bt709');
  assert.ok(Object.isFrozen(committed.storage));assert.ok(Object.isFrozen(committed.storage.descriptor.colorSpace));
});

test('explicit expected storage version and physical kind totals reject mislabeled outer recordings',async()=>{
  const data=await archive([await native(),await rgba()]),totals={complete:true,dropped:0,events:2,frames:2,storageVersion:1 as const,nativeFrames:1,rgbaFrames:1};
  assert.equal((await executionSummary(data.blob,signal(),totals)).recordingComplete,true);
  await assert.rejects(executionSummary(data.blob,signal(),{complete:true,dropped:0,events:2,frames:2}),/저장 형식 불일치/);
  await assert.rejects(executionSummary(data.blob,signal(),{...totals,nativeFrames:0,rgbaFrames:2}),/저장 종류 총량 불일치/);
  await assert.rejects(executionSummary(data.blob,signal(),{...totals,nativeFrames:0}),/저장 종류 총량/);
  await assert.rejects(executionSummary(new Blob(),signal(),{complete:true,dropped:0,events:0,frames:0,nativeFrames:0,rgbaFrames:0}),/저장 종류 총량/);
  await assert.rejects(collect(data.blob,0),/저장 형식 불일치/);
  const rgb=await rgba(),single=await archive([rgb]),{storage:_,...legacy}=single.headers[0];void _;
  const old=new Blob(entryParts(legacy,single.payloads[0]));await assert.rejects(collect(old,1),/저장 형식 불일치/);
  let draws=0;const priorDocument=Object.getOwnPropertyDescriptor(globalThis,'document'),priorImage=Object.getOwnPropertyDescriptor(globalThis,'ImageData');
  const canvas={width:0,height:0,getContext:()=>({putImageData:()=>{draws++;}})};
  Object.defineProperty(globalThis,'document',{configurable:true,value:{createElement:()=>canvas}});
  Object.defineProperty(globalThis,'ImageData',{configurable:true,value:class{constructor(public data:Uint8ClampedArray,public width:number,public height:number){}}});
  try{
    await assert.rejects(async()=>{for await(const frame of exactReplayFrames(data.blob,signal(),undefined,2,false,0))void frame;},/저장 형식 불일치/);
    assert.equal(draws,0);
    const frames=[];for await(const frame of exactReplayFrames(data.blob,signal(),undefined,2,false,1))frames.push(frame.provenance);
    assert.equal(frames.length,2);assert.equal(draws,2);assert.equal(frames[0].sourceFrameId,1);assert.equal(frames[0].frameId,101);
  }finally{
    if(priorDocument)Object.defineProperty(globalThis,'document',priorDocument);else Reflect.deleteProperty(globalThis,'document');
    if(priorImage)Object.defineProperty(globalThis,'ImageData',priorImage);else Reflect.deleteProperty(globalThis,'ImageData');
  }
});
