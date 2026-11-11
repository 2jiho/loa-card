import {SOURCE_PREPARATION_BYTES,parsePreparedSource,parseSourceBinding,parsePreparationAttestationIdentity,parseSourcePreparationMode,preparationObject,sourceRgbaBytes,
  type PreparedSource,type SourceBinding,type SourcePreparationAttestationIdentity,type SourcePreparationMode} from './source-preparation-protocol';
export type {PreparedSource,SourceBinding,SourcePreparationMode} from './source-preparation-protocol';

export type SourcePreparationWorker=Pick<Worker,'onmessage'|'onerror'|'onmessageerror'|'postMessage'|'terminate'>;
export interface SourcePreparationOptions {
  createWorker?:()=>SourcePreparationWorker;
  /** Opt in to drawing the same owned source through the existing Canvas path. */
  mode?:SourcePreparationMode;
  timeoutMs?:number;readyTimeoutMs?:number;disposeTimeoutMs?:number;maxPendingBytes?:number;
  /** Trusted bootstrap capability. Ownership transfers to the preparation Worker,
   * never through ordinary prepare messages or parsed recording JSON. */
  attestation?:{port:MessagePort;sessionId:string;producerId:string};
}
const close=(input:VideoFrame|ImageBitmap)=>{try{input?.close();}catch{/* A rejected source is still released once. */}};
const finite=(value:number)=>Number.isFinite(value)&&value>=1;
const sameBinding=(a:SourceBinding,b:SourceBinding)=>a.sourceFrameId===b.sourceFrameId&&a.captureTime===b.captureTime;

/** Explicit source preparation, separate from the default scanner. Ownership of
 * input moves on prepare() invocation, including busy/validation failures. There
 * is no waiting queue. Returned arrays belong to the caller and need its own
 * storage/acquisition reservations after this component releases its credit. */
