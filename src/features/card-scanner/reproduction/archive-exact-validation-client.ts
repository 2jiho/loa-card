import type {ReproductionFile} from './scan-reproduction';

/** Abort terminates the worker; failure is never evidence of completeness. */
export function validateArchiveExactInWorker(file:ReproductionFile,signal:AbortSignal):Promise<boolean> {
  signal.throwIfAborted();
  const worker=new Worker(new URL('./archive-exact-validation-worker.ts',import.meta.url),{type:'module'});
  return new Promise((resolve,reject)=>{
    let done=false;
    const finish=(error?:unknown,valid?:boolean)=>{
      if(done)return;done=true;signal.removeEventListener('abort',abort);worker.terminate();
      if(error!==undefined)reject(error);else resolve(valid===true);
    };
    const abort=()=>finish(signal.reason??new DOMException('Stopped','AbortError'));
    worker.onmessage=(event:MessageEvent<unknown>)=>{
      const value=event.data;
      if(!value||typeof value!=='object'||Array.isArray(value)||(value as {ok?:unknown}).ok!==true||
        typeof (value as {valid?:unknown}).valid!=='boolean')finish(Error('입력 기록 검증 실패'));
      else finish(undefined,(value as {valid:boolean}).valid);
    };
    worker.onerror=()=>finish(Error('입력 기록 검증 Worker 오류'));
    worker.onmessageerror=()=>finish(Error('입력 기록 검증 Worker 응답 오류'));
    signal.addEventListener('abort',abort,{once:true});
    if(signal.aborted){abort();return;}
    try{worker.postMessage(file);}catch(error){finish(error);}
  });
}
