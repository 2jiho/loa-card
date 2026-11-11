/** Recording availability is an output, never the identity of the live input. */
export type ScannerRecordingMode='diagnostic'|'detailed';

/** Basic diagnostics must never silently allocate an encoded source recording.
 * Detailed recording is explicit; DEV failure injection is independent. */
export function shouldRecordContinuous(mode:ScannerRecordingMode|undefined,override:'disabled'|'fail-start'|undefined,development:boolean):boolean {
  if(mode!==undefined&&mode!=='diagnostic'&&mode!=='detailed')throw TypeError('Invalid scanner recording mode');
  if(development&&override!==undefined){
    if(override!=='disabled'&&override!=='fail-start')throw TypeError('Invalid recording override');
    return override==='fail-start';
  }
  return mode==='detailed';
}

export function startOptionalRecording<T>(enabled:boolean,start:()=>T):
  {status:'active';recording:T}|{status:'disabled'|'failed';warning:string} {
  if(!enabled)return {status:'disabled',warning:'연속 기록 꺼짐 · 저장 영상으로 보완 판독할 수 없습니다.'};
  try{return {status:'active',recording:start()};}
  catch(error){return {status:'failed',warning:`연속 기록 시작 실패 · 저장 영상 보완 불가: ${String(error).slice(0,500)}`};}
}
