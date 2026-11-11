import {parseLiveCaptureDecision} from '../capture/live-capture-pipeline';
import {parseInputFrameLink,parseInputRecoveryFact} from '../reproduction/live-input-decision-replay';

/** This contract covers acquisition attempts, not source completeness, card
 * identification, timestamps from the operating system, or scan accuracy. */
export type InputAcquisitionSkipReason='aborted'|'not-ready'|'zero-dimensions'|'completion-paused';
export type InputAcquisitionSkip=Readonly<{version:1;inputId:number;captureTime:number;reason:InputAcquisitionSkipReason}>;
export interface InputAcquisitionEvidenceSummary {
 readonly supported:boolean;
 /** Null means that this versioned contract was not recorded. */
 readonly complete:boolean|null;
 readonly started:number;readonly linked:number;readonly skipped:number;readonly failed:number;
 readonly unresolved:number;readonly inFlight:boolean;
 /** A skipped frame has no stored pixels. No skip does not establish that
  * every OS/callback frame was captured or that stored pixels are intact. */
 readonly pixelCoverage:'partial'|'unknown';
}
function fields(value:unknown,allowed:readonly string[]):Record<string,unknown> {
 if(!value||typeof value!=='object'||Array.isArray(value)||![Object.prototype,null].includes(Object.getPrototypeOf(value)))
  throw Error('잘못된 입력 획득 증거');
 const descriptors=Object.getOwnPropertyDescriptors(value);
 if(Reflect.ownKeys(value).some(key=>typeof key!=='string'||!allowed.includes(key)||!('value' in descriptors[key])))
  throw Error('잘못된 입력 획득 증거');
 return value as Record<string,unknown>;
}
export function parseInputAcquisitionSkip(value:unknown):InputAcquisitionSkip {
 const v=fields(value,['version','inputId','captureTime','reason']);
 if(v.version!==1||!Number.isSafeInteger(v.inputId)||(v.inputId as number)<1||
   typeof v.captureTime!=='number'||!Number.isFinite(v.captureTime)||v.captureTime<0||
   !['aborted','not-ready','zero-dimensions','completion-paused'].includes(v.reason as string))
  throw Error('잘못된 입력 획득 생략');
 return Object.freeze({version:1,inputId:v.inputId as number,captureTime:v.captureTime,reason:v.reason as InputAcquisitionSkipReason});
}
export function parseInputAcquisitionContract(value:unknown):Readonly<{version:1}> {
 const v=fields(value,['version']);
 if(v.version!==1)throw Error('잘못된 입력 획득 계약');
 return Object.freeze({version:1});
}

/** Constant-space reducer for one in-flight normal acquisition. The caller
 * forwards all pipeline decisions and input links in recorded order, plus the
 * explicit skip emitted before collect() returns without using pixels. */