export async function createSourcePreparation(signal:AbortSignal,options:SourcePreparationOptions={}){
  let attestationPort:MessagePort|undefined,attestationIdentity:SourcePreparationAttestationIdentity|undefined;
  let preparationMode:SourcePreparationMode;
  const releaseAttestationPort=()=>{const port=attestationPort;attestationPort=undefined;try{port?.close();}catch{/* Release other ownership despite a failed port close. */}};
  try{
    if(options.attestation!==undefined){
      const data=preparationObject(options.attestation,['port','sessionId','producerId']);
      if(typeof MessagePort==='undefined'||!(data.port instanceof MessagePort))throw Error('Invalid owned attestation MessagePort');
      attestationPort=data.port;
      if(attestationPort.onmessage!==null||attestationPort.onmessageerror!==null)throw Error('Attestation MessagePort must be unused');
      attestationIdentity=parsePreparationAttestationIdentity({version:1,sessionId:data.sessionId,producerId:data.producerId});
    }
    preparationMode=options.mode===undefined?'auto':parseSourcePreparationMode(options.mode);
    signal.throwIfAborted();
  }catch(error){releaseAttestationPort();throw error;}
  const timeout=options.timeoutMs??30_000,readyTimeout=options.readyTimeoutMs??3000,disposeTimeout=options.disposeTimeoutMs??2000,
    limit=options.maxPendingBytes??SOURCE_PREPARATION_BYTES;
  if(!finite(timeout)||timeout>30_000||!finite(readyTimeout)||readyTimeout>10_000||!finite(disposeTimeout)||disposeTimeout>2000||
    !Number.isSafeInteger(limit)||limit<1||limit>SOURCE_PREPARATION_BYTES){releaseAttestationPort();throw Error('Invalid source preparation limits');}
  let worker:SourcePreparationWorker;
  try{worker=(options.createWorker??(()=>new Worker(new URL('./source-preparation-worker.ts',import.meta.url),{type:'module'})))();}
  catch(error){releaseAttestationPort();throw error;}
  type Job={id:number;binding:SourceBinding;width:number;height:number;bytes:number;input:VideoFrame|ImageBitmap;owned:boolean;attest:boolean;
    resolve:(value:PreparedSource)=>void;reject:(error:unknown)=>void;timer:ReturnType<typeof setTimeout>;settled:boolean};
  let active:Job|undefined,ready=false,closing=false,terminated=false,nextId=0,disposing:Promise<void>|undefined;
  let submitted=0,completed=0,failed=0,busy=0,pendingBytes=0,peakPendingBytes=0;
  let lastCompletedMode:PreparedSource['mode']|undefined;
  let resolveReady!:()=>void,rejectReady!:(error:unknown)=>void,resolveDisposed:()=>void=()=>{};
  const readiness=new Promise<void>((resolve,reject)=>{resolveReady=resolve;rejectReady=reject;});void readiness.catch(()=>{});
  function rejectJob(error:unknown,release=true){
    if(!active)return;const job=active;
    if(!job.settled){job.settled=true;failed++;clearTimeout(job.timer);job.reject(error);}
    if(release){if(job.owned)close(job.input);active=undefined;pendingBytes=0;}
  }
  function stop(error:unknown){
    if(terminated)return;terminated=true;closing=true;
    releaseAttestationPort();
    worker.onmessage=worker.onerror=worker.onmessageerror=null;
    worker.terminate();signal.removeEventListener('abort',abort);
    rejectReady(error);rejectJob(error);resolveDisposed();
  }
  const abort=()=>stop(signal.reason??new DOMException('Source preparation aborted','AbortError'));
  signal.addEventListener('abort',abort,{once:true});
  worker.onmessage=event=>{
    const data=event.data;
    if(terminated)return;
    if(data?.kind==='disposed'){if(closing)resolveDisposed();else stop(Error('Unexpected source preparation disposal'));return;}
    if(!ready){
      try{preparationObject(data,attestationIdentity?['kind','attestation']:['kind']);if(data.kind!=='ready')throw Error('Invalid source preparation readiness');
        if(attestationIdentity){const identity=parsePreparationAttestationIdentity(data.attestation);
          if(identity.sessionId!==attestationIdentity.sessionId||identity.producerId!==attestationIdentity.producerId)throw Error('Source preparation attestation handshake mismatch');}
        ready=true;resolveReady();}catch(error){stop(error);}return;
    }
    if(closing)return;
    if(data?.kind!=='prepared'&&data?.kind!=='preparation-error'){stop(Error('Invalid source preparation response'));return;}
    if(!active||data.id!==active.id){stop(Error('Source preparation response identity mismatch'));return;}
    if(data.kind==='preparation-error'){
      try{preparationObject(data,['kind','id','error','fatal']);if(typeof data.error!=='string'||data.error.length>2000||typeof data.fatal!=='boolean')
        throw Error('Invalid source preparation failure');
        const error=Error(data.error);if(data.fatal)stop(error);else rejectJob(error);
      }catch(error){stop(error);}return;
    }
    try{
      preparationObject(data,['kind','id','result']);const parsed=parsePreparedSource(data.result),job=active;
      if(!sameBinding(parsed.binding,job.binding)||parsed.width!==job.width||parsed.height!==job.height||parsed.reservationBytes!==job.bytes)
        throw Error('Prepared source binding/dimensions mismatch');
      if(preparationMode==='canvas'&&(parsed.mode!=='rgba'||parsed.fallbackReason!=='canvas-requested'))
        throw Error('Prepared source selector mismatch');
      if(parsed.storage.kind==='native'&&(job.attest?parsed.storage.ticketId===undefined:parsed.storage.ticketId!==undefined))
        throw Error('Prepared source requested ticket mismatch');
      clearTimeout(job.timer);job.settled=true;active=undefined;pendingBytes=0;completed++;lastCompletedMode=parsed.mode;job.resolve(parsed);
    }catch(error){stop(error);}
  };
  worker.onerror=worker.onmessageerror=()=>stop(Error('Source preparation Worker failed'));
  const timer=setTimeout(()=>stop(Error('Source preparation readiness timeout')),readyTimeout);
  try{if(signal.aborted)abort();else if(attestationPort){worker.postMessage({kind:'init',attestation:{...attestationIdentity,port:attestationPort}},[attestationPort]);attestationPort=undefined;}
    else worker.postMessage({kind:'init'});await readiness;signal.throwIfAborted();}
  catch(error){stop(error);throw error;}finally{clearTimeout(timer);}
  return {
    prepare(input:VideoFrame|ImageBitmap,binding:SourceBinding,request?:{attest?:boolean}):Promise<PreparedSource>{
      submitted++;
      let parsed:SourceBinding,width:number,height:number,bytes:number,attest=false;
      try{
        if(closing||terminated||signal.aborted)throw signal.reason??Error('Source preparation closed');
        if(active){busy++;throw Error('Source preparation is busy');}
        if(!input||typeof input.close!=='function')throw Error('Invalid owned source');
        if(request!==undefined){const data=preparationObject(request,['attest'],[]);
          if(Object.hasOwn(data,'attest')&&typeof data.attest!=='boolean')throw Error('Invalid source preparation attestation request');attest=data.attest===true;}
        if(attest&&!attestationIdentity)throw Error('Source preparation attestation capability unavailable');
        parsed=parseSourceBinding(binding);
        width='displayWidth' in input?input.displayWidth:input.width;height='displayHeight' in input?input.displayHeight:input.height;
        bytes=sourceRgbaBytes(width,height)*2;
        if(bytes>limit||nextId===Number.MAX_SAFE_INTEGER)throw Error('Source preparation reservation limit');
      }catch(error){failed++;close(input);return Promise.reject(error);}
      return new Promise<PreparedSource>((resolve,reject)=>{
        const job:Job={id:++nextId,binding:parsed,width,height,bytes,input,owned:true,attest,resolve,reject,settled:false,
          timer:setTimeout(()=>stop(Error('Source preparation timeout')),timeout)};
        active=job;pendingBytes=bytes;peakPendingBytes=Math.max(peakPendingBytes,pendingBytes);
        try{worker.postMessage({kind:'prepare',id:job.id,binding:parsed,input,...(attest?{attest:true}:{}),
          ...(preparationMode==='canvas'?{mode:preparationMode}:{})},[input]);job.owned=false;}
        catch(error){rejectJob(error);}
      });
    },
    dispose(){return disposing??=(async()=>{
      if(terminated)return;closing=true;rejectJob(new DOMException('Source preparation disposed','AbortError'),false);
      let timer:ReturnType<typeof setTimeout>|undefined;
      try{await new Promise<void>(resolve=>{
        timer=setTimeout(resolve,disposeTimeout);resolveDisposed=resolve;
        try{worker.postMessage({kind:'dispose'});}catch{resolve();}
      });}finally{clearTimeout(timer);stop(new DOMException('Source preparation disposed','AbortError'));}
    })();},
    get stats(){return Object.freeze({submitted,completed,failed,busy,pending:active?1:0,pendingBytes,peakPendingBytes,closing,terminated,
      preparationMode,lastCompletedMode});},
  };
}
export type SourcePreparation=Awaited<ReturnType<typeof createSourcePreparation>>;
