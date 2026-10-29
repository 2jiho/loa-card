import {fastInflate,inflate,unpackPixels} from './exact-recording-codec';
import {MAX_FRAME_BYTES,pixelHash} from './recording-frame-integrity';
import {frameDecodeWorkBytes,frameStorageSignature,frameStoredBytes,parseFrameStorage,restoreFrameStorage} from './native-frame-storage';
import type {CanonicalFrameDescriptor} from './canonical-frame-index';
import {RGBA_WINDOW_CODEC,RGBA_WINDOW_POLICY,parseWindowFrame,windowWorkingSet} from './rgba-window-policy';
import {createGenericBoundedInput,type BoundedReadSource} from './generic-bounded-input';
import {decodeFastPixelPatchFromSource} from './streaming-delta-source';
import {yieldForCapture} from './input-source';

export type CanonicalReadDescriptor=Pick<CanonicalFrameDescriptor,
  'frameId'|'offset'|'endOffset'|'width'|'height'|'captureTime'|'key'|'pixelHash'|'storage'|'codec'|'policy'>;
export interface CanonicalReadFrame {
  readonly id:number;readonly width:number;readonly height:number;readonly time:number;readonly hash:string;
  readonly phase?:'input'|'recovery';readonly pixels:Uint8ClampedArray<ArrayBuffer>;
}
const natural=(value:unknown,minimum=0):value is number=>Number.isSafeInteger(value)&&(value as number)>=minimum;
export interface CanonicalReadOptions {
  read(offset:number,length:number):Uint8Array|Promise<Uint8Array>;
  frames:readonly CanonicalReadDescriptor[];
  signal?:AbortSignal;
  codecPolicy?:typeof RGBA_WINDOW_POLICY;
  /** Required for the window codec. The snapshot revision detects provider
   * lifetime/mutation, never card identity or independent capture evidence. */
  source?:BoundedReadSource;
}

/** Random access visits only a bounded key chain. No complete archive or range
 * is materialized: each envelope and compressed payload is read separately.
 * Returned pixels belong to this read, not the writer's previous-frame buffer. */
