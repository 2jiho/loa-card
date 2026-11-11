import type {CaptureCompletion} from './auto-completion';
import {confirmedCaptureCount} from './auto-completion';
import {confirmedReadingCount} from './recovery-completion';

/** A diagnostic only; it never certifies or changes the completion gate. */
export type AutoCompletionGate = 'inventory'|'names'|'fields'|'latest-observations'|'occluded'|'input'|'input-dropped'|'metadata'|'header-unavailable'|'hold'|'header-reading'|'header-mismatch'|'header-error'|'completion-error'|'input-ended'|'complete';
export type AutoCompletionDiagnostic = Readonly<{
  gate:AutoCompletionGate; expected:number|null; identities:number; names:number; fields:number;
  unresolved:number|null; inputPending:boolean; headerAvailable:boolean;
  headerAttempts:number; headerMismatches:number; headerErrors:number;
  /** DEV-only sampled checks; absence on old reports means unmeasured. */
  inputWait?:InputWaitSummary;
}>;
const gates:readonly AutoCompletionGate[]=['inventory','names','fields','latest-observations','occluded','input','input-dropped','metadata','header-unavailable','hold','header-reading','header-mismatch','header-error','completion-error','input-ended','complete'];
const MAX_COUNT=1_000_000;
const bounded=(n:number)=>Number.isSafeInteger(n)&&n>=0?Math.min(n,MAX_COUNT):0;

export type InputWaitCauses=Readonly<{collection:boolean;preview:boolean;readers:boolean;acquisition:boolean}>;
export type InputWaitSummary=Readonly<{version:1;samples:number;dropped:number;clockErrors:number;spanMs:number;maxGapMs:number;
  collection:number;preview:number;readers:number;acquisition:number;none:number;current:InputWaitCauses}>;

/** Sampled only when a completion check reports input work in progress.
 * Counts can overlap, gaps are not interpolated into durations, and no pixels
 * or per-frame history are retained. Saturation is explicitly reported. */
export class InputWaitSampler {
 private samples=0;private dropped=0;private clockErrors=0;private first:number|undefined;private last:number|undefined;private maxGap=0;
 private collection=0;private preview=0;private readers=0;private acquisition=0;private none=0;
 private current:InputWaitCauses={collection:false,preview:false,readers:false,acquisition:false};
 observe(causes:InputWaitCauses,now:number):void {
  if(this.samples>=MAX_COUNT){this.dropped=bounded(this.dropped+1);return;}
  this.samples++;this.current={...causes};
  if(causes.collection)this.collection++;if(causes.preview)this.preview++;if(causes.readers)this.readers++;if(causes.acquisition)this.acquisition++;
  if(!causes.collection&&!causes.preview&&!causes.readers&&!causes.acquisition)this.none++;
  if(!Number.isFinite(now)||now<0||(this.last!==undefined&&now<this.last)){this.clockErrors=bounded(this.clockErrors+1);return;}
  if(this.first===undefined)this.first=now;
  if(this.last!==undefined)this.maxGap=Math.max(this.maxGap,now-this.last);
  this.last=now;
 }
 snapshot():InputWaitSummary|undefined {
  if(!this.samples)return;
  return {version:1,samples:this.samples,dropped:this.dropped,clockErrors:this.clockErrors,
    spanMs:this.first===undefined||this.last===undefined?0:this.last-this.first,maxGapMs:this.maxGap,
    collection:this.collection,preview:this.preview,readers:this.readers,acquisition:this.acquisition,none:this.none,current:{...this.current}};
 }
}

/** Reject malformed or getter-backed imported metrics without evaluating them. */
function parseInputWait(value:unknown):InputWaitSummary|undefined {
 if(!value||typeof value!=='object'||Array.isArray(value))return;
 const own=(obj:object,key:string)=>{const d=Object.getOwnPropertyDescriptor(obj,key);return d&&'value' in d?d.value:undefined;};
 const row=value as object,version=own(row,'version'),samples=own(row,'samples'),dropped=own(row,'dropped'),clockErrors=own(row,'clockErrors');
 const spanMs=own(row,'spanMs'),maxGapMs=own(row,'maxGapMs'),current=own(row,'current');
 const names=['collection','preview','readers','acquisition','none'] as const,counts=names.map(name=>own(row,name));
 if(version!==1||!Number.isSafeInteger(samples)||samples<1||samples>MAX_COUNT||
  ![dropped,clockErrors,...counts].every(n=>Number.isSafeInteger(n)&&n>=0&&n<=MAX_COUNT)||counts.some(n=>n>samples)||clockErrors>samples||
  !Number.isFinite(spanMs)||spanMs<0||!Number.isFinite(maxGapMs)||maxGapMs<0||maxGapMs>spanMs||
  !current||typeof current!=='object'||Array.isArray(current))return;
 const flags=names.slice(0,4).map(name=>own(current,name));if(flags.some(flag=>typeof flag!=='boolean'))return;
 return {version:1,samples,dropped,clockErrors,spanMs,maxGapMs,collection:counts[0],preview:counts[1],readers:counts[2],acquisition:counts[3],none:counts[4],
  current:{collection:flags[0],preview:flags[1],readers:flags[2],acquisition:flags[3]}};
}

/** Reflect the same evidence checks as capture, in their actual order. This
 * does not accept, retire, associate, or otherwise modify observations. */
