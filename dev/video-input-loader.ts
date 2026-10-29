/** A DEV input deadline, separate from scanner/model execution deadlines. */
export const VIDEO_INPUT_LOAD_TIMEOUT_MS=15_000;
const MAX_VIDEO_INPUT_LOAD_TIMEOUT_MS=30_000;
const owners=new WeakMap<HTMLVideoElement,object>();

export class VideoInputLoadTimeoutError extends Error{
  readonly timeoutMs:number;
  constructor(timeoutMs:number){
    super(`영상 입력이 ${timeoutMs}ms 안에 준비되지 않았습니다.`);
    this.name='VideoInputLoadTimeoutError';
    this.timeoutMs=timeoutMs;
  }
}

/** Wait for current media readiness, not frame identity or OCR completion.
 * One caller owns an element until this promise settles. Cancellation only
 * resets that caller's still-assigned request; it never clears a replacement. */
export async function loadVideoInput(video:HTMLVideoElement,url:string,signal:AbortSignal,
  {timeoutMs=VIDEO_INPUT_LOAD_TIMEOUT_MS}:{timeoutMs?:number}={}):Promise<void>{
  signal.throwIfAborted(); // In particular, do not touch the element on pre-abort.
  if(typeof timeoutMs!=='number'||!Number.isFinite(timeoutMs)||timeoutMs<=0||timeoutMs>MAX_VIDEO_INPUT_LOAD_TIMEOUT_MS){
    throw new RangeError(`영상 입력 제한 시간은 0ms 초과 ${MAX_VIDEO_INPUT_LOAD_TIMEOUT_MS}ms 이하여야 합니다.`);
  }
  if(typeof url!=='string'||url.length===0)throw new TypeError('영상 입력 주소가 필요합니다.');
  if(owners.has(video))throw new Error('이 영상 요소의 입력 준비가 이미 진행 중입니다.');
  const owner={};
  owners.set(video,owner);
  return new Promise<void>((resolve,reject)=>{
    let assignedSource='',closed=false,starting=true,abortRequested=false,requestStarted=false;
    let timer:ReturnType<typeof setTimeout>|undefined;
    const ownsElement=()=>owners.get(video)===owner;
    const ownsSource=()=>ownsElement()&&video.srcObject===null&&video.src===assignedSource;
    const stopOwnedRequest=()=>{
      if(!requestStarted)return;
      try{if(!ownsSource())return;}catch{return;}
      try{video.pause();}catch{/* Continue the owned request reset if pause fails. */}
      // pause/load can synchronously dispatch events whose observers replace src.
      try{if(!ownsSource())return;}catch{return;}
      try{video.removeAttribute('src');}catch{return;}
      try{
        if(ownsElement()&&video.srcObject===null&&video.getAttribute('src')===null)video.load();
      }catch{/* Cleanup cannot replace the original failure/cancellation. */}
    };
    const finish=(success:boolean,error?:unknown,stop=false)=>{
      if(closed||!ownsElement())return;
      closed=true;
      if(timer!==undefined)clearTimeout(timer);
      for(const event of ['loadeddata','canplay','loadedmetadata','error'])video.removeEventListener(event,ready);
      signal.removeEventListener('abort',aborted);
      if(stop)stopOwnedRequest();
      if(ownsElement())owners.delete(video);
      if(success)resolve();else reject(error);
    };
    const ready=()=>{
      if(starting||closed||!ownsElement())return;
      try{
        if(!ownsSource()){
          finish(false,new Error('준비 중인 영상 입력 주소가 교체되었습니다.'));
        }else if(video.error){
          finish(false,new Error('영상 입력을 불러오지 못했습니다.'));
        }else if(video.currentSrc===assignedSource&&video.readyState>=2){
          // An event alone is not provenance. Even same-URL late events only
          // establish readiness through current element state, not frame identity.
          finish(true);
        }
      }catch(error){finish(false,error,true);}
    };
    const aborted=()=>{
      if(starting){abortRequested=true;return;}
      finish(false,signal.reason,true);
    };
    try{
      assignedSource=new URL(url,video.ownerDocument.baseURI).href;
      if(video.srcObject!==null)throw new Error('다른 미디어 스트림을 사용하는 영상 요소입니다.');
      for(const event of ['loadeddata','canplay','loadedmetadata','error'])video.addEventListener(event,ready);
      signal.addEventListener('abort',aborted,{once:true});
      timer=setTimeout(()=>finish(false,new VideoInputLoadTimeoutError(timeoutMs),true),timeoutMs);
      if(signal.aborted){starting=false;aborted();return;}
      if(ownsSource()&&video.currentSrc===assignedSource&&video.readyState>=2&&!video.error){
        starting=false;finish(true);return;
      }
      // A readiness hint for the DEV element, not a network/codec failure fix.
      video.preload='auto';
      requestStarted=true;
      video.src=assignedSource;
      if(!signal.aborted)video.load();
      starting=false;
      if(abortRequested||signal.aborted)aborted();else ready();
    }catch(error){
      starting=false;
      finish(false,error,true);
    }
  });
}
