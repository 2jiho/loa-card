import {compressBlock,decompressBlock} from 'lz4-lite';
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
export async function pixelHash(data: Uint8Array<ArrayBuffer>) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', data))].map(v => v.toString(16).padStart(2, '0')).join('');
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
export const MAX_FRAME_BYTES = 64 * 1024 * 1024;
export interface ExactFrame { kind: 'frame'; id: number; time: number; width: number; height: number; key: boolean; hash: string; codec?:'lz4'; xor?:boolean;phase?:'input'|'recovery' }
export interface ExactEvent { kind: 'event'; seq: number; time: number; type: string; value: unknown }
export type ExactEntry = ExactFrame | ExactEvent;
export function entryParts(header: ExactEntry, payload = new Uint8Array()): BlobPart[] {
  const json = new TextEncoder().encode(JSON.stringify(header)), prefix = new Uint8Array(8);
  new DataView(prefix.buffer).setUint32(0, json.length, true); new DataView(prefix.buffer).setUint32(4, payload.length, true);
  return [prefix, json, payload];
}
export async function* exactEntries(blob: Blob, signal: AbortSignal): AsyncGenerator<{header:ExactEntry;payload:Blob;percent:number}> {
  let offset = 0, cachedAt=-1, cached=new Uint8Array();
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
    if (header.kind === 'frame' && (!Number.isSafeInteger(header.id) || header.id < 1 || !Number.isSafeInteger(header.width) || !Number.isSafeInteger(header.height) || header.width < 1 || header.height < 1 || header.width * header.height * 4 > MAX_FRAME_BYTES || typeof header.key !== 'boolean' || (header.codec!==undefined&&header.codec!=='lz4') || (header.xor!==undefined&&typeof header.xor!=='boolean') || (header.phase!==undefined&&!['input','recovery'].includes(header.phase)) || !/^[a-f0-9]{64}$/.test(header.hash))) throw Error('잘못된 프레임 정보');
    if (header.kind === 'event' && (!Number.isSafeInteger(header.seq) || header.seq < 1 || typeof header.type !== 'string' || length !== 0)) throw Error('잘못된 이벤트 정보');
    const start = offset + 8 + size; offset = start + length;
    yield {header, payload:blob.slice(start, offset), percent:offset / blob.size * 100};
  }
}
export async function* exactPixels(blob:Blob, signal:AbortSignal) {
  let pixels:Uint8Array<ArrayBuffer>|undefined, width=0, height=0, lastId=0;
  for await (const entry of exactEntries(blob,signal)) {
    if(entry.header.kind!=='frame')continue;
    const h=entry.header;
    if(h.id<=lastId)throw Error('프레임 순서 오류');lastId=h.id;
    if(h.key){width=h.width;height=h.height;pixels=new Uint8Array(width*height*4);}
    if(!pixels||width!==h.width||height!==h.height)throw Error('기준 프레임 누락');
    const maximum=pixels.length+Math.ceil(pixels.length/16384)*8+4;
    unpackPixels(h.codec==='lz4'?fastInflate(new Uint8Array(await entry.payload.arrayBuffer()),maximum):await inflate(entry.payload,maximum),pixels,h.xor);
    if(await pixelHash(pixels)!==h.hash)throw Error(`입력 픽셀 불일치: 프레임 ${h.id}`);
    signal.throwIfAborted();
    yield { ...h, pixels, percent:entry.percent };
  }
}

/** One decoded frame at a time. The next frame is read only after collect() finishes. */
export async function* exactReplayFrames(blob:Blob,signal:AbortSignal,onVerified?:(count:number,hash:string)=>void,expectedFrames?:number){
 const canvas=document.createElement('canvas');let count=0;
 try{for await(const frame of exactPixels(blob,signal)){
   canvas.width=frame.width;canvas.height=frame.height;
   canvas.getContext('2d',{willReadFrequently:true})!.putImageData(new ImageData(new Uint8ClampedArray(frame.pixels.buffer),frame.width,frame.height),0,0);
   onVerified?.(++count,frame.hash);
   yield {element:canvas,time:frame.time,percent:frame.percent};
 }
 if(!count)throw Error('재현 가능한 입력 프레임이 없습니다.');
 if(expectedFrames!==undefined&&count!==expectedFrames)throw Error('기록 프레임 수 불일치');
 }finally{canvas.width=0;}
}
export async function executionSummary(blob:Blob,signal:AbortSignal){
 let events=0,frames=0,lastSequence=0,first=Infinity,last=0;
 const kinds:Record<string,number>=Object.create(null),cards=new Map<string,{id:string;name:string;awakening:number|null;extraCopies:number|null}>();
 for await(const {header} of exactEntries(blob,signal)){
  if(header.kind==='frame'){frames++;continue;}
  if(header.seq<=lastSequence)throw Error('이벤트 순서 오류');lastSequence=header.seq;
  events++;first=Math.min(first,header.time);last=Math.max(last,header.time);if(!(header.type in kinds)&&Object.keys(kinds).length>=64)throw Error('이벤트 종류 한도 초과');kinds[header.type]=(kinds[header.type]??0)+1;
  if(header.type==='card'){const card=header.value as {id:string;name:string;awakening:number|null;extraCopies:number|null};if(typeof card?.id==='string'){if(!cards.has(card.id)&&cards.size>=1000)throw Error('카드 기록 한도 초과');cards.set(card.id,{id:card.id,name:card.name,awakening:card.awakening,extraCopies:card.extraCopies});}}
 }
 return {events,frames,seconds:events?last-first:0,kinds,cards:[...cards.values()]};
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
