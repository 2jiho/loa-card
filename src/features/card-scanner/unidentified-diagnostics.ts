import type {ObservationSource} from './observation-execution';
import type {ScrollCardLocation} from './scroll-card-location';
import {readPortraitDiagnostics,type PortraitDiagnostics} from './portrait-diagnostics';

export const MAX_UNIDENTIFIED_DIAGNOSTIC_ENTRIES=1000;
export const MAX_UNIDENTIFIED_DIAGNOSTIC_BYTES=1_048_576;
export const MAX_RETAINED_DIAGNOSTIC_IMAGES=32;
export const MAX_UNIDENTIFIED_NAME_ATTEMPTS=24;
const MAX_NAME_CANDIDATES=3;
const MAX_IMAGE_TEXT_LENGTH=262_144,MAX_REASON_LENGTH=300,MAX_ID_LENGTH=160;

/** Projected OCR candidates explain a failed read; they are not card identity. */
export interface UnidentifiedNameCandidate {
 readonly id:string|null;
 readonly name:string|null;
 readonly score:number|null;
}
export interface UnidentifiedNameAttempt {
 readonly text:string|null;
 readonly confidence:number|null;
 readonly engine:string|null;
 readonly variant:string|null;
 readonly reason:string|null;
 readonly candidates:readonly UnidentifiedNameCandidate[]|null;
 readonly candidatesOmitted:number|null;
}
export interface UnidentifiedDiagnostic {
 readonly group:number|null;
 readonly captureOrder:number|null;
 readonly time:number|null;
 readonly pending:boolean|null;
 readonly reason:string|null;
 readonly location:Readonly<ScrollCardLocation>|null;
 readonly source:Readonly<ObservationSource>|null;
 /** Exact data URI lookup in the separately retained images, never a time join. */
 readonly retainedImageIndex:number|null;
 readonly recognitionImageIndex:number|null;
 /** Null means not captured/invalid; [] means explicitly no OCR attempts. */
 readonly nameAttempts:readonly UnidentifiedNameAttempt[]|null;
 /** Omission count for the 24-attempt cap; null if attempts were not captured. */
 readonly nameAttemptsOmitted:number|null;
 /** Missing/invalid is null; [] means the invocation explicitly made no calls.
  * Measurements are optional diagnostics, never identity/retirement evidence. */
 readonly portraitDiagnostics:PortraitDiagnostics|null;
}
export interface UnidentifiedDiagnosticSummary {
 readonly entries:readonly UnidentifiedDiagnostic[];
 readonly omitted:number;
}
export interface UnidentifiedDiagnosticLimits {maxEntries?:number;maxBytes?:number}

function record(value:unknown):Record<string,unknown>|null {
 if(!value||typeof value!=='object')return null;
 try{return Array.isArray(value)?null:value as Record<string,unknown>;}catch{return null;}
}
/** Diagnostics must survive a malformed source without reading unknown fields. */
function own(value:Record<string,unknown>|null,key:string):unknown {
 if(!value)return undefined;
 try{return Object.hasOwn(value,key)?value[key]:undefined;}catch{return undefined;}
}
const natural=(value:unknown):value is number=>typeof value==='number'&&Number.isSafeInteger(value)&&value>=0;
const time=(value:unknown):value is number=>typeof value==='number'&&Number.isFinite(value)&&value>=0;
const finite=(value:unknown):value is number=>typeof value==='number'&&Number.isFinite(value);
const identifier=(value:unknown):value is string=>typeof value==='string'&&value.length>0&&value.length<=MAX_ID_LENGTH;
/** Parsing a bounded slice also detaches a potentially large sliced-string
 * backing. The temporary JSON contains at most the stated text bound. */