export function completionEvidenceGate(input:CaptureCompletion):AutoCompletionGate|undefined {
 const {expected,cards,latest}=input;
 if(input.dropped!==0)return 'input-dropped';
 if(expected===null||!Number.isInteger(expected)||expected<=0||cards.length!==expected||latest.size!==expected||new Set(cards.map(card=>card.id)).size!==expected)return 'inventory';
 if(input.unresolved!==0)return 'latest-observations';
 if(input.fieldChangesSettled!==true)return 'latest-observations';
 if(confirmedCaptureCount(input)!==expected)return 'names';
 if(confirmedReadingCount(input)!==expected)return 'fields';
 return undefined;
}

/** A bounded, pixel-free snapshot of the latest check and header outcomes. */
export class AutoCompletionDiagnostics {
 private attempts=0;private mismatches=0;private errors=0;
 attempted(){this.attempts=Math.min(MAX_COUNT,this.attempts+1);}
 mismatch(){this.mismatches=Math.min(MAX_COUNT,this.mismatches+1);}
 error(){this.errors=Math.min(MAX_COUNT,this.errors+1);}
 inventory(input:{expected:number|null;identities:number;names:number;fields:number;unresolved:number|null;inputPending:boolean;headerAvailable:boolean}):AutoCompletionDiagnostic {
  return {gate:'inventory',expected:input.expected===null?null:bounded(input.expected),identities:bounded(input.identities),
   names:bounded(input.names),fields:bounded(input.fields),unresolved:input.unresolved===null?null:bounded(input.unresolved),
   inputPending:input.inputPending,headerAvailable:input.headerAvailable,headerAttempts:this.attempts,headerMismatches:this.mismatches,headerErrors:this.errors};
 }
 snapshot(input:CaptureCompletion,unresolved:number,gate:AutoCompletionGate):AutoCompletionDiagnostic {
  return {gate,expected:input.expected===null?null:bounded(input.expected),identities:bounded(input.latest.size),
   names:bounded(confirmedCaptureCount(input)),fields:bounded(confirmedReadingCount(input)),unresolved:bounded(unresolved),
   inputPending:!input.inputSettled,headerAvailable:input.headerAvailable,
   headerAttempts:this.attempts,headerMismatches:this.mismatches,headerErrors:this.errors};
 }
}
/** Copy known primitive fields only, without invoking accessors on imported state. */
export function boundedAutoCompletionDiagnostic(value:unknown):AutoCompletionDiagnostic|undefined {
 if(!value||typeof value!=='object')return;
 const read=(key:string)=>{const d=Object.getOwnPropertyDescriptor(value,key);return d&&'value' in d?d.value:undefined;};
 const gate=read('gate'),expected=read('expected');
 const keys=['identities','names','fields','headerAttempts','headerMismatches','headerErrors'] as const;
 const values=keys.map(read),inputPending=read('inputPending'),headerAvailable=read('headerAvailable');
 const unresolved=read('unresolved');
 if(!gates.includes(gate)||!(expected===null||Number.isSafeInteger(expected)&&expected>=0&&expected<=MAX_COUNT)||
  !(unresolved===null||Number.isSafeInteger(unresolved)&&unresolved>=0&&unresolved<=MAX_COUNT)||
  values.some(n=>!Number.isSafeInteger(n)||n<0||n>MAX_COUNT)||typeof inputPending!=='boolean'||typeof headerAvailable!=='boolean')return;
 const wait=read('inputWait'),inputWait=wait===undefined?undefined:parseInputWait(wait);
 if(wait!==undefined&&!inputWait)return;
 return {gate,expected,identities:values[0],names:values[1],fields:values[2],unresolved,inputPending,headerAvailable,
  headerAttempts:values[3],headerMismatches:values[4],headerErrors:values[5],...(inputWait?{inputWait}:{})};
}

export function autoCompletionMessage(gate:AutoCompletionGate):string {
 switch(gate){
  case 'inventory':return '보관함 수량과 수집한 카드를 확인하고 있어요.';
  case 'names':return '카드 이름을 다시 확인하고 있어요.';
  case 'fields':return '각성과 카드 장수를 다시 확인하고 있어요.';
  case 'latest-observations':return '확인되지 않은 화면이 남아 있어요. 카드 목록을 다시 보여 주세요.';
  case 'occluded':return '가려진 카드가 있어요. 가림을 없애고 카드 목록 전체를 다시 보여 주세요.';
  case 'input':return '수집한 화면을 정리하고 있어요.';
  case 'input-dropped':return '처리하지 못한 화면이 있어요. 공유를 종료한 뒤 처음부터 다시 스캔해 주세요.';
  case 'metadata':return '보관함 정보를 확인하고 있어요.';
  case 'header-unavailable':return '보관함 수량이 보이도록 성장 탭을 보여 주세요.';
  case 'hold':return '마지막 화면을 확인하고 있어요.';
  case 'header-reading':return '보관함 수량을 마지막으로 확인하고 있어요.';
  case 'header-mismatch':return '보관함 수량을 다시 확인하고 있어요.';
  case 'header-error':return '보관함 수량 확인을 다시 시도하고 있어요.';
  case 'completion-error':return '스캔 완료 확인을 다시 시도하고 있어요.';
  case 'input-ended':return '화면 공유가 종료됐어요.';
  case 'complete':return '전체 카드 확인을 마쳤어요.';
 }
}
