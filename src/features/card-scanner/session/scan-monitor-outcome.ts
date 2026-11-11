import type {ScanGridSnapshot} from './scan-grid';
import {boundedUnresolvedFieldChanges} from './current-scan-fields';

export interface ScanMonitorOutcomeSource {
 currentRunRead?:number;
 currentRunNames?:number;
 review?:number;
 expected?:number|null;
 interrupted?:string;
 queued?:number;
 activeReadings?:number;
 unresolvedCount?:number;
 unresolvedCountUnavailable?:true;
 unresolvedObservations?:number;
 droppedFrames?:number;
 headerConflict?:boolean;
 unresolvedFieldChanges?:number;
 unresolvedFieldChangesUnavailable?:true;
 hasInput?:boolean;
 /** Raw ScannerState adapters may supply these; no array/pixels are retained. */
 sampled?:number;
 unidentified?:readonly unknown[];
 grid?:Pick<ScanGridSnapshot,'recent'|'recentFrame'>;
}
const count=(value:unknown):value is number=>typeof value==='number'&&Number.isSafeInteger(value)&&value>=0;

/** Count the exact cells shown below the summary, not historical accepted crops.
 * Unknown/rejected/empty cells are never evidence of queued reader work. */
export function scanMonitorRecentCounts(grid:Pick<ScanGridSnapshot,'recentFrame'>|undefined) {
 const cells=grid?.recentFrame?.cells;
 if(!cells?.length)return null;
 const counts={captured:cells.length,unknown:0,waiting:0,reading:0,read:0,review:0,empty:0};
 for(const cell of cells)counts[cell.status]++;
 return counts;
}

/** Project facts only. Raw arrays take precedence over a stale projected count. */
export function scanMonitorInputFacts(state:ScanMonitorOutcomeSource) {
 const raw=Array.isArray(state.unidentified)?state.unidentified.length:undefined;
 const hasBound=Object.hasOwn(state,'unresolvedObservations'),validBound=count(state.unresolvedObservations);
 // A visible image list is only a lower bound: a ledger group can remain
 // unresolved without an image. Never let a stale zero erase that bound.
 const unavailable=state.unresolvedCountUnavailable===true||hasBound&&!validBound||raw===0&&!validBound;
 const projected=count(state.unresolvedCount)?state.unresolvedCount:undefined;
 const unresolvedCount=validBound?Math.max(state.unresolvedObservations!,raw??0):raw!==undefined?(raw||undefined):projected;
 const hasInput=typeof state.hasInput==='boolean'?state.hasInput:count(state.sampled)?state.sampled>0:
  (count(state.currentRunRead)&&state.currentRunRead>0)||(unresolvedCount??0)>0||!!state.grid?.recentFrame||!!state.grid?.recent?.captured;
 const changes=boundedUnresolvedFieldChanges(state);
 return {hasInput,...(state.headerConflict===true?{headerConflict:true as const}:{}),...(unresolvedCount===undefined?{}:{unresolvedCount}),...changes,
  ...(unavailable?{unresolvedCountUnavailable:true as const}:{}),...(count(state.droppedFrames)?{droppedFrames:state.droppedFrames}:{}),
  ...(state.unresolvedFieldChangesUnavailable?{unresolvedFieldChangesUnavailable:true as const}:{})};
}

/** Used for status styling only; missing evidence is never presented as a
 * completed scan after inputs have been sampled. */
export function scanHasInputWarnings(state:ScanMonitorOutcomeSource|null|undefined):boolean {
 if(!state)return false;
 const facts=scanMonitorInputFacts(state);
 return facts.headerConflict===true||(facts.unresolvedCount??0)>0||(facts.droppedFrames??0)>0||
  (facts.hasInput&&(facts.unresolvedCount===undefined||facts.unresolvedCountUnavailable===true||facts.droppedFrames===undefined));
}

/** Display outcome, not a scanner verification/auto-stop gate. Matching counts
 * may label card reading complete only when unresolved input is known to be 0. */
