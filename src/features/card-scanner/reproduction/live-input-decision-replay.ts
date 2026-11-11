import {applyLiveInputAdmissionFact,createLiveInputAdmission,parseLiveInputAdmissionFact} from '../capture/live-input-admission';
import {parseLiveCaptureDecision} from '../capture/live-capture-pipeline';
import {yieldForCapture} from '../capture/input-source';
import type {InputStamp} from '../capture/live-input-admission';
import {sameSourceFrameCorrelation} from '../capture/source-frame-correlation';
import type {SourceFrameCorrelation} from '../capture/source-frame-correlation';

export const MAX_REPLAY_INPUT_SELECTIONS=20_000;
export interface InputFrameLink {
  readonly inputId:number;
  readonly frameId:number;
  readonly captureTime:number;
  readonly phase:'input'|'recovery';
}
export type InputRecoveryFact =
  | Readonly<{version:1;seq:number;kind:'retained';stamp:InputStamp}>
  | Readonly<{version:2;seq:number;kind:'retained';stamp:InputStamp;skipReason:'cadence'|'source-capacity'}>
  | Readonly<{version:1;seq:number;kind:'started';inputId:number}>
  | Readonly<{version:1;seq:number;kind:'verified';inputId:number}>
  | Readonly<{version:1;seq:number;kind:'finished';inputId:number;outcome:'completed'|'error'}>
  | Readonly<{version:1;seq:number;kind:'released';inputId:number;failed:boolean;reason:'compared'|'processed'|'lost'}>
  | Readonly<{version:1;seq:number;kind:'lost';inputId:number;reason:'capacity'|'cancelled'|'overflow'|'error'|'unavailable'}>
  | Readonly<{version:2;seq:number;kind:'lost';inputId:number;stamp:InputStamp;skipReason:'cadence'|'source-capacity';reason:'capacity'|'cancelled'|'overflow'|'error'|'unavailable'}>;
export type InputCheckpoint=Readonly<{complete:true;hash:string;error?:string}|{complete:false;error?:string}>;
export interface InputReplaySummary {
  readonly supported:boolean;
  readonly admission:{readonly supported:boolean;readonly facts:number;readonly considered:number;readonly frozen:number;
    readonly skipped:number;readonly freezeFailed:number;readonly completed:number};
  readonly pipeline:{readonly supported:boolean;readonly decisions:number;readonly offered:number;readonly replaced:number;
    readonly started:number;readonly finished:number;readonly released:number;readonly linked:number;readonly retained:number};
  readonly settled:boolean;
  readonly recovery?:Readonly<{facts:number;retained:number;started:number;linked:number;finished:number;released:number;lost:number;owned:number}>;
  readonly hash:string|null;
  readonly expectedHash:string|null;
  readonly matchesCapturedState:boolean|null;
}

function object(value:unknown,keys:readonly string[]):Record<string,unknown> {
  if(!value||typeof value!=='object'||Array.isArray(value)||![Object.prototype,null].includes(Object.getPrototypeOf(value))||
    Object.keys(value).some(key=>!keys.includes(key)))throw Error('잘못된 입력 재생 정보');
  return value as Record<string,unknown>;
}
/** Records a skipped input's separate ownership. Version 1 covers verification
 * skips. Version 2 can additionally describe a cadence/capacity skip, with its
 * original stamp and reason. Neither certifies pixels or physical completeness. */
