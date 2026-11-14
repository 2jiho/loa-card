import type {LiveCaptureDecision,LiveCaptureReleaseEvent} from '../capture/live-capture-pipeline';
import type {CandidateAdmission} from '../acquisition/candidate-queue';

export const LIVE_INPUT_LOSS_MESSAGE='일부 화면을 놓쳤어요. 스크롤을 더 천천히 하면서 다시 스캔해 주세요.';
export type InputLossReason='freeze-failed'|'capacity'|'rejected'|'pipeline-error'|'not-ready'|'zero-dimensions'|'completion-paused'|'queue-full';
export interface InputLossFact {version:1;inputId:number;captureTime:number;reason:InputLossReason}
const reasons:readonly InputLossReason[]=['freeze-failed','capacity','rejected','pipeline-error','not-ready','zero-dimensions','completion-paused','queue-full'];
const LIMIT=4096;
export function parseInputLossFact(value:unknown):InputLossFact {
 if(!value||typeof value!=='object'||Array.isArray(value))throw TypeError('Invalid input loss');
 const v=value as Record<string,unknown>;
 if(Object.keys(v).length!==4||v.version!==1||!Number.isSafeInteger(v.inputId)||(v.inputId as number)<1||
   typeof v.captureTime!=='number'||!Number.isFinite(v.captureTime)||v.captureTime<0||!reasons.includes(v.reason as InputLossReason))
  throw TypeError('Invalid input loss');
 return {version:1,inputId:v.inputId as number,captureTime:v.captureTime,reason:v.reason as InputLossReason};
}
export function parseInputLossContract(value:unknown):{version:1} {
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length!==1||(value as {version?:unknown}).version!==1)
  throw TypeError('Invalid input loss contract');
 return {version:1};
}
/** Monotonic, per-session source loss. No unrelated observation clears a loss. */
export class InputLossEvidence {
 private seeded=false;
 private invalid=false;
 private readonly lost=new Map<number,InputLossFact>();
 private overflow=false;
 seed(value:unknown){
  if(this.seeded||!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length!==1||(value as {version?:unknown}).version!==1){this.invalid=true;return;}
  this.seeded=true;
 }
 markIncomplete(){this.invalid=true;}
 accept(value:unknown):boolean {
  if(!this.seeded){this.invalid=true;return false;}
  let fact:InputLossFact;
  try{fact=parseInputLossFact(value);}catch{this.invalid=true;return false;}
  const existing=this.lost.get(fact.inputId);
  if(existing){if(existing.captureTime!==fact.captureTime)this.invalid=true;return false;}
  if(this.lost.size>=LIMIT){this.overflow=true;return false;}
  this.lost.set(fact.inputId,{...fact});return true;
 }
 summary(){return {supported:this.seeded&&!this.invalid,observedCount:this.seeded&&!this.invalid?this.lost.size:null,absenceProven:false as const,overflow:this.overflow};}
}
/** Intentional replacement, disposal and cancellation are not evidence of loss. */
export function pipelineInputLoss(decision:LiveCaptureDecision|LiveCaptureReleaseEvent,active:boolean):InputLossFact|null {
 if(!active||decision.kind!=='released')return null;
 const reason=decision.reason==='capacity'?'capacity':decision.reason==='rejected'?'rejected':decision.reason==='error'?'pipeline-error':null;
 return reason?{version:1,inputId:decision.inputId,captureTime:decision.captureTime,reason}:null;
}
/** A full candidate queue may reject only some slots after the frame-level
 * check passed. Account for that source once; a lower-quality same-key
 * rejection is a different event and is not mislabeled as capacity loss. */
export function candidateQueueInputLoss(admission:CandidateAdmission,stamp:{inputId:number;captureTime:number}|undefined,active:boolean):InputLossFact|null {
 return active&&admission==='full'&&stamp?{version:1,inputId:stamp.inputId,captureTime:stamp.captureTime,reason:'queue-full'}:null;
}
export function acceptInputLossEvent(evidence:InputLossEvidence,type:string,value:unknown){
 if(type==='input-loss-contract')evidence.seed(value);
 else if(type==='input-loss')evidence.accept(value);
 else if(type==='input-recording-error')evidence.markIncomplete();
}
