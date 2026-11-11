import type {ScanWorkPhase} from './read-progress';

/** A preview flush can follow either shared-screen or other scanner input.
 * It describes presentation only and must not mask an error or interruption. */
export function previewFinalizationStatus(input:{busy:boolean;sharing:boolean;engineReady:boolean;
  stopped:boolean;error:unknown;status:string|undefined;phase:ScanWorkPhase}) {
  if(!input.busy||input.sharing||!input.engineReady||input.stopped||input.error||
    input.phase!=='reading'||input.status!=='카드 이미지 정리 중')return null;
  return {title:'카드 이미지 정리 중',description:'인식한 카드의 이미지를 정리하고 있습니다.'};
}

/** Publish the next real stage together with its status after the preview
 * flush, so the old image-processing message cannot outlive that work. */
export function beginFinalCardVerification(state:{status:string;workPhase?:ScanWorkPhase}):void {
  state.status='판독 결과 검증 중';
  state.workPhase='verifying';
}