export function parseInputRecoveryFact(value:unknown):InputRecoveryFact {
  const fact=object(value,['version','seq','kind','stamp','inputId','outcome','failed','reason','skipReason']);
  if(!Number.isSafeInteger(fact.seq)||(fact.seq as number)<1)throw Error('잘못된 복구 입력 순서');
  if(fact.version===2){
    if(fact.kind!=='retained'&&fact.kind!=='lost')throw Error('알 수 없는 복구 입력 사실');
    object(fact,fact.kind==='retained'?['version','seq','kind','stamp','skipReason']:
      ['version','seq','kind','stamp','inputId','skipReason','reason']);
    if(fact.skipReason!=='cadence'&&fact.skipReason!=='source-capacity')throw Error('잘못된 복구 생략 사유');
    const parsed=parseLiveInputAdmissionFact({kind:'consider',stamp:fact.stamp,gates:{capturing:true,checkingCompletion:true}});
    if(parsed.kind!=='consider')throw Error('잘못된 복구 입력');
    const base={version:2 as const,seq:fact.seq as number,stamp:parsed.stamp,skipReason:fact.skipReason as 'cadence'|'source-capacity'};
    if(fact.kind==='retained')return Object.freeze({...base,kind:'retained'});
    if(fact.inputId!==parsed.stamp.inputId||!['capacity','cancelled','overflow','error','unavailable'].includes(fact.reason as string))
      throw Error('잘못된 복구 손실 사유');
    return Object.freeze({...base,kind:'lost',inputId:parsed.stamp.inputId,
      reason:fact.reason as 'capacity'|'cancelled'|'overflow'|'error'|'unavailable'});
  }
  if(fact.version!==1)throw Error('잘못된 복구 입력 순서');
  const base={version:1 as const,seq:fact.seq as number};
  if(fact.kind==='retained'){
    object(fact,['version','seq','kind','stamp']);
    const parsed=parseLiveInputAdmissionFact({kind:'consider',stamp:fact.stamp,gates:{capturing:true,checkingCompletion:true}});
    if(parsed.kind!=='consider')throw Error('잘못된 복구 입력');
    return Object.freeze({...base,kind:'retained',stamp:parsed.stamp});
  }
  if(!Number.isSafeInteger(fact.inputId)||(fact.inputId as number)<1)throw Error('잘못된 복구 입력 ID');
  const inputId=fact.inputId as number;
  if(fact.kind==='started'){object(fact,['version','seq','kind','inputId']);return Object.freeze({...base,kind:'started',inputId});}
  if(fact.kind==='verified'){object(fact,['version','seq','kind','inputId']);return Object.freeze({...base,kind:'verified',inputId});}
  if(fact.kind==='finished'){
    object(fact,['version','seq','kind','inputId','outcome']);
    if(fact.outcome!=='completed'&&fact.outcome!=='error')throw Error('잘못된 복구 판독 결과');
    return Object.freeze({...base,kind:'finished',inputId,outcome:fact.outcome});
  }
  if(fact.kind==='released'){
    object(fact,['version','seq','kind','inputId','failed','reason']);
    if(typeof fact.failed!=='boolean'||!['compared','processed','lost'].includes(fact.reason as string))throw Error('잘못된 복구 해제 결과');
    return Object.freeze({...base,kind:'released',inputId,failed:fact.failed,reason:fact.reason as 'compared'|'processed'|'lost'});
  }
  if(fact.kind==='lost'){
    object(fact,['version','seq','kind','inputId','reason']);
    if(!['capacity','cancelled','overflow','error','unavailable'].includes(fact.reason as string))throw Error('잘못된 복구 손실 사유');
    return Object.freeze({...base,kind:'lost',inputId,reason:fact.reason as 'capacity'|'cancelled'|'overflow'|'error'|'unavailable'});
  }
  throw Error('알 수 없는 복구 입력 사실');
}
export function parseInputFrameLink(value:unknown):InputFrameLink {
  const link=object(value,['inputId','frameId','captureTime','phase']);
  if(!Number.isSafeInteger(link.inputId)||(link.inputId as number)<1||!Number.isSafeInteger(link.frameId)||(link.frameId as number)<1||
    typeof link.captureTime!=='number'||!Number.isFinite(link.captureTime)||link.captureTime<0||
    !['input','recovery'].includes(link.phase as string))throw Error('잘못된 입력 프레임 연결');
  return Object.freeze({inputId:link.inputId as number,frameId:link.frameId as number,captureTime:link.captureTime,phase:link.phase as 'input'|'recovery'});
}
export function parseInputCheckpoint(value:unknown):InputCheckpoint {
  const checkpoint=object(value,['complete','hash','error']);
  if(typeof checkpoint.complete!=='boolean'||checkpoint.error!==undefined&&(typeof checkpoint.error!=='string'||checkpoint.error.length>2000))
    throw Error('잘못된 입력 검증점');
  if(checkpoint.complete){
    if(typeof checkpoint.hash!=='string'||!/^[a-f0-9]{64}$/.test(checkpoint.hash))throw Error('잘못된 입력 검증 해시');
    return Object.freeze({complete:true,hash:checkpoint.hash,...(checkpoint.error===undefined?{}:{error:checkpoint.error as string})});
  }
  if(Object.hasOwn(checkpoint,'hash'))throw Error('잘못된 입력 검증점');
  return Object.freeze({complete:false,...(checkpoint.error===undefined?{}:{error:checkpoint.error as string})});
}

