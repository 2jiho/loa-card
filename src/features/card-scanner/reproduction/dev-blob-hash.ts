import {MAX_DEV_REPLAY_BYTES,MAX_DEV_HASH_BLOBS,MAX_DEV_HASH_CHUNK_BYTES,MAX_DEV_HASH_LIST_BYTES} from './dev-blob-hash-limits';

type HashWorker=Pick<Worker,'postMessage'|'terminate'|'addEventListener'|'removeEventListener'>;
type WorkerFactory=()=>HashWorker;
const createWorker:WorkerFactory=()=>new Worker(new URL('./dev-blob-hash-worker.ts',import.meta.url),{type:'module'});

/** Hash in a dedicated Worker. Failure or cancellation is an error, never a
 * digest; the caller must keep the original session protected in that case. */
export function hashReplayBlob(blob:Blob,signal:AbortSignal,options:{workerFactory?:WorkerFactory;timeoutMs?:number}={}):Promise<string> {
  signal.throwIfAborted();
  if(!(blob instanceof Blob)||!Number.isSafeInteger(blob.size)||blob.size>MAX_DEV_REPLAY_BYTES)
    return Promise.reject(Error('해시 입력 크기가 올바르지 않습니다.'));
  const timeout=options.timeoutMs??180_000;
  if(!Number.isFinite(timeout)||timeout<=0||timeout>600_000)return Promise.reject(Error('해시 제한 시간이 올바르지 않습니다.'));
  let worker:HashWorker;
  try{worker=(options.workerFactory??createWorker)();}catch(error){return Promise.reject(error);}
  return new Promise((resolve,reject)=>{
    let done=false;
    const cleanup=()=>{
      try{
        clearTimeout(timer);signal.removeEventListener('abort',onAbort);
        worker.removeEventListener('message',onMessage);worker.removeEventListener('error',onError);worker.removeEventListener('messageerror',onError);
      }finally{worker.terminate();}
    };
    const finish=(error?:unknown,digest?:string)=>{
      if(done)return;done=true;
      try{cleanup();}catch(cleanupError){error??=cleanupError;}
      if(error!==undefined)reject(error);else resolve(digest!);
    };
    const onAbort=()=>finish(signal.reason??new DOMException('Stopped','AbortError'));
    const onError=()=>finish(Error('기록 해시 Worker 오류'));
    const onMessage=(event:Event)=>{
      const data=(event as MessageEvent<unknown>).data;
      if(!data||typeof data!=='object'||Array.isArray(data)){finish(Error('기록 해시 Worker 응답 오류'));return;}
      const result=data as Record<string,unknown>;
      if(result.ok!==true||typeof result.sha256!=='string'||!/^[a-f0-9]{64}$/.test(result.sha256)||result.bytes!==blob.size){
        finish(Error('기록 해시를 검증하지 못했습니다.'));return;
      }
      finish(undefined,result.sha256);
    };
    const timer=setTimeout(()=>finish(Error('기록 해시 시간 초과')),timeout);
    try{
      worker.addEventListener('message',onMessage);worker.addEventListener('error',onError);worker.addEventListener('messageerror',onError);
      signal.addEventListener('abort',onAbort,{once:true});
      if(signal.aborted){onAbort();return;}
      worker.postMessage(blob);
    }catch(error){finish(error);}
  });
}

/** Hash raw-session chunks in one short-lived worker. Blob references are
 * structured-cloned; browser-internal backing-store copies and RSS are not
 * guaranteed by this API. No source bytes are read on the UI thread. */
export function hashBlobList(blobs:readonly Blob[],signal:AbortSignal,options:{workerFactory?:WorkerFactory;timeoutMs?:number}={}):Promise<readonly string[]> {
  signal.throwIfAborted();
  if(!Array.isArray(blobs)||blobs.length>MAX_DEV_HASH_BLOBS)return Promise.reject(Error('해시 청크 목록이 올바르지 않습니다.'));
  let total=0;
  for(const blob of blobs){
    if(!(blob instanceof Blob)||!Number.isSafeInteger(blob.size)||blob.size<1||blob.size>MAX_DEV_HASH_CHUNK_BYTES)
      return Promise.reject(Error('해시 청크 크기가 올바르지 않습니다.'));
    total+=blob.size;
    if(!Number.isSafeInteger(total)||total>MAX_DEV_HASH_LIST_BYTES)return Promise.reject(Error('해시 청크 합계가 한도를 초과했습니다.'));
  }
  if(blobs.length===0)return Promise.resolve([]);
  const timeout=options.timeoutMs??180_000;
  if(!Number.isFinite(timeout)||timeout<=0||timeout>600_000)return Promise.reject(Error('해시 제한 시간이 올바르지 않습니다.'));
  let worker:HashWorker;
  try{worker=(options.workerFactory??createWorker)();}catch(error){return Promise.reject(error);}
  return new Promise((resolve,reject)=>{
    let done=false;
    const cleanup=()=>{
      try{clearTimeout(timer);signal.removeEventListener('abort',onAbort);
        worker.removeEventListener('message',onMessage);worker.removeEventListener('error',onError);worker.removeEventListener('messageerror',onError);
      }finally{worker.terminate();}
    };
    const finish=(error?:unknown,digests?:readonly string[])=>{
      if(done)return;done=true;
      try{cleanup();}catch(cleanupError){error??=cleanupError;}
      if(error!==undefined)reject(error);else resolve(digests!);
    };
    const onAbort=()=>finish(signal.reason??new DOMException('Stopped','AbortError'));
    const onError=()=>finish(Error('기록 해시 Worker 오류'));
    const onMessage=(event:Event)=>{
      const data=(event as MessageEvent<unknown>).data;
      if(!data||typeof data!=='object'||Array.isArray(data)){finish(Error('기록 해시 Worker 응답 오류'));return;}
      const result=data as Record<string,unknown>;
      if(result.ok!==true||result.kind!=='list'||!Array.isArray(result.hashes)||result.hashes.length!==blobs.length||
        !Array.isArray(result.bytes)||result.bytes.length!==blobs.length||
        result.hashes.some(value=>typeof value!=='string'||!/^[a-f0-9]{64}$/.test(value))||
        result.bytes.some((value,index)=>value!==blobs[index].size)){
        finish(Error('기록 청크 해시를 검증하지 못했습니다.'));return;
      }
      finish(undefined,Object.freeze([...result.hashes] as string[]));
    };
    const timer=setTimeout(()=>finish(Error('기록 해시 시간 초과')),timeout);
    try{
      worker.addEventListener('message',onMessage);worker.addEventListener('error',onError);worker.addEventListener('messageerror',onError);
      signal.addEventListener('abort',onAbort,{once:true});
      if(signal.aborted){onAbort();return;}
      worker.postMessage({kind:'list',blobs});
    }catch(error){finish(error);}
  });
}
