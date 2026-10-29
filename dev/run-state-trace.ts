import {ScanGrid} from '../src/features/card-scanner/scan-grid';
import {
  applyScanGridCommand, hashScanGridReplay, parseScanGridCommand, scanGridReplaySnapshot,
} from '../src/features/card-scanner/scan-grid-command';
import type {ScanGridCommand} from '../src/features/card-scanner/scan-grid-command';
import {parseObservationFact} from '../src/features/card-scanner/observation-execution';
import type {ObservationFact} from '../src/features/card-scanner/observation-execution';
import {ObservationExecutionReplay} from '../src/features/card-scanner/observation-execution-replay';
import {
  inventoryEventData, parseInventoryEvent, parseInventorySeed,
} from '../src/features/card-scanner/inventory-evidence';
import type {SerializedInventoryEvent} from '../src/features/card-scanner/inventory-evidence';
import {InventoryEvidenceReplay, parseInventoryCheckpoint} from '../src/features/card-scanner/inventory-evidence-replay';
import type {InventoryCheckpoint} from '../src/features/card-scanner/inventory-evidence-replay';
import {parseLiveInputAdmissionFact} from '../src/features/card-scanner/live-input-admission';
import {parseInputArrival,parseInputBackupReservation,parseBackupCapacityDeferral} from '../src/features/card-scanner/input-arrival';
import {parseAcquisitionCapture,parseRecognitionCapture} from '../src/features/card-scanner/capture-provenance';
import {parseScrollCaptureFact,parseInventoryHeaderFact} from '../src/features/card-scanner/scroll-capture-diagnostic';
import {parseMediaLineageFact,parseMediaInputLink} from '../src/features/card-scanner/media-lineage';
import {parseMediaPlaybackFact} from './media-playback-observer';
import {parseLiveCaptureDecision} from '../src/features/card-scanner/live-capture-pipeline';
import {InputDecisionReplay,parseInputCheckpoint,parseInputFrameLink} from '../src/features/card-scanner/live-input-decision-replay';
import {yieldForCapture} from '../src/features/card-scanner/input-source';
import {parseUnknownCheckpoint,parseUnknownFact,parseUnknownSeed} from '../src/features/card-scanner/unknown-lifecycle';
import {UnknownLifecycleReplay} from '../src/features/card-scanner/unknown-lifecycle-replay';
import {parseFreshnessSeed,parseFreshnessFact,parseFreshnessCheckpoint} from '../src/features/card-scanner/freshness-evidence';
import {FreshnessEvidenceReplay} from '../src/features/card-scanner/freshness-evidence-replay';
import {RunStateCompression} from './run-state-compression';

/** Encoded payload bounds, not a claim about the JavaScript heap's size. */
export const MAX_RUN_STATE_TRACE_BYTES = 8 * 1024 * 1024;
export const MAX_RUN_STATE_TRACE_RAW_BYTES = 128 * 1024 * 1024;
export const MAX_RUN_STATE_TRACE_PENDING_BYTES = 2 * 1024 * 1024;
export const MAX_RUN_STATE_TRACE_EVENTS = 250_000;
export const MAX_RUN_STATE_TRACE_BLOB_BYTES = 12 * 1024 * 1024;
// A difficult recorded run reached 101k events and about 60 MiB of source JSON.
// Archive capacity covers that scale; staging remains bounded independently.
// The recorded 48k-event run produced 381 native gzip streams at 32 KiB;
// 128 KiB batches reduced that to 91. A 2 MiB staging cap also accommodates
// short recognition bursts without making capture wait for the compressor.
const MAX_CHUNKS = 2048, BATCH_BYTES = 128 * 1024;
const encoder = new TextEncoder();

/** Optional diagnostic bridge from trace time to the page clock. It does not
 * authorize a capture, card identity, completion, or a reducer transition. */