export async function readCanonicalFrame(options:CanonicalReadOptions):Promise<CanonicalReadFrame> {
  if(options.codecPolicy!==undefined&&options.codecPolicy!==RGBA_WINDOW_POLICY)throw Error('잘못된 정규 입력 복원 정책');
  if(options.codecPolicy===RGBA_WINDOW_POLICY)return readWindowCanonicalFrame(options);
  if(options.source!==undefined)throw Error('원본 범위 출처에는 명시적 복원 정책이 필요합니다.');
  const {frames,signal}=options;
  signal?.throwIfAborted();
  if(!Array.isArray(frames)||frames.length<1||frames.length>8)throw Error('정규 입력 복원 범위 오류');
  let decodedBytes=0,lastId=0,lastEnd=0,signature:string|undefined,marked:boolean|undefined;
  const checked:CanonicalReadDescriptor[]=[];
  for(const [index,frame]of frames.entries()){
    if(Object.hasOwn(frame,'codec')||Object.hasOwn(frame,'policy'))throw Error('정규 입력 색인과 복원 정책 불일치');
    const size=frame.width*frame.height*4;
    if(!natural(frame.frameId,1)||frame.frameId<=lastId||!natural(frame.offset)||!natural(frame.endOffset,1)||
      frame.endOffset<=frame.offset||index>0&&frame.offset<lastEnd||!natural(frame.width,1)||!natural(frame.height,1)||
      !natural(size,1)||size>MAX_FRAME_BYTES||typeof frame.captureTime!=='number'||!Number.isFinite(frame.captureTime)||frame.captureTime<0||
      typeof frame.key!=='boolean'||frame.key!==(index===0)||!/^[a-f0-9]{64}$/.test(frame.pixelHash)||
      index>0&&(frame.width!==frames[0].width||frame.height!==frames[0].height))throw Error('정규 입력 복원 색인 오류');
    const storage=frame.storage===undefined?undefined:parseFrameStorage(frame.storage,frame.width,frame.height),
      nextSignature=frameStorageSignature(storage,frame.width,frame.height),nextMarked=storage!==undefined;
    if(index>0&&(signature!==nextSignature||marked!==nextMarked))throw Error('정규 입력 복원 저장 형식 불일치');
    signature=nextSignature;marked=nextMarked;
    decodedBytes+=frameDecodeWorkBytes(storage,frame.width,frame.height);lastId=frame.frameId;lastEnd=frame.endOffset;
    checked.push({frameId:frame.frameId,offset:frame.offset,endOffset:frame.endOffset,width:frame.width,height:frame.height,
      captureTime:frame.captureTime,key:frame.key,pixelHash:frame.pixelHash,...(storage?{storage}:{})});
  }
  if(decodedBytes>32*1024*1024&&frames.length!==1)throw Error('정규 입력 복원 예산 초과');
  const read=async(offset:number,length:number)=>{
    signal?.throwIfAborted();
    const value=await options.read(offset,length);
    signal?.throwIfAborted();
    if(!(value instanceof Uint8Array)||value.byteLength!==length)throw Error('정규 입력 일부 읽기 실패');
    return value;
  };
  let stored:Uint8Array<ArrayBuffer>|undefined,pixels:Uint8Array<ArrayBuffer>|undefined;
  let result:Omit<CanonicalReadFrame,'pixels'>|undefined;
  for(const descriptor of checked){
    const prefix=await read(descriptor.offset,8),view=new DataView(prefix.buffer,prefix.byteOffset,prefix.byteLength);
    const headerBytes=view.getUint32(0,true),payloadBytes=view.getUint32(4,true);
    if(!headerBytes||headerBytes>1024*1024||payloadBytes>MAX_FRAME_BYTES+64_000||
      descriptor.offset+8+headerBytes+payloadBytes!==descriptor.endOffset)throw Error('정규 입력 항목 길이 오류');
    const header=JSON.parse(new TextDecoder().decode(await read(descriptor.offset+8,headerBytes)));
    if(!header||header.kind!=='frame'||header.id!==descriptor.frameId||header.time!==descriptor.captureTime||
      header.width!==descriptor.width||header.height!==descriptor.height||header.key!==descriptor.key||header.hash!==descriptor.pixelHash||
      header.codec!==undefined&&header.codec!=='lz4'||header.xor!==undefined&&typeof header.xor!=='boolean'||
      Object.hasOwn(header,'policy')||
      header.phase!==undefined&&header.phase!=='input'&&header.phase!=='recovery'||
      header.canonical!==undefined&&header.canonical!==true)throw Error('정규 입력 항목과 색인 불일치');
    const storage=Object.hasOwn(header,'storage')?parseFrameStorage(header.storage,header.width,header.height):undefined;
    if(storage!==undefined&&header.canonical!==true)throw Error('압축 원본 저장에는 정규 입력 형식이 필요합니다.');
    if(JSON.stringify(storage??null)!==JSON.stringify(descriptor.storage??null))throw Error('정규 입력 저장 정보와 색인 불일치');
    if(header.key)stored=new Uint8Array(frameStoredBytes(storage,header.width,header.height));
    if(!stored)throw Error('정규 입력 기준 프레임 없음');
    const payload=await read(descriptor.offset+8+headerBytes,payloadBytes);
    const maximum=stored.byteLength+Math.ceil(stored.byteLength/16384)*8+4;
    const delta=header.codec==='lz4'?fastInflate(payload,maximum):await inflate(new Blob([Uint8Array.from(payload)]),maximum);
    unpackPixels(delta,stored,header.xor);
    try{pixels=await restoreFrameStorage(storage,header.width,header.height,stored,header.hash);}
    catch(error){throw Error(`정규 입력 픽셀 불일치: ${header.id} (${error instanceof Error?error.message:String(error)})`,{cause:error});}
    signal?.throwIfAborted();
    result={id:header.id,width:header.width,height:header.height,time:header.time,hash:header.hash,
      ...(header.phase?{phase:header.phase}:{})};
  }
  return {...result!,pixels:new Uint8ClampedArray(pixels!.buffer,pixels!.byteOffset,pixels!.byteLength)};
}

/** New-policy random reads own one in-place target. They return that target to
 * the caller only after every dependency hash and the final source snapshot
 * check succeeds. No intermediate published RGBA copy is retained. */
