/** The reduced raster path is a local transport experiment, never recording
 * completeness or an assertion that rejected crops contain no useful pixels. */
export function parseRejectedTransport(search:string):boolean {
 const params=new URLSearchParams(search),values=params.getAll('rejectedTransport');
 if(values.length>1||values.some(value=>value!=='0'&&value!=='1'))throw Error('rejectedTransport는 0 또는 1만 지원합니다.');
 if(values[0]==='1'&&[...params.keys()].some(key=>key!=='rejectedTransport'))throw Error('전송 생략 실험은 단독으로 실행하세요.');
 return values[0]==='1';
}
export function validateRejectedTransportInput(input:{enabled:boolean;images:boolean;replay:boolean;mode:string;captureOnly:boolean;
 cropRecording:boolean;recording:boolean;batch:boolean;caseId:string|null;mediaTypes:readonly string[];recordingMode?:string}):void {
 if(input.enabled&&(input.images||input.replay||input.mode!=='live'||input.captureOnly||input.cropRecording||input.recording||input.batch||
  input.recordingMode==='detailed'||!input.caseId||input.mediaTypes.length!==1||!input.mediaTypes[0].startsWith('video/')))
  throw Error('전송 생략 실험은 등록된 단일 영상 1배속 판독·상세 기록 끔으로 검사하세요.');
}

/** Both variants run the acquisition worker over the same stored scanner input.
 * Replay uses screen semantics regardless of the original capture source. */
export function parseRejectedReplay(search:string):'baseline'|'reduced'|undefined {
 const params=new URLSearchParams(search),values=params.getAll('rejectedReplay');
 if(values.length===0)return undefined;
 if(values.length!==1||(values[0]!=='baseline'&&values[0]!=='reduced')||[...params.keys()].some(key=>key!=='rejectedReplay'))
  throw Error('저장 입력 전송 비교는 rejectedReplay=baseline 또는 reduced 단독으로 실행하세요.');
 return values[0] as 'baseline'|'reduced';
}
export function validateRejectedReplayInput(input:{variant:'baseline'|'reduced'|undefined;exact:boolean;source:string|undefined;seedCount:number;
 mode:string;captureOnly:boolean;cropRecording:boolean;recording:boolean;batch:boolean;caseId:string|null;recordingMode?:string}):void {
 if(input.variant&&(!input.exact||input.source!=='screen'||input.seedCount!==0||input.mode!=='offline'||input.captureOnly||
  input.cropRecording||input.recording||input.batch||!input.caseId||input.recordingMode==='detailed'))
  throw Error('저장 입력 전송 비교는 빈 초기 목록의 픽셀 기록과 화면 재현 경로·판독 모드·상세 기록 끔에서만 실행하세요.');
}

export function rejectedReplayEvidence(variant:'baseline'|'reduced') {
 return {variant,source:'stored-scanner-input',originalCaptureSource:'unknown',replaySemantics:'screen',acquisition:'worker',
  inputPhase:variant==='reduced'?'omit-repeated-rejected-raster':'full-raster',recoveryPhase:'full-raster',
  workerInputPixelAttestation:'not-verified',seedPolicy:'empty-required'} as const;
}
