import type {ExactRecorder,ExactRecording,ExactRecordingStats,ExactJournalStats} from './exact-recording';
import {parseDebugCapture} from './debug-capture';
import type {DebugCapture} from './debug-capture';
import type {ScannerState,runScanner} from './scanner';
import type {ScannedCard} from './recognizer';
import type {ContinuousRecording} from './continuous-capture';
import {boundedCountDiagnostics,boundedUnresolvedFieldChanges,type UnresolvedFieldChangeSnapshot} from './current-scan-fields';
import {createReproductionSessionStore,SessionStorageLimitError} from './reproduction-session-store';
import type {ReproductionSession,ReproductionSessionStore} from './reproduction-session-store';
import {createBoundedJournal,splitJournalBlob} from './recording-journal';
import {inspectExactPrefix} from './exact-recording-prefix';
import {MAX_RETAINED_DIAGNOSTIC_IMAGES,summarizeUnidentified,type UnidentifiedDiagnostic} from './unidentified-diagnostics';
import {NORMAL_SCANNER_NAME_CONFIGURATION,parseScannerNameConfiguration,sameScannerNameConfiguration} from './scanner-name-configuration';
import type {ScannerNameConfiguration} from './scanner-name-configuration';
import type {NameOcrMetrics} from './name-reader';
import {feedbackReceiptDiagnostic} from './scanner-feedback-summary';
import type {FeedbackReceiptDiagnostic} from './scanner-feedback-summary';
import {parseReplayPolicy} from './rgba-window-policy';
import {verifyCanonicalFinalization} from './canonical-finalization-proof';

const MAGIC='LOACARD-REPLAY1\n';
const MAX_META=16*1024*1024,MAX_VIDEO=256*1024*1024,MAX_EXACT=1024*1024*1024;
export const CANONICAL_FINALIZATION_TIMEOUT_MS=15_000;
export function reproductionResult(state:ScannerState){return {
  expected:state.expected,read:state.currentRunRead??0,unidentified:state.unidentified.filter(c=>!c.pending).length,
  experience:state.growthPoints?.current??null,
  cards:state.cards.map(({id,name,awakening,extraCopies,review})=>({id,name,awakening,extraCopies,review:[...review]})).sort((a,b)=>a.id.localeCompare(b.id)),
};}
export type ReproductionResult=ReturnType<typeof reproductionResult>;
type RecoveredExactStats=Omit<ExactRecordingStats,'dropped'|'peakQueuedBytes'|'peakWorkingBytes'|'readbackMs'|'encodeMs'>&{
  recovered:true;dropped:null;peakQueuedBytes:null;peakWorkingBytes:null;readbackMs:null;encodeMs:null;
};
export interface ReproductionMetadata {
  version:1|2|3|4|5|6;createdAt:string;browser:string;catalog:string;build:string;completed:boolean;warnings:string[];
  exact?:ExactRecordingStats|RecoveredExactStats;signature?:string;duration:number;type:string;bytes:number;seed:ScannedCard[];result:ReproductionResult|null;
  sessionId?:string;recordState?:'complete'|'partial'|'failed';
  /** Absent in older recordings: their effective name policy is unknown. */
  nameConfiguration?:ScannerNameConfiguration;
}
export interface ReproductionFile {metadata:ReproductionMetadata;video:Blob;exact?:Blob}

/** Small, automatic diagnostic record. It contains card crops, never source frames. */
export interface ScanDiagnosticSummary extends UnresolvedFieldChangeSnapshot {
  createdAt:string;completed:boolean;status:string;result:ReproductionResult|null;
  nameConfiguration?:ScannerNameConfiguration;
  unattributedFieldReviews?:number;
  /** Latest unresolved field evidence, independent of the retained inventory value. */
  fieldIssues?:Omit<NonNullable<ScannerState['pendingFields']>[number],'image'|'recognitionImage'>[];
  fieldIssuesOmitted?:number;
  finishTiming?:ScannerState['finishTiming'];
  performance?:{live?:ScannerState['livePerformance'];recovery?:ScannerState['recoveryPerformance'];presentation?:ScannerState['resultPresentation'];sourceStore?:ScannerState['sourceStore'];
    nameOcr?:readonly NameOcrMetrics[];nameOcrUnavailable?:'invalid-or-over-limit'} & FeedbackReceiptDiagnostic;
  images:{image:string;reason:string;time:number;source?:'recognition'|'preview'}[];warnings:string[];
  /** Candidate attempts, not distinct cards/images. Rejected images are not retained. */
  imageRetention?:{candidates:number;duplicates:number;limitRejected:number;invalid:number;encodedCharacters:number};
  /** All bounded observation metadata, including entries without a retained image. */
  unidentifiedObservations?:readonly UnidentifiedDiagnostic[];
  unidentifiedOmitted?:number;
}
/** Presence is deliberate: undefined/null/accessors are not legacy absence. */
function optionalNameConfiguration(value:object):ScannerNameConfiguration|undefined {
  const descriptor=Object.getOwnPropertyDescriptor(value,'nameConfiguration');
  if(!descriptor){if('nameConfiguration' in value)throw Error('상속된 이름 판독 설정은 사용할 수 없습니다.');return;}
  if(!('value' in descriptor))throw Error('이름 판독 설정은 데이터 필드여야 합니다.');
  return parseScannerNameConfiguration(descriptor.value);
}
const NAME_OCR_DIAGNOSTIC_BYTES=64*1024,NAME_OCR_DIAGNOSTIC_READERS=32,NAME_OCR_DIAGNOSTIC_RECIPES=14;
/** Only the small metrics schema is copied; no arbitrary diagnostic objects,
 * getters, pixels or missing-value-to-zero conversions enter the summary. */