interface InputSelectionMetadata {
  readonly selection:Readonly<{rowStart:number;rowCount:number}>|null;
  readonly estimatedBytes:number;
  readonly source?:SourceFrameCorrelation;
}
interface PipelinePolicy {readonly maxPendingFrames:1|2;readonly maxRetainedBytes:number}
interface SelectedInput {
  readonly inputId:number;readonly captureTime:number;link:InputFrameLink|null;
  readonly metadata?:InputSelectionMetadata;
}
interface RetainedInput {
  readonly inputId:number;readonly captureTime:number;
  stage:'offered'|'replaced'|'started'|'finished';
  outcome?:'completed'|'error';
  selection?:number;
  readonly metadata?:InputSelectionMetadata;
}
interface RecoveryInput {
  readonly stamp:InputStamp;
  /** Absent on all version 1 events to preserve historical checkpoint bytes. */
  readonly skipReason?:'cadence'|'source-capacity';
  stage:'retained'|'verified'|'started'|'finished'|'lost'|'released';
  owns:boolean;
  link:InputFrameLink|null;
  outcome?:'completed'|'error';
  loss?:'capacity'|'cancelled'|'overflow'|'error'|'unavailable';
  releaseFailed?:boolean;
  releaseReason?:'compared'|'processed'|'lost';
}

/** Checks admission policy and recorded ownership transitions, without scheduling
 * or decoding pixels. Version 1 retains at most three transient ownership
 * records; version 2 permits an incoming fourth frame before bounded cleanup.
 * Skipped arrivals use constant-size policy state. Hints never create card or
 * absolute-position evidence. */
export class InputDecisionReplay {
  private readonly signal:AbortSignal;
  private readonly selectionLimit:number;
  private readonly policy=createLiveInputAdmission();
  private readonly retained=new Map<number,RetainedInput>();
  private readonly selected:SelectedInput[]=[];
  private admissionFacts=0;
  private considered=0;
  private frozen=0;
  private skipped=0;
  private freezeFailed=0;
  private completed=0;
  private pipelineDecisions=0;
  private offered=0;
  private replaced=0;
  private started=0;
  private finished=0;
  private released=0;
  private linked=0;
  private lastPipelineSequence=0;
  private lastDecisionAtMs:number|null=null;
  private lastOfferedInputId=0;
  private pipelineVersion:1|2|null=null;
  private pipelinePolicy:PipelinePolicy|null=null;
  private latestFrozen:InputStamp|null=null;
  private latestVerificationSkip:InputStamp|null=null;
  private latestDeferredSkip:{stamp:InputStamp;reason:'cadence'|'source-capacity'}|null=null;
  private readonly recoveryInputs:RecoveryInput[]=[];
  private recoverySequence=0;
  private recoveryLost=0;
  private deferredRecovery=false;
  private expectedHash:string|null=null;
  private invalid=false;