async function readWindowCanonicalFrame(options:CanonicalReadOptions):Promise<CanonicalReadFrame> {
  const {frames,signal,source}=options;
  signal?.throwIfAborted();
  if(!source||Object.getOwnPropertyDescriptor(source,'read')?.value!==options.read)
    throw Error('정규 입력 범위 출처와 읽기 함수가 일치하지 않습니다.');
  if(!Array.isArray(frames)||frames.length<1||frames.length>8)throw Error('정규 입력 복원 범위 오류');
  const checked:CanonicalReadDescriptor[]=[];
  let lastId=0,lastEnd=0;
  for(const [index,frame]of frames.entries()){
    if(!frame||typeof frame!=='object'||Array.isArray(frame)||![Object.prototype,null].includes(Object.getPrototypeOf(frame))||
      Reflect.ownKeys(frame).some(key=>typeof key!=='string'||!('value'in Object.getOwnPropertyDescriptor(frame,key)!)))
      throw Error('정규 입력 window 색인 형식 오류');
    if(!frame||!natural(frame.frameId,1)||frame.frameId<=lastId||!natural(frame.offset)||!natural(frame.endOffset,1)||
      frame.endOffset<=frame.offset||index>0&&frame.offset<lastEnd||!natural(frame.width,1)||!natural(frame.height,1)||
      typeof frame.captureTime!=='number'||!Number.isFinite(frame.captureTime)||frame.captureTime<0||
      typeof frame.key!=='boolean'||frame.key!==(index===0)||typeof frame.pixelHash!=='string'||!/^[a-f0-9]{64}$/.test(frame.pixelHash)||
      frame.codec!==RGBA_WINDOW_CODEC||frame.policy!==RGBA_WINDOW_POLICY||Object.hasOwn(frame,'storage')||
      index>0&&(frame.width!==frames[0].width||frame.height!==frames[0].height))throw Error('정규 입력 window 색인 오류');
    const budget=windowWorkingSet(frame.width,frame.height);
    if(!budget.admitted)throw Error('정규 입력 window 복원 예산 초과');
    checked.push({frameId:frame.frameId,offset:frame.offset,endOffset:frame.endOffset,width:frame.width,height:frame.height,
      captureTime:frame.captureTime,key:frame.key,pixelHash:frame.pixelHash,codec:RGBA_WINDOW_CODEC,policy:RGBA_WINDOW_POLICY});
    lastId=frame.frameId;lastEnd=frame.endOffset;
  }
  const first=checked[0],last=checked.at(-1)!,budget=windowWorkingSet(first.width,first.height);
  const monitor=await createGenericBoundedInput({kind:'range',source,start:first.offset,length:last.endOffset-first.offset},{signal});
  const cooperationSignal=signal??new AbortController().signal;
  let stored:Uint8Array<ArrayBuffer>|undefined;
  let result:Omit<CanonicalReadFrame,'pixels'>|undefined;
  const selected={kind:'rgba-window' as const,version:6 as const,codec:RGBA_WINDOW_CODEC,policy:RGBA_WINDOW_POLICY};
  // Header buffers belong to the outer reservation. Use the same <=32KiB source
  // adapter for metadata too; a large untrusted header cannot bypass read bounds.
  const readHeaderBytes=async(offset:number,length:number):Promise<Uint8Array<ArrayBuffer>>=>{
    if(!natural(length,1)||length>1024*1024)throw Error('정규 입력 헤더 길이 오류');
    monitor.assertUnchanged();
    const input=await createGenericBoundedInput({kind:'range',source,start:offset,length},{signal});
    try{
      const bytes=new Uint8Array(length);let written=0;
      for(let next=await input.next();next!==undefined;next=await input.next()){
        bytes.set(next,written);written+=next.length;
      }
      if(written!==length)throw Error('정규 입력 헤더 일부 읽기 실패');
      monitor.assertUnchanged();return bytes;
    }finally{await input.dispose();}
  };
  try{
    for(const descriptor of checked){
      let prefix:Uint8Array<ArrayBuffer>|undefined=await readHeaderBytes(descriptor.offset,8);
      const view=new DataView(prefix.buffer,prefix.byteOffset,prefix.byteLength);
      const headerBytes=view.getUint32(0,true),payloadBytes=view.getUint32(4,true);prefix=undefined;
      const payloadOffset=descriptor.offset+8+headerBytes;
      if(!headerBytes||headerBytes>1024*1024||!natural(payloadBytes,9)||!Number.isSafeInteger(payloadOffset)||
        !Number.isSafeInteger(payloadOffset+payloadBytes)||payloadOffset+payloadBytes!==descriptor.endOffset)
        throw Error('정규 입력 항목 길이 오류');
      let encodedHeader:Uint8Array<ArrayBuffer>|undefined=await readHeaderBytes(descriptor.offset+8,headerBytes);
      const header=parseWindowFrame(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(encodedHeader)),payloadBytes,selected);
      encodedHeader=undefined;
      if(header.id!==descriptor.frameId||header.time!==descriptor.captureTime||header.width!==descriptor.width||
        header.height!==descriptor.height||header.key!==descriptor.key||header.hash!==descriptor.pixelHash)
        throw Error('정규 입력 항목과 색인 불일치');
      if(header.key){
        // A random range has one first key and one size. Reuse/clear that one
        // target rather than briefly retaining old+new targets with an output.
        if(stored&&stored.byteLength===budget.rgbaBytes)stored.fill(0);
        else{stored=undefined;stored=new Uint8Array(budget.rgbaBytes);}
      }
      if(!stored)throw Error('정규 입력 기준 프레임 없음');
      const decoded=await decodeFastPixelPatchFromSource({kind:'range',source,start:payloadOffset,length:payloadBytes},stored,
        {xor:header.xor===true,signal,yieldTask:()=>yieldForCapture(cooperationSignal)});
      if(decoded.pixels!==stored||decoded.stats.peakInputBackingBytes>32768||
        decoded.stats.peakExplicitOwnedBytes>budget.decoderOwnedBytes)throw Error('정규 입력 window 소유 버퍼 예산 초과');
      if(await pixelHash(stored)!==header.hash)throw Error(`정규 입력 픽셀 불일치: ${header.id}`);
      signal?.throwIfAborted();monitor.assertUnchanged();
      result={id:header.id,width:header.width,height:header.height,time:header.time,hash:header.hash,
        ...(header.phase?{phase:header.phase}:{})};
    }
    monitor.assertUnchanged();
    const output=stored!;stored=undefined;
    return {...result!,pixels:new Uint8ClampedArray(output.buffer,output.byteOffset,output.byteLength)};
  }finally{stored=undefined;await monitor.dispose();}
}