export interface ScannerClockFact {
  readonly version:1;
  readonly clock:'page-performance-now';
  readonly phase:'input-and-recognition';
  readonly originMs:number;
}
export type RunStateTraceEvent = {readonly seq:number;readonly time:number} & (
  | {readonly type:'recording-availability';readonly value:{readonly status:'active'|'disabled'|'failed';readonly liveScreen:boolean}}
  | {readonly type:'scanner-clock';readonly value:ScannerClockFact}
  | {readonly type:'grid-command';readonly value:ScanGridCommand}
  | {readonly type:'observation-fact';readonly value:ObservationFact}
  | {readonly type:'inventory-seed';readonly value:ReturnType<typeof parseInventorySeed>}
  | {readonly type:'inventory-event';readonly value:SerializedInventoryEvent}
  | {readonly type:'inventory-checkpoint';readonly value:InventoryCheckpoint}
  | {readonly type:'input-admission';readonly value:ReturnType<typeof parseLiveInputAdmissionFact>}
  | {readonly type:'input-arrival';readonly value:ReturnType<typeof parseInputArrival>}
  | {readonly type:'input-backup-reservation';readonly value:ReturnType<typeof parseInputBackupReservation>}
  | {readonly type:'backup-capacity-deferral';readonly value:ReturnType<typeof parseBackupCapacityDeferral>}
  | {readonly type:'acquisition-capture';readonly value:ReturnType<typeof parseAcquisitionCapture>}
  | {readonly type:'recognition-capture';readonly value:ReturnType<typeof parseRecognitionCapture>}
  | {readonly type:'scroll-capture';readonly value:ReturnType<typeof parseScrollCaptureFact>}
  | {readonly type:'inventory-header-read';readonly value:ReturnType<typeof parseInventoryHeaderFact>}
  | {readonly type:'media-lineage';readonly value:ReturnType<typeof parseMediaLineageFact>}
  | {readonly type:'media-input-link';readonly value:ReturnType<typeof parseMediaInputLink>}
  | {readonly type:'source-playback';readonly value:ReturnType<typeof parseMediaPlaybackFact>}
  | {readonly type:'input-decision';readonly value:ReturnType<typeof parseLiveCaptureDecision>}
  | {readonly type:'input-link';readonly value:ReturnType<typeof parseInputFrameLink>}
  | {readonly type:'input-checkpoint';readonly value:ReturnType<typeof parseInputCheckpoint>}
  | {readonly type:'unknown-seed';readonly value:ReturnType<typeof parseUnknownSeed>}
  | {readonly type:'unknown-event';readonly value:ReturnType<typeof parseUnknownFact>}
  | {readonly type:'unknown-checkpoint';readonly value:ReturnType<typeof parseUnknownCheckpoint>}
  | {readonly type:'freshness-seed';readonly value:ReturnType<typeof parseFreshnessSeed>}
  | {readonly type:'freshness-event';readonly value:ReturnType<typeof parseFreshnessFact>}
  | {readonly type:'freshness-checkpoint';readonly value:ReturnType<typeof parseFreshnessCheckpoint>}
);
export interface RunStateTraceSnapshot {
  readonly version:1|2;
  /** All selected state events were retained; not a card accuracy assertion. */
  readonly complete:boolean;
  readonly dropped:number;
  readonly events:readonly RunStateTraceEvent[];
}
interface CompressedChunk {readonly bytes:number;readonly events:number;readonly data:string;}
interface CompressedTrace {
  readonly version:2;readonly codec:'gzip';readonly complete:boolean;readonly dropped:number;
  /** Prefix totals are independent of the chunks, so losing a trailing no-op
   * command cannot masquerade as a complete recording with the same grid hash. */
  readonly events:number;readonly chunkCount:number;readonly lastSeq:number;
  readonly chunks:readonly CompressedChunk[];
}
type TraceInput = CompressedTrace | RunStateTraceSnapshot;

