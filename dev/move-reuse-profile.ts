/** Strict isolated opt-in: a report with missing settings is not a profile. */
export function parseMoveReuseProfile(search:string):boolean {
 const p=new URLSearchParams(search),v=p.getAll('moveReuseProfile');
 if(v.length>1||v.some(x=>x!=='0'&&x!=='1'))throw Error('moveReuseProfile must be 0 or 1');
 if(v[0]==='1'&&[...p.keys()].some(k=>k!=='moveReuseProfile'))throw Error('moveReuseProfile must be isolated');
 return v[0]==='1';
}
export function validateMoveReuseProfileInput(input:{enabled:boolean;images:boolean;replay:boolean;mode:string;captureOnly:boolean;cropRecording:boolean;recording:boolean;batch:boolean;caseId:string|null;mediaTypes:readonly string[]}){
 if(input.enabled&&(input.images||input.replay||input.mode!=='live'||input.captureOnly||input.cropRecording||input.recording||input.batch||!input.caseId||input.mediaTypes.length!==1||!input.mediaTypes[0].startsWith('video/')))
  throw Error('행 이동 계측은 등록된 영상 1개를 1배속 판독하고 기록을 끈 상태에서만 지원합니다.');
}