function nameOcrDiagnostic(state:ScannerState):
  Pick<NonNullable<ScanDiagnosticSummary['performance']>,'nameOcr'|'nameOcrUnavailable'> {
  const descriptor=Object.getOwnPropertyDescriptor(state,'nameOcrMetrics');
  if(!descriptor)return {};
  if('value' in descriptor&&descriptor.value===undefined)return {};
  try {
    if(!('value' in descriptor))throw Error('Accessor metrics');
    const fields=['scope','policy','invocations','continued','quickAccepted','invocationFailures','requests','reusedRequests','failedRequests','wallAwaitMs','recipes'];
    const own=(value:unknown,keys:string[])=>{
      if(!value||typeof value!=='object'||Array.isArray(value))throw Error('Invalid metrics object');
      const names=Reflect.ownKeys(value);
      if(names.length!==keys.length||names.some(key=>typeof key!=='string'||!keys.includes(key)))throw Error('Invalid metrics fields');
      const output:Record<string,unknown>={};
      for(const key of keys){const field=Object.getOwnPropertyDescriptor(value,key);if(!field||!('value' in field))throw Error('Accessor metric');output[key]=field.value;}
      return output;
    };
    const natural=(value:unknown)=>typeof value==='number'&&Number.isSafeInteger(value)&&value>=0;
    const finite=(value:unknown)=>typeof value==='number'&&Number.isFinite(value)&&value>=0;
    const array=(value:unknown,limit:number)=>{
      if(!Array.isArray(value))throw Error('Invalid metrics array');
      const length=Object.getOwnPropertyDescriptor(value,'length');
      if(!length||!('value' in length)||!natural(length.value)||length.value>limit)throw Error('Metrics array limit');
      return Array.from({length:length.value},(_,index)=>{
        const item=Object.getOwnPropertyDescriptor(value,String(index));if(!item||!('value' in item))throw Error('Accessor/sparse metrics array');return item.value;
      });
    };
    const rows=array(descriptor.value,NAME_OCR_DIAGNOSTIC_READERS);
    const result:NameOcrMetrics[]=rows.map(value=>{
      const row=own(value,fields);
      if(row.scope!=='korean-neural-name-request-await'||typeof row.policy!=='string'||!['resample','continue'].includes(row.policy)||
        !['invocations','continued','quickAccepted','invocationFailures','requests','reusedRequests','failedRequests'].every(key=>natural(row[key]))||
        !finite(row.wallAwaitMs))throw Error('Invalid metrics values');
      const seen=new Set<string>();
      const recipes=array(row.recipes,NAME_OCR_DIAGNOSTIC_RECIPES).map(value=>{
        const recipe=own(value,['recipe','requests','reusedRequests','failedRequests','wallAwaitMs']);
        if(typeof recipe.recipe!=='string'||!/^(?:raw-first-line|raw-second-line|raw-full-label|gray-first-line|soft-grade-[0-4]-(?:original|normalized))$/.test(recipe.recipe)||
          seen.has(recipe.recipe)||!['requests','reusedRequests','failedRequests'].every(key=>natural(recipe[key]))||!finite(recipe.wallAwaitMs))throw Error('Invalid recipe metrics');
        seen.add(recipe.recipe);return recipe;
      });
      for(const key of ['requests','reusedRequests','failedRequests'])if(recipes.reduce((sum,recipe)=>sum+(recipe[key] as number),0)!==row[key])throw Error('Inconsistent recipe counts');
      return {...row,recipes} as unknown as NameOcrMetrics;
    });
    if(new TextEncoder().encode(JSON.stringify(result)).byteLength>NAME_OCR_DIAGNOSTIC_BYTES)throw Error('Metrics byte limit');
    return {nameOcr:result};
  }catch{return {nameOcrUnavailable:'invalid-or-over-limit'};}
}
export function createScanDiagnosticSummary(state:ScannerState|undefined,completed:boolean):ScanDiagnosticSummary {
  const nameConfiguration=state?optionalNameConfiguration(state):undefined;
  const changes=boundedUnresolvedFieldChanges(state);
  const images:ScanDiagnosticSummary['images']=[],seen=new Set<string>();let bytes=0;
  const imageRetention={candidates:0,duplicates:0,limitRejected:0,invalid:0,encodedCharacters:0};
  const add=(image:string,reason:string,time:number,source?:'recognition'|'preview')=>{
    // Limit both retained images and encoded data before cloning/serializing.
    imageRetention.candidates++;
    if(seen.has(image)){imageRetention.duplicates++;return true;}
    if(!/^data:image\/(?:png|jpeg|webp);base64,/.test(image)){imageRetention.invalid++;return false;}
    if(images.length>=MAX_RETAINED_DIAGNOSTIC_IMAGES||image.length>262_144||bytes+image.length>1_048_576){imageRetention.limitRejected++;return false;}
    seen.add(image);bytes+=image.length;imageRetention.encodedCharacters=bytes;
    images.push({image,reason:reason.slice(0,300),time,...(source?{source}:{})});return true;
  };
  const fieldIssues:NonNullable<ScanDiagnosticSummary['fieldIssues']>=[];
  const encoder=new TextEncoder();let fieldBytes=2;
  // Independently cap UTF-8 metadata: many failed cards must not multiply the
  // per-card OCR evidence into an unbounded summary. Images stay separate.
  for(const {id,name,time,captureOrder,reason,countReason,stable,borderAlignment,countDiagnostics} of state?.pendingFields??[]){
    if(fieldIssues.length>=1000)break;
    const field={id:id.slice(0,100),name:name.slice(0,100),time,captureOrder,reason:reason.slice(0,300),
      countReason:countReason?.slice(0,300),stable,borderAlignment,
      ...(countDiagnostics?{countDiagnostics:boundedCountDiagnostics(countDiagnostics)}:{})};
    const size=encoder.encode(JSON.stringify(field)).byteLength+1;
    if(fieldBytes+size>1_048_576)break;
    fieldBytes+=size;fieldIssues.push(field);
  }
  const fieldIssuesOmitted=(state?.pendingFields?.length??0)-fieldIssues.length;
  // Keep the failed latest crop before generic rejection samples or older good
  // inventory thumbnails; otherwise a stale 0 can conceal the useful evidence.
  for(const field of state?.pendingFields??[]){
    const reason=`${field.name}: ${field.reason}${field.countReason?` · ${field.countReason}`:''}`;
    if(!field.recognitionImage||!add(field.recognitionImage,reason,field.time,'recognition'))
      add(field.image,reason,field.time,'preview');
  }
  // Keep real recognition crops before optional previews. Image count may grow
  // within the unchanged 1MiB byte budget; missing images retain their metadata.
  for(const card of state?.unidentified??[])if(!card.pending&&card.recognitionImage)add(card.recognitionImage,card.reason??'이름 미확인',card.time,'recognition');
  for(const card of state?.cards??[])if(card.review.length)add(card.image,`${card.name}: ${card.review.join(' · ')}`,card.time);
  for(const card of state?.unidentified??[])if(!card.pending)add(card.image,card.reason??'이름 미확인',card.time,'preview');
  for(const sample of state?.captureDiagnostics?.samples??[])if(!sample.accepted)add(sample.image,sample.reason,sample.time);
  const unidentified=summarizeUnidentified(state?.unidentified??[],images);
  const summary:ScanDiagnosticSummary={createdAt:new Date().toISOString(),completed:completed&&!state?.interrupted,
    status:state?.status??'스캔 시작 전 중지',...changes,
    ...(nameConfiguration?{nameConfiguration}:{}),
    result:state?reproductionResult(state):null,images,imageRetention,unidentifiedObservations:unidentified.entries,unidentifiedOmitted:unidentified.omitted,
    fieldIssues,...(fieldIssuesOmitted?{fieldIssuesOmitted}:{}),
    unattributedFieldReviews:state?.unattributedFieldReviews,
    finishTiming:state?.finishTiming?{...state.finishTiming}:undefined,
    performance:state?{...structuredClone({live:state.livePerformance,recovery:state.recoveryPerformance,presentation:state.resultPresentation,sourceStore:state.sourceStore}),
      ...nameOcrDiagnostic(state)}:undefined,
    warnings:[state?.captureWarning,state?.processingWarning,
      imageRetention.limitRejected?`진단 이미지 후보 ${imageRetention.limitRejected}건이 저장 한도로 제외됐습니다.`:undefined,
      imageRetention.invalid?`진단 이미지 후보 ${imageRetention.invalid}건의 형식을 읽을 수 없습니다.`:undefined,
      changes.unresolvedFieldChangesUnavailable?'최신 필드 변경 진단을 읽을 수 없습니다.':undefined].filter((value):value is string=>!!value).map(value=>value.slice(0,2000))};
  if(summary.performance?.nameOcr&&new TextEncoder().encode(JSON.stringify(summary)).byteLength>MAX_META)omitNameOcr(summary);
  return summary;
}
function omitNameOcr(summary:ScanDiagnosticSummary):boolean {
  if(!summary.performance||!Object.hasOwn(summary.performance,'nameOcr'))return false;
  const {nameOcr:_omitted,...performance}=summary.performance;
  summary.performance={...performance,nameOcrUnavailable:'invalid-or-over-limit'};return true;
}
function omitFeedbackReceipts(summary:ScanDiagnosticSummary):boolean {
  if(!summary.performance||!Object.hasOwn(summary.performance,'feedbackReceipts'))return false;
  const {feedbackReceipts:_omitted,...performance}=summary.performance;
  summary.performance={...performance,feedbackReceiptsUnavailable:'invalid-or-over-limit'};return true;
}

