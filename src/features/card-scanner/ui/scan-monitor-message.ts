import type {AutoCompletionGate} from '../session/auto-completion-diagnostics';

/** Presentation only: a ready viewport is not a verified complete scan or an
 * indication of which direction the user should scroll. */
export function scanMonitorMessage(input:{
  outcome:{kind:string;message:string};sharing:boolean;inputLoss:boolean;obstructed:boolean;
  located:boolean;viewportReady:boolean;gate?:AutoCompletionGate;
  expected:number|null|undefined;completed:number;queued?:number;reading?:number;
  unresolvedCount?:number;unresolvedCountUnavailable?:boolean;
  unresolvedFieldChanges?:number;unresolvedFieldChangesUnavailable?:boolean;
}):{message:string;ready:boolean} {
 const {outcome,sharing,inputLoss,obstructed,located,viewportReady,gate}=input;
 if(outcome.kind!=='active')return {message:outcome.message,ready:outcome.kind==='complete'};
 if(inputLoss)return {message:sharing?'화면 누락 · 공유 종료 후 다시 스캔해 주세요':'화면 누락 · 처음부터 다시 스캔해 주세요',ready:false};
 if(!sharing)return {message:'남은 카드를 읽고 있어요',ready:false};
 if(obstructed)return {message:'커서를 카드 밖으로 옮겨 주세요',ready:false};
 if(!located)return {message:'카드 성장 탭을 보여 주세요',ready:false};
 const idleCount=(value:unknown):value is number=>typeof value==='number'&&Number.isSafeInteger(value)&&value>=0;
 const readingPending=!idleCount(input.queued)||!idleCount(input.reading)||input.queued>0||input.reading>0;
 const allRead=input.expected!=null&&input.expected>0&&input.completed>=input.expected;
 // A diagnostic may not yet have been published (or may lag a lightweight
 // state update). Preserve independently observed unresolved evidence. During
 // collection, an unresolved item does not imply that all other sections were
 // shown, so do not block the ordinary scroll prompt on its count alone.
 if(allRead){
  if((input.unresolvedCount??0)>0)return {message:'확인할 화면 입력이 남아 있어요',ready:false};
  if((input.unresolvedFieldChanges??0)>0&&gate!=='fields'&&gate!=='occluded')return {message:'최신 카드 상태 확인이 필요해요',ready:false};
 }
 switch(gate){
  case 'names':return {message:readingPending?'카드 이름을 확인하고 있어요':'카드 이름을 다시 확인해 주세요',ready:false};
  case 'fields':return {message:readingPending?'각성과 장수를 확인하고 있어요':'각성과 장수 확인이 필요해요',ready:false};
  case 'latest-observations':return {message:readingPending?'미확인 화면의 판독 상태를 확인하고 있어요':'확인할 카드를 다시 보여 주세요',ready:false};
  case 'occluded':return {message:readingPending?'판독 상태 확인 중 · 커서를 카드 밖으로 옮겨 주세요':'가림을 없애고 다시 보여 주세요',ready:false};
  case 'input':return {message:'수집한 화면을 정리하고 있어요',ready:false};
  case 'metadata':return {message:'보관함 정보를 확인하고 있어요',ready:false};
  case 'header-unavailable':return {message:'보관함 수량을 보여 주세요',ready:false};
  case 'hold':case 'header-reading':return {message:'보관함 수량을 확인하고 있어요',ready:false};
  case 'header-mismatch':return {message:'보관함 수량·용량이 달라요 · 계속 다르면 다시 스캔해 주세요',ready:false};
  case 'header-error':return {message:'보관함 수량을 다시 확인하고 있어요',ready:false};
  case 'completion-error':return {message:'스캔 완료를 다시 확인하고 있어요',ready:false};
  case 'input-dropped':return {message:'화면 누락 · 공유 종료 후 다시 스캔해 주세요',ready:false};
  case 'input-ended':return {message:'화면 공유가 종료됐어요',ready:false};
  case 'complete':return {message:'스캔 완료를 확인하고 있어요',ready:false};
 }
 // Missing diagnostic data is not a verified zero. A concrete gate can still
 // describe an independently known pending check without claiming no other
 // check exists, and is more actionable than the unavailable projection.
 if(allRead&&input.unresolvedCountUnavailable)return {message:'미식별 입력 상태를 확인해 주세요',ready:false};
 if(allRead&&input.unresolvedFieldChangesUnavailable)return {message:'최신 카드 상태를 확인해 주세요',ready:false};
 // The same number of identities and slots can still need latest field proof.
 // Do not ask for another scroll merely because the visible 40 slots are ready.
 if(allRead)
  return {message:'카드 정보를 확인하고 있어요',ready:false};
 return viewportReady?{message:'다른 구간을 보여 주세요',ready:true}:{message:'잠깐 멈춰 주세요',ready:false};
}
