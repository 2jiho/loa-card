/** The report records a request; it does not assert the gate saw a pixel. */
export function parseLatestPixelGate(search:string):boolean {
 return parseScannerExperiment(search,'latestPixelGate');
}
export function parseScannerExperiment(search:string,name:'latestPixelGate'|'completionDrain'|'fastOcrAssist'|'obstructionFence'|'advisoryFence'|'frameObstructionProbe'|'frameObstructionHash'|'countSourceProbe'|'hiddenUnknownProbe'|'restoredHandoff'|'preparedCropProof'):boolean {
 const values=new URLSearchParams(search).getAll(name);
 if(values.length>1||values.some(value=>value!=='0'&&value!=='1'))
  throw Error(`${name} 실험은 0 또는 1만 지원합니다.`);
 return values[0]==='1';
}
/** The advisory fence changes a completion gate; never silently combine it
 * with an unrelated experiment, recording or pixel input override. */
export function parseAdvisoryFence(search:string):boolean {
 const enabled=parseScannerExperiment(search,'advisoryFence');
 if(enabled&&[...new URLSearchParams(search).keys()].some(key=>key!=='advisoryFence'))
  throw Error('가림 후보 종료 보류 실험은 advisoryFence=1만 단독으로 사용하세요.');
 return enabled;
}
export function validateAdvisoryFenceInput(input:{enabled:boolean;images:boolean;replay:boolean;mode:string;captureOnly:boolean;
 cropRecording:boolean;recording:boolean;batch:boolean;caseId:string|null;mediaTypes:readonly string[]}):void {
 if(input.enabled&&(input.images||input.replay||input.mode!=='live'||input.captureOnly||input.cropRecording||input.recording||input.batch||
  !input.caseId||input.mediaTypes.length!==1||!input.mediaTypes[0].startsWith('video/')))
  throw Error('가림 후보 종료 보류 실험은 등록된 단일 영상 1배속 판독·기록 끔으로 검사하세요.');
}
/** Requested is separate from successful restored transfers in run metrics. */
export function parseRestoredHandoff(search:string,prepared:boolean):boolean {
 const requested=parseScannerExperiment(search,'restoredHandoff');
 if(requested&&!prepared)throw Error('복원 픽셀 이전 실험에는 prepared=1이 필요합니다.');
 return requested;
}
/** Prepared crop checks are an opt-in development diagnostic. */
export function parsePreparedCropProofRequest(search:string,prepared:boolean):boolean {
 const requested=parseScannerExperiment(search,'preparedCropProof');
 if(requested&&!prepared)throw Error('크롭 픽셀 비교 실험에는 prepared=1이 필요합니다.');
 return requested;
}
/** Existing reports without this explicit field remain unknown. */
export function readLatestPixelGateRequested(report:unknown):boolean|null {
 if(!report||typeof report!=='object')return null;
 const validation=(report as {validation?:unknown}).validation;
 if(!validation||typeof validation!=='object')return null;
 const value=(validation as {latestPixelGateRequested?:unknown}).latestPixelGateRequested;
 return typeof value==='boolean'?value:null;
}