function reproductionVersion(exact:Pick<ExactRecordingStats,'canonical'|'storageVersion'|'codec'|'policy'>|undefined):3|4|5|6 {
  // A malformed new tag cannot silently fall back to a legacy version. The
  // metadata gate below rejects incomplete or mismatching codec/policy pairs.
  if(exact&&(exact.codec!==undefined||exact.policy!==undefined))return 6;
  return exact?.storageVersion?5:exact?.canonical?4:3;
}
function validateMetadata(value:unknown):ReproductionMetadata {
  const m=value as ReproductionMetadata;
  const nameConfiguration=m&&typeof m==='object'?optionalNameConfiguration(m):undefined;
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
  return nameConfiguration?{...m,nameConfiguration}:m;
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
export function replaySettings(file:ReproductionFile):DebugCapture{return {
  kind:'loacard-capture',version:1,createdAt:file.metadata.createdAt,source:'screen',rowMode:'all',captureOnly:false,
  seed:file.metadata.seed,frames:[],truncated:!file.metadata.completed||file.metadata.exact?.complete===false||file.metadata.recordState==='partial',
};}
export function replayNameConfiguration(file:ReproductionFile):Readonly<{configuration:ScannerNameConfiguration;recorded:boolean}> {
  const configuration=optionalNameConfiguration(file.metadata);
  return Object.freeze({configuration:configuration??NORMAL_SCANNER_NAME_CONFIGURATION,recorded:configuration!==undefined});
}
export function compareReproduction(before:ReproductionResult|null,after:ReproductionResult){
  if(!before)return null;
  const old=new Map(before.cards.map(c=>[c.id,c])),now=new Map(after.cards.map(c=>[c.id,c]));
  return {
    added:after.cards.filter(c=>!old.has(c.id)).map(c=>c.name),
    missing:before.cards.filter(c=>!now.has(c.id)).map(c=>c.name),
    changed:after.cards.filter(c=>{const previous=old.get(c.id);return previous&&(previous.awakening!==c.awakening||previous.extraCopies!==c.extraCopies||previous.review.join('|')!==c.review.join('|'));}).map(c=>c.name),
  };
}

/** Session indexes and Blob chunks are independent of the current inventory. */
const sessions=createReproductionSessionStore();
let storageEpoch=0;
let storageLifetime=new AbortController();
const EMPTY_IMAGE='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLttAAAAABJRU5ErkJggg==';
export interface ReproductionSessionItem {
  id:string;createdAt:string;status:'open'|'complete'|'partial'|'failed';pinned:boolean;bytes:number;
  read:number|null;expected:number|null;hasInput:boolean;reason?:string;
}
export interface ReproductionSessionAccess {
  list(signal?:AbortSignal):Promise<ReproductionSessionItem[]>;
  load(id:string,signal?:AbortSignal):Promise<ReproductionFile|undefined>;
  summary(id:string,signal?:AbortSignal):Promise<ScanDiagnosticSummary|undefined>;
  remove(id:string,signal?:AbortSignal):Promise<boolean>;
  pin(id:string,pinned:boolean,signal?:AbortSignal):Promise<unknown>;
}
/** UI can use an isolated development store without touching real inventory or
 * browser history. File construction and validation stay shared. */
export function createReproductionSessionAccess(store:ReproductionSessionStore):ReproductionSessionAccess {
  return {
    async list(signal){await store.recoverInterrupted({signal});return (await store.listSessions({signal})).map(
      ({id,createdAt,status,pinned,bytes,read,expected,hasInput,reason})=>({id,createdAt,status,pinned,bytes,read,expected,hasInput,...(reason?{reason}:{})}));},
    async load(id,signal=new AbortController().signal){const stored=await store.getSession(id,{signal});return stored?fileFromSession(stored,signal):undefined;},
    async summary(id,signal){return (await store.getSessionDetails(id,{signal}))?.summary as ScanDiagnosticSummary|undefined;},
    remove:(id,signal)=>store.deleteSession(id,{signal}),pin:(id,pinned,signal)=>store.pinSession(id,pinned,{signal}),
  };
}
interface InitialContext {seed:ScannedCard[];signature?:string;nameConfiguration?:ScannerNameConfiguration}
const context=(value:unknown):InitialContext=>{
  if(!value||typeof value!=='object'||!('seed' in value)||!Array.isArray(value.seed))throw Error('기록의 시작 목록이 없습니다.');
  const nameConfiguration=optionalNameConfiguration(value);
  return {...value,...(nameConfiguration?{nameConfiguration}:{})} as InitialContext;
};
async function legacyValue<T>(key:string,signal?:AbortSignal,clear=false):Promise<T|undefined>{
  signal?.throwIfAborted();
  return new Promise((resolve,reject)=>{
    let db:IDBDatabase|undefined,tx:IDBTransaction|undefined,settled=false;
    const clean=()=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);db?.close();};
    const finish=(value?:T,error?:unknown)=>{if(settled)return;settled=true;if(error)try{tx?.abort();}catch{/* Already inactive. */}clean();if(error)reject(error);else resolve(value);};
    const abort=()=>finish(undefined,signal?.reason??new DOMException('취소됨','AbortError'));
    const timer=setTimeout(()=>finish(undefined,Error('이전 기록 읽기 시간 초과')),10_000);
    signal?.addEventListener('abort',abort,{once:true});
    const opening=indexedDB.open('loacard-reproduction');
    opening.onerror=()=>finish(undefined,opening.error);
    opening.onblocked=()=>finish(undefined,Error('이전 기록 저장소가 사용 중입니다.'));
    opening.onsuccess=()=>{
      db=opening.result;if(settled){db.close();return;}
      if(!db.objectStoreNames.contains('recent')){finish();return;}
      tx=db.transaction('recent',clear?'readwrite':'readonly');
      const request=clear?tx.objectStore('recent').clear():tx.objectStore('recent').get(key);
      let result:T|undefined;
      request.onsuccess=()=>{result=request.result;};
      tx.oncomplete=()=>finish(result);tx.onabort=tx.onerror=()=>finish(undefined,tx?.error??Error('이전 기록 읽기 실패'));
    };
  });
}
export async function listReproductionSessions(signal?:AbortSignal):Promise<ReproductionSessionItem[]>{
  return createReproductionSessionAccess(sessions).list(signal);
}
export const deleteReproductionSession=(id:string,signal?:AbortSignal)=>sessions.deleteSession(id,{signal});
export const pinReproductionSession=(id:string,pinned:boolean,signal?:AbortSignal)=>sessions.pinSession(id,pinned,{signal});
export async function loadSessionDiagnosticSummary(id:string,signal?:AbortSignal):Promise<ScanDiagnosticSummary|undefined>{
  return createReproductionSessionAccess(sessions).summary(id,signal);
}
async function fileFromSession(stored:ReproductionSession,signal:AbortSignal):Promise<ReproductionFile|undefined>{
  const {index}=stored;
  if(!stored.video.size&&!stored.exact?.size)return;
  const original=stored.metadata?validateMetadata(stored.metadata):undefined;
  const initialConfiguration=stored.initial&&typeof stored.initial==='object'?optionalNameConfiguration(stored.initial):undefined;
  if(original?.nameConfiguration&&initialConfiguration&&!sameScannerNameConfiguration(original.nameConfiguration,initialConfiguration))
    throw Error('기록의 시작 이름 판독 설정과 최종 설정이 다릅니다.');
  const nameConfiguration=original?.nameConfiguration??initialConfiguration;
  if(original&&original.bytes===stored.video.size&&
    (original.exact?.bytes??0)===(stored.exact?.size??0)){
    const partial=index.status!=='complete'||!index.sealed;
    const preserved=nameConfiguration?{...original,nameConfiguration}:original;
    const metadata=partial?{...preserved,recordState:'partial' as const,
      warnings:[...original.warnings,...(index.reason?[index.reason]:[])],
      ...(original.exact?{exact:{...original.exact,complete:false}}:{})}:preserved;
    return {metadata,video:stored.video,...(stored.exact?{exact:stored.exact}:{})};
  }
  // A closed tab can leave the last entry half-written. Keep only complete
  // entries; decoding still checks the original frame hashes during replay.
  const prefix=stored.exact?await inspectExactPrefix(stored.exact,signal):undefined;
  if(original){
    const selected=parseReplayPolicy(original),windowMarked=prefix?.codec!==undefined||prefix?.policy!==undefined;
    if(selected.kind==='rgba-window'?(!prefix?.bytes||prefix.codec!==selected.codec||prefix.policy!==selected.policy):windowMarked)
      throw Error('기록의 저장 정책과 복구 입력 형식이 다릅니다.');
  }
  const initial=context(stored.initial),summary=stored.summary as ScanDiagnosticSummary|undefined;
  const exact=prefix?.bytes?prefix.blob:undefined;
  if(!stored.video.size&&!exact)return;
  const exactStats:RecoveredExactStats|undefined=exact&&prefix?{recovered:true,bytes:exact.size,frames:prefix.frames,events:prefix.events,
    dropped:null,peakQueuedBytes:null,peakWorkingBytes:null,readbackMs:null,encodeMs:null,complete:false,
    error:index.reason??prefix.error??'중단 후 남아 있는 부분 입력',...(prefix.canonical?{canonical:true}:{}),
    ...(prefix.storageVersion?{storageVersion:prefix.storageVersion,nativeFrames:prefix.nativeFrames,rgbaFrames:prefix.rgbaFrames}:{}),
    ...(prefix.codec?{codec:prefix.codec,policy:prefix.policy}:{})}:undefined;
  const metadata:ReproductionMetadata={version:reproductionVersion(exactStats),sessionId:index.id,createdAt:index.createdAt,...index.environment,
    completed:summary?.completed??false,recordState:index.status==='failed'?'failed':'partial',
    ...(initial.signature?{signature:initial.signature}:{}),seed:initial.seed,result:summary?.result??original?.result??null,
    ...(nameConfiguration?{nameConfiguration}:{}),
    duration:original?.duration??prefix?.duration??0,bytes:stored.video.size,type:stored.video.size?stored.video.type:'',
    warnings:[index.reason??'일부 입력만 저장된 기록입니다.',...(prefix?.error?[prefix.error]:[])],...(exactStats?{exact:exactStats}:{})};
  validateMetadata(metadata);return {metadata,video:stored.video,...(exact?{exact}:{})};
}
export async function loadReproductionSession(id:string,signal:AbortSignal=new AbortController().signal){
  return createReproductionSessionAccess(sessions).load(id,signal);
}
export async function loadReproduction(signal?:AbortSignal):Promise<ReproductionFile|undefined>{
  const latest=(await listReproductionSessions(signal))[0];
  return latest?latest.status==='open'?undefined:loadReproductionSession(latest.id,signal):legacyValue<ReproductionFile>('file',signal);
}
export async function loadScanDiagnosticSummary(signal?:AbortSignal):Promise<ScanDiagnosticSummary|undefined>{
  const latest=(await listReproductionSessions(signal))[0];
  return latest?loadSessionDiagnosticSummary(latest.id,signal):legacyValue<ScanDiagnosticSummary>('summary',signal);
}
export function clearReproduction(signal?:AbortSignal){
  signal?.throwIfAborted();storageEpoch++;
  const previousLifetime=storageLifetime;storageLifetime=new AbortController();
  previousLifetime.abort(new DOMException('기록 초기화로 이전 저장 작업 취소','AbortError'));
  return (async()=>{
  let deleted=0,protectedActive=0;
  for(const entry of await sessions.listSessions({signal})){
    if(!entry.sealed&&entry.ownerId!==sessions.ownerId){protectedActive++;continue;}
    if(await sessions.deleteSession(entry.id,{signal,cancelOwned:true}))deleted++;
  }
  // Preserve upgrade compatibility until an explicit clear, never at scan start.
  await legacyValue('unused',signal,true);
  return {deleted,protectedActive};
  })();
}
export type ReproductionFinalizationStage='registered'|'exactFinish'|'producerJournalJoin'|'exactJournalJoin'|'videoJournalJoin'|
  'fallbackWrites'|'journalDrain'|'preSealLoad'|'canonicalVerify'|'canonicalPrepare'|'canonicalCommit'|
  'seal'|'postSealLoad'|'filePrefix'|'cleanup';
