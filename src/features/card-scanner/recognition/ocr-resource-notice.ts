import {OcrResourceUnavailable} from './ocr-worker-leases';

/** A missing notice means an unrelated error, not a successful read. */
export function ocrResourceNotice(error:unknown):string|null {
 if(!(error instanceof OcrResourceUnavailable))return null;
 return error.reason==='capacity'
  ?'이전 OCR 작업이 종료되기를 기다리고 있습니다. 저장된 부분 결과를 확인하고 정리 후 다시 스캔해 주세요.'
  :'OCR 작업 종료를 확인하지 못했습니다. 저장된 부분 결과를 확인하고 다시 스캔해 주세요.';
}

/** Report before teardown; an unavailable publisher cannot replace the failure. */
export function emitOcrResourceNotice(error:unknown,state:{captureWarning?:string},emit:()=>void):boolean {
 const notice=ocrResourceNotice(error);if(!notice)return false;
 state.captureWarning=notice;
 try{emit();}catch{/* UI diagnostics do not alter scanner error handling. */}
 return true;
}
