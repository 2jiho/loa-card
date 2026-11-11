import {hashBlobChunks} from './dev-blob-hash-core';
import {MAX_SESSION_CHUNK_BYTES} from './reproduction-session-store';
import type {ReproductionSessionIndex,SessionChunkKind} from './reproduction-session-store';

/** A raw journal is a byte-preserving evidence container, not a replay. It
 * includes incomplete final chunks and makes no claim about captured pixels. */
export const RAW_SESSION_MAGIC='LOARAW1\0';
export const MAX_RAW_HEADER_BYTES=32*1024*1024;
export const MAX_RAW_PAYLOAD_BYTES=512*1024*1024;
export const MAX_RAW_ARCHIVE_BYTES=12+MAX_RAW_HEADER_BYTES+MAX_RAW_PAYLOAD_BYTES;
export const MAX_RAW_CHUNKS=100_000;

export interface RawSessionChunk {
  readonly kind:SessionChunkKind;readonly seq:number;readonly bytes:number;readonly sha256:string;readonly blob:Blob;
}
export interface RawSessionSnapshot {
  readonly index:ReproductionSessionIndex;
  readonly initial?:unknown;readonly summary?:unknown;readonly metadata?:unknown;readonly exactFinalization?:unknown;
  /** Optional reference only; this container cannot authenticate the target. */
  readonly replayCaseId?:string;
  /** All video chunks followed by all exact chunks, each beginning at seq 0. */
  readonly chunks:readonly RawSessionChunk[];
}
export interface RawSessionHeader {
  readonly version:1;readonly kind:'raw-session';readonly replayable:false;
  readonly index:ReproductionSessionIndex;
  readonly initial?:unknown;readonly summary?:unknown;readonly metadata?:unknown;readonly exactFinalization?:unknown;
  readonly replayCaseId?:string;
  readonly chunks:readonly Omit<RawSessionChunk,'blob'>[];
}
export interface OpenRawSessionArchive {readonly metadata:RawSessionHeader;readonly chunks:readonly RawSessionChunk[]}

const encoder=new TextEncoder();
const magic=encoder.encode(RAW_SESSION_MAGIC);
const hashPattern=/^[a-f0-9]{64}$/;
const indexKinds=['video','exact'] as const;
function plain(value:unknown):value is Record<string,unknown> {
  return !!value&&typeof value==='object'&&!Array.isArray(value)&&[Object.prototype,null].includes(Object.getPrototypeOf(value));
}
function keys(value:Record<string,unknown>,allowed:readonly string[]) {
  if(Object.keys(value).some(key=>!allowed.includes(key)))throw Error('원시 기록에 알 수 없는 항목이 있습니다.');
}
function natural(value:unknown):value is number{return Number.isSafeInteger(value)&&(value as number)>=0;}
function identifier(value:unknown):boolean{return typeof value==='string'&&value.length>0&&value.length<=160;}
function date(value:unknown):boolean{return typeof value==='string'&&value.length<=64&&Number.isFinite(Date.parse(value));}
function optionalCount(value:unknown):boolean{return value===null||natural(value);}
function descriptor(input:unknown):Omit<RawSessionChunk,'blob'> {
  if(!plain(input))throw Error('잘못된 원시 기록 청크 정보입니다.');
  keys(input,['kind','seq','bytes','sha256']);
  if((input.kind!=='video'&&input.kind!=='exact')||!natural(input.seq)||!natural(input.bytes)||input.bytes<1||
    input.bytes>MAX_SESSION_CHUNK_BYTES||typeof input.sha256!=='string'||!hashPattern.test(input.sha256))
    throw Error('잘못된 원시 기록 청크 정보입니다.');
  return {kind:input.kind,seq:input.seq,bytes:input.bytes,sha256:input.sha256};
}
/** Treat metadata as untrusted. Existing detailed fields are preserved, but
 * identity, sealing and accounting must agree with the serialized chunks. */
