import {canFinishEndedCapture, type CaptureCompletion} from './auto-completion';
import type {RecoveryCompletion} from './recovery-completion';
import {negativeCompletionReasons, type NegativeCompletionState} from './negative-completion';

/** Current-session completion evidence, not proof of unobserved pixels. */
export interface PositiveCompletionReceipt {
  version: 1;
  mode: 'auto' | 'ended';
  expected: number;
  finalExpected: number;
}

type CompletionState = NegativeCompletionState & {completionReceipt?: PositiveCompletionReceipt};

export type ReceiptEvidence = CaptureCompletion &
  Pick<RecoveryCompletion, 'pending' | 'tailFresh'> &
  {inputClosed:boolean;headerVerified:boolean;mode:'auto'|'ended';headerCaptureOrder:number};

/** Both end modes use the final joined evidence; the caller must bind the
 * verified header and its capture order to this session. */
export function issuePositiveCompletionReceipt(input:ReceiptEvidence):PositiveCompletionReceipt|undefined {
  // A recovered observation newer than the verified header can describe a
  // newer inventory. Matching card values cannot make the older total current.
  if(!Number.isSafeInteger(input.headerCaptureOrder)||input.headerCaptureOrder<0||
    [...input.latest.values()].some(order=>!Number.isSafeInteger(order)||order>input.headerCaptureOrder))return undefined;
  if(!canFinishEndedCapture(input))return undefined;
  return {version:1,mode:input.mode,expected:input.expected!,finalExpected:input.finalExpected!};
}

/** No known negative evidence is not itself a positive completion proof. */
export function completionReasons(state:CompletionState):string[] {
  const reasons=negativeCompletionReasons(state);
  const receipt=state.completionReceipt;
  if(!receipt||receipt.version!==1||(receipt.mode!=='auto'&&receipt.mode!=='ended')||
    !Number.isSafeInteger(receipt.expected)||receipt.expected<=0||receipt.expected!==state.expected||
    receipt.finalExpected!==receipt.expected)reasons.push('최종 스캔 검증 미완료');
  return reasons;
}