function object(value:unknown,keys:readonly string[],ownData=false):Record<string,unknown> {
  if(!value||typeof value!=='object'||Array.isArray(value)||
    ![Object.prototype,null].includes(Object.getPrototypeOf(value)))throw Error('잘못된 상태 기록 객체');
  const result=value as Record<string,unknown>;
  if(ownData){
    const fields=Reflect.ownKeys(result),detached:Record<string,unknown>=Object.create(null);
    if(fields.length!==keys.length||fields.some(key=>typeof key!=='string'||!keys.includes(key)))
      throw Error('잘못된 상태 기록 필드');
    for(const key of keys){
      const property=Object.getOwnPropertyDescriptor(result,key);
      if(!property||!('value' in property)||!property.enumerable)throw Error('상태 기록은 고유 데이터 필드가 필요합니다.');
      detached[key]=property.value;
    }
    return detached;
  }
  if(Object.keys(result).length!==keys.length||keys.some(key=>!Object.hasOwn(result,key)))
    throw Error('잘못된 상태 기록 필드');
  return result;
}
function positive(value:unknown,maximum:number):value is number {
  return Number.isSafeInteger(value)&&(value as number)>0&&(value as number)<=maximum;
}
function scannerClock(value:unknown):ScannerClockFact {
  const clock=object(value,['version','clock','phase','originMs'],true);
  if(clock.version!==1||clock.clock!=='page-performance-now'||clock.phase!=='input-and-recognition'||
    typeof clock.originMs!=='number'||!Number.isFinite(clock.originMs)||clock.originMs<0)
    throw Error('잘못된 스캐너 시계 진단');
  return Object.freeze({version:1,clock:'page-performance-now',phase:'input-and-recognition',originMs:clock.originMs});
}
function parseEvent(value:unknown):RunStateTraceEvent {
  const event=object(value,['seq','time','type','value']);
  if(!positive(event.seq,Number.MAX_SAFE_INTEGER)||typeof event.time!=='number'||
    !Number.isFinite(event.time)||event.time<0)throw Error('잘못된 상태 기록 순서 또는 시각');
  const base={seq:event.seq,time:event.time};
  if(event.type==='recording-availability'){
    const value=object(event.value,['status','liveScreen'],true);
    if((value.status!=='active'&&value.status!=='disabled'&&value.status!=='failed')||typeof value.liveScreen!=='boolean')
      throw Error('잘못된 기록 가용성 진단');
    return Object.freeze({...base,type:'recording-availability',value:Object.freeze({status:value.status,liveScreen:value.liveScreen})});
  }
  if(event.type==='scanner-clock')return Object.freeze({...base,type:'scanner-clock',value:scannerClock(event.value)});
  if(event.type==='grid-command')return Object.freeze({...base,type:'grid-command',value:parseScanGridCommand(event.value)});
  if(event.type==='observation-fact')return Object.freeze({...base,type:'observation-fact',value:parseObservationFact(event.value)});
  if(event.type==='inventory-seed')return Object.freeze({...base,type:'inventory-seed',value:parseInventorySeed(event.value)});
  if(event.type==='inventory-event')return Object.freeze({...base,type:'inventory-event',value:inventoryEventData(parseInventoryEvent(event.value))});
  if(event.type==='inventory-checkpoint')return Object.freeze({...base,type:'inventory-checkpoint',value:parseInventoryCheckpoint(event.value)});
  if(event.type==='input-admission')return Object.freeze({...base,type:'input-admission',value:parseLiveInputAdmissionFact(event.value)});
  if(event.type==='input-arrival')return Object.freeze({...base,type:'input-arrival',value:parseInputArrival(event.value)});
  if(event.type==='input-backup-reservation')return Object.freeze({...base,type:'input-backup-reservation',value:parseInputBackupReservation(event.value)});
  if(event.type==='backup-capacity-deferral')return Object.freeze({...base,type:'backup-capacity-deferral',value:parseBackupCapacityDeferral(event.value)});
  if(event.type==='acquisition-capture')return Object.freeze({...base,type:'acquisition-capture',value:parseAcquisitionCapture(event.value)});
  if(event.type==='recognition-capture')return Object.freeze({...base,type:'recognition-capture',value:parseRecognitionCapture(event.value)});
  if(event.type==='scroll-capture')return Object.freeze({...base,type:'scroll-capture',value:parseScrollCaptureFact(event.value)});
  if(event.type==='inventory-header-read')return Object.freeze({...base,type:'inventory-header-read',value:parseInventoryHeaderFact(event.value)});
  if(event.type==='media-lineage')return Object.freeze({...base,type:'media-lineage',value:parseMediaLineageFact(event.value)});
  if(event.type==='media-input-link')return Object.freeze({...base,type:'media-input-link',value:parseMediaInputLink(event.value)});
  if(event.type==='source-playback')return Object.freeze({...base,type:'source-playback',value:parseMediaPlaybackFact(event.value)});
  if(event.type==='input-decision')return Object.freeze({...base,type:'input-decision',value:parseLiveCaptureDecision(event.value)});
  if(event.type==='input-link')return Object.freeze({...base,type:'input-link',value:parseInputFrameLink(event.value)});
  if(event.type==='input-checkpoint')return Object.freeze({...base,type:'input-checkpoint',value:parseInputCheckpoint(event.value)});
  if(event.type==='unknown-seed')return Object.freeze({...base,type:'unknown-seed',value:parseUnknownSeed(event.value)});
  if(event.type==='unknown-event')return Object.freeze({...base,type:'unknown-event',value:parseUnknownFact(event.value)});
  if(event.type==='unknown-checkpoint')return Object.freeze({...base,type:'unknown-checkpoint',value:parseUnknownCheckpoint(event.value)});
  if(event.type==='freshness-seed')return Object.freeze({...base,type:'freshness-seed',value:parseFreshnessSeed(event.value)});
  if(event.type==='freshness-event')return Object.freeze({...base,type:'freshness-event',value:parseFreshnessFact(event.value)});
  if(event.type==='freshness-checkpoint')return Object.freeze({...base,type:'freshness-checkpoint',value:parseFreshnessCheckpoint(event.value)});
  throw Error('지원하지 않는 상태 기록 이벤트');
}
function base64(bytes:Uint8Array):string {
  // No spread or per-byte array: large command chunks cannot overflow the stack.
  let binary='';for(const byte of bytes)binary+=String.fromCharCode(byte);
  return btoa(binary);
}
function compressedSize(value:unknown):number {
  if(typeof value!=='string'||!value.length||value.length%4||
    value.length>Math.ceil(MAX_RUN_STATE_TRACE_BYTES/3)*4||!/^[A-Za-z0-9+/]*={0,2}$/.test(value))
    throw Error('잘못된 상태 기록 압축 데이터');
  return value.length/4*3-(value.endsWith('==')?2:value.endsWith('=')?1:0);
}
function decodeBase64(value:string):Uint8Array<ArrayBuffer> {
  const binary=atob(value);
  if(btoa(binary)!==value)throw Error('잘못된 상태 기록 압축 데이터');
  const bytes=new Uint8Array(binary.length);
  for(let index=0;index<binary.length;index++)bytes[index]=binary.charCodeAt(index);
  return bytes;
}
async function inflate(chunk:CompressedChunk,signal:AbortSignal):Promise<string> {
  signal.throwIfAborted();
  const reader=new Blob([decodeBase64(chunk.data)]).stream().pipeThrough(new DecompressionStream('gzip')).getReader();
  // Allocate only the validated declared size; reject before copying any excess.
  const bytes=new Uint8Array(chunk.bytes);let size=0,finished=false;
  const abort=()=>{void reader.cancel().catch(()=>undefined);};
  signal.addEventListener('abort',abort,{once:true});
  try{
    while(true){
      signal.throwIfAborted();const {done,value}=await reader.read();signal.throwIfAborted();
      if(done){finished=true;break;}
      if(size+value.byteLength>bytes.byteLength)throw Error('상태 기록 압축 해제 용량 한도 초과');
      bytes.set(value,size);size+=value.byteLength;
    }
    if(size!==chunk.bytes)throw Error('상태 기록 압축 해제 크기 불일치');
    return new TextDecoder('utf-8',{fatal:true}).decode(bytes);
  }finally{
    signal.removeEventListener('abort',abort);
    if(!finished)await reader.cancel().catch(()=>undefined);reader.releaseLock();
  }
}