  constructor(signal:AbortSignal,selectionLimit=MAX_REPLAY_INPUT_SELECTIONS){
    if(!Number.isSafeInteger(selectionLimit)||selectionLimit<1||selectionLimit>MAX_REPLAY_INPUT_SELECTIONS)throw Error('입력 선택 재생 한도 오류');
    this.signal=signal;this.selectionLimit=selectionLimit;
  }
  private apply(action:()=>void):void {
    this.signal.throwIfAborted();
    if(this.invalid)throw Error('유효하지 않은 입력 상태 기록');
    try{action();}catch(error){this.invalid=true;throw error;}
    this.expectedHash=null;
  }
  /** A newly offered frame may temporarily exceed the retained budget while
   * its recorded replacements are being released. A following stable boundary
   * must not hide that cleanup or permit a second unaccounted incoming frame. */
  private assertStableOwnership():void {
    if(this.pipelineVersion!==2||!this.pipelinePolicy)return;
    const frames=[...this.retained.values()];
    if(frames.some(frame=>frame.stage==='replaced')||
      frames.filter(frame=>frame.stage==='offered').length>this.pipelinePolicy.maxPendingFrames||
      frames.reduce((sum,frame)=>sum+(frame.metadata?.estimatedBytes??0),0)>this.pipelinePolicy.maxRetainedBytes)
      throw Error('입력 대기열 정리 또는 메모리 한도 불일치');
  }
  admission(value:unknown):void {
    this.apply(()=>{
      const fact=parseLiveInputAdmissionFact(value),decision=applyLiveInputAdmissionFact(this.policy,fact);
      this.admissionFacts++;
      if(fact.kind==='consider'){
        this.considered++;
        this.latestVerificationSkip=decision?.kind==='skip'&&decision.reason==='verification'?fact.stamp:null;
        this.latestDeferredSkip=decision?.kind==='skip'&&(decision.reason==='cadence'||decision.reason==='source-capacity')?
          {stamp:fact.stamp,reason:decision.reason}:null;
        if(decision?.kind==='skip')this.skipped++;
      }
      else if(fact.kind==='frozen'){
        if(fact.succeeded){this.frozen++;this.latestFrozen=fact.stamp;}else this.freezeFailed++;
      }
      else this.completed++;
    });
  }
  /** A separate ownership path is required: verification skips do not grant an
   * ordinary pipeline offer or create independent card observations. */
  recovery(value:unknown):void {
    this.apply(()=>{
      const fact=parseInputRecoveryFact(value);
      if(fact.seq!==this.recoverySequence+1)throw Error('복구 입력 이벤트 순서 오류');
      if(fact.kind==='retained'){
        const prior=fact.version===2?this.latestDeferredSkip?.stamp:this.latestVerificationSkip,stamp=fact.stamp;
        if(!prior||prior.inputId!==stamp.inputId||prior.captureTime!==stamp.captureTime||prior.observedAtMs!==stamp.observedAtMs||
          (fact.version===2?this.latestDeferredSkip?.reason!==fact.skipReason||!sameSourceFrameCorrelation(prior.source,stamp.source):
            prior.source!==undefined&&!sameSourceFrameCorrelation(prior.source,stamp.source)))throw Error('복구 입력 복사 근거 불일치');
        if(this.recoveryInputs.length>=this.selectionLimit||this.retained.has(stamp.inputId)||
          this.selected.some(item=>item.inputId===stamp.inputId)||this.recoveryInputs.some(item=>item.stamp.inputId===stamp.inputId)||
          this.recoveryInputs.filter(item=>item.owns).length>=2)
          throw Error('중복 또는 초과 복구 입력 소유권');
        this.recoveryInputs.push({stamp,stage:'retained',link:null,owns:true,...(fact.version===2?{skipReason:fact.skipReason}:{})});
        if(fact.version===2){this.latestDeferredSkip=null;this.deferredRecovery=true;}else this.latestVerificationSkip=null;
      }else{
        let item=this.recoveryInputs.find(input=>input.stamp.inputId===fact.inputId);
        if(fact.kind==='lost'&&fact.version===2){
          const prior=this.latestDeferredSkip;
          if(item||!prior||prior.reason!==fact.skipReason||prior.stamp.inputId!==fact.inputId||
            prior.stamp.captureTime!==fact.stamp.captureTime||prior.stamp.observedAtMs!==fact.stamp.observedAtMs||
            !sameSourceFrameCorrelation(prior.stamp.source,fact.stamp.source)||this.recoveryInputs.length>=this.selectionLimit)
            throw Error('복구 입력 손실 근거 불일치');
          item={stamp:fact.stamp,stage:'lost',link:null,loss:fact.reason,owns:false,skipReason:fact.skipReason};
          this.recoveryInputs.push(item);this.latestDeferredSkip=null;this.deferredRecovery=true;this.recoveryLost++;
        }else if(fact.kind==='lost'&&!item&&this.latestVerificationSkip?.inputId===fact.inputId){
          if(this.recoveryInputs.length>=this.selectionLimit)throw Error('복구 입력 재생 한도 초과');
          item={stamp:this.latestVerificationSkip,stage:'lost',link:null,loss:fact.reason,owns:false};
          this.recoveryInputs.push(item);this.latestVerificationSkip=null;this.recoveryLost++;
        }else{
          if(!item)throw Error('복구 입력 소유권 없음');
          if(fact.kind==='started'){
            if(item.stage!=='retained'&&item.stage!=='verified'||
              [...this.retained.values()].some(other=>other.stage==='started'||other.stage==='finished')||
              this.recoveryInputs.some(other=>other.stage==='started'||other.stage==='finished'||
              (other.stage==='retained'||other.stage==='verified')&&other.stamp.inputId<item!.stamp.inputId))throw Error('복구 입력 판독 순서 오류');
            item.stage='started';
          }else if(fact.kind==='verified'){
            if(item.stage!=='retained'||this.recoveryInputs.some(other=>other.stage==='retained'&&other.stamp.inputId<item!.stamp.inputId))
              throw Error('복구 입력 비교 순서 오류');
            item.stage='verified';
          }else if(fact.kind==='finished'){
            if(item.stage!=='started')throw Error('복구 입력 종료 상태 오류');
            item.stage='finished';item.outcome=fact.outcome;
            if(fact.outcome==='error'||!item.link)this.recoveryLost++;
          }else if(fact.kind==='lost'){
            if(item.stage!=='retained'&&item.stage!=='verified')throw Error('복구 입력 손실 상태 오류');
            item.stage='lost';item.loss=fact.reason;this.recoveryLost++;
          }else if(fact.kind==='released'){
            if(!item.owns||fact.reason==='processed'&&item.stage!=='finished'||fact.reason==='compared'&&item.stage!=='verified'||
              fact.reason==='lost'&&item.stage!=='lost')throw Error('복구 입력 해제 상태 오류');
            item.stage='released';item.owns=fact.failed;item.releaseFailed=fact.failed;item.releaseReason=fact.reason;
            if(fact.failed)this.recoveryLost++;
          }
        }
      }
      this.recoverySequence=fact.seq;
    });
  }
  pipeline(value:unknown):void {
    this.apply(()=>{
      const event=parseLiveCaptureDecision(value);
      if(event.seq!==this.lastPipelineSequence+1||this.lastDecisionAtMs!==null&&event.atMs<this.lastDecisionAtMs)
        throw Error('입력 파이프라인 이벤트 순서 오류');
      if(this.pipelineVersion!==null&&event.version!==this.pipelineVersion)throw Error('입력 파이프라인 버전 변경');
      this.pipelineVersion=event.version;
      if(event.kind==='offered'){
        this.assertStableOwnership();
        if(this.recoveryInputs.some(item=>item.stamp.inputId===event.inputId)||this.latestVerificationSkip?.inputId===event.inputId||
          this.latestDeferredSkip?.stamp.inputId===event.inputId)
          throw Error('복구 입력과 일반 입력 소유권 충돌');
        let metadata:InputSelectionMetadata|undefined;
        if(event.version===2){
          if(this.pipelinePolicy&&(event.maxPendingFrames!==this.pipelinePolicy.maxPendingFrames||
            event.maxRetainedBytes!==this.pipelinePolicy.maxRetainedBytes))throw Error('입력 대기열 설정 변경');
          this.pipelinePolicy??=Object.freeze({maxPendingFrames:event.maxPendingFrames,maxRetainedBytes:event.maxRetainedBytes});
          if(this.considered>0&&(!this.latestFrozen||this.latestFrozen.inputId!==event.inputId||
            this.latestFrozen.captureTime!==event.captureTime||this.latestFrozen.observedAtMs!==event.observedAtMs||
            this.latestFrozen.source!==undefined&&!sameSourceFrameCorrelation(this.latestFrozen.source,event.source)))
            throw Error('입력 복사 승인과 파이프라인 연결 불일치');
          metadata=Object.freeze({selection:event.selection,estimatedBytes:event.estimatedBytes,
            ...(event.source===undefined?{}:{source:event.source})});
        }
        const maxTransient=event.version===1?3:(this.pipelinePolicy!.maxPendingFrames+2);
        if(event.inputId<=this.lastOfferedInputId||this.retained.has(event.inputId)||this.retained.size>=maxTransient)
          throw Error('중복 또는 초과 입력 소유권');
        this.retained.set(event.inputId,{inputId:event.inputId,captureTime:event.captureTime,stage:'offered',
          ...(metadata===undefined?{}:{metadata})});
        this.lastOfferedInputId=event.inputId;this.offered++;
      }else if(event.kind==='replaced'){
        const old=this.retained.get(event.oldInputId),next=this.retained.get(event.newInputId);
        if(!old||!next||old.stage!=='offered'||next.stage!=='offered'||event.newInputId!==this.lastOfferedInputId)
          throw Error('대기 입력 교체 근거 불일치');
        old.stage='replaced';this.replaced++;
      }else {
        const input=this.retained.get(event.inputId);
        if(!input||input.captureTime!==event.captureTime)throw Error('입력 소유권 또는 캡처 시각 불일치');
        if(event.kind==='started'){
          this.assertStableOwnership();
          if(input.stage!=='offered'||[...this.retained.values()].some(other=>other.stage==='started'||other.stage==='finished')||
            this.recoveryInputs.some(other=>other.stage==='started'||other.stage==='finished'))
            throw Error('입력 판독 시작 상태 불일치');
          if(event.version===2&&[...this.retained.values()].some(other=>other.stage==='offered'&&other.inputId<input.inputId))
            throw Error('대표 입력의 판독 순서 불일치');
          if(this.selected.length>=this.selectionLimit)throw Error('입력 선택 순서 재생 한도 초과');
          input.stage='started';input.selection=this.selected.length;
          this.selected.push({inputId:input.inputId,captureTime:input.captureTime,link:null,
            ...(input.metadata===undefined?{}:{metadata:input.metadata})});this.started++;
        }else if(event.kind==='finished'){
          this.assertStableOwnership();
          if(input.stage!=='started')throw Error('입력 판독 종료 상태 불일치');
          input.stage='finished';input.outcome=event.outcome;this.finished++;
        }else {
          const valid=event.reason==='normal'?input.stage==='finished'&&input.outcome==='completed':
            event.reason==='replaced'?input.stage==='replaced':
            event.reason==='capacity'?event.version===2&&input.stage==='offered'&&input.inputId===this.lastOfferedInputId:
            event.reason==='error'?input.stage==='offered'||input.stage==='finished'&&input.outcome==='error':input.stage==='offered';
          if(!valid)throw Error('입력 해제 상태 불일치');
          this.retained.delete(input.inputId);this.released++;
        }
      }
      this.pipelineDecisions++;this.lastPipelineSequence=event.seq;this.lastDecisionAtMs=event.atMs;
    });
  }
  link(value:unknown):void {
    this.apply(()=>{
      this.assertStableOwnership();
      const link=parseInputFrameLink(value),input=this.retained.get(link.inputId);
      const recovery=this.recoveryInputs.find(item=>item.stamp.inputId===link.inputId);
      if(!input&&recovery){
        if(recovery.stage!=='started'||recovery.stamp.captureTime!==link.captureTime||recovery.link)throw Error('복구 입력 프레임 연결 불일치');
        recovery.link=link;return;
      }
      if(!input||input.stage!=='started'||input.captureTime!==link.captureTime||input.selection===undefined)
        throw Error('시작되지 않은 입력 프레임 연결');
      const selection=this.selected[input.selection];
      if(selection.link)throw Error('중복 입력 프레임 연결');
      selection.link=link;this.linked++;
    });
  }
  checkpoint(value:unknown):void {
    this.signal.throwIfAborted();
    const checkpoint=parseInputCheckpoint(value);
    this.expectedHash=checkpoint.complete?checkpoint.hash:null;
  }
  async summary():Promise<InputReplaySummary> {
    this.signal.throwIfAborted();
    if(this.invalid)throw Error('유효하지 않은 입력 상태 기록');
    this.assertStableOwnership();
    const admission={supported:this.admissionFacts>0,facts:this.admissionFacts,considered:this.considered,frozen:this.frozen,
      skipped:this.skipped,freezeFailed:this.freezeFailed,completed:this.completed};
    const pipeline={supported:this.pipelineDecisions>0,decisions:this.pipelineDecisions,offered:this.offered,replaced:this.replaced,
      started:this.started,finished:this.finished,released:this.released,linked:this.linked,retained:this.retained.size};
    const policy=this.policy.snapshot(),supported=admission.supported||pipeline.supported||this.recoverySequence>0;
    const recovery=this.recoverySequence?{facts:this.recoverySequence,retained:this.recoveryInputs.length,
      started:this.recoveryInputs.filter(item=>item.stage==='started'||item.stage==='finished'||item.stage==='released'&&item.outcome!==undefined).length,
      linked:this.recoveryInputs.filter(item=>item.link).length,finished:this.recoveryInputs.filter(item=>item.outcome!==undefined).length,
      released:this.recoveryInputs.filter(item=>item.stage==='released').length,lost:this.recoveryLost,
      owned:this.recoveryInputs.filter(item=>item.owns).length}:undefined;
    const settled=!policy.pending&&!this.retained.size&&(!recovery||recovery.owned===0&&recovery.lost===0),expectedHash=this.expectedHash;
    // Keep the original property order and absent fields for v1 checkpoints.
    const snapshot={version:this.deferredRecovery?4:recovery?3:this.pipelineVersion===2?2:1,scope:'input-decisions',admission,pipeline,policy,
      lastPipelineSequence:this.lastPipelineSequence,lastDecisionAtMs:this.lastDecisionAtMs,lastOfferedInputId:this.lastOfferedInputId,
      retained:[...this.retained.values()].map(value=>({...value})),selected:this.selected.map(value=>({...value})),
      ...(this.pipelineVersion===2?{pipelinePolicy:this.pipelinePolicy}:{}),
      ...(recovery?{recovery,recoveryInputs:this.recoveryInputs.map(item=>({...item}))}:{})};
    await yieldForCapture(this.signal);
    const hash=supported?Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(snapshot)))),
      value=>value.toString(16).padStart(2,'0')).join(''):null;
    this.signal.throwIfAborted();
    return {supported,admission,pipeline,settled,hash,expectedHash,...(recovery?{recovery}:{}),
      matchesCapturedState:hash!==null&&expectedHash!==null&&settled?hash===expectedHash:null};
  }
}
