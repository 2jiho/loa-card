/** The LoaCard replay file format (.loareplay) written by the scan diagnostics of v0.2 and earlier
 * (removed in v0.3.0). Kept to read and verify such files in the private corpus
 * (dev/replay-archive.ts, scripts/verify-replay-input.ts); nothing here replays them. */
import type {ExactRecordingStats} from './exact-recording';
import {parseDebugCapture} from './debug-capture';
import type {ScannedCard} from '../recognition/recognizer-types';
import {parseScannerNameConfiguration} from '../session/scanner-name-configuration';
import type {ScannerNameConfiguration} from '../session/scanner-name-configuration';
import {parseReplayPolicy} from './rgba-window-policy';
import {parseSourceVersionEvidence} from '../session/source-version-evidence';
import type {SourceVersionEvidence} from '../session/source-version-evidence';

const MAGIC='LOACARD-REPLAY1\n';
const MAX_META=16*1024*1024,MAX_VIDEO=256*1024*1024,MAX_EXACT=1024*1024*1024;
export const CANONICAL_FINALIZATION_TIMEOUT_MS=15_000;
/** The scan result a recording kept for comparison. */
export interface ReproductionResult {
  expected:number|null;read:number;unidentified:number;experience:number|null;
  cards:{id:string;name:string;awakening:number|null;extraCopies:number|null;review:string[]}[];
}
type RecoveredExactStats=Omit<ExactRecordingStats,'dropped'|'peakQueuedBytes'|'peakWorkingBytes'|'readbackMs'|'encodeMs'>&{
  recovered:true;dropped:null;peakQueuedBytes:null;peakWorkingBytes:null;readbackMs:null;encodeMs:null;
};
export interface ReproductionMetadata {
  version:1|2|3|4|5|6;createdAt:string;browser:string;catalog:string;build:string;completed:boolean;warnings:string[];
  exact?:ExactRecordingStats|RecoveredExactStats;signature?:string;duration:number;type:string;bytes:number;seed:ScannedCard[];result:ReproductionResult|null;
  sessionId?:string;recordState?:'complete'|'partial'|'failed';
  /** Absent in older recordings: their effective name policy is unknown. */
  nameConfiguration?:ScannerNameConfiguration;
  /** DEV recognition retry options only; not the full capture configuration. */
  devRecognitionOptions?:DevRecognitionOptions;
  sourceVersion?:SourceVersionEvidence;
}
export interface ReproductionFile {metadata:ReproductionMetadata;video:Blob;exact?:Blob}

/** Presence is deliberate: undefined/null/accessors are not legacy absence. */
function optionalNameConfiguration(value:object):ScannerNameConfiguration|undefined {
  const descriptor=Object.getOwnPropertyDescriptor(value,'nameConfiguration');
  if(!descriptor){if('nameConfiguration' in value)throw Error('상속된 이름 판독 설정은 사용할 수 없습니다.');return;}
  if(!('value' in descriptor))throw Error('이름 판독 설정은 데이터 필드여야 합니다.');
  return parseScannerNameConfiguration(descriptor.value);
}
/** Limited to recognition retry switches which can be applied to saved pixels.
 * This does not describe the original acquisition, timing, queues or workers. */