/** Development-only recorder. Sync capture just appends serialized facts.
 * Two Worker gzip lanes consume bounded batches independently of scanning.
 * No frames, pixels or mutable input references are retained. */
export class RunStateTrace {
  private readonly maxBytes:number;
  private readonly maxRawBytes:number;
  private readonly maxPendingBytes:number;
  private readonly maxEvents:number;
  private readonly jobs:Promise<CompressedChunk|null>[]=[];
  private commitTail:Promise<unknown>=Promise.resolve();
  private readonly compression:RunStateCompression;
  private batch:string[]=[];
  private batchBytes=0;
  private pendingBytes=0;
  private peakPendingBytes=0;
  private rawBytes=0;
  private compressedBytes=0;
  private events=0;
  private accepted=0;
  private sequence=0;
  private dropped=0;
  private full=false;
  private storageFull=false;

  constructor(options:{maxBytes?:number;maxRawBytes?:number;maxPendingBytes?:number;maxEvents?:number;
    compression?:RunStateCompression}={}) {
    this.maxBytes=options.maxBytes??MAX_RUN_STATE_TRACE_BYTES;
    this.maxRawBytes=options.maxRawBytes??MAX_RUN_STATE_TRACE_RAW_BYTES;
    this.maxPendingBytes=options.maxPendingBytes??MAX_RUN_STATE_TRACE_PENDING_BYTES;
    this.maxEvents=options.maxEvents??MAX_RUN_STATE_TRACE_EVENTS;
    this.compression=options.compression??new RunStateCompression();
    if(!positive(this.maxBytes,MAX_RUN_STATE_TRACE_BYTES)||!positive(this.maxRawBytes,MAX_RUN_STATE_TRACE_RAW_BYTES)||
      !positive(this.maxPendingBytes,MAX_RUN_STATE_TRACE_PENDING_BYTES)||!positive(this.maxEvents,MAX_RUN_STATE_TRACE_EVENTS))
      throw Error('잘못된 상태 기록 한도');
  }

