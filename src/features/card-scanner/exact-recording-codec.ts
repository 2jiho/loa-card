import {compressBlock,decompressBlock} from 'lz4-lite';
import {ScanGrid} from './scan-grid';
import {applyScanGridCommand,hashScanGridReplay,scanGridReplaySnapshot} from './scan-grid-command';
import {parseScannerInputProvenance,type ScannerInputFrame} from './scanner-input-frame';
import {ObservationExecutionReplay} from './observation-execution-replay';
import {InventoryEvidenceReplay} from './inventory-evidence-replay';
import {InputDecisionReplay} from './live-input-decision-replay';
import {UnknownLifecycleReplay} from './unknown-lifecycle-replay';
import {FreshnessEvidenceReplay} from './freshness-evidence-replay';
import {yieldForCapture} from './input-source';
import {CanonicalFrameIndex} from './canonical-frame-index';
import {readCanonicalFrame} from './canonical-frame-reader';
import {parseCanonicalSourceUse,type CanonicalSourceUse} from './canonical-source-use';
import {parseScrollCaptureFact,parseInventoryHeaderFact} from './scroll-capture-diagnostic';
import {CanonicalRasterReplay} from './canonical-raster-replay';
import {CanonicalStorageAttestationReplay} from './canonical-storage-attestation';
import {MAX_FRAME_BYTES} from './recording-frame-integrity';
import {parseFrameStorage,frameStorageSignature,frameStoredBytes,frameDecodeWorkBytes,restoreFrameStorage} from './native-frame-storage';
import type {FrameStorage} from './native-frame-storage';
import {RGBA_WINDOW_CODEC,RGBA_WINDOW_POLICY,admitWindowFrame,
  type WindowPolicy,type DependencyState} from './rgba-window-policy';