function validateHeader(input:unknown):RawSessionHeader {
  if(!plain(input))throw Error('잘못된 원시 기록 헤더입니다.');
  keys(input,['version','kind','replayable','index','initial','summary','metadata','exactFinalization','replayCaseId','chunks']);
  if(input.version!==1||input.kind!=='raw-session'||input.replayable!==false||!plain(input.index)||!Array.isArray(input.chunks)||input.chunks.length>MAX_RAW_CHUNKS)
    throw Error('지원하지 않는 원시 기록 형식입니다.');
  if(input.replayCaseId!==undefined&&(typeof input.replayCaseId!=='string'||!hashPattern.test(input.replayCaseId)))
    throw Error('잘못된 재현 사례 참조입니다.');
  const index=input.index;
  if(index.version!==1||!identifier(index.id)||index.sealed!==true||
    !['complete','partial','failed'].includes(index.status as string)||!identifier(index.generation)||!identifier(index.archiveRevision)||
    !date(index.createdAt)||!date(index.updatedAt)||!plain(index.environment)||
    ['browser','catalog','build'].some(field=>typeof (index.environment as Record<string,unknown>)[field]!=='string'||
      ((index.environment as Record<string,string>)[field]).length>4096)||
    typeof index.record!=='boolean'||typeof index.pinned!=='boolean'||!identifier(index.ownerId)||index.leaseUntil!==null||
    !optionalCount(index.read)||!optionalCount(index.expected)||!optionalCount(index.cards)||
    !plain(index.chunkCounts)||!plain(index.chunkBytes)||!natural(index.detailsBytes)||!natural(index.bytes)||
    typeof index.hasInput!=='boolean')throw Error('잘못된 원시 기록 세션입니다.');
  const descriptors=input.chunks.map(descriptor),counts={video:0,exact:0},sizes={video:0,exact:0};let exactStarted=false;
  for(const item of descriptors){
    if(item.kind==='exact')exactStarted=true;
    if(item.kind==='video'&&exactStarted||item.seq!==counts[item.kind])throw Error('원시 기록 청크 순서가 올바르지 않습니다.');
    counts[item.kind]++;sizes[item.kind]+=item.bytes;
    if(!Number.isSafeInteger(sizes[item.kind])||sizes.video+sizes.exact>MAX_RAW_PAYLOAD_BYTES)throw Error('원시 기록 용량 한도 초과');
  }
  for(const kind of indexKinds){
    if(!natural(index.chunkCounts[kind])||!natural(index.chunkBytes[kind])||index.chunkCounts[kind]!==counts[kind]||index.chunkBytes[kind]!==sizes[kind])
      throw Error('세션과 원시 기록 청크 수 또는 용량이 다릅니다.');
  }
  if(index.hasInput!==(descriptors.length>0)||index.bytes!==index.detailsBytes+sizes.video+sizes.exact)
    throw Error('원시 기록 세션 용량이 일치하지 않습니다.');
  return {...input,index:index as unknown as ReproductionSessionIndex,chunks:descriptors} as unknown as RawSessionHeader;
}
function headerBytes(snapshot:RawSessionSnapshot) {
  if(!snapshot||!Array.isArray(snapshot.chunks)||snapshot.chunks.length>MAX_RAW_CHUNKS)throw Error('잘못된 원시 기록입니다.');
  const descriptors=snapshot.chunks.map(chunk=>({kind:chunk.kind,seq:chunk.seq,bytes:chunk.bytes,sha256:chunk.sha256}));
  const value={version:1,kind:'raw-session',replayable:false,index:snapshot.index,
    ...(snapshot.initial===undefined?{}:{initial:snapshot.initial}),...(snapshot.summary===undefined?{}:{summary:snapshot.summary}),
    ...(snapshot.metadata===undefined?{}:{metadata:snapshot.metadata}),
    ...(snapshot.exactFinalization===undefined?{}:{exactFinalization:snapshot.exactFinalization}),
    ...(snapshot.replayCaseId===undefined?{}:{replayCaseId:snapshot.replayCaseId}),chunks:descriptors};
  let text:string,nodes=0;
  try{text=JSON.stringify(value,(_key,item:unknown)=>{
    if(++nodes>1_000_000)throw Error('원시 기록 정보 항목 한도 초과');
    if(item===null||typeof item==='boolean'||typeof item==='string'||typeof item==='number'&&Number.isFinite(item)||Array.isArray(item)||plain(item))return item;
    throw Error('원시 기록 정보는 JSON이어야 합니다.');
  });}catch{throw Error('원시 기록 정보는 JSON이어야 합니다.');}
  if(typeof text!=='string'||text.length>MAX_RAW_HEADER_BYTES)throw Error('원시 기록 헤더 용량 초과');
  const bytes=encoder.encode(text);
  if(bytes.length>MAX_RAW_HEADER_BYTES)throw Error('원시 기록 헤더 용량 초과');
  // Reparse the actual bytes and apply the same serialized validation as the
  // receiver. The replacer above rejects implicit numeric/undefined changes.
  const parsed=JSON.parse(text) as unknown;validateHeader(parsed);
  return bytes;
}