  record(type:string,value:unknown,time:number):boolean {
    if(!['grid-command','observation-fact','inventory-seed','inventory-event','inventory-checkpoint',
      'input-admission','input-arrival','input-backup-reservation','backup-capacity-deferral','input-decision','input-link','input-checkpoint','input-recording-error',
      'acquisition-capture','recognition-capture','scroll-capture','inventory-header-read','capture-recording-error',
      'media-lineage','media-input-link','media-recording-error',
      'source-playback','scanner-clock','recording-availability',
      'unknown-seed','unknown-event','unknown-checkpoint','unknown-recording-error',
      'freshness-seed','freshness-event','freshness-checkpoint','freshness-recording-error'].includes(type))return false;
    this.sequence=Math.min(Number.MAX_SAFE_INTEGER,this.sequence+1);
    const drop=()=>{this.dropped=Math.min(Number.MAX_SAFE_INTEGER,this.dropped+1);return false;};
    // A failed optional decision recorder may already have omitted facts before
    // this callback. Never call the remaining selected state a complete run.
    if(type==='input-recording-error'||type==='unknown-recording-error'||type==='capture-recording-error'||type==='media-recording-error'||type==='freshness-recording-error')return drop();
    if(this.full||this.accepted>=this.maxEvents||this.jobs.length>=MAX_CHUNKS){this.full=true;return drop();}
    let json:string;
    try{json=JSON.stringify(parseEvent({seq:this.sequence,time,type,value}));}
    catch{return drop();}
    const size=encoder.encode(json).byteLength+1; // NDJSON newline belongs to the batch.
    if(this.rawBytes+size>this.maxRawBytes||this.pendingBytes+size>this.maxPendingBytes){this.full=true;return drop();}
    if(this.batchBytes&&this.batchBytes+size>BATCH_BYTES)this.flush();
    if(this.jobs.length>=MAX_CHUNKS){this.full=true;return drop();}
    this.batch.push(json);this.batchBytes+=size;this.pendingBytes+=size;this.rawBytes+=size;
    this.peakPendingBytes=Math.max(this.peakPendingBytes,this.pendingBytes);this.events++;this.accepted++;
    if(this.batchBytes>=BATCH_BYTES)this.flush();
    return true;
  }

