import type {ScanGridSnapshot} from './scan-grid';
import {boundedUnresolvedFieldChanges} from './current-scan-fields';

export interface ScanMonitorOutcomeSource {
 currentRunRead?:number;
 expected?:number|null;
 interrupted?:string;
 queued?:number;
 activeReadings?:number;
 unresolvedCount?:number;
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
 const unresolvedCount=Array.isArray(state.unidentified)?state.unidentified.length:count(state.unresolvedCount)?state.unresolvedCount:undefined;
 const hasInput=typeof state.hasInput==='boolean'?state.hasInput:count(state.sampled)?state.sampled>0:
  (count(state.currentRunRead)&&state.currentRunRead>0)||(unresolvedCount??0)>0||!!state.grid?.recentFrame||!!state.grid?.recent?.captured;
 const changes=boundedUnresolvedFieldChanges(state);
 return {hasInput,...(unresolvedCount===undefined?{}:{unresolvedCount}),...changes,
  ...(state.unresolvedFieldChangesUnavailable?{unresolvedFieldChangesUnavailable:true as const}:{})};
}

/** Display outcome, not a scanner verification/auto-stop gate. Matching counts
 * may label card reading complete only when unresolved input is known to be 0. */
export function scanMonitorOutcome(state:ScanMonitorOutcomeSource|null,{busy,sharing}:{busy:boolean;sharing:boolean}) {
 const facts=state?scanMonitorInputFacts(state):{hasInput:false,unresolvedCount:undefined,unresolvedFieldChanges:undefined,unresolvedFieldChangesUnavailable:undefined};
 const expected=count(state?.expected)?state.expected:null,read=count(state?.currentRunRead)?state.currentRunRead:0;
 const missingCount=expected===null?null:Math.max(0,expected-read),unresolvedCount=facts.unresolvedCount??0;
 const pending=(count(state?.queued)?state.queued:0)+(count(state?.activeReadings)?state.activeReadings:0);
 const changes=facts.unresolvedFieldChanges??0,changesUnavailable=facts.unresolvedFieldChangesUnavailable===true;
 const base={hasInput:facts.hasInput,unresolvedCount,missingCount,...(facts.unresolvedFieldChanges===undefined?{}:{unresolvedFieldChanges:changes}),
  ...(changesUnavailable?{unresolvedFieldChangesUnavailable:true as const}:{})};
 if(busy||sharing)return {...base,kind:'active' as const,showGrid:true,header:sharing?'공유 중':'처리 중',
  message:sharing?'화면 공유 중':'남은 카드를 읽고 있어요',detail:''};
 const problems=[missingCount?`${missingCount}종 부족`:'',unresolvedCount?`확인할 입력 ${unresolvedCount}건`:'',
  changesUnavailable?'최신 필드 상태 확인 필요':changes?`최신 필드 확인 ${changes}건`:'',pending?`미완료 작업 ${pending}건`:''].filter(Boolean).join(' · ');
 if(state?.interrupted)return {...base,kind:'interrupted' as const,showGrid:true,header:'중단',message:'스캔이 중단됐어요',
  detail:problems?`${problems} · 해당 구간을 다시 보여 주세요.`:'카드 성장 탭을 다시 공유해 주세요.'};
 if(!facts.hasInput&&!changes&&!changesUnavailable)return {...base,kind:'idle' as const,showGrid:false,header:'대기',message:'화면 공유를 시작해 주세요',detail:''};
 if(expected!==null&&count(state?.currentRunRead)&&read===expected&&facts.unresolvedCount===0&&pending===0&&!changes&&!changesUnavailable)
  return {...base,kind:'complete' as const,showGrid:true,header:'판독 완료',message:'카드 판독 완료',detail:''};
 return {...base,kind:'review' as const,showGrid:true,header:'확인 필요',
  message:expected===null||read>expected?'보관함 수량을 다시 보여 주세요':'확인할 구간을 다시 보여 주세요',
  detail:problems||((expected!==null&&read>expected)?'판독 수량이 보관함 수량과 달라요.':
   expected===null?'카드 성장 탭의 보관함 수량을 확인해 주세요.':'카드 판독 상태를 확인해 주세요.')};
}