export interface ReproductionJournalJoin {
  /** Main-clock offsets from this finalization's start, not capture times. */
  readonly startedAtMs:number|null;readonly finishedAtMs:number|null;
  readonly before?:Readonly<ExactJournalStats>;readonly after?:Readonly<ExactJournalStats>;
}
/** Main-clock elapsed diagnostics, independent of recording completeness. A
 * stage stays null until its attempted work settles. File/prefix and cleanup
 * can overlap; stage durations must not be summed into totalMs. */
export interface ReproductionFinalizationTiming extends Readonly<Record<`${ReproductionFinalizationStage}Ms`,number|null>> {
  readonly status:'idle'|'running'|'fulfilled'|'rejected';
  readonly totalMs:number|null;
  readonly failedStages:readonly ReproductionFinalizationStage[];
  readonly producerJournals:Readonly<Record<'exact'|'video',ReproductionJournalJoin>>;
}
/** Starting a scan never waits for IndexedDB. The bounded journal owns pending
 * chunks, and final writes run after the inventory becomes available. */
export function beginReproduction(seed:ScannedCard[],environment:{browser:string;catalog:string;build:string},
  settings:{record?:boolean;exact?:ExactRecorder;store?:ReproductionSessionStore;nameConfiguration?:ScannerNameConfiguration;feedbackReceipts?:()=>unknown}={}){
  const nameConfiguration=optionalNameConfiguration(settings)??NORMAL_SCANNER_NAME_CONFIGURATION;
  const sessionStore=settings.store??sessions;
  const epoch=storageEpoch,id=crypto.randomUUID(),createdAt=new Date().toISOString();
  const currentEpoch=()=>!!settings.store||epoch===storageEpoch;
  // Explicit test/development stores have their own lifecycle. The normal
  // store's reset cancels pending verification, hashing and transactions.
  const storageSignal=settings.store?new AbortController().signal:storageLifetime.signal;
  // Replay needs starting values, not a second set of all thumbnail strings.
  const initial:InitialContext={seed:settings.record?structuredClone(seed.map(card=>({...card,image:EMPTY_IMAGE}))):[],
    signature:import.meta.env?.VITE_REPLAY_SIGNATURE,nameConfiguration};
  const registered=sessionStore.beginSession({id,createdAt,environment,record:!!settings.record,initial},{signal:storageSignal});
  let heartbeat:ReturnType<typeof setInterval>|undefined;
  const keepAlive=()=>{void sessionStore.heartbeat(id,{signal:storageSignal}).catch(()=>{});};
  void registered.then(()=>{if(!finalized){heartbeat=setInterval(keepAlive,15_000);(heartbeat as unknown as {unref?:()=>void}).unref?.();}},()=>{});
  let journalError='',closed=false,finalized=false,recording:ContinuousRecording|undefined,handedOff:ContinuousRecording|undefined;
  const received={exact:0,video:0};
  const journal=createBoundedJournal({
    async write(chunk,signal){await registered;const joined=signal?AbortSignal.any([storageSignal,signal]):storageSignal;
      joined.throwIfAborted();await sessionStore.appendChunk(id,chunk.kind,chunk.sequence,chunk.blob,{signal:joined});},
    incomplete(reason){journalError ||= reason;},
  });
  let exact=settings.record?settings.exact:undefined;
  const sink={write(chunk:Parameters<typeof journal.write>[0],signal?:AbortSignal){received[chunk.kind]++;return journal.write(chunk,signal);},
    incomplete(reason:string){journalError ||= reason;journal.incomplete(reason);}};
  if(settings.record)try{exact?.setJournal?.(sink);}catch(error){
    journalError=String(error);
    const failedRecorder=exact;exact=undefined;
    void failedRecorder?.dispose().catch(()=>{});
  }
  const options:Parameters<typeof runScanner>[9]=settings.record?{nameConfiguration,recordingMode:'detailed',exact,journal:sink,
    continuous:value=>{if(!closed)recording=value;else if(value!==handedOff)void value.dispose?.();}}:{nameConfiguration};
  const phaseTimes:Record<`${ReproductionFinalizationStage}Ms`,number|null>={registeredMs:null,exactFinishMs:null,
    producerJournalJoinMs:null,exactJournalJoinMs:null,videoJournalJoinMs:null,fallbackWritesMs:null,journalDrainMs:null,
    preSealLoadMs:null,canonicalVerifyMs:null,canonicalPrepareMs:null,canonicalCommitMs:null,sealMs:null,
    postSealLoadMs:null,filePrefixMs:null,cleanupMs:null};
  const producerJournals:Record<'exact'|'video',ReproductionJournalJoin>={exact:{startedAtMs:null,finishedAtMs:null},
    video:{startedAtMs:null,finishedAtMs:null}};
  const journalSnapshot=(value:ExactJournalStats|undefined):Readonly<ExactJournalStats>|undefined=>{
    if(!value)return undefined;
    const copied=structuredClone(value);
    if(copied.mirror)Object.freeze(copied.mirror);
    return Object.freeze(copied);
  };
  const failedStages=new Set<ReproductionFinalizationStage>();
  let finalizationStatus:ReproductionFinalizationTiming['status']='idle',totalMs:number|null=null,finalizationStartedAt=0;
  const finalizationTiming=():ReproductionFinalizationTiming=>Object.freeze({...phaseTimes,status:finalizationStatus,totalMs,
    failedStages:Object.freeze([...failedStages]),producerJournals:Object.freeze({exact:Object.freeze({...producerJournals.exact}),
      video:Object.freeze({...producerJournals.video})})});
  async function measure<T>(stage:ReproductionFinalizationStage,operation:()=>T|Promise<T>):Promise<T>{
    const started=performance.now();
    try{return await operation();}
    catch(error){failedStages.add(stage);throw error;}
    finally{const key=`${stage}Ms` as const;phaseTimes[key]=(phaseTimes[key]??0)+Math.max(0,performance.now()-started);}
  }
  async function joinProducer(kind:'exact'|'video',producer:{readonly journalStats?:ExactJournalStats;
    finishJournal?:()=>Promise<ExactJournalStats>}|undefined){
    if(!producer?.finishJournal)return;
    const offset=()=>Math.max(0,performance.now()-finalizationStartedAt);
    producerJournals[kind]={startedAtMs:offset(),finishedAtMs:null,before:journalSnapshot(producer.journalStats)};
    try{const after=await measure(kind==='exact'?'exactJournalJoin':'videoJournalJoin',()=>producer.finishJournal!());
      producerJournals[kind]={...producerJournals[kind],after:journalSnapshot(after)};
    }finally{producerJournals[kind]={...producerJournals[kind],finishedAtMs:offset()};}
  }
  let finishing:Promise<ReproductionFile|undefined>|undefined;
  async function finishRecording(state:ScannerState|undefined,completed:boolean):Promise<ReproductionFile|undefined>{
    closed=true;
    const summary=createScanDiagnosticSummary(state,completed),current=recording;handedOff=current;recording=undefined;
    const feedback=feedbackReceiptDiagnostic(settings);
    if(Object.keys(feedback).length)summary.performance={...summary.performance,...feedback};
    if(summary.performance?.feedbackReceipts&&new TextEncoder().encode(JSON.stringify(summary)).byteLength>MAX_META)omitFeedbackReceipts(summary);
    let lossless:ExactRecording|undefined,exactError='',canonicalCommitted=false;
    const seal=async(value:Parameters<ReproductionSessionStore['sealSession']>[1]):ReturnType<ReproductionSessionStore['sealSession']>=>{
      try{return await sessionStore.sealSession(id,value,{signal:storageSignal});}
      catch(error){
        const capacity=error instanceof SessionStorageLimitError||error instanceof Error&&/기록 정보 (?:항목|용량) 한도 초과/.test(error.message);
        if(!capacity||!(omitFeedbackReceipts(summary)||omitNameOcr(summary)))throw error;
        return seal({...value,summary});
      }
    };
    try{
      await measure('registered',()=>registered);if(!currentEpoch())return;
      if(summary.nameConfiguration&&!sameScannerNameConfiguration(summary.nameConfiguration,nameConfiguration))
        throw Error('실제 이름 판독 설정이 기록의 시작 설정과 다릅니다.');
      // Exact input is useful even when the optional preview encoder failed.
      if(settings.record)try{lossless=await (exact?measure('exactFinish',()=>exact!.finish()):undefined);}catch(error){exactError=String(error);}
      // Both producers are already finished. Join independently rather than
      // starting the preview's deadline only after the exact join has settled.
      try{await measure('producerJournalJoin',async()=>{
        const results=await Promise.allSettled([joinProducer('exact',exact),joinProducer('video',current)]);
        for(const result of results)if(result.status==='rejected')throw result.reason;
      });}
      catch(error){journalError ||= String(error);journal.incomplete(journalError);}
      if(!currentEpoch())return;
      // Test/legacy adapters can hand over a final Blob without streaming hooks.
      try{await measure('fallbackWrites',async()=>{
        if(current&&!received.video)for(const chunk of splitJournalBlob('video',current.blob))await sink.write(chunk);
        if(lossless&&!received.exact)for(const chunk of splitJournalBlob('exact',lossless.blob))await sink.write(chunk);
      });}catch(error){journalError ||= String(error);journal.incomplete(journalError);}
      const durable=await measure('journalDrain',()=>journal.finish());
      if(!currentEpoch())return;
      const stored=await measure('preSealLoad',()=>sessionStore.getSession(id,{signal:storageSignal}));if(!stored)return;
      // A failed transport copy can leave a complete producer file on disk.
      // Only the current recorder's returned Blob is eligible. Imported flags,
      // counts and partial-prefix reconstruction cannot enter this path.
      if(settings.record&&lossless?.stats.canonical===true&&lossless.stats.complete&&
        (!durable.complete||journalError||stored.exact?.size!==lossless.blob.size||stored.index.status==='partial')){
        try{
          const finalizationSignal=AbortSignal.any([storageSignal,AbortSignal.timeout(CANONICAL_FINALIZATION_TIMEOUT_MS)]);
          const proof=await measure('canonicalVerify',()=>verifyCanonicalFinalization(lossless!,finalizationSignal));
          if(!currentEpoch())return;
          const metadata:ReproductionMetadata={version:reproductionVersion(lossless.stats),sessionId:id,createdAt,...environment,
            completed,recordState:completed?'complete':'partial',duration:current?.duration??0,bytes:0,type:'',seed:initial.seed,
            nameConfiguration,...(initial.signature?{signature:initial.signature}:{}),result:summary.result,
            warnings:[...summary.warnings],exact:{...lossless.stats,complete:true}};
          // MediaRecorder/spool remains available for scanner recovery until
          // cleanup. Only its durable optional preview is omitted, after the
          // actual canonical event/use/checkpoint proof passed.
          const repairSummary={...summary,performance:{...summary.performance,canonicalFinalization:proof,
            journalBeforeFinalization:{...durable},...(journalError?{journalErrorBeforeFinalization:journalError}:{})}};
          const plan=await measure('canonicalPrepare',()=>sessionStore.prepareExactFinalization(id,
            {producer:lossless!.blob,seal:{status:completed?'complete':'partial',summary:repairSummary,metadata},omitVideo:true},{signal:finalizationSignal}));
          if(!currentEpoch())return;
          await measure('canonicalCommit',()=>sessionStore.commitExactFinalization(plan,{signal:finalizationSignal}));
          canonicalCommitted=true;
        }catch(error){
          // Failed proof/budget/transaction keeps the pre-existing prefix and
          // preview. Preserve the failure separately; do not erase producer or
          // event loss by retrying the legacy complete flag.
          journalError ||= String(error).slice(0,2000);
          summary.warnings.push(`원본 기록 정산 미완료: ${String(error).slice(0,1800)}`);
        }
        if(canonicalCommitted){
          // The transaction is the commit point. A later read/open failure
          // must never re-seal from the stale pre-commit prefix/video snapshot.
          if(!currentEpoch())return;
          const sealed=await measure('postSealLoad',()=>sessionStore.getSession(id,{signal:storageSignal}));
          return currentEpoch()&&sealed?measure('filePrefix',()=>fileFromSession(sealed,storageSignal)):undefined;
        }
      }
      const completeInput=!!settings.record&&!!lossless?.stats.complete&&durable.complete&&!journalError&&
        stored.exact?.size===lossless.blob.size;
      const hasInput=!!stored.video.size||!!stored.exact?.size;
      const reason=journalError||durable.error||exactError||(!hasInput?'재현 가능한 입력 없이 진단 요약만 남았습니다.':
        !completeInput&&settings.record?'입력 일부 또는 압축 영상만 저장되었습니다.':'');
      let metadata:ReproductionMetadata|undefined;
      if(hasInput){
        const fullExact=lossless&&stored.exact?.size===lossless.blob.size?lossless.stats:undefined;
        metadata={version:reproductionVersion(fullExact),sessionId:id,createdAt,...environment,completed,recordState:completeInput&&completed?'complete':'partial',
          duration:current?.duration??0,bytes:stored.video.size,type:stored.video.size?stored.video.type:'',seed:initial.seed,
          nameConfiguration,
          ...(initial.signature?{signature:initial.signature}:{}),result:summary.result,warnings:[...summary.warnings,...(reason?[reason]:[])],
          ...(fullExact?{exact:{...fullExact,complete:completeInput}}:{})};
        // Incomplete exact streams are inspected when opened, not on the hot path.
        if(stored.exact?.size&&!fullExact)metadata=undefined;
      }
      await measure('seal',()=>seal({status:settings.record?(completeInput&&completed?'complete':hasInput?'partial':'failed'):
        completed?'complete':'partial',summary,metadata,...(reason?{reason}:{})}));
      if(!settings.record||!currentEpoch())return;
      const sealed=await measure('postSealLoad',()=>sessionStore.getSession(id,{signal:storageSignal}));
      return currentEpoch()&&sealed?measure('filePrefix',()=>fileFromSession(sealed,storageSignal)):undefined;
    }catch(error){
      // A store failure must leave a diagnostic when the index can still be
      // updated; never manufacture a complete input or delete the old prefix.
      if(currentEpoch()&&!canonicalCommitted)try{
        await measure('seal',()=>seal({status:'partial',summary,reason:String(error).slice(0,2000)}));
      }catch{/* The index remains open/partial for lease-based recovery. */}
      if(!currentEpoch())return;
      throw error;
    }finally{
      await measure('cleanup',async()=>{
        finalized=true;clearInterval(heartbeat);journal.dispose();
        try{await current?.dispose?.();}finally{await exact?.dispose();}
      });
    }
  }
  async function finish(state:ScannerState|undefined,completed:boolean):Promise<ReproductionFile|undefined>{
    const started=performance.now();finalizationStartedAt=started;finalizationStatus='running';
    try{const result=await finishRecording(state,completed);finalizationStatus='fulfilled';return result;}
    catch(error){finalizationStatus='rejected';throw error;}
    finally{totalMs=Math.max(0,performance.now()-started);}
  }
  return {id,ready:registered,options,journalStats:()=>journal.stats,finalizationTiming,
    finish(state:ScannerState|undefined,completed:boolean){return finishing??=finish(state,completed);}};
}