  private flush():void {
    if(!this.batch.length)return;
    const raw=this.batch.join('\n')+'\n',bytes=this.batchBytes,events=this.batch.length;
    this.batch=[];this.batchBytes=0;
    // Compression starts independently, but storage commits follow input order.
    // A later job must not consume an earlier snapshot's byte budget or make an
    // earlier prefix incomplete. Retain its pending reservation through commit.
    const work=this.compression.compress(raw,bytes,this.maxBytes),previous=this.commitTail;
    const job=(async():Promise<CompressedChunk|null>=>{
      try{
        const compressed=await work;await previous;
        if(this.storageFull)throw Error('상태 기록 압축 한도 도달');
        if(this.compressedBytes+compressed.byteLength>this.maxBytes)throw Error('상태 기록 압축 용량 한도 초과');
        const chunk=Object.freeze({bytes,events,data:base64(compressed)});
        this.compressedBytes+=compressed.byteLength;
        return chunk;
      }catch{
        await previous;
        this.full=true;this.storageFull=true;this.events-=events;this.dropped+=events;return null;
      }finally{this.pendingBytes-=bytes;}
    })();
    this.jobs.push(job);this.commitTail=job;
  }

  /** Release old runs/page resources; already captured prefixes settle partial
   * if their compression was still outstanding. Settled snapshots stay valid. */
  dispose():void {this.flush();this.full=true;this.compression.dispose();}

  get stats(){return Object.freeze({events:this.events,bytes:this.compressedBytes,rawBytes:this.rawBytes,
    compressedBytes:this.compressedBytes,pendingBytes:this.pendingBytes,peakPendingBytes:this.peakPendingBytes,
    dropped:this.dropped,complete:this.dropped===0,compression:this.compression.stats});}

  /** Fix the prefix synchronously before awaiting compression. Future calls to
   * record, including failures/overflow, cannot alter this snapshot's contents. */
  async snapshotBlob():Promise<Blob> {
    this.flush();const prefix=this.jobs.slice(),sequence=this.sequence;
    const chunks=(await Promise.all(prefix)).filter((chunk):chunk is CompressedChunk=>chunk!==null);
    const events=chunks.reduce((count,chunk)=>count+chunk.events,0),dropped=sequence-events;
    const snapshot:CompressedTrace={version:2,codec:'gzip',complete:dropped===0,dropped,
      events,chunkCount:chunks.length,lastSeq:sequence,chunks};
    return new Blob([JSON.stringify(snapshot)],{type:'application/json;charset=utf-8'});
  }
}

