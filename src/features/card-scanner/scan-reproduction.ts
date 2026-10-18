import {createExactRecording} from './exact-recording';
import type {ExactRecording,ExactRecordingStats} from './exact-recording';
import {parseDebugCapture} from './debug-capture';
import type {DebugCapture} from './debug-capture';
import type {ScannerState,runScanner} from './scanner';
import type {ScannedCard} from './recognizer';
import type {ContinuousRecording} from './continuous-capture';

const MAGIC='LOACARD-REPLAY1\n';
const MAX_META=16*1024*1024,MAX_VIDEO=256*1024*1024,MAX_EXACT=1024*1024*1024;
export function reproductionResult(state:ScannerState){return {
  expected:state.expected,read:state.currentRunRead??0,unidentified:state.unidentified.filter(c=>!c.pending).length,
  experience:state.growthPoints?.current??null,
  cards:state.cards.map(({id,name,awakening,extraCopies,review})=>({id,name,awakening,extraCopies,review:[...review]})).sort((a,b)=>a.id.localeCompare(b.id)),
};}
export type ReproductionResult=ReturnType<typeof reproductionResult>;
export interface ReproductionMetadata {
  version:1|2;createdAt:string;browser:string;catalog:string;build:string;completed:boolean;warnings:string[];
  exact?:ExactRecordingStats;signature?:string;duration:number;type:string;bytes:number;seed:ScannedCard[];result:ReproductionResult|null;
}
export interface ReproductionFile {metadata:ReproductionMetadata;video:Blob;exact?:Blob}

function validateMetadata(value:unknown):ReproductionMetadata {
  const m=value as ReproductionMetadata;
  if(!m||![1,2].includes(m.version)||!['createdAt','browser','catalog','build'].every(key=>typeof m[key as keyof ReproductionMetadata]==='string')||
    typeof m.completed!=='boolean'||!Array.isArray(m.warnings)||m.warnings.length>100||m.warnings.some(w=>typeof w!=='string')||
    !Number.isFinite(m.duration)||m.duration<=0||!Number.isSafeInteger(m.bytes)||m.bytes<1||m.bytes>MAX_VIDEO||
    typeof m.type!=='string'||!/^video\/webm(?:;codecs=(?:vp8|vp9)(?:,opus)?)?$/.test(m.type))throw Error('재현 기록 정보가 올바르지 않습니다.');
  if(m.version===2){
    const e=m.exact;
    if(!e||!['frames','events','dropped','bytes','peakQueuedBytes','peakWorkingBytes','readbackMs','encodeMs'].every(k=>Number.isFinite(e[k as keyof ExactRecordingStats])&&Number(e[k as keyof ExactRecordingStats])>=0)||
      !Number.isSafeInteger(e.bytes)||e.bytes>MAX_EXACT||typeof e.complete!=='boolean'||typeof e.error!=='string'||(m.signature!==undefined&&typeof m.signature!=='string'))throw Error('무손실 기록 정보가 올바르지 않습니다.');
  }
  // Reuse seed validation; these are starting inventory values, never new evidence.
  parseDebugCapture(JSON.stringify({kind:'loacard-capture',version:1,source:'screen',rowMode:'all',captureOnly:false,
    createdAt:m.createdAt,seed:m.seed,frames:[{image:'data:image/png;base64,AAAA',time:0,elapsed:0}],truncated:false}));
  if(m.result!==null){
    const r=m.result;
    const count=(n:unknown)=>Number.isSafeInteger(n)&&Number(n)>=0;
    if(!r||!count(r.read)||!count(r.unidentified)||(r.expected!==null&&!count(r.expected))||
      (r.experience!==null&&!count(r.experience))||!Array.isArray(r.cards)||r.cards.length>1000||
      r.cards.some(c=>!c||typeof c.id!=='string'||typeof c.name!=='string'||
        (c.awakening!==null&&(!count(c.awakening)||c.awakening>5))||
        (c.extraCopies!==null&&(!count(c.extraCopies)||c.extraCopies>15))||
        !Array.isArray(c.review)||c.review.some(v=>typeof v!=='string')))
      throw Error('기록의 비교 결과가 올바르지 않습니다.');
  }
  return m;
}
export function createReproductionBundle(file:ReproductionFile){
  validateMetadata(file.metadata);
  if(file.video.size!==file.metadata.bytes)throw Error('재현 영상 용량이 일치하지 않습니다.');
  if((file.exact?.size??0)!==(file.metadata.exact?.bytes??0))throw Error('무손실 기록 용량이 일치하지 않습니다.');
  const meta=new Blob([JSON.stringify(file.metadata)]);
  if(meta.size>MAX_META)throw Error('재현 정보 용량 초과');
  const length=new Uint8Array(4);new DataView(length.buffer).setUint32(0,meta.size,true);
  // Blob references avoid reading the complete video into an ArrayBuffer/base64.
  return new Blob([MAGIC,length,meta,file.video,...(file.exact?[file.exact]:[])],{type:'application/octet-stream'});
}
export async function openReproduction(blob:Blob,signal:AbortSignal):Promise<ReproductionFile>{
  signal.throwIfAborted();
  if(blob.size>MAX_META+MAX_VIDEO+MAX_EXACT+MAGIC.length+4||await blob.slice(0,MAGIC.length).text()!==MAGIC)throw Error('LoaCard 재현 파일을 선택하세요.');
  const header=await blob.slice(MAGIC.length,MAGIC.length+4).arrayBuffer();
  if(header.byteLength!==4)throw Error('재현 파일이 잘렸습니다.');
  const size=new DataView(header).getUint32(0,true),offset=MAGIC.length+4;
  if(!size||size>MAX_META||offset+size>=blob.size)throw Error('재현 정보 용량이 올바르지 않습니다.');
  const metadata=validateMetadata(JSON.parse(await blob.slice(offset,offset+size).text()));
  if(offset+size+metadata.bytes+(metadata.exact?.bytes??0)!==blob.size)throw Error('재현 영상이 잘렸거나 불필요한 데이터가 있습니다.');
  signal.throwIfAborted();
  return {metadata,video:blob.slice(offset+size,offset+size+metadata.bytes,metadata.type),...(metadata.version===2?{exact:blob.slice(offset+size+metadata.bytes)}:{})};
}
export function replaySettings(file:ReproductionFile):DebugCapture{return {
  kind:'loacard-capture',version:1,createdAt:file.metadata.createdAt,source:'screen',rowMode:'all',captureOnly:false,
  seed:file.metadata.seed,frames:[],truncated:!file.metadata.completed,
};}
export function compareReproduction(before:ReproductionResult|null,after:ReproductionResult){
  if(!before)return null;
  const old=new Map(before.cards.map(c=>[c.id,c])),now=new Map(after.cards.map(c=>[c.id,c]));
  return {
    added:after.cards.filter(c=>!old.has(c.id)).map(c=>c.name),
    missing:before.cards.filter(c=>!now.has(c.id)).map(c=>c.name),
    changed:after.cards.filter(c=>{const previous=old.get(c.id);return previous&&(previous.awakening!==c.awakening||previous.extraCopies!==c.extraCopies||previous.review.join('|')!==c.review.join('|'));}).map(c=>c.name),
  };
}

