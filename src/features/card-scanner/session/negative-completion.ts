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

/** Negative evidence only. An empty result is not a completion receipt. Each reason is one sentence
 * for the person (the scan shows the first two); reasons that say the same are given once. */
export function negativeCompletionReasons(state:NegativeCompletionState):string[]{
 const issues:string[]=[];
 const count=(v:unknown):v is number=>Number.isSafeInteger(v)&&Number(v)>=0;
 if(state.interrupted||state.status==='스캔 중지')issues.push('스캔이 중간에 멈췄어요.');
 const pinnedRecognition=state.recognitionNeeded?.filter(slot=>slot.pinned).length??0;
 const accountsForPinned=pinnedRecognition>0&&count(state.expected)&&state.cards.length+pinnedRecognition===state.expected;
 const recognizedNames=(state.currentRunNames??0)+(accountsForPinned?pinnedRecognition:0);
 const recognizedRead=(state.currentRunRead??0)+(accountsForPinned?pinnedRecognition:0);
 const recognizedCards=state.cards.length+(accountsForPinned?pinnedRecognition:0);
 if(!count(state.expected))issues.push('보관함의 카드 수를 읽지 못했어요.');
 if(!count(state.currentRunNames)||!count(state.currentRunRead))issues.push('스캔을 끝까지 확인하지 못했어요.');
 else if(count(state.expected)&&(recognizedNames!==state.expected||recognizedRead!==state.expected)){
  const missingNames=Math.max(0,state.expected-recognizedNames);
  const missingFields=Math.max(0,state.expected-recognizedRead);
  issues.push(missingNames?`카드 ${missingNames}종을 아직 못 읽었어요.`:missingFields?`카드 ${missingFields}종의 각성·장수를 못 읽었어요.`:'읽은 카드 수가 보관함 수량과 달라요.');
 }
 if(count(state.expected)&&recognizedCards!==state.expected)issues.push('읽은 카드 수가 보관함 수량과 달라요.');
 if(new Set(state.cards.map(card=>card.id)).size!==state.cards.length)issues.push('같은 카드가 두 번 읽혔어요.');
 const facts=scanMonitorInputFacts(state);
 if((facts.unresolvedCount??0)>0)issues.push(`어느 카드인지 알아보지 못한 화면이 ${facts.unresolvedCount}개 있어요.`);
 else if(facts.unresolvedCount===undefined||facts.unresolvedCountUnavailable)issues.push('스캔을 끝까지 확인하지 못했어요.');
 if(state.discardedObservations?.length)issues.push(`읽지 못한 화면이 ${state.discardedObservations.length}개 있어요.`);
 if(facts.unresolvedFieldChangesUnavailable||facts.unresolvedFieldChanges===undefined)issues.push('스캔을 끝까지 확인하지 못했어요.');
 else if(facts.unresolvedFieldChanges>0)issues.push('스캔을 끝까지 확인하지 못했어요.');
 if(unattributedFieldReviewCount(state)>0&&(facts.unresolvedFieldChanges??0)<=0)issues.push('스캔을 끝까지 확인하지 못했어요.');
 if(state.unknownEvidenceLost||state.drainInputLoss)issues.push('스캔을 끝까지 확인하지 못했어요.');
 if(state.recognitionNeeded?.length)issues.push(`읽지 못한 칸이 ${state.recognitionNeeded.length}개 있어요.`);
 if(facts.droppedFrames===undefined)issues.push('스캔을 끝까지 확인하지 못했어요.');
 else if(facts.droppedFrames>0)issues.push(`놓친 화면이 ${facts.droppedFrames}개 있어요.`);
 if(!count(state.queued)||state.queued>0||state.activeReadings!==undefined&&(!count(state.activeReadings)||state.activeReadings>0))issues.push('스캔을 끝까지 확인하지 못했어요.');
 if(state.cards.some(card=>!card.id||!card.name||!count(card.awakening)||card.awakening>5||!count(card.extraCopies)||
    card.extraCopies>15-card.awakening*(card.awakening+1)/2||card.countReliable===false||card.review.length>0))issues.push('각성·장수가 맞지 않는 카드가 있어요.');
 return [...new Set(issues)];
}