async function readTrace(blob:Blob,signal:AbortSignal):Promise<TraceInput> {
  signal.throwIfAborted();
  if(blob.size>MAX_RUN_STATE_TRACE_BLOB_BYTES)throw Error('상태 기록 파일 용량 한도 초과');
  const bytes=await blob.arrayBuffer();signal.throwIfAborted();
  const value:unknown=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
  const version=value&&typeof value==='object'?'version' in value?value.version:undefined:undefined;
  const raw=object(value,version===1?['version','complete','dropped','events']:
    ['version','codec','complete','dropped','events','chunkCount','lastSeq','chunks']);
  if(typeof raw.complete!=='boolean'||!Number.isSafeInteger(raw.dropped)||(raw.dropped as number)<0||raw.complete&&raw.dropped!==0)
    throw Error('잘못된 상태 기록 버전 또는 한도');
  if(version===1){
    if(blob.size>MAX_RUN_STATE_TRACE_BYTES+256||!Array.isArray(raw.events)||raw.events.length>MAX_RUN_STATE_TRACE_EVENTS)
      throw Error('잘못된 상태 기록 버전 또는 한도');
    // Legacy values are strictly parsed on iteration, never trusted by replay.
    return {version:1,complete:raw.complete,dropped:raw.dropped as number,events:raw.events};
  }
  if(version!==2||raw.codec!=='gzip'||!Array.isArray(raw.chunks)||raw.chunks.length>MAX_CHUNKS)
    throw Error('잘못된 상태 기록 버전 또는 한도');
  if(!Number.isSafeInteger(raw.events)||(raw.events as number)<0||(raw.events as number)>MAX_RUN_STATE_TRACE_EVENTS||
    !Number.isSafeInteger(raw.chunkCount)||raw.chunkCount!==raw.chunks.length||
    !Number.isSafeInteger(raw.lastSeq)||(raw.lastSeq as number)<0||
    (raw.events as number)+(raw.dropped as number)!==raw.lastSeq)
    throw Error('상태 기록 전체 이벤트 또는 청크 수 불일치');
  const chunks:CompressedChunk[]=[];let rawBytes=0,compressedBytes=0,events=0;
  for(const value of raw.chunks){
    const chunk=object(value,['bytes','events','data']);
    if(!positive(chunk.bytes,MAX_RUN_STATE_TRACE_PENDING_BYTES)||!positive(chunk.events,MAX_RUN_STATE_TRACE_EVENTS))
      throw Error('잘못된 상태 기록 청크 한도');
    rawBytes+=chunk.bytes;events+=chunk.events;compressedBytes+=compressedSize(chunk.data);
    if(rawBytes>MAX_RUN_STATE_TRACE_RAW_BYTES||compressedBytes>MAX_RUN_STATE_TRACE_BYTES||events>MAX_RUN_STATE_TRACE_EVENTS)
      throw Error('상태 기록 용량 또는 이벤트 한도 초과');
    chunks.push(Object.freeze({bytes:chunk.bytes,events:chunk.events,data:chunk.data as string}));
  }
  if(events!==raw.events)throw Error('상태 기록 전체 이벤트 수 불일치');
  signal.throwIfAborted();
  return {version:2,codec:'gzip',complete:raw.complete,dropped:raw.dropped as number,
    events,chunkCount:raw.chunkCount as number,lastSeq:raw.lastSeq as number,chunks};
}

async function* iterateEvents(trace:TraceInput,signal:AbortSignal):AsyncGenerator<RunStateTraceEvent> {
  let sequence=0,count=0;
  const next=async(value:unknown)=>{
    if(count%256===0)await yieldForCapture(signal);
    const event=parseEvent(value);
    if(event.seq<=sequence||trace.complete&&event.seq!==sequence+1)throw Error('상태 기록 이벤트 순서 오류');
    if('chunks' in trace&&event.seq>trace.lastSeq)throw Error('상태 기록 마지막 순번 불일치');
    sequence=event.seq;if(++count>MAX_RUN_STATE_TRACE_EVENTS)throw Error('상태 기록 이벤트 한도 초과');
    return event;
  };
  if('chunks' in trace){
    for(const chunk of trace.chunks){
      const text=await inflate(chunk,signal),lines=text.split('\n');
      if(lines.pop()!==''||lines.length!==chunk.events)throw Error('상태 기록 청크 이벤트 수 불일치');
      for(const line of lines)yield await next(JSON.parse(line));
    }
    if(count!==trace.events||trace.complete&&sequence!==trace.lastSeq)throw Error('상태 기록 마지막 순번 또는 이벤트 수 불일치');
  }else for(const value of trace.events)yield await next(value);
  signal.throwIfAborted();
}