/** Create from verified immutable Blob chunks. Chunk bytes are still hashed
 * again: a store receipt is not an independent file integrity check. */
export async function createRawSessionArchive(snapshot:RawSessionSnapshot,signal:AbortSignal,
  options:{hashChunks?:(blobs:readonly Blob[],signal:AbortSignal)=>Promise<readonly string[]>}={}):Promise<Blob> {
  signal.throwIfAborted();const header=headerBytes(snapshot);
  for(const chunk of snapshot.chunks){
    signal.throwIfAborted();
    if(!(chunk.blob instanceof Blob)||chunk.blob.size!==chunk.bytes)
      throw Error('원시 기록 청크 해시가 일치하지 않습니다.');
  }
  if(options.hashChunks){
    const hashes=await options.hashChunks(snapshot.chunks.map(chunk=>chunk.blob),signal);signal.throwIfAborted();
    if(!Array.isArray(hashes)||hashes.length!==snapshot.chunks.length||hashes.some((hash,index)=>hash!==snapshot.chunks[index].sha256))
      throw Error('원시 기록 청크 해시가 일치하지 않습니다.');
  }else for(const chunk of snapshot.chunks){
    signal.throwIfAborted();
    if(await hashBlobChunks(chunk.blob,signal)!==chunk.sha256)throw Error('원시 기록 청크 해시가 일치하지 않습니다.');
  }
  const prefix=new Uint8Array(12);prefix.set(magic);new DataView(prefix.buffer).setUint32(8,header.length,true);
  const archive=new Blob([prefix,header,...snapshot.chunks.map(chunk=>chunk.blob)],{type:'application/octet-stream'});
  if(archive.size>MAX_RAW_ARCHIVE_BYTES)throw Error('원시 기록 용량 한도 초과');
  signal.throwIfAborted();return archive;
}

/** Verify a file-backed Blob sequentially. Only the bounded header and one
 * bounded hash slice are materialized; returned payloads are Blob slices. */
export async function openRawSessionArchive(blob:Blob,signal:AbortSignal):Promise<OpenRawSessionArchive> {
  signal.throwIfAborted();
  if(!(blob instanceof Blob)||blob.size<12||blob.size>MAX_RAW_ARCHIVE_BYTES)throw Error('원시 기록 크기가 올바르지 않습니다.');
  const prefix=new Uint8Array(await blob.slice(0,12).arrayBuffer());signal.throwIfAborted();
  if(prefix.length!==12||!magic.every((byte,index)=>prefix[index]===byte))throw Error('원시 기록 식별자가 올바르지 않습니다.');
  const length=new DataView(prefix.buffer,prefix.byteOffset,prefix.byteLength).getUint32(8,true);
  if(!length||length>MAX_RAW_HEADER_BYTES||12+length>blob.size)throw Error('원시 기록 헤더 길이가 올바르지 않습니다.');
  let text:string,value:unknown;
  try{text=new TextDecoder('utf-8',{fatal:true}).decode(await blob.slice(12,12+length).arrayBuffer());value=JSON.parse(text);}
  catch{throw Error('원시 기록 헤더를 읽을 수 없습니다.');}
  signal.throwIfAborted();
  if(JSON.stringify(value)!==text)throw Error('원시 기록 헤더가 정규 형식이 아닙니다.');
  const metadata=validateHeader(value),chunks:RawSessionChunk[]=[];let offset=12+length;
  for(const desc of metadata.chunks){
    signal.throwIfAborted();const end=offset+desc.bytes;
    if(end>blob.size)throw Error('원시 기록 청크가 잘렸습니다.');
    const part=blob.slice(offset,end);
    if(await hashBlobChunks(part,signal)!==desc.sha256)throw Error('원시 기록 청크 해시가 일치하지 않습니다.');
    chunks.push({...desc,blob:part});offset=end;
  }
  if(offset!==blob.size)throw Error('원시 기록에 추가 바이트가 있습니다.');
  signal.throwIfAborted();return {metadata,chunks};
}
