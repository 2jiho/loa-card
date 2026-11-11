import type {CropEvent} from './recognition-crop-journal';
import type {RecognitionInputMeta} from '../src/features/card-scanner/recognition/recognition-input-observer';
import {currentCountReliability} from '../src/features/card-scanner/recognition/count-confidence';
import type {CountDiagnostics} from '../src/features/card-scanner/recognition/recognizer';

export type SavedOutcome=Extract<CropEvent,{kind:'finish'}>['outcome'];
/** Identity evidence is a diagnostic comparison, not a replay equivalence. */
export function cropRereadPlan(meta:RecognitionInputMeta,outcome:SavedOutcome){
  if(!outcome.admitted)return {kind:'unsupported' as const,reason:'원래 판독이 승인되지 않았습니다.'};
  if(meta.stage==='visual')return {kind:'visual' as const,reason:'원래 visual worker 또는 유지된 이름 경로는 기록되지 않았습니다.'};
  if(!outcome.identifyExecuted)return {kind:'unsupported' as const,reason:'원래 이름 판독이 실행되지 않았거나 유지된 이름을 사용했습니다.'};
  return {kind:'identity' as const,reason:'원래 예산·캐시·동시 실행 상태는 기록되지 않았습니다.'};
}
export function diagnosticIdentityComparison(outcome:SavedOutcome,identity:{id:string;name:string}|null){
  return {original:outcome.identified,current:identity,
    same:!outcome.identified&&!identity?null:outcome.identified?.id===identity?.id&&outcome.identified?.name===identity?.name,
    comparison:'진단용 값 비교 · 동일 입력과 원래 경로 재현의 증거 아님'};
}

/** Candidate fields from this single crop, using the same single-observation
 * count policy as the scanner. Original field values are absent from the
 * journal; neither this projection nor a reliable count is ground truth. */
export function diagnosticFieldCandidates(meta:Pick<RecognitionInputMeta,'stable'|'borderAlignment'>,
  maxAwakening:number|undefined,values:{awakening:number|null;extraCopies:number|null;countDiagnostics?:CountDiagnostics}){
  const awakening=Number.isInteger(values.awakening)&&values.awakening!>=0&&values.awakening!<=5?values.awakening:null;
  const max=awakening===null?15:15-awakening*(awakening+1)/2;
  const extraCopies=Number.isInteger(values.extraCopies)&&values.extraCopies!>=0&&values.extraCopies!<=max?values.extraCopies:null;
  const diagnostic=values.countDiagnostics;
  const reliability=currentCountReliability({stable:meta.stable,borderAlignment:meta.borderAlignment,awakening,maxAwakening,
    extraCopies,pattern:diagnostic?.pattern,iconPresent:diagnostic?.iconPresent,
    patternOcrAgreed:diagnostic?.patternOcrAgreed,ocrConfirmedValue:diagnostic?.ocrConfirmedValue});
  return {awakening,extraCopies:extraCopies===0&&reliability==='unconfirmed'?null:extraCopies,
    countReliability:reliability,countReason:diagnostic?.reason??null,
    scope:'단일 크롭의 현재 판독 후보 · 원래 각성·장수와 비교하거나 보유 값을 확정하지 않음'};
}

/** A timeout stops waiting but does not release the underlying read. A caller
 * must join before it destroys the reader or reuses its canvas. */
export function createDiagnosticReadOwner(){
  let pending:Promise<unknown>|undefined;
  return {
    run<T>(operation:()=>Promise<T>|T):Promise<T>{
      if(pending)throw Error('이전 판독이 아직 종료되지 않았습니다.');
      const owned=Promise.resolve().then(operation);pending=owned;
      void owned.then(()=>{if(pending===owned)pending=undefined;},()=>{if(pending===owned)pending=undefined;});
      return owned;
    },
    join():Promise<void>{const outstanding=pending;return outstanding?outstanding.then(()=>{},()=>{}):Promise.resolve();},
  };
}

/** The factory owns initialization until its promise settles. A rejected
 * factory is safe to release only when it explicitly reported no cleanup
 * failure; a late successful reader must be disposed first. */
export function settleLateDiagnosticPreparation<T>(preparing:Promise<T>,dispose:(reader:T)=>Promise<void>,cleanupUncertain:()=>boolean):Promise<void>{
  return preparing.then(async reader=>{await dispose(reader);if(cleanupUncertain())throw Error('판독기 초기화 정리 확인 실패');},error=>{
    if(cleanupUncertain())throw error;
  });
}

/** Call only after the journal and all retained pixel hashes have been verified.
 * Missing finish events and unsupported original paths cannot be reread by the
 * single-card tool. A bounded list keeps large diagnostic records usable. */
export function cropRereadChoices(
  crops:readonly {readId:number;meta:RecognitionInputMeta}[], events:readonly CropEvent[], limit=1000,
){
  if(!Number.isSafeInteger(limit)||limit<1||limit>5000)throw Error('Invalid crop choice limit');
  const finishes=new Map<number,SavedOutcome>();
  for(const event of events)if(event.kind==='finish')finishes.set(event.readId,event.outcome);
  const choices=crops.flatMap(({readId,meta})=>{
    const outcome=finishes.get(readId);
    if(!outcome||cropRereadPlan(meta,outcome).kind==='unsupported')return [];
    return [{readId,slot:meta.slot,stage:meta.stage,captureTime:meta.source.captureTime,phase:meta.source.phase,
      name:outcome.identified?.name??null,needsReview:!outcome.acceptedIdentity||outcome.timedOut||!!outcome.error}];
  });
  // Prioritize unresolved original attempts while preserving their source order.
  const sorted=[...choices.filter(choice=>choice.needsReview),...choices.filter(choice=>!choice.needsReview)];
  return {choices:sorted.slice(0,limit),total:choices.length,omitted:Math.max(0,choices.length-limit)};
}