export function scanMonitorOutcome(state:ScanMonitorOutcomeSource|null,{busy,sharing}:{busy:boolean;sharing:boolean}) {
 const facts=state?scanMonitorInputFacts(state):{hasInput:false,unresolvedCount:undefined,unresolvedCountUnavailable:undefined,droppedFrames:undefined,unresolvedFieldChanges:undefined,unresolvedFieldChangesUnavailable:undefined};
 const expected=count(state?.expected)?state.expected:null,read=count(state?.currentRunRead)?state.currentRunRead:0;
 const collected=count(state?.currentRunNames)?state.currentRunNames:read;
 const reviewCount=count(state?.review)?state.review:0;
 const missingCount=expected===null?null:Math.max(0,expected-collected),unresolvedCount=facts.unresolvedCount??0;
 const pending=(count(state?.queued)?state.queued:0)+(count(state?.activeReadings)?state.activeReadings:0);
 const changes=facts.unresolvedFieldChanges??0,changesUnavailable=facts.unresolvedFieldChangesUnavailable===true;
 const inputUnknown=facts.unresolvedCountUnavailable===true||facts.unresolvedCount===undefined;
 const dropped=facts.droppedFrames,droppedUnknown=dropped===undefined;
 const base={hasInput:facts.hasInput,unresolvedCount,missingCount,...(facts.unresolvedFieldChanges===undefined?{}:{unresolvedFieldChanges:changes}),
  ...(changesUnavailable?{unresolvedFieldChangesUnavailable:true as const}:{})};
 if(busy||sharing)return {...base,kind:'active' as const,showGrid:true,header:sharing?'공유 중':'처리 중',
  message:sharing?'화면 공유 중':'남은 카드를 읽고 있어요',detail:''};
 const problems=[state?.headerConflict?'보관함 수량·용량 확인 필요':'',missingCount?`${missingCount}종 이름 미확인`:'',reviewCount?`확인 필요 ${reviewCount}종`:'',unresolvedCount?`확인할 입력 ${unresolvedCount}건`:inputUnknown&&facts.hasInput?'미식별 입력 상태 확인 필요':'',
  dropped?`처리하지 못한 화면 최소 ${dropped}건`:droppedUnknown&&facts.hasInput?'화면 누락 상태 확인 필요':'',
  changesUnavailable?'화면 관측 상태 확인 필요':changes?'확인할 화면 관측 있음':'',pending?`미완료 작업 ${pending}건`:''].filter(Boolean).join(' · ');
 if(state?.interrupted)return {...base,kind:'interrupted' as const,showGrid:true,header:'중단',message:'스캔이 중단됐어요',
  detail:problems?`${problems} · 해당 구간을 다시 보여 주세요.`:'카드 성장 탭을 다시 공유해 주세요.'};
 if(!facts.hasInput&&!changes&&!changesUnavailable&&!unresolvedCount&&!dropped&&!state?.headerConflict)return {...base,kind:'idle' as const,showGrid:false,header:'대기',message:'화면 공유를 시작해 주세요',detail:''};
 if(expected!==null&&count(state?.currentRunRead)&&read===expected&&facts.unresolvedCount===0&&!inputUnknown&&dropped===0&&pending===0&&!changes&&!changesUnavailable&&!state?.headerConflict)
  return {...base,kind:'complete' as const,showGrid:true,header:'판독 완료',message:'카드 판독 완료',detail:''};
  const allNamesRead=expected!==null&&read===expected;
  if(allNamesRead&&!unresolvedCount&&!dropped&&!changes&&!changesUnavailable&&!pending&&!state?.headerConflict&&(inputUnknown||droppedUnknown))
   return {...base,kind:'review' as const,showGrid:true,header:'상태 확인 불가',message:'이전 스캔의 입력 상태를 확인할 수 없어요',detail:'필요하면 새 스캔으로 확인해 주세요.'};
  const unidentifiedOnly=allNamesRead&&unresolvedCount>0&&!changes&&!changesUnavailable&&!pending&&!dropped&&!droppedUnknown&&!state?.headerConflict;
  return {...base,kind:'review' as const,showGrid:true,header:unidentifiedOnly?'미식별 입력 확인':'확인 필요',
   message:dropped?'공유를 종료하고 처음부터 다시 스캔해 주세요':state?.headerConflict?'보관함 수량과 용량을 다시 보여 주세요':expected===null||read>expected?'보관함 수량을 다시 보여 주세요':unidentifiedOnly?'카드 수량은 확인됐지만 미식별 화면 입력이 남아 있어요':'확인할 구간을 다시 보여 주세요',
  detail:problems||((expected!==null&&read>expected)?'판독 수량이 보관함 수량과 달라요.':
   expected===null?'카드 성장 탭의 보관함 수량을 확인해 주세요.':'카드 판독 상태를 확인해 주세요.')};
}