/** Explicit full-event inspection can retain up to 128 MiB of source JSON as
 * expanded objects (heap usage can be larger). Use only for deliberate analysis;
 * normal replay below instead decodes and applies one chunk at a time. */
export async function parseRunStateTrace(blob:Blob,signal:AbortSignal):Promise<RunStateTraceSnapshot> {
  const trace=await readTrace(blob,signal),events:RunStateTraceEvent[]=[];
  for await(const event of iterateEvents(trace,signal))events.push(event);
  return Object.freeze({version:trace.version,complete:trace.complete,dropped:trace.dropped,events:Object.freeze(events)});
}

/** Reapply command order and common lifecycle reducers without OCR or the live
 * scheduler. Only compressed chunks and bounded reducer state are retained. */
export async function replayRunStateTrace(blob:Blob,signal:AbortSignal) {
  const trace=await readTrace(blob,signal);
  if(!trace.complete||trace.dropped)throw Error('불완전한 상태 기록은 전체 실행 비교에 사용할 수 없습니다.');
  const grid=new ScanGrid(),observations=new ObservationExecutionReplay(signal);let commands=0,events=0;
  const inventory=new InventoryEvidenceReplay(signal);
  const input=new InputDecisionReplay(signal);
  const unknownLifecycle=new UnknownLifecycleReplay(signal);
  const freshness=new FreshnessEvidenceReplay(signal,()=>inventory.confirmedFieldOrder);
  for await(const event of iterateEvents(trace,signal)){
    if(event.type==='grid-command'){applyScanGridCommand(grid,event.value);commands++;}
    else if(event.type==='observation-fact')observations.accept(event.value);
    else if(event.type==='inventory-seed'){inventory.seed(event.value);freshness.proofsChanged();}
    else if(event.type==='inventory-event'){inventory.accept(event.value);freshness.proofsChanged();}
    else if(event.type==='inventory-checkpoint')inventory.checkpoint(event.value);
    else if(event.type==='input-admission')input.admission(event.value);
    else if(event.type==='input-decision')input.pipeline(event.value);
    else if(event.type==='input-link')input.link(event.value);
    else if(event.type==='input-checkpoint')input.checkpoint(event.value);
    else if(event.type==='unknown-seed')unknownLifecycle.seed(event.value);
    else if(event.type==='unknown-event')unknownLifecycle.accept(event.value);
    else if(event.type==='unknown-checkpoint')unknownLifecycle.checkpoint(event.value);
    else if(event.type==='freshness-seed')freshness.seed(event.value);
    else if(event.type==='freshness-event')freshness.accept(event.value);
    else if(event.type==='freshness-checkpoint')freshness.checkpoint(event.value);
    // Clock anchors, backup deferral, acquisition/recognition receipts and scroll/header facts
    // are retained/countable metadata, never reducer evidence.
    events++;
  }
  signal.throwIfAborted();
  const hash=commands?await hashScanGridReplay(scanGridReplaySnapshot(grid)):null;
  signal.throwIfAborted();const observationSummary=await observations.summary();signal.throwIfAborted();
  const inventorySummary=await inventory.summary();
  const inputSummary=await input.summary();
  const unknownSummary=await unknownLifecycle.summary();
  const freshnessSummary=await freshness.summary();
  signal.throwIfAborted();
  return {version:trace.version,complete:true as const,events,
    grid:{supported:commands>0,commands,hash},observations:observationSummary,
    inventory:inventorySummary,input:inputSummary,unknownLifecycle:unknownSummary,freshness:freshnessSummary};
}
