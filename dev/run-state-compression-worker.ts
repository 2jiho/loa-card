/** Shared wire bounds also apply to the no-Worker native gzip fallback. */
export const RUN_STATE_COMPRESSION_LIMITS=Object.freeze({pendingBytes:2*1024*1024,outputBytes:8*1024*1024,
 concurrency:2,deadlineMs:30_000,idleMs:2_000});
export interface RunStateCompressionRequest {
 readonly version:1;readonly id:number;readonly rawBytes:number;readonly limit:number;readonly raw:ArrayBuffer;
}
export type RunStateCompressionResponse={readonly version:1;readonly id:number;readonly rawBytes:number}&(
 {readonly output:ArrayBuffer}|{readonly error:'compression-failed'});
const bounded=(value:unknown,maximum:number):value is number=>Number.isSafeInteger(value)&&(value as number)>0&&(value as number)<=maximum;
function keys(value:unknown,expected:readonly string[]):value is Record<string,unknown>{
 return !!value&&typeof value==='object'&&!Array.isArray(value)&&[Object.prototype,null].includes(Object.getPrototypeOf(value))&&
  Object.keys(value).length===expected.length&&expected.every(key=>Object.hasOwn(value,key));
}
export function parseRunStateCompressionRequest(value:unknown):RunStateCompressionRequest {
 if(!keys(value,['version','id','rawBytes','limit','raw'])||value.version!==1||!bounded(value.id,Number.MAX_SAFE_INTEGER)||
  !bounded(value.rawBytes,RUN_STATE_COMPRESSION_LIMITS.pendingBytes)||!bounded(value.limit,RUN_STATE_COMPRESSION_LIMITS.outputBytes)||
  !(value.raw instanceof ArrayBuffer)||value.raw.byteLength!==value.rawBytes)throw Error('잘못된 상태 기록 압축 요청');
 return value as unknown as RunStateCompressionRequest;
}
export function parseRunStateCompressionResponse(value:unknown,id:number,rawBytes:number,limit:number):Uint8Array<ArrayBuffer> {
 if(!keys(value,['version','id','rawBytes','output'])||value.version!==1||value.id!==id||value.rawBytes!==rawBytes||
  !(value.output instanceof ArrayBuffer)||!bounded(value.output.byteLength,limit))throw Error('잘못된 상태 기록 압축 응답');
 return new Uint8Array(value.output);
}

/** Native gzip copies only bounded output; cancellation closes a stalled reader. */
export async function gzipRunStateBytes(raw:Uint8Array<ArrayBuffer>,limit:number,signal:AbortSignal):Promise<Uint8Array<ArrayBuffer>> {
 signal.throwIfAborted();
 const reader=new Blob([raw]).stream().pipeThrough(new CompressionStream('gzip')).getReader();
 const parts:Uint8Array<ArrayBuffer>[]=[];let size=0,finished=false;
 const abort=()=>{void reader.cancel().catch(()=>undefined);};signal.addEventListener('abort',abort,{once:true});
 try{
  while(true){
   signal.throwIfAborted();const {done,value}=await reader.read();signal.throwIfAborted();
   if(done){finished=true;break;}
   if(size+value.byteLength>limit)throw Error('상태 기록 압축 용량 한도 초과');
   size+=value.byteLength;parts.push(value);
  }
  const result=new Uint8Array(size);let offset=0;
  for(const part of parts){result.set(part,offset);offset+=part.byteLength;}return result;
 }finally{signal.removeEventListener('abort',abort);if(!finished)await reader.cancel().catch(()=>undefined);reader.releaseLock();}
}

interface CompressionScope {postMessage(value:RunStateCompressionResponse,transfer:Transferable[]):void}
/** One job per Worker. The parent owns the hard deadline and terminates on failure. */
export function createRunStateCompressionRuntime(scope:CompressionScope){
 let active=false,lastId=0;
 return {async handle(value:unknown):Promise<void>{
  const request=parseRunStateCompressionRequest(value);
  if(active||request.id<=lastId)throw Error('잘못된 상태 기록 압축 작업 순서');
  active=true;lastId=request.id;
  try{
   const output=await gzipRunStateBytes(new Uint8Array(request.raw),request.limit,new AbortController().signal);
   scope.postMessage({version:1,id:request.id,rawBytes:request.rawBytes,output:output.buffer},[output.buffer]);
  }catch{scope.postMessage({version:1,id:request.id,rawBytes:request.rawBytes,error:'compression-failed'},[]);}
  finally{active=false;}
 }};
}

// This file also supplies shared validation to the main thread and Node tests.
if(typeof document==='undefined'&&typeof self!=='undefined'){
 const scope=self as unknown as CompressionScope&{onmessage:((event:MessageEvent)=>void)|null};
 const runtime=createRunStateCompressionRuntime(scope);
 scope.onmessage=event=>{void runtime.handle(event.data).catch(()=>{
  // A malformed request cannot identify a trusted owner. Fail the Worker.
  setTimeout(()=>{throw Error('잘못된 상태 기록 압축 요청');},0);
 });};
}