/** Single recent capture in IndexedDB. Blob-backed video is not loaded into JS.
 * The run token prevents a slow/late previous scan from replacing a newer one. */
async function database(){return new Promise<IDBDatabase>((resolve,reject)=>{
  let expired=false;
  const timer=setTimeout(()=>{expired=true;reject(Error('기록 저장소 응답 시간 초과'));},10_000);
  const request=indexedDB.open('loacard-reproduction',1);
  request.onupgradeneeded=()=>request.result.createObjectStore('recent');
  request.onsuccess=()=>{clearTimeout(timer);if(expired)request.result.close();else resolve(request.result);};
  request.onerror=()=>{clearTimeout(timer);reject(request.error);};
});}
async function transaction<T>(mode:IDBTransactionMode,work:(store:IDBObjectStore,done:(value:T)=>void)=>void):Promise<T>{
  const db=await database();
  try{return await new Promise<T>((resolve,reject)=>{
    const tx=db.transaction('recent',mode);let result:T;
    const timer=setTimeout(()=>{try{tx.abort();}catch{/* Already closed. */}reject(Error('기록 저장 시간 초과'));},15_000);
    work(tx.objectStore('recent'),value=>{result=value;});
    tx.oncomplete=()=>{clearTimeout(timer);resolve(result);};tx.onerror=tx.onabort=()=>{clearTimeout(timer);reject(tx.error??Error('기록 저장 실패'));};
  });}finally{db.close();}
}
export const loadReproduction=()=>transaction<ReproductionFile|undefined>('readonly',(store,done)=>{const request=store.get('file');request.onsuccess=()=>done(request.result);});
export const clearReproduction=()=>transaction<void>('readwrite',(store,done)=>{store.clear();done();});
export async function beginReproduction(seed:ScannedCard[],environment:{browser:string;catalog:string;build:string}){
  const id=crypto.randomUUID(),createdAt=new Date().toISOString(),initial=structuredClone(seed);
  // CSV seeds can have no image; diagnostics validate them with a tiny placeholder.
  for(const card of initial)if(!card.image)card.image='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLttAAAAABJRU5ErkJggg==';
  await transaction<void>('readwrite',(store,done)=>{store.clear();store.put(id,'run');done();});
  const exact=typeof Worker!=='undefined'?await createExactRecording().catch(()=>undefined):undefined;
  let recording:ContinuousRecording|undefined,handedOff:ContinuousRecording|undefined,closed=false;
  const options:Parameters<typeof runScanner>[9]={exact,continuous:value=>{if(!closed)recording=value;else if(value!==handedOff)void value.dispose?.();}};
  return {options,async finish(state:ScannerState|undefined,completed:boolean){
    closed=true;
    if(!recording){await exact?.dispose();throw Error('재현 영상이 없습니다. 공유 종료까지의 기록을 저장하지 못했습니다.');}
    const current=recording;handedOff=current;recording=undefined;
    let lossless:ExactRecording|undefined,exactError='';
    try{
      try{lossless=await exact?.finish();}catch(error){exactError=String(error);}
      const file:ReproductionFile={video:current.blob,exact:lossless?.blob,metadata:{version:lossless?2:1,exact:lossless?.stats,signature:import.meta.env?.VITE_REPLAY_SIGNATURE,createdAt,...environment,completed,
        duration:current.duration,type:current.blob.type,bytes:current.blob.size,seed:initial,
        warnings:[...(exactError?[exactError]:[]),...(lossless&&!lossless.stats.complete?['일부 입력 기록 누락: '+(lossless.stats.error||lossless.stats.dropped+'프레임')]:[]),...(!completed?['중단된 스캔의 부분 기록']:[]),...(state?.captureWarning?[state.captureWarning]:[])],
        result:state?reproductionResult(state):null}};
      await transaction<void>('readwrite',(store,done)=>{
        const request=store.get('run');request.onsuccess=()=>{if(request.result===id)store.put(file,'file');done();};
      });
      return file;
    }finally{await current.dispose?.();await exact?.dispose();}
  }};
}