import {decodeFastPixelPatchFromSource} from './streaming-delta-source';
const WINDOW_FORMAT:WindowPolicy=Object.freeze({kind:'rgba-window',version:6,codec:RGBA_WINDOW_CODEC,policy:RGBA_WINDOW_POLICY});
export {MAX_FRAME_BYTES,pixelHash} from './recording-frame-integrity';
/** Lossless block deltas. Exact byte comparisons, never a similarity threshold. */
export function packPixels(current: Uint8Array, previous?: Uint8Array, xor=false): Uint8Array<ArrayBuffer> {
  const sameSize = previous?.length === current.length;
  const blocks: number[] = [];
  const block = 16_384;
  let size = 4;
  for (let from = 0; from < current.length; from += block) {
    const end = Math.min(current.length, from + block);
    let changed = !sameSize;
    if (!changed) for (let i = from; i < end; i++) if (current[i] !== previous![i]) { changed = true; break; }
    if (changed) { blocks.push(from); size += 8 + end - from; }
  }
  const out = new Uint8Array(size), view = new DataView(out.buffer);
  view.setUint32(0, blocks.length, true);
  let offset = 4;
  for (const from of blocks) {
    const length = Math.min(block, current.length - from);
    view.setUint32(offset, from, true); view.setUint32(offset + 4, length, true);
    if(xor&&sameSize){for(let i=0;i<length;i++)out[offset+8+i]=current[from+i]^previous![from+i];}
    else out.set(current.subarray(from, from + length), offset + 8);
    offset += 8 + length;
  }
  return out;
}
export function unpackPixels(delta: Uint8Array, target: Uint8Array, xor=false) {
  if (delta.length < 4) throw Error('잘린 픽셀 기록');
  const view = new DataView(delta.buffer, delta.byteOffset, delta.byteLength);
  const count = view.getUint32(0, true);
  let offset = 4, end = 0;
  if (count > Math.ceil(target.length / 16_384)) throw Error('픽셀 블록 수 초과');
  for (let i = 0; i < count; i++) {
    if (offset + 8 > delta.length) throw Error('잘린 픽셀 블록');
    const from = view.getUint32(offset, true), length = view.getUint32(offset + 4, true);
    if (from < end || from % 16_384 || length !== Math.min(16_384, target.length - from) || length <= 0 || from + length > target.length || offset + 8 + length > delta.length)
      throw Error('잘못된 픽셀 블록');
    if(xor){for(let i=0;i<length;i++)target[from+i]^=delta[offset+8+i];}
    else target.set(delta.subarray(offset + 8, offset + 8 + length), from);
    end = from + length; offset += 8 + length;
  }
  if (offset !== delta.length) throw Error('불필요한 픽셀 데이터');
}
export async function deflate(data: Uint8Array<ArrayBuffer>) {
  return new Uint8Array(await new Response(new Blob([data]).stream().pipeThrough(new CompressionStream('deflate'))).arrayBuffer());
}
export async function inflate(data: Blob, maximum: number) {
  const reader = data.stream().pipeThrough(new DecompressionStream('deflate')).getReader();
  const chunks: Uint8Array[] = []; let bytes = 0;
  try {
    while (true) { const next = await reader.read(); if (next.done) break;
      bytes += next.value.length; if (bytes > maximum) throw Error('압축 해제 용량 초과'); chunks.push(next.value);
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  const output = new Uint8Array(bytes); let at = 0;
  for (const chunk of chunks) { output.set(chunk, at); at += chunk.length; }
  return output;
}
export interface ExactFrame { kind: 'frame'; id: number; time: number; width: number; height: number; key: boolean; hash: string; codec?:'lz4'|typeof RGBA_WINDOW_CODEC;policy?:typeof RGBA_WINDOW_POLICY; xor?:boolean;phase?:'input'|'recovery';canonical?:true;storage?:FrameStorage }
export interface ExactEvent { kind: 'event'; seq: number; time: number; type: string; value: unknown }
export type ExactEntry = ExactFrame | ExactEvent;
export function entryParts(header: ExactEntry, payload = new Uint8Array()): BlobPart[] {
  const json = new TextEncoder().encode(JSON.stringify(header)), prefix = new Uint8Array(8);
  new DataView(prefix.buffer).setUint32(0, json.length, true); new DataView(prefix.buffer).setUint32(4, payload.length, true);
  return [prefix, json, payload];
}
export async function* exactEntries(blob: Blob, signal: AbortSignal): AsyncGenerator<{header:ExactEntry;payload:Blob;percent:number;endOffset:number}> {
  let offset = 0, cachedAt=-1, cached=new Uint8Array(),storageMarked:boolean|undefined,windowMarked:boolean|undefined;
  let windowState:DependencyState|null=null;
  // Events have no payload. Reuse one immutable empty value instead of creating
  // a native Blob slice for every event in long state/diagnostic journals.
  const emptyPayload=new Blob();
  const read=async(at:number,length:number)=>{
    if(at<cachedAt||at+length>cachedAt+cached.length){signal.throwIfAborted();cachedAt=at;cached=new Uint8Array(await blob.slice(at,Math.min(blob.size,at+Math.max(1024*1024,length))).arrayBuffer());}
    return cached.subarray(at-cachedAt,at-cachedAt+length);
  };
  while (offset < blob.size) {
    signal.throwIfAborted();
    const prefix = await read(offset,8);
    if (prefix.byteLength !== 8) throw Error('잘린 재현 기록');
    const view = new DataView(prefix.buffer,prefix.byteOffset,prefix.byteLength), size = view.getUint32(0, true), length = view.getUint32(4, true);
    if (!size || size > 1024 * 1024 || length > MAX_FRAME_BYTES + 64_000 || offset + 8 + size + length > blob.size) throw Error('잘못된 재현 기록 길이');
    const header = JSON.parse(new TextDecoder().decode(await read(offset+8,size))) as ExactEntry;
    if (!Number.isFinite(header.time) || header.time < 0 || !['frame','event'].includes(header.kind)) throw Error('잘못된 재현 시각');
    if(header.kind==='frame'&&header.canonical!==undefined&&header.canonical!==true)throw Error('잘못된 공통 원본 형식');
    if (header.kind === 'frame' && (!Number.isSafeInteger(header.id) || header.id < 1 || !Number.isSafeInteger(header.width) || !Number.isSafeInteger(header.height) || header.width < 1 || header.height < 1 || header.width * header.height * 4 > MAX_FRAME_BYTES || typeof header.key !== 'boolean' || (header.codec!==undefined&&header.codec!=='lz4'&&header.codec!==RGBA_WINDOW_CODEC) || (header.xor!==undefined&&typeof header.xor!=='boolean') || (header.phase!==undefined&&!['input','recovery'].includes(header.phase)) || !/^[a-f0-9]{64}$/.test(header.hash))) throw Error('잘못된 프레임 정보');
    if(header.kind==='frame'){
      const window=header.codec===RGBA_WINDOW_CODEC;
      if(window)windowState=admitWindowFrame(WINDOW_FORMAT,windowState,header,length).state;
      else if(Object.hasOwn(header,'policy'))throw Error('기존 프레임에 새 복원 정책을 사용할 수 없습니다.');
      if(windowMarked!==undefined&&windowMarked!==window)throw Error('혼합된 프레임 복원 정책');
      windowMarked=window;
      if(Object.hasOwn(header,'storage'))header.storage=parseFrameStorage(header.storage,header.width,header.height);
      const marked=header.storage!==undefined;
      if(marked&&header.canonical!==true)throw Error('압축 원본 저장에는 정규 입력 형식이 필요합니다.');
      if(storageMarked!==undefined&&storageMarked!==marked)throw Error('혼합된 압축 원본 저장 형식');
      storageMarked=marked;
    }
    if (header.kind === 'event' && (!Number.isSafeInteger(header.seq) || header.seq < 1 || typeof header.type !== 'string' || length !== 0)) throw Error('잘못된 이벤트 정보');
    const start = offset + 8 + size; offset = start + length;
    yield {header, payload:length?blob.slice(start, offset):emptyPayload, percent:offset / blob.size * 100,endOffset:offset};
  }
}
function checkStorageVersion(storage:FrameStorage|undefined,expected:0|1|undefined):void {
  if(expected!==undefined&&expected!==0&&expected!==1)throw Error('잘못된 원본 저장 버전');
  if(expected!==undefined&&Number(storage!==undefined)!==expected)throw Error('기록 버전과 원본 저장 형식 불일치');
}
function checkExpectedCodecPolicy(value:unknown):asserts value is typeof RGBA_WINDOW_POLICY|undefined {
  if(value!==undefined&&value!==RGBA_WINDOW_POLICY)throw Error('잘못된 프레임 복원 정책');
}
function checkFrameCodecPolicy(frame:ExactFrame,expected:typeof RGBA_WINDOW_POLICY|undefined):void {
  checkExpectedCodecPolicy(expected);
  if(expected===RGBA_WINDOW_POLICY?(frame.codec!==RGBA_WINDOW_CODEC||frame.policy!==RGBA_WINDOW_POLICY):
    (frame.codec===RGBA_WINDOW_CODEC||Object.hasOwn(frame,'policy')))throw Error('기록 버전과 프레임 복원 정책 불일치');
}
/** Each yielded RGBA buffer belongs to the consumer. The decoder retains its
 * stored predecessor privately until the next key replaces the delta chain. */
export async function* exactPixels(blob:Blob, signal:AbortSignal,expectedStorageVersion?:0|1,expectedCodecPolicy?:typeof RGBA_WINDOW_POLICY) {
  if(expectedStorageVersion!==undefined&&expectedStorageVersion!==0&&expectedStorageVersion!==1)throw Error('잘못된 원본 저장 버전');
  checkExpectedCodecPolicy(expectedCodecPolicy);
  if(expectedCodecPolicy!==undefined&&expectedStorageVersion===1)throw Error('새 복원 정책은 RGBA 입력만 지원합니다.');
  let windowState:DependencyState|null=null;
  let stored:Uint8Array<ArrayBuffer>|undefined,width=0,height=0,lastId=0,canonical:boolean|undefined,signature:string|undefined,
    chainFrames=0,chainBytes=0;
  for await (const entry of exactEntries(blob,signal)) {
    if(entry.header.kind!=='frame')continue;
    const h=entry.header;
    checkFrameCodecPolicy(h,expectedCodecPolicy);
    checkStorageVersion(h.storage,expectedStorageVersion);
    if(canonical!==undefined&&canonical!==!!h.canonical)throw Error('혼합된 원본 기록 형식');canonical=!!h.canonical;
    if(h.id<=lastId)throw Error('프레임 순서 오류');lastId=h.id;
    const nextSignature=frameStorageSignature(h.storage,h.width,h.height);
    const nextChainFrames=h.key?1:chainFrames+1,
      nextChainBytes=frameDecodeWorkBytes(h.storage,h.width,h.height)+(h.key?0:chainBytes);
    if(expectedCodecPolicy===RGBA_WINDOW_POLICY)windowState=admitWindowFrame(WINDOW_FORMAT,windowState,h,entry.payload.size).state;
    else if(h.canonical&&(nextChainFrames>8||nextChainBytes>32*1024*1024&&nextChainFrames>1))throw Error('정규 입력 복원 예산 초과');
    if(h.key){
      const size=frameStoredBytes(h.storage,h.width,h.height);
      if(expectedCodecPolicy===RGBA_WINDOW_POLICY&&stored?.length===size)stored.fill(0);
      else{stored=undefined;stored=new Uint8Array(size);}
      width=h.width;height=h.height;signature=nextSignature;
    }
    if(!stored||width!==h.width||height!==h.height||signature!==nextSignature)throw Error('기준 프레임 누락 또는 저장 형식 불일치');
    chainFrames=nextChainFrames;chainBytes=nextChainBytes;
    const maximum=stored.length+Math.ceil(stored.length/16384)*8+4;
    if(expectedCodecPolicy===RGBA_WINDOW_POLICY){
      await decodeFastPixelPatchFromSource({kind:'blob',blob:entry.payload,inputMode:'auto'},stored,
        {xor:h.xor===true,signal,yieldTask:()=>yieldForCapture(signal)});
    }else unpackPixels(h.codec==='lz4'?fastInflate(new Uint8Array(await entry.payload.arrayBuffer()),maximum):await inflate(entry.payload,maximum),stored,h.xor);
    let pixels:Uint8Array<ArrayBuffer>;
    try{pixels=await restoreFrameStorage(h.storage,h.width,h.height,stored,h.hash);}
    catch(error){throw Error(`입력 픽셀 불일치: 프레임 ${h.id} (${error instanceof Error?error.message:String(error)})`,{cause:error});}
    signal.throwIfAborted();
    // RGBA restore validates in place; native restore already generates a
    // separate RGBA buffer. Copy only the storage alias at this consumer boundary.
    if(pixels.buffer===stored.buffer)pixels=pixels.slice();
    yield { ...h, pixels, percent:entry.percent };
  }
}

/** One decoded frame at a time. The next frame is read only after collect() finishes. */
export async function* exactReplayFrames(blob:Blob,signal:AbortSignal,onVerified?:(count:number,hash:string)=>void,expectedFrames?:number,allowPartial=false,expectedStorageVersion?:0|1,expectedCodecPolicy?:typeof RGBA_WINDOW_POLICY):AsyncGenerator<ScannerInputFrame<HTMLCanvasElement>>{
 if(expectedStorageVersion!==undefined&&expectedStorageVersion!==0&&expectedStorageVersion!==1)throw Error('잘못된 원본 저장 버전');
 checkExpectedCodecPolicy(expectedCodecPolicy);
 let canonical=false;
 for await(const {header}of exactEntries(blob,signal)){if(header.kind==='frame'){checkStorageVersion(header.storage,expectedStorageVersion);checkFrameCodecPolicy(header,expectedCodecPolicy);canonical=!!header.canonical;break;}}
 if(canonical){yield* canonicalReplayFrames(blob,signal,onVerified,expectedFrames,allowPartial,expectedStorageVersion,expectedCodecPolicy);return;}
 const canvas=document.createElement('canvas');let count=0;
 try{for await(const frame of exactPixels(blob,signal,expectedStorageVersion,expectedCodecPolicy)){
   canvas.width=frame.width;canvas.height=frame.height;
   canvas.getContext('2d',{willReadFrequently:true})!.putImageData(new ImageData(new Uint8ClampedArray(frame.pixels.buffer),frame.width,frame.height),0,0);
   count++;onVerified?.(count,frame.hash);
   yield {element:canvas,time:frame.time,percent:frame.percent,provenance:parseScannerInputProvenance({
     frameId:frame.id,captureTime:frame.time,phase:frame.phase,pixelHash:frame.hash,
   })};
 }
 if(!count)throw Error('재현 가능한 입력 프레임이 없습니다.');
 if(expectedFrames!==undefined&&count!==expectedFrames)throw Error('기록 프레임 수 불일치');
 }finally{canvas.width=0;}
}

/** Pixel storage order and processing-use order differ. Build a bounded index
 * first, then replay each recorded acquisition use, including recovery reuse.
 * Backups without a use are hash-verified without inventing an OCR attempt. */
async function* canonicalReplayFrames(blob:Blob,signal:AbortSignal,onVerified:((count:number,hash:string)=>void)|undefined,expectedFrames:number|undefined,allowPartial:boolean,expectedStorageVersion:0|1|undefined,expectedCodecPolicy:typeof RGBA_WINDOW_POLICY|undefined):AsyncGenerator<ScannerInputFrame<HTMLCanvasElement>> {
 const index=new CanonicalFrameIndex({codecPolicy:expectedCodecPolicy}),uses:{value:CanonicalSourceUse;percent:number}[]=[],verified=new Set<number>();
 const storageAttestation=new CanonicalStorageAttestationReplay(signal);
 let offset=0,lastUse=0,entries=0;
 for await(const {header,endOffset,percent}of exactEntries(blob,signal)){
  storageAttestation.accept(header);
  if(header.kind==='frame'){
   checkStorageVersion(header.storage,expectedStorageVersion);
   checkFrameCodecPolicy(header,expectedCodecPolicy);
   if(!header.canonical)throw Error('혼합된 원본 기록 형식');
   index.append({sourceFrameId:header.id,frameId:header.id,offset,endOffset,width:header.width,height:header.height,
    captureTime:header.time,arrivalOrder:header.id,key:header.key,pixelHash:header.hash,role:'input',...(header.storage?{storage:header.storage}:{}),
    ...(expectedCodecPolicy?{codec:RGBA_WINDOW_CODEC,policy:expectedCodecPolicy}:{})});
  }else if(header.type==='canonical-source-use'){
   const value=parseCanonicalSourceUse(header.value);
   if(value.acquisitionFrameId<=lastUse||uses.length>=20_000)throw Error('공통 원본 사용 순서 또는 한도 오류');
   lastUse=value.acquisitionFrameId;uses.push({value,percent});
  }
  offset=endOffset;if(++entries%256===0)await yieldForCapture(signal);
 }
 if(expectedFrames!==undefined&&index.stats().entries!==expectedFrames)throw Error('기록 프레임 수 불일치');
 await storageAttestation.summary(!allowPartial);
 const read=async(id:number)=>{
  const range=index.decodeRange(id),frames=range.frameIds.map(frameId=>index.getByFrameId(frameId)!);
  const source={snapshot:()=>({byteLength:blob.size,revision:'immutable-blob-v1'}),
    read:async(at:number,length:number)=>new Uint8Array(await blob.slice(at,at+length).arrayBuffer())};
  const frame=await readCanonicalFrame({read:source.read,frames,signal,
    ...(expectedCodecPolicy?{source,codecPolicy:expectedCodecPolicy}:{})});
  if(!verified.has(id)){verified.add(id);onVerified?.(verified.size,frame.hash);}return frame;
 };
 const canvas=document.createElement('canvas');let played=0;
 try{
  for(const {value,percent}of uses){
   signal.throwIfAborted();const descriptor=index.get(value.sourceFrameId);
   if(!descriptor){if(allowPartial)continue;throw Error('사용한 공통 원본이 기록에 없습니다.');}
   if(Math.abs(descriptor.captureTime-value.captureTime)>1e-9)throw Error('공통 원본 사용 시각 불일치');
   const frame=await read(value.sourceFrameId);canvas.width=frame.width;canvas.height=frame.height;
   canvas.getContext('2d',{willReadFrequently:true})!.putImageData(new ImageData(frame.pixels,frame.width,frame.height),0,0);played++;
   yield {element:canvas,time:value.captureTime,percent,provenance:parseScannerInputProvenance({
    frameId:value.acquisitionFrameId,sourceFrameId:value.sourceFrameId,captureTime:value.captureTime,phase:value.phase,pixelHash:frame.hash})};
  }
  for(const descriptor of index.snapshotOriginals())if(!verified.has(descriptor.sourceFrameId)){await read(descriptor.sourceFrameId);await yieldForCapture(signal);}
  if(!played)throw Error('재현 가능한 판독 사용 기록이 없습니다.');
 }finally{canvas.width=canvas.height=0;}
}
export interface ExecutionRecordingTotals {readonly complete:boolean;readonly dropped:number|null;readonly events:number;readonly frames:number;readonly storageVersion?:1;readonly nativeFrames?:number;readonly rgbaFrames?:number;readonly nativeAttestedFrames?:number;readonly codec?:typeof RGBA_WINDOW_CODEC;readonly policy?:typeof RGBA_WINDOW_POLICY}
export async function executionSummary(blob:Blob,signal:AbortSignal,totals?:ExecutionRecordingTotals){
 if(totals){
   if(totals.codec!==undefined||totals.policy!==undefined){
     if(totals.codec!==RGBA_WINDOW_CODEC||totals.policy!==RGBA_WINDOW_POLICY||Object.hasOwn(totals,'storageVersion'))throw Error('실행 기록 복원 정책 불일치');
   }
 }
 if(totals&&(typeof totals.complete!=='boolean'||['events','frames'].some(key=>
   !Number.isSafeInteger(totals[key as 'events'|'frames'])||totals[key as 'events'|'frames']<0)||
   !(totals.dropped===null&&!totals.complete||Number.isSafeInteger(totals.dropped)&&totals.dropped!==null&&totals.dropped>=0)||
   totals.storageVersion!==undefined&&totals.storageVersion!==1))throw Error('잘못된 실행 기록 총량');
 if(totals&&(totals.storageVersion===1?
   !Number.isSafeInteger(totals.nativeFrames)||!Number.isSafeInteger(totals.rgbaFrames)||totals.nativeFrames! < 0||totals.rgbaFrames! < 0||
     totals.nativeFrames! + totals.rgbaFrames! !== totals.frames:
   Object.hasOwn(totals,'nativeFrames')||Object.hasOwn(totals,'rgbaFrames')))throw Error('잘못된 실행 기록 저장 종류 총량');
 if(totals?.nativeAttestedFrames!==undefined&&(totals.storageVersion!==1||!Number.isSafeInteger(totals.nativeAttestedFrames)||
   totals.nativeAttestedFrames<0||totals.nativeAttestedFrames>totals.nativeFrames!))throw Error('잘못된 native 변환 증명 총량');
 let grid:ScanGrid|undefined,gridCommands=0,expectedGridHash:string|null=null;
 let events=0,frames=0,nativeFrames=0,rgbaFrames=0,lastSequence=0,first=Infinity,last=0,inputRecordingLost=false,unknownRecordingLost=false,freshnessRecordingLost=false;
 const kinds:Record<string,number>=Object.create(null),cards=new Map<string,{id:string;name:string;awakening:number|null;extraCopies:number|null}>();
  const observationReplay=new ObservationExecutionReplay(signal),inventoryReplay=new InventoryEvidenceReplay(signal),inputReplay=new InputDecisionReplay(signal);let entries=0;
  const unknownReplay=new UnknownLifecycleReplay(signal);
 const freshnessReplay=new FreshnessEvidenceReplay(signal,()=>inventoryReplay.confirmedFieldOrder);
 const rasterReplay=new CanonicalRasterReplay();
 const storageAttestation=new CanonicalStorageAttestationReplay(signal);
 for await(const {header} of exactEntries(blob,signal)){
  rasterReplay.accept(header);
  storageAttestation.accept(header);
   if(++entries%256===0)await yieldForCapture(signal);
  if(header.kind==='frame'){checkStorageVersion(header.storage,totals?totals.storageVersion===1?1:0:undefined);checkFrameCodecPolicy(header,totals?.policy);frames++;
    if(header.storage?.kind==='native-yuv420')nativeFrames++;else if(header.storage?.kind==='rgba8')rgbaFrames++;continue;}
  if(header.seq<=lastSequence||totals?.complete&&header.seq!==lastSequence+1)throw Error('이벤트 순서 오류');lastSequence=header.seq;
  events++;first=Math.min(first,header.time);last=Math.max(last,header.time);if(!(header.type in kinds)&&Object.keys(kinds).length>=64)throw Error('이벤트 종류 한도 초과');kinds[header.type]=(kinds[header.type]??0)+1;
  if(header.type==='canonical-source-use')parseCanonicalSourceUse(header.value);
   if(header.type==='scroll-capture')parseScrollCaptureFact(header.value);
   if(header.type==='inventory-header-read')parseInventoryHeaderFact(header.value);
  if(header.type==='grid-command'){grid??=new ScanGrid();applyScanGridCommand(grid,header.value);gridCommands++;expectedGridHash=null;}
  if(header.type==='grid-checkpoint'){
    const checkpoint=header.value as {complete?:boolean;hash?:unknown;error?:unknown};
    if(!checkpoint||typeof checkpoint!=='object'||Array.isArray(checkpoint)||typeof checkpoint.complete!=='boolean'
      ||Object.keys(checkpoint).some(key=>!['complete','hash','error'].includes(key))
      ||checkpoint.error!==undefined&&(typeof checkpoint.error!=='string'||checkpoint.error.length>2000))throw Error('잘못된 지도 검증점');
    if(checkpoint.complete){if(typeof checkpoint.hash!=='string'||!/^[a-f0-9]{64}$/.test(checkpoint.hash))throw Error('잘못된 지도 검증 해시');expectedGridHash=checkpoint.hash;}
    else {if(checkpoint.hash!==undefined)throw Error('잘못된 지도 검증점');expectedGridHash=null;}
  }
  if(header.type==='card'){const card=header.value as {id:string;name:string;awakening:number|null;extraCopies:number|null};if(typeof card?.id==='string'){if(!cards.has(card.id)&&cards.size>=1000)throw Error('카드 기록 한도 초과');cards.set(card.id,{id:card.id,name:card.name,awakening:card.awakening,extraCopies:card.extraCopies});}}
   if(header.type==='observation-fact')observationReplay.accept(header.value);
   if(header.type==='inventory-seed'){inventoryReplay.seed(header.value);freshnessReplay.proofsChanged();}
   if(header.type==='inventory-event'){inventoryReplay.accept(header.value);freshnessReplay.proofsChanged();}
   if(header.type==='inventory-checkpoint')inventoryReplay.checkpoint(header.value);
   if(header.type==='input-admission')inputReplay.admission(header.value);
   if(header.type==='input-decision')inputReplay.pipeline(header.value);
   if(header.type==='input-link')inputReplay.link(header.value);
   if(header.type==='input-checkpoint')inputReplay.checkpoint(header.value);
   if(header.type==='input-recording-error')inputRecordingLost=true;
   if(header.type==='unknown-seed')unknownReplay.seed(header.value);
   if(header.type==='unknown-event')unknownReplay.accept(header.value);
   if(header.type==='unknown-checkpoint')unknownReplay.checkpoint(header.value);
   if(header.type==='unknown-recording-error')unknownRecordingLost=true;
   if(header.type==='freshness-seed')freshnessReplay.seed(header.value);
   if(header.type==='freshness-event')freshnessReplay.accept(header.value);
   if(header.type==='freshness-checkpoint')freshnessReplay.checkpoint(header.value);
   if(header.type==='freshness-recording-error')freshnessRecordingLost=true;
 }
  signal.throwIfAborted();
  if(totals&&(events!==totals.events||frames!==totals.frames))throw Error('실행 기록 총량 불일치');
  if(totals?.storageVersion===1&&(nativeFrames!==totals.nativeFrames||rgbaFrames!==totals.rgbaFrames))throw Error('실행 기록 저장 종류 총량 불일치');
  const recordingComplete=inputRecordingLost||unknownRecordingLost||freshnessRecordingLost?false:totals?totals.complete&&totals.dropped===0:null;
  const observations=await observationReplay.summary();
  const inventory=await inventoryReplay.summary();
  const input=await inputReplay.summary();
  const unknownLifecycle=await unknownReplay.summary();
  const freshness=await freshnessReplay.summary();
  const rasterProof=rasterReplay.summary(recordingComplete===true);
  const storageAttestationProof=await storageAttestation.summary(recordingComplete===true);
  if(totals?.nativeAttestedFrames!==undefined&&recordingComplete===true&&
    (!storageAttestationProof.supported||storageAttestationProof.attestations!==totals.nativeAttestedFrames))throw Error('native 변환 증명 기록 총량 불일치');
  const gridHash=grid?await hashScanGridReplay(scanGridReplaySnapshot(grid)):null;
  signal.throwIfAborted();
  return {events,frames,seconds:events?last-first:0,kinds,cards:[...cards.values()],observations,
    ...(rasterProof.supported?{rasterProof}:{}),
    ...(storageAttestationProof.supported?{storageAttestationProof}:{}),
    recordingComplete,inventory:{...inventory,matchesCapturedState:recordingComplete===false?null:inventory.matchesCapturedState},
    input:{...input,matchesCapturedState:recordingComplete===false?null:input.matchesCapturedState},
    unknownLifecycle:{...unknownLifecycle,complete:recordingComplete===true&&unknownLifecycle.complete,
      matchesCapturedState:recordingComplete===true?unknownLifecycle.matchesCapturedState:null},
    freshness:{...freshness,complete:recordingComplete===true&&freshness.complete,
      matchesCapturedState:recordingComplete===true?freshness.matchesCapturedState:null},
    grid:{supported:!!grid,commands:gridCommands,hash:gridHash,expectedHash:expectedGridHash,
      matchesCapturedState:recordingComplete!==false&&gridHash!==null&&expectedGridHash!==null?gridHash===expectedGridHash:null}};
}

/** Speed-first, bounded LZ4 block; raw fallback for tiny/incompressible deltas. */
export function fastCompress(data:Uint8Array<ArrayBuffer>){
 const output=compressBlock(data),size=output.length,compressed=size<data.length;
 const result=new Uint8Array(5+(compressed?size:data.length));result[0]=compressed?1:0;
 new DataView(result.buffer).setUint32(1,data.length,true);result.set(compressed?output.subarray(0,size):data,5);return result;
}
export function fastInflate(input:Uint8Array,maximum:number){
 if(input.length<5||input[0]>1)throw Error('잘못된 LZ4 기록');
 const size=new DataView(input.buffer,input.byteOffset,input.length).getUint32(1,true);
 if(size>maximum)throw Error('압축 해제 용량 초과');
 const data=input.subarray(5);
 if(input[0]===0){if(data.length!==size)throw Error('원본 블록 길이 오류');return data;}
 // The library decoder trusts its input. Validate every token before allocating/copying.
 let i=0,written=0;
 const extended=(base:number)=>{if(base!==15)return base;let value;do{if(i>=data.length)throw Error('잘린 LZ4 길이');value=data[i++];base+=value;if(base>maximum)throw Error('LZ4 길이 초과');}while(value===255);return base;};
 while(i<data.length){
  const token=data[i++],literal=extended(token>>>4);
  if(i+literal>data.length||written+literal>size)throw Error('LZ4 리터럴 초과');i+=literal;written+=literal;
  if(i===data.length)break;
  if(i+2>data.length)throw Error('잘린 LZ4 오프셋');const offset=data[i]|data[i+1]<<8;i+=2;
  if(!offset||offset>written)throw Error('잘못된 LZ4 오프셋');
  written+=extended(token&15)+4;if(written>size)throw Error('LZ4 출력 초과');
 }
 if(written!==size)throw Error('LZ4 출력 길이 오류');
 return decompressBlock(data,size);
}
