import type {ScrollCardLocation} from '../session/scroll-card-location';
import type {PortraitDiagnostics} from '../recognition/portrait-diagnostics';
import type {ScannedCard} from '../recognition/recognizer-types';
import type {PendingCardFields} from '../session/current-scan-fields';

export type AttentionScanMode='processing'|'sharing'|'restart';

/** Unknown queue counts are not proof that all reader work has finished. */
export function attentionScanMode(input:{sharing:boolean;busy:boolean;queued?:number;activeReadings?:number}):AttentionScanMode {
  const count=(value:unknown):value is number=>typeof value==='number'&&Number.isSafeInteger(value)&&value>=0;
  if(input.busy&&(!input.sharing||!count(input.queued)||!count(input.activeReadings)||input.queued>0||input.activeReadings>0))return 'processing';
  return input.sharing?'sharing':'restart';
}

export function attentionCardAdvice(mode:AttentionScanMode):string {
  if(mode==='processing')return '스캔 처리가 진행 중이에요. 처리가 끝난 뒤에도 남으면 다시 확인해 주세요.';
  if(mode==='sharing')return '커서와 툴팁을 카드 밖으로 옮기고 해당 카드를 다시 보여 주세요.';
  return '화면 공유를 다시 시작하고 커서와 툴팁을 카드 밖으로 옮긴 뒤 해당 카드를 보여 주세요.';
}

/** Explain only a current unresolved observation, never a preserved older
 * card's diagnostic or an unspecified reason for a failed counter. */
export function attentionCountAdvice(card:ScannedCard,pending:PendingCardFields|undefined):string|null {
  if(!pending||pending.id!==card.id||!Number.isSafeInteger(pending.captureOrder)||
      !Number.isSafeInteger(card.captureOrder)||pending.captureOrder!<card.captureOrder!)return null;
  const diagnostic=pending.countDiagnostics;
  if(diagnostic?.reliability!=='unconfirmed'||diagnostic.pattern?.value!==null||
      diagnostic.pattern.reason!=='장수 숫자 미검출 또는 불명확')return null;
  return '장수 숫자를 확인하지 못했어요. 카드의 장수 표시를 확인해 주세요.';
}

/** Optional diagnostics explain an existing unresolved observation only.
 * They do not identify a card, establish image quality or change completion. */
export function unidentifiedReferenceAdvice(diagnostics:PortraitDiagnostics|null|undefined):string|null {
  return diagnostics?.some(call=>call.diagnostic.outcome==='rejected'&&
    call.diagnostic.reason==='missing-competitor-reference')
    ?'유사 카드 비교 자료 부족' : null;
}

/** Pending observations are still being read; only finished unidentified
 * inputs require this advice. A location is always an estimate, not identity. */
export function unidentifiedAttention<T extends {pending:boolean;location?:ScrollCardLocation}>(entries:readonly T[],mode:AttentionScanMode='sharing',sharing=false) {
  const unresolved=entries.filter(entry=>!entry.pending);
  const withLocation=unresolved.filter(entry=>!!entry.location).length;
  if(!unresolved.length)return {unresolved,advice:undefined,hasLocation:false};
  if(mode==='processing'&&!sharing)return {unresolved,advice:'스캔 처리가 진행 중이에요. 처리가 끝난 뒤에도 남은 항목을 확인해 주세요.',hasLocation:withLocation>0};
  const area=withLocation===unresolved.length?'표시된 추정 위치 부근을':withLocation?'표시된 추정 위치 부근을 보여 주고, 위치가 없는 입력은 목록 전체를':'카드 목록 전체를';
  if(mode==='processing')return {unresolved,advice:`판독 중에도 ${area} 다시 보여 주세요. 툴팁과 커서는 치워 주세요.`,hasLocation:withLocation>0};
  const live=mode==='sharing'||sharing;
  const prefix=live?'툴팁과 커서를 치우고':'화면 공유를 다시 시작하고 툴팁과 커서를 치운 뒤';
  const retry=live?' 계속 남으면 화면 공유를 종료한 뒤 새 스캔을 시작해 주세요.':'';
  return {unresolved,advice:`${prefix} ${area} 천천히 다시 보여 주세요.${retry}`,hasLocation:withLocation>0};
}

/** Preserve a failed field observation even when no matching card has been
 * published. A repeated ID is shown once; the caller does not infer names or
 * positions for the unmatched entries. */
export function unmatchedPendingFields<T extends {id:string}>(entries:readonly T[],shown:readonly {id:string}[]):T[] {
  const seen=new Set(shown.map(entry=>entry.id));
  return entries.filter(entry=>{if(seen.has(entry.id))return false;seen.add(entry.id);return true;});
}
import type {ObservationSource} from '../session/observation-execution';


/** Same-group unresolved observations are distinct in source-scoped scans.
 * Keep keys tied to the actual source; never invent a card ID or position. */
export function unidentifiedDisplayKey(entry:{group?:number;source?:ObservationSource},index:number):string {
  const source=entry.source;
  if(entry.group!==undefined&&source)return JSON.stringify(['source',entry.group,source.sessionId,source.frameId,
    source.observationId,source.captureOrder,source.captureTime,source.phase,source.slot]);
  return JSON.stringify(entry.group===undefined?['legacy',index]:['group',entry.group]);
}