export interface DevRecognitionOptions {readonly version:1;readonly fractionalPortrait:boolean;readonly grayNameFallback:boolean}
export function parseDevRecognitionOptions(value:unknown):DevRecognitionOptions {
  if(!value||typeof value!=='object'||Array.isArray(value)||![Object.prototype,null].includes(Object.getPrototypeOf(value)))
    throw Error('개발 판독 설정은 일반 객체여야 합니다.');
  const keys=Reflect.ownKeys(value),allowed=['version','fractionalPortrait','grayNameFallback'];
  if(keys.length!==allowed.length||keys.some(key=>typeof key!=='string'||!allowed.includes(key)))throw Error('개발 판독 설정 필드가 잘못됐습니다.');
  const values:Record<string,unknown>=Object.create(null);
  for(const key of allowed){const property=Object.getOwnPropertyDescriptor(value,key);
    if(!property||!('value' in property)||!property.enumerable)throw Error('개발 판독 설정은 데이터 필드여야 합니다.');values[key]=property.value;}
  if(values.version!==1||typeof values.fractionalPortrait!=='boolean'||typeof values.grayNameFallback!=='boolean'||
     values.fractionalPortrait&&values.grayNameFallback)throw Error('지원하지 않는 개발 판독 설정입니다.');
  return Object.freeze({version:1,fractionalPortrait:values.fractionalPortrait,grayNameFallback:values.grayNameFallback});
}
function optionalDevRecognitionOptions(value:object):DevRecognitionOptions|undefined {
  const property=Object.getOwnPropertyDescriptor(value,'devRecognitionOptions');
  if(!property){if('devRecognitionOptions' in value)throw Error('상속된 개발 판독 설정은 사용할 수 없습니다.');return;}
  if(!('value' in property))throw Error('개발 판독 설정은 데이터 필드여야 합니다.');
  return parseDevRecognitionOptions(property.value);
}
function validateMetadata(value:unknown):ReproductionMetadata {
  const m=value as ReproductionMetadata;
  const nameConfiguration=m&&typeof m==='object'?optionalNameConfiguration(m):undefined;
  const devRecognitionOptions=m&&typeof m==='object'?optionalDevRecognitionOptions(m):undefined;
  const sourceVersion=m&&typeof m==='object'&&m.sourceVersion!==undefined?parseSourceVersionEvidence(m.sourceVersion):undefined;
  if(!m||![1,2,3,4,5,6].includes(m.version)||!['createdAt','browser','catalog','build'].every(key=>typeof m[key as keyof ReproductionMetadata]==='string')||
    typeof m.completed!=='boolean'||!Array.isArray(m.warnings)||m.warnings.length>100||m.warnings.some(w=>typeof w!=='string')||
    !Number.isFinite(m.duration)||(m.version>=3?m.duration<0:m.duration<=0)||!Number.isSafeInteger(m.bytes)||m.bytes<(m.version>=3?0:1)||m.bytes>MAX_VIDEO||
    typeof m.type!=='string'||!(m.version>=3&&m.bytes===0&&m.type===''||/^video\/webm(?:;codecs=(?:vp8|vp9)(?:,opus)?)?$/.test(m.type)))throw Error('재현 기록 정보가 올바르지 않습니다.');
  try{parseReplayPolicy(m);}catch(error){throw Error('재현 기록 저장 정책 정보가 올바르지 않습니다.',{cause:error});}
  if(m.version===2||m.exact){
    const e=m.exact;
    const recovered=m.version>=3&&e&&'recovered' in e&&e.recovered===true;
    if(!e||!['frames','events','bytes'].every(k=>Number.isSafeInteger(e[k as 'frames'|'events'|'bytes'])&&e[k as 'frames'|'events'|'bytes']>=0)||
      !['dropped','peakQueuedBytes','peakWorkingBytes','readbackMs','encodeMs'].every(k=>
        recovered?e[k as keyof ExactRecordingStats]===null:Number.isFinite(e[k as keyof ExactRecordingStats])&&Number(e[k as keyof ExactRecordingStats])>=0)||
      e.bytes>MAX_EXACT||typeof e.complete!=='boolean'||recovered&&e.complete||typeof e.error!=='string'||
      e.canonical!==undefined&&e.canonical!==true||e.canonical===true&&m.version!==4&&m.version!==5&&m.version!==6||
      e.storageVersion!==undefined&&e.storageVersion!==1||e.storageVersion===1&&m.version!==5||
      (m.signature!==undefined&&typeof m.signature!=='string'))throw Error('무손실 기록 정보가 올바르지 않습니다.');
    if(e.storageVersion===1&&(typeof e.nativeFrames!=='number'||typeof e.rgbaFrames!=='number'||
      !Number.isSafeInteger(e.nativeFrames)||!Number.isSafeInteger(e.rgbaFrames)||
      e.nativeFrames<0||e.rgbaFrames<0||e.nativeFrames+e.rgbaFrames!==e.frames))throw Error('원본 저장 형식별 프레임 수가 올바르지 않습니다.');
    if(e.storageVersion===undefined&&(e.nativeFrames!==undefined||e.rgbaFrames!==undefined))throw Error('원본 저장 형식 표시가 없습니다.');
    if(e.nativeAttestedFrames!==undefined&&(e.storageVersion!==1||!Number.isSafeInteger(e.nativeAttestedFrames)||
      e.nativeAttestedFrames<0||e.nativeAttestedFrames>e.nativeFrames!))throw Error('원본 native 변환 증명 수가 올바르지 않습니다.');
    if(e.nativeAttestationBudget!==undefined&&(e.nativeAttestationBudget!=='native-owned-v1'||e.storageVersion!==1||
      e.nativeAttestedFrames===undefined))throw Error('원본 native 예약 정책이 올바르지 않습니다.');
    if(e.complete&&(e.dropped!==0||e.error!==''))throw Error('무손실 기록의 누락·오류 정보가 완료 표시와 일치하지 않습니다.');
  }
  if(m.version===4&&m.exact?.canonical!==true)throw Error('공통 원본 사용 형식이 없습니다.');
  if(m.version===5&&(m.exact?.canonical!==true||m.exact.storageVersion!==1))throw Error('압축 원본 저장 형식이 없습니다.');
  if(m.version>=3&&(!m.bytes&&!m.exact?.bytes||m.recordState!==undefined&&!['complete','partial','failed'].includes(m.recordState)))throw Error('재현 가능한 입력이 없습니다.');
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
  return {...m,...(nameConfiguration?{nameConfiguration}:{}),...(devRecognitionOptions?{devRecognitionOptions}:{}),...(sourceVersion?{sourceVersion}:{})};
}
export function createReproductionBundle(file:ReproductionFile){
  const metadata=validateMetadata(file.metadata);
  if(file.video.size!==file.metadata.bytes)throw Error('재현 영상 용량이 일치하지 않습니다.');
  if((file.exact?.size??0)!==(file.metadata.exact?.bytes??0))throw Error('무손실 기록 용량이 일치하지 않습니다.');
  const meta=new Blob([JSON.stringify(metadata)]);
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
  const metadataText=await blob.slice(offset,offset+size).text();
  signal.throwIfAborted();
  const metadata=validateMetadata(JSON.parse(metadataText));
  if(offset+size+metadata.bytes+(metadata.exact?.bytes??0)!==blob.size)throw Error('재현 영상이 잘렸거나 불필요한 데이터가 있습니다.');
  signal.throwIfAborted();
  return {metadata,video:blob.slice(offset+size,offset+size+metadata.bytes,metadata.type),...(metadata.exact?{exact:blob.slice(offset+size+metadata.bytes)}:{})};
}
