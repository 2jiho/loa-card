import type {DrainClockFailure} from './completion-drain-clock';
export type DrainInputLossReason=DrainClockFailure|'clock-error'|'buffer-timeout'|'buffer-unverified'|
 'buffer-rejected'|'frame-unavailable'|'comparison-failed'|'release-error';
export interface DrainInputLoss {readonly reason:DrainInputLossReason;readonly replaySupported:false}
const reasons:readonly string[]=['clock-fallback','clock-invalid','clock-duplicate','clock-regression','clock-gap',
 'clock-error','buffer-timeout','buffer-unverified','buffer-rejected','frame-unavailable','comparison-failed','release-error'];
export function boundedDrainInputLoss(value:unknown):DrainInputLoss|undefined {
 if(!value||typeof value!=='object'||Array.isArray(value))return;
 const reason=Object.getOwnPropertyDescriptor(value,'reason'),replay=Object.getOwnPropertyDescriptor(value,'replaySupported');
 if(!reason||!('value' in reason)||typeof reason.value!=='string'||!reasons.includes(reason.value)||
  !replay||!('value' in replay)||replay.value!==false)return;
 return {reason:reason.value as DrainInputLossReason,replaySupported:false};
}
export const DRAIN_INPUT_LOSS_MESSAGE='스캔 입력을 확인하지 못했습니다. 카드 목록을 처음부터 다시 스캔해 주세요.';
/** The independently tracked input loss must survive every live refresh. */
export function unresolvedWithDrainLoss(freshness:number,obstruction:number,loss:DrainInputLoss|undefined):number {
 return freshness+obstruction+Number(!!loss);
}
/** A diagnostic-only loss is separate from a card's field failure. Keep it
 * visible and blocking even when card inventory totals happen to match. */
export function drainLossFinal(input:{unresolved:number;status:string;warning?:string},loss:DrainInputLoss|undefined){
 if(!loss)return {...input};
 return {unresolved:input.unresolved+1,status:DRAIN_INPUT_LOSS_MESSAGE,warning:DRAIN_INPUT_LOSS_MESSAGE};
}
