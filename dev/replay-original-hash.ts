import {MAX_REPLAY_ORIGINAL_BYTES} from './replay-original-hash-core';

type HashWorker=Pick<Worker,'postMessage'|'terminate'|'addEventListener'|'removeEventListener'>;
type Options={workerFactory?:()=>HashWorker;timeoutMs?:number;onProgress?:(bytes:number,total:number)=>void};
const createWorker=()=>new Worker(new URL('./replay-original-hash-worker.ts',import.meta.url),{type:'module'});

/** A worker failure, cancellation or malformed reply never grants verification. */
export function hashReplayOriginal(blob:Blob,signal:AbortSignal,options:Options={}):Promise<string>{
 signal.throwIfAborted();
 if(!(blob instanceof Blob)||!Number.isSafeInteger(blob.size)||blob.size<=0||blob.size>MAX_REPLAY_ORIGINAL_BYTES)
  return Promise.reject(Error('Invalid replay byte length'));
 const timeout=options.timeoutMs??180_000;
 if(!Number.isFinite(timeout)||timeout<=0||timeout>600_000)return Promise.reject(Error('Invalid replay hash timeout'));
 let worker:HashWorker;
 try{worker=(options.workerFactory??createWorker)();}catch(error){return Promise.reject(error);}
 return new Promise((resolve,reject)=>{
  let done=false,lastProgress=0;
  const cleanup=()=>{try{clearTimeout(timer);signal.removeEventListener('abort',onAbort);
   worker.removeEventListener('message',onMessage);worker.removeEventListener('error',onError);worker.removeEventListener('messageerror',onError);
  }finally{worker.terminate();}};
  const finish=(error?:unknown,digest?:string)=>{
   if(done)return;done=true;
   try{cleanup();}catch(cleanupError){error??=cleanupError;}
   if(error!==undefined)reject(error);else resolve(digest!);
  };
  const onAbort=()=>finish(signal.reason??new DOMException('Stopped','AbortError'));
  const onError=()=>finish(Error('Replay hash worker failed'));
  const onMessage=(event:Event)=>{
   const data=(event as MessageEvent<unknown>).data;
   if(!data||typeof data!=='object'||Array.isArray(data)){finish(Error('Invalid replay hash reply'));return;}
   const result=data as Record<string,unknown>;
   if(result.kind==='progress'){
    if(!Number.isSafeInteger(result.bytes)||Number(result.bytes)<=lastProgress||Number(result.bytes)>blob.size){finish(Error('Invalid replay hash progress'));return;}
    lastProgress=Number(result.bytes);try{options.onProgress?.(lastProgress,blob.size);}catch{/* Presentation cannot change verification. */}return;
   }
   if(result.kind!=='done'||result.bytes!==blob.size||typeof result.sha256!=='string'||!/^[a-f0-9]{64}$/.test(result.sha256)){
    finish(Error('Replay hash worker failed'));return;
   }
   finish(undefined,result.sha256);
  };
  const timer=setTimeout(()=>finish(Error('Replay hash timeout')),timeout);
  try{
   worker.addEventListener('message',onMessage);worker.addEventListener('error',onError);worker.addEventListener('messageerror',onError);
   signal.addEventListener('abort',onAbort,{once:true});
   if(signal.aborted){onAbort();return;}
   worker.postMessage(blob);
  }catch(error){finish(error);}
 });
}
