import {applyLiveInputAdmissionFact,createLiveInputAdmission,parseLiveInputAdmissionFact} from './live-input-admission';
import {parseLiveCaptureDecision} from './live-capture-pipeline';
import {yieldForCapture} from './input-source';
import type {InputStamp} from './live-input-admission';
import {sameSourceFrameCorrelation} from './source-frame-correlation';
import type {SourceFrameCorrelation} from './source-frame-correlation';

export const MAX_REPLAY_INPUT_SELECTIONS=20_000;
export interface InputFrameLink {
  readonly inputId:number;
  readonly frameId:number;
  readonly captureTime:number;
  readonly phase:'input'|'recovery';
}
export type InputCheckpoint=Readonly<{complete:true;hash:string;error?:string}|{complete:false;error?:string}>;
export interface InputReplaySummary {
  readonly supported:boolean;
  readonly admission:{readonly supported:boolean;readonly facts:number;readonly considered:number;readonly frozen:number;
    readonly skipped:number;readonly freezeFailed:number;readonly completed:number};
  readonly pipeline:{readonly supported:boolean;readonly decisions:number;readonly offered:number;readonly replaced:number;
    readonly started:number;readonly finished:number;readonly released:number;readonly linked:number;readonly retained:number};
  readonly settled:boolean;
  readonly hash:string|null;
  readonly expectedHash:string|null;
  readonly matchesCapturedState:boolean|null;
}

function object(value:unknown,keys:readonly string[]):Record<string,unknown> {
  if(!value||typeof value!=='object'||Array.isArray(value)||![Object.prototype,null].includes(Object.getPrototypeOf(value))||
    Object.keys(value).some(key=>!keys.includes(key)))throw Error('잘못된 입력 재생 정보');
  return value as Record<string,unknown>;
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
      if(fact.kind==='consider'){this.considered++;if(decision?.kind==='skip')this.skipped++;}
      else if(fact.kind==='frozen'){
        if(fact.succeeded){this.frozen++;this.latestFrozen=fact.stamp;}else this.freezeFailed++;
      }
      else this.completed++;
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
          if(input.stage!=='offered'||[...this.retained.values()].some(other=>other.stage==='started'||other.stage==='finished'))
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
    const policy=this.policy.snapshot(),supported=admission.supported||pipeline.supported;
    const settled=!policy.pending&&!this.retained.size,expectedHash=this.expectedHash;
    // Keep the original property order and absent fields for v1 checkpoints.
    const snapshot={version:this.pipelineVersion===2?2:1,scope:'input-decisions',admission,pipeline,policy,
      lastPipelineSequence:this.lastPipelineSequence,lastDecisionAtMs:this.lastDecisionAtMs,lastOfferedInputId:this.lastOfferedInputId,
      retained:[...this.retained.values()].map(value=>({...value})),selected:this.selected.map(value=>({...value})),
      ...(this.pipelineVersion===2?{pipelinePolicy:this.pipelinePolicy}:{})};
    await yieldForCapture(this.signal);
    const hash=supported?Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(snapshot)))),
      value=>value.toString(16).padStart(2,'0')).join(''):null;
    this.signal.throwIfAborted();
    return {supported,admission,pipeline,settled,hash,expectedHash,
      matchesCapturedState:hash!==null&&expectedHash!==null&&settled?hash===expectedHash:null};
  }
}
