import type {ScanMonitorOutcomeSource} from './scan-monitor-outcome';
import {scanMonitorInputFacts} from './scan-monitor-outcome';
import {unattributedFieldReviewCount} from './current-scan-fields';
import type {ScannedCard} from '../recognition/recognizer-types';

export interface NegativeCompletionState extends ScanMonitorOutcomeSource {
  status: string;
  cards: readonly ScannedCard[];
  recognitionNeeded?: readonly {pinned?: boolean}[];
  currentRunNames?: number;
  discardedObservations?: readonly unknown[];
  unknownEvidenceLost?: boolean;
  drainInputLoss?: unknown;
}

/** Negative evidence only. An empty result is not a completion receipt. */
export function negativeCompletionReasons(state:NegativeCompletionState):string[]{
 const issues:string[]=[];
 const count=(v:unknown):v is number=>Number.isSafeInteger(v)&&Number(v)>=0;
 if(state.interrupted||state.status==='스캔 중지')issues.push('스캔 중단');
 const pinnedRecognition=state.recognitionNeeded?.filter(slot=>slot.pinned).length??0;
 const accountsForPinned=pinnedRecognition>0&&count(state.expected)&&state.cards.length+pinnedRecognition===state.expected;
 const recognizedNames=(state.currentRunNames??0)+(accountsForPinned?pinnedRecognition:0);
 const recognizedRead=(state.currentRunRead??0)+(accountsForPinned?pinnedRecognition:0);
 const recognizedCards=state.cards.length+(accountsForPinned?pinnedRecognition:0);
 if(!count(state.expected))issues.push('보관함 수량 미확인');
 if(!count(state.currentRunNames)||!count(state.currentRunRead))issues.push('이번 스캔 판독 수량 미확인');
 else if(count(state.expected)&&(recognizedNames!==state.expected||recognizedRead!==state.expected)){
  const missingNames=Math.max(0,state.expected-recognizedNames);
  const missingFields=Math.max(0,state.expected-recognizedRead);
  issues.push(missingNames?`${missingNames}종 부족`:missingFields?`${missingFields}종 각성·장수 확인 필요`:'이번 스캔 수량 불일치');
 }
 if(count(state.expected)&&recognizedCards!==state.expected)issues.push('전체 목록과 보관함 수량 불일치');
 if(new Set(state.cards.map(card=>card.id)).size!==state.cards.length)issues.push('중복 카드 식별');
 const facts=scanMonitorInputFacts(state);
 if((facts.unresolvedCount??0)>0)issues.push(`미식별 입력 ${facts.unresolvedCount}건`);
 else if(facts.unresolvedCount===undefined||facts.unresolvedCountUnavailable)issues.push('미식별 입력 상태 미확인');
 if(state.discardedObservations?.length)issues.push(`인식 필요 ${state.discardedObservations.length}건`);
 if(facts.unresolvedFieldChangesUnavailable||facts.unresolvedFieldChanges===undefined)issues.push('화면 관측 상태 미확인');
 else if(facts.unresolvedFieldChanges>0)issues.push('확인할 화면 관측 있음');
 if(unattributedFieldReviewCount(state)>0&&(facts.unresolvedFieldChanges??0)<=0)issues.push('확인할 화면 관측 있음');
 if(state.unknownEvidenceLost||state.drainInputLoss)issues.push('입력 근거 누락');
 if(state.recognitionNeeded?.length)issues.push(`인식 필요 ${state.recognitionNeeded.length}칸`);
 if(facts.droppedFrames===undefined)issues.push('입력 누락 상태 미확인');
 else if(facts.droppedFrames>0)issues.push(`처리하지 못한 화면 ${facts.droppedFrames}건`);
 if(!count(state.queued)||state.queued>0||state.activeReadings!==undefined&&(!count(state.activeReadings)||state.activeReadings>0))issues.push('판독 작업 미완료');
 if(state.cards.some(card=>!card.id||!card.name||!count(card.awakening)||card.awakening>5||!count(card.extraCopies)||
    card.extraCopies>15-card.awakening*(card.awakening+1)/2||card.countReliable===false||card.review.length>0))issues.push('카드 값 확인 필요');
 return issues;
}
