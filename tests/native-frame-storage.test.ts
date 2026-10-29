import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {parseFrameStorage,parseNativeYuvMetadata,prepareNativeStorage,restoreFrameStorage,rgbaFrameStorage,
  frameStorageSignature,frameStoredBytes,frameDecodeWorkBytes} from '../src/features/card-scanner/native-frame-storage';
import {convertNativeYuvToRgba,nativeYuvDescriptorJson,planNativeYuvFrame,
  type NativeYuvFrameMetadata} from '../src/features/card-scanner/native-yuv-recipe';
import {MAX_FRAME_BYTES,pixelHash} from '../src/features/card-scanner/recording-frame-integrity';

function metadata(name:'bt709'|'smpte170m'='bt709',format:'I420'|'NV12'='I420',width=4,height=4):NativeYuvFrameMetadata {
  return {format,codedWidth:width,codedHeight:height,displayWidth:width,displayHeight:height,
    visibleRect:{x:0,y:0,width,height},rotation:0,flip:false,
    colorSpace:{primaries:name,transfer:name,matrix:name,fullRange:false}};
}
const hash=(value:string|Uint8Array)=>createHash('sha256').update(value).digest('hex');
function samples(meta:NativeYuvFrameMetadata):Uint8Array<ArrayBuffer> {
  const pixels=meta.codedWidth*meta.codedHeight;
  return Uint8Array.from({length:pixels*3/2},(_,i)=>(i*79+13)%256);
}

test('all supported profiles/formats roundtrip physical bytes and generated RGBA independently',async()=>{
  for(const name of ['bt709','smpte170m']as const)for(const format of ['I420','NV12']as const){
    const meta=metadata(name,format),native=samples(meta),before=native.slice(),plan=planNativeYuvFrame(meta);
    const result=await prepareNativeStorage(meta,native);
    assert.equal(result.storage.nativeSha256,hash(native));
    assert.equal(result.storage.descriptorSha256,hash(nativeYuvDescriptorJson(meta,plan.layout)));
    assert.equal(result.storage.recipeSha256,hash(JSON.stringify(plan.recipe)));
    assert.equal(result.storage.recipeId,plan.recipe.id);assert.equal(result.rgbaHash,hash(result.pixels));
    assert.deepEqual(result.pixels,convertNativeYuvToRgba(meta,native,plan.layout).rgba);
    const restored=await restoreFrameStorage(result.storage,4,4,native,result.rgbaHash);
    assert.deepEqual(restored,result.pixels);assert.notEqual(restored.buffer,native.buffer);
    assert.deepEqual(native,before);assert.equal(frameStoredBytes(result.storage,4,4),24);
    assert.equal(frameDecodeWorkBytes(result.storage,4,4),88);
    assert.equal(result.storage.byteLength/result.pixels.byteLength,.375,'raw ratio only, not compressed capacity proof');
  }
});

test('metadata and parsed storage are detached exact frozen records before async work',async()=>{
  const meta=metadata(),native=samples(meta),pending=prepareNativeStorage(meta,native);
  meta.colorSpace.matrix='unknown';meta.visibleRect!.width=2;
  const result=await pending,parsed=parseFrameStorage(JSON.parse(JSON.stringify(result.storage)),4,4);
  assert.equal(result.storage.descriptor.colorSpace.matrix,'bt709');assert.equal(result.storage.descriptor.visibleRect?.width,4);
  assert.ok(Object.isFrozen(parsed));assert.ok(parsed.kind==='native-yuv420');
  assert.ok(Object.isFrozen(parsed.descriptor));assert.ok(Object.isFrozen(parsed.descriptor.colorSpace));
  assert.ok(Object.isFrozen(parsed.descriptor.visibleRect));assert.notEqual(parsed.descriptor,result.storage.descriptor);
  assert.deepEqual(parsed,result.storage);
});

test('strict metadata rejects unknown keys, geometry, orientation, profile and unsafe dimensions',()=>{
  const meta=metadata();
  const invalid:unknown[]=[null,{},[],{...meta,extra:1},{...meta,visibleRect:{...meta.visibleRect,extra:1}},
    {...meta,colorSpace:{...meta.colorSpace,extra:1}},{...meta,colorSpace:{...meta.colorSpace,fullRange:true}},
    {...meta,colorSpace:{...meta.colorSpace,matrix:null}},{...meta,colorSpace:{...meta.colorSpace,transfer:'pq'}},
    {...meta,format:'RGBA'},{...meta,rotation:90},{...meta,flip:true},{...meta,codedWidth:NaN},
    {...meta,codedWidth:Number.MAX_SAFE_INTEGER},{...meta,displayWidth:5},{...meta,visibleRect:null},
    {...meta,visibleRect:{x:1,y:0,width:4,height:4}},{...meta,codedHeight:3}];
  invalid.forEach(value=>assert.throws(()=>parseNativeYuvMetadata(value)));
  const parsed=parseNativeYuvMetadata(meta);assert.deepEqual(parsed,meta);assert.notEqual(parsed,meta);
});

test('storage parser rejects malformed versions, packing, recipe identities and SHA syntax',async()=>{
  const result=await prepareNativeStorage(metadata(),samples(metadata())),value=result.storage;
  const invalid:unknown[]=[null,{},[],{...value,version:2},{...value,kind:'nv12'},
    {...value,extra:1},{...value,byteLength:23},{...value,byteLength:NaN},{...value,recipeId:'guessed-recipe'},
    {...value,descriptor:{...value.descriptor,extra:1}},{...value,descriptor:{...value.descriptor,codedWidth:6}},
    {...value,descriptorSha256:'A'.repeat(64)},{...value,nativeSha256:'g'.repeat(64)},
    {...value,recipeSha256:null},{...value,recipeSha256:'a'.repeat(65)}];
  invalid.forEach(item=>assert.throws(()=>parseFrameStorage(item,4,4)));
  assert.throws(()=>parseFrameStorage(value,2,4));assert.throws(()=>parseFrameStorage(value,4,2));
  assert.throws(()=>parseFrameStorage({...rgbaFrameStorage(4,4),byteLength:63},4,4));
  assert.throws(()=>parseFrameStorage({...rgbaFrameStorage(4,4),descriptor:value.descriptor},4,4));
});