export class InputAcquisitionEvidence {
 private declared=false;
 private beforeContractAttempt=false;
 private invalid=false;
 private active:{inputId:number;captureTime:number;resolution:'link'|'skip'|null}|undefined;
 private lastSeq=0;
 private readonly recoveryInputs=new Map<number,{captureTime:number;stage:'retained'|'verified'|'started'|'finished'|'lost';linked:boolean}>();
 private started=0;private linked=0;private skipped=0;private failed=0;private unresolved=0;
 private apply(action:()=>void){
  if(this.invalid)throw Error('유효하지 않은 입력 획득 증거');
  try{action();}catch(error){this.invalid=true;throw error;}
 }
 contract(value:unknown):void {
  this.apply(()=>{
   parseInputAcquisitionContract(value);
   if(this.declared||this.beforeContractAttempt)throw Error('잘못된 입력 획득 계약');
   this.declared=true;
  });
 }
 decision(value:unknown):void {
  if(!this.declared){
   // Old recordings are unsupported. Only remember whether a later contract
   // would be too late; never interpret a legacy event as a successful proof.
   this.beforeContractAttempt=true;
   return;
  }
  this.apply(()=>{
   const v=parseLiveCaptureDecision(value);
   if(v.seq!==this.lastSeq+1)throw Error('입력 획득 결정 순서 누락');
   this.lastSeq=v.seq;
   if(v.kind==='started'){
    if(this.active||[...this.recoveryInputs.values()].some(input=>input.stage==='started'||input.stage==='finished'))
     throw Error('중복된 입력 획득 시작');
    this.active={inputId:v.inputId,captureTime:v.captureTime,resolution:null};this.started++;
   }else if(v.kind==='finished'){
    const a=this.active;
    if(!a||a.inputId!==v.inputId||a.captureTime!==v.captureTime)throw Error('입력 획득 종료 연결 불일치');
    if(!a.resolution)this.unresolved++;
    if(v.outcome==='error')this.failed++;
    this.active=undefined;
   }
  });
 }
 link(value:unknown):void {
  if(!this.declared){this.beforeContractAttempt=true;return;}
  this.apply(()=>{
   const link=parseInputFrameLink(value);
   // A drain recovery may have phase "input". Its separate ownership record,
   // rather than its phase, identifies it as distinct from a normal attempt.
   const recovery=this.recoveryInputs.get(link.inputId);
   if(recovery){
    if(recovery.stage!=='started'||recovery.captureTime!==link.captureTime||recovery.linked)
     throw Error('복구 입력 획득 연결 불일치');
    recovery.linked=true;return;
   }
   const a=this.active;
   if(link.phase!=='input'||!a||a.inputId!==link.inputId||a.captureTime!==link.captureTime||a.resolution)
    throw Error('입력 획득 연결 불일치');
   a.resolution='link';this.linked++;
  });
 }
 /** Track the separate bounded drain ownership only to route input-link. The
  * existing recovery replay remains responsible for its complete validation. */
 recovery(value:unknown):void {
  if(!this.declared){this.beforeContractAttempt=true;return;}
  this.apply(()=>{
   const fact=parseInputRecoveryFact(value);
   if(fact.kind==='retained'){
    if(this.recoveryInputs.has(fact.stamp.inputId)||this.recoveryInputs.size>=2)
     throw Error('중복 또는 과도한 복구 입력 획득');
    this.recoveryInputs.set(fact.stamp.inputId,{captureTime:fact.stamp.captureTime,stage:'retained',linked:false});return;
   }
   const item=this.recoveryInputs.get(fact.inputId);
   // A verification-skipped frame may be lost before it was retained, in
   // which case no link can legitimately follow that loss.
   if(!item&&fact.kind==='lost')return;
   if(!item)throw Error('복구 입력 획득 소유권 없음');
   if(fact.kind==='started'){
    if(this.active||item.stage!=='retained'&&item.stage!=='verified'||
      [...this.recoveryInputs.values()].some(other=>other!==item&&(other.stage==='started'||other.stage==='finished')))
     throw Error('복구 입력 획득 시작 충돌');
    item.stage='started';
   }else if(fact.kind==='verified'){
    if(item.stage!=='retained')throw Error('복구 입력 획득 확인 순서 오류');item.stage='verified';
   }else if(fact.kind==='finished'){
    if(item.stage!=='started')throw Error('복구 입력 획득 종료 순서 오류');item.stage='finished';
   }else if(fact.kind==='lost'){
    if(item.stage!=='retained'&&item.stage!=='verified')throw Error('복구 입력 획득 손실 순서 오류');item.stage='lost';
   }else if(fact.kind==='released'){
    if(fact.reason==='processed'&&item.stage!=='finished'||fact.reason==='compared'&&item.stage!=='verified'||
      fact.reason==='lost'&&item.stage!=='lost')throw Error('복구 입력 획득 해제 순서 오류');
    this.recoveryInputs.delete(fact.inputId);
   }
  });
 }
 skip(value:unknown):void {
  if(!this.declared){this.beforeContractAttempt=true;return;}
  this.apply(()=>{
   const skip=parseInputAcquisitionSkip(value),a=this.active;
   if(!a||a.inputId!==skip.inputId||a.captureTime!==skip.captureTime||a.resolution)
    throw Error('입력 획득 생략 연결 불일치');
   a.resolution='skip';this.skipped++;
  });
 }
 summary():InputAcquisitionEvidenceSummary {
  const supported=this.declared&&!this.invalid;
  return Object.freeze({supported,complete:!this.declared?null:!this.invalid&&this.started>0&&!this.active&&this.failed===0&&this.unresolved===0,
   started:this.started,linked:this.linked,skipped:this.skipped,failed:this.failed,unresolved:this.unresolved,
   inFlight:!!this.active,pixelCoverage:this.skipped?'partial':'unknown'});
 }
}

/** Both exact input replay and event-summary validation use the same contract. */
export function acceptInputAcquisitionEvent(evidence:InputAcquisitionEvidence,type:string,value:unknown):void {
 if(type==='input-acquisition-contract')evidence.contract(value);
 else if(type==='input-acquisition-skip')evidence.skip(value);
 else if(type==='input-decision')evidence.decision(value);
 else if(type==='input-link')evidence.link(value);
 else if(type==='input-recovery')evidence.recovery(value);
}