const copyText=(value:string,limit:number):string=>JSON.parse(JSON.stringify(value.slice(0,limit))) as string;
const text=(value:unknown,limit:number):string|null=>typeof value==='string'?copyText(value,limit):null;
function sourceFrom(value:unknown):Readonly<ObservationSource>|null {
 const source=record(value),sessionId=own(source,'sessionId'),frameId=own(source,'frameId'),observationId=own(source,'observationId'),
  captureOrder=own(source,'captureOrder'),captureTime=own(source,'captureTime'),phase=own(source,'phase'),slot=own(source,'slot');
 if(!identifier(sessionId)||!identifier(observationId)||!natural(frameId)||!natural(captureOrder)||!time(captureTime)||
  phase!=='input'&&phase!=='recovery'||!natural(slot)||slot>=40)return null;
 // InventorySource.frame and any image/debug properties are deliberately absent.
 return Object.freeze({sessionId:copyText(sessionId,MAX_ID_LENGTH),frameId,observationId:copyText(observationId,MAX_ID_LENGTH),captureOrder,captureTime,phase,slot});
}
function locationFrom(value:unknown):Readonly<ScrollCardLocation>|null {
 const location=record(value),percent=own(location,'percent'),column=own(location,'column'),row=own(location,'row');
 if(!time(percent)||percent>100||!natural(column)||column<1||column>10)return null;
 return Object.freeze({percent,column,...(natural(row)&&row>0?{row}:{})});
}
function imageKey(value:unknown):value is string {
 return typeof value==='string'&&value.length<=MAX_IMAGE_TEXT_LENGTH&&/^data:image\/(?:png|jpeg|webp);base64,/.test(value);
}
function boundedArray(value:unknown):{items:readonly unknown[];length:number}|null {
 try{if(Array.isArray(value)){const length=value.length;if(natural(length))return {items:value,length};}}catch{/* Unknown diagnostics may be malformed. */}
 return null;
}
function itemAt(array:readonly unknown[],index:number):unknown {
 try{return Object.hasOwn(array,index)?array[index]:undefined;}catch{return undefined;}
}
function attemptsFrom(value:unknown):Pick<UnidentifiedDiagnostic,'nameAttempts'|'nameAttemptsOmitted'> {
 const input=boundedArray(value);
 if(!input)return {nameAttempts:null,nameAttemptsOmitted:null};
 const attempts:UnidentifiedNameAttempt[]=[];
 for(let index=0;index<Math.min(input.length,MAX_UNIDENTIFIED_NAME_ATTEMPTS);index++){
  const attempt=record(itemAt(input.items,index)),confidence=own(attempt,'confidence'),candidates=boundedArray(own(attempt,'candidates'));
  let projected:UnidentifiedNameCandidate[]|null=null;
  if(candidates){
   projected=[];
   for(let candidateIndex=0;candidateIndex<Math.min(candidates.length,MAX_NAME_CANDIDATES);candidateIndex++){
    const candidate=record(itemAt(candidates.items,candidateIndex)),id=own(candidate,'id'),score=own(candidate,'score');
    projected.push(Object.freeze({id:identifier(id)?copyText(id,MAX_ID_LENGTH):null,name:text(own(candidate,'name'),160),score:finite(score)?score:null}));
   }
  }
  attempts.push(Object.freeze({text:text(own(attempt,'text'),120),confidence:finite(confidence)?confidence:null,
   engine:text(own(attempt,'engine'),32),variant:text(own(attempt,'variant'),64),reason:text(own(attempt,'reason'),MAX_REASON_LENGTH),
   candidates:projected?Object.freeze(projected):null,candidatesOmitted:candidates?Math.max(0,candidates.length-MAX_NAME_CANDIDATES):null}));
 }
 return {nameAttempts:Object.freeze(attempts),nameAttemptsOmitted:Math.max(0,input.length-MAX_UNIDENTIFIED_NAME_ATTEMPTS)};
}

/** Image-free metadata in input order. Missing/invalid values stay null (or an
 * omitted optional row), not synthetic 0. Retained data URI references are held
 * only in this synchronous call; the returned snapshot owns no input objects.
 * The byte bound covers the complete serialized {entries,omitted} envelope. */
export function summarizeUnidentified(entries:readonly unknown[],retainedImages:readonly unknown[],limits:UnidentifiedDiagnosticLimits={}):UnidentifiedDiagnosticSummary {
 if(!Array.isArray(entries)||!Array.isArray(retainedImages))throw Error('미식별 진단 목록 형식 오류');
 const maxEntries=limits.maxEntries??MAX_UNIDENTIFIED_DIAGNOSTIC_ENTRIES,maxBytes=limits.maxBytes??MAX_UNIDENTIFIED_DIAGNOSTIC_BYTES;
 const encoder=new TextEncoder(),total=entries.length;
 const fixedBytes=encoder.encode('{"entries":[').byteLength+encoder.encode('],"omitted":').byteLength+1;
 if(!natural(maxEntries)||maxEntries>MAX_UNIDENTIFIED_DIAGNOSTIC_ENTRIES||!natural(maxBytes)||
  maxBytes<fixedBytes+String(total).length||maxBytes>MAX_UNIDENTIFIED_DIAGNOSTIC_BYTES)throw RangeError('미식별 진단 상한 오류');
 const imageIndices=new Map<string,number>();
 for(let index=0;index<Math.min(retainedImages.length,MAX_RETAINED_DIAGNOSTIC_IMAGES);index++){
  const image=own(record(retainedImages[index]),'image');
  if(imageKey(image)&&!imageIndices.has(image))imageIndices.set(image,index);
 }
 const indexOf=(value:unknown)=>imageKey(value)?imageIndices.get(value)??null:null;
 const result:UnidentifiedDiagnostic[]=[];let contentBytes=0;
 for(let index=0;index<total&&result.length<maxEntries;index++){
  const input=record(entries[index]),group=own(input,'group'),captureOrder=own(input,'captureOrder'),captured=own(input,'time'),
   pending=own(input,'pending'),reason=own(input,'reason');
  const entry:UnidentifiedDiagnostic=Object.freeze({group:natural(group)?group:null,captureOrder:natural(captureOrder)?captureOrder:null,
   time:time(captured)?captured:null,pending:typeof pending==='boolean'?pending:null,reason:text(reason,MAX_REASON_LENGTH),
   location:locationFrom(own(input,'location')),source:sourceFrom(own(input,'source')),
   retainedImageIndex:indexOf(own(input,'image')),recognitionImageIndex:indexOf(own(input,'recognitionImage')),
   ...attemptsFrom(own(input,'nameAttempts')),portraitDiagnostics:readPortraitDiagnostics(input)});
  const size=encoder.encode(JSON.stringify(entry)).byteLength+(result.length?1:0);
  if(fixedBytes+contentBytes+size+String(total-result.length-1).length>maxBytes)break;
  contentBytes+=size;result.push(entry);
 }
 return Object.freeze({entries:Object.freeze(result),omitted:total-result.length});
}