test('content, recipe, descriptor and generated-RGBA hash mismatches always fail restoration',async()=>{
  const meta=metadata(),native=samples(meta),result=await prepareNativeStorage(meta,native);
  for(const field of ['nativeSha256','recipeSha256','descriptorSha256']as const)
    await assert.rejects(restoreFrameStorage({...result.storage,[field]:'0'.repeat(64)},4,4,native,result.rgbaHash),/hash mismatch/);
  const changed=native.slice();changed[0]^=1;
  await assert.rejects(restoreFrameStorage(result.storage,4,4,changed,result.rgbaHash),/hash mismatch/);
  await assert.rejects(restoreFrameStorage(result.storage,4,4,native,'0'.repeat(64)),/RGBA hash mismatch/);
  await assert.rejects(restoreFrameStorage(result.storage,4,4,native,'null'),/SHA-256/);
  // Swapping even supported profile changes descriptor, recipe and RGBA meaning.
  await assert.rejects(restoreFrameStorage({...result.storage,descriptor:metadata('smpte170m'),
    recipeId:planNativeYuvFrame(metadata('smpte170m')).recipe.id},4,4,native,result.rgbaHash),/hash mismatch/);
});

test('static dependency signatures ignore content but change on representation/profile/layout/dimensions',async()=>{
  const meta=metadata(),first=await prepareNativeStorage(meta,samples(meta));
  const other=samples(meta);other[0]^=255;const second=await prepareNativeStorage(meta,other);
  const signature=frameStorageSignature(first.storage,4,4);
  assert.equal(signature,frameStorageSignature(second.storage,4,4));
  assert.notEqual(first.storage.nativeSha256,second.storage.nativeSha256);
  const variants=[metadata('bt709','NV12'),metadata('smpte170m'),metadata('bt709','I420',2,4)];
  for(const variant of variants){const item=await prepareNativeStorage(variant,samples(variant));
    assert.notEqual(signature,frameStorageSignature(item.storage,variant.codedWidth,variant.codedHeight));}
  assert.notEqual(signature,frameStorageSignature(rgbaFrameStorage(4,4),4,4));
  assert.notEqual(frameStorageSignature(undefined,4,4),frameStorageSignature(rgbaFrameStorage(4,4),4,4));
});

test('explicit RGBA and unmarked legacy fallback preserve their exact bytes including alpha',async()=>{
  const stored=Uint8Array.from({length:36},(_,i)=>(i*29)%256),expected=await pixelHash(stored);
  for(const storage of [undefined,rgbaFrameStorage(3,3)]){
    assert.equal(await restoreFrameStorage(storage,3,3,stored,expected),stored);
    assert.equal(frameStoredBytes(storage,3,3),36);assert.equal(frameDecodeWorkBytes(storage,3,3),36);
    await assert.rejects(restoreFrameStorage(storage,3,3,stored,'0'.repeat(64)),/RGBA hash mismatch/);
  }
});

test('buffer ownership rejects shared/resizable/detached/padded/offset/truncated payloads',async()=>{
  const meta=metadata(),native=samples(meta),result=await prepareNativeStorage(meta,native);
  const padded=new Uint8Array(26),offset=padded.subarray(1,25),detached=new Uint8Array(24);
  structuredClone(detached.buffer,{transfer:[detached.buffer]});
  const invalid=[new Uint8Array(23),new Uint8Array(25),offset,new Uint8Array(new SharedArrayBuffer(24)),
    new Uint8Array(new ArrayBuffer(24,{maxByteLength:48})),detached,new Uint8ClampedArray(24)];
  for(const bytes of invalid){
    await assert.rejects(prepareNativeStorage(meta,bytes as Uint8Array<ArrayBuffer>));
    await assert.rejects(restoreFrameStorage(result.storage,4,4,bytes as Uint8Array<ArrayBuffer>,result.rgbaHash));
  }
  await assert.rejects(restoreFrameStorage(rgbaFrameStorage(4,4),4,4,new Uint8Array(63),'0'.repeat(64)));
});

test('size helpers validate bounds before payload allocation and charge native plus RGBA work',()=>{
  for(const [width,height]of [[0,2],[2,-1],[NaN,2],[2,Infinity],[Number.MAX_SAFE_INTEGER,2],[4098,4096]]){
    assert.throws(()=>rgbaFrameStorage(width,height));assert.throws(()=>frameStoredBytes(undefined,width,height));
    assert.throws(()=>frameStorageSignature(undefined,width,height));assert.throws(()=>frameDecodeWorkBytes(undefined,width,height));
  }
  assert.equal(rgbaFrameStorage(4096,4096).byteLength,MAX_FRAME_BYTES);
  const meta=metadata('smpte170m','I420',2560,1440),plan=planNativeYuvFrame(meta);
  const storage={version:1 as const,kind:'native-yuv420' as const,descriptor:meta,recipeId:plan.recipe.id,
    recipeSha256:'a'.repeat(64),descriptorSha256:'b'.repeat(64),nativeSha256:'c'.repeat(64),byteLength:plan.nativeByteLength};
  assert.equal(frameStoredBytes(storage,2560,1440),5_529_600);
  assert.equal(frameDecodeWorkBytes(storage,2560,1440),20_275_200);
});
