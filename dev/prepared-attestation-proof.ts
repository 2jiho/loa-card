import {createSourcePreparation} from '../src/features/card-scanner/source-preparation';
import {preparedDecodedFrames} from '../src/features/card-scanner/prepared-decoded-frames';
import {createAcquisitionClient,type PreparedAcquisition} from '../src/features/card-scanner/acquisition-client';
import {parseFrameStorage,restoreFrameStorage,type NativeStorage} from '../src/features/card-scanner/native-frame-storage';
import {parsePreparedNativeAttestation,type PreparedNativeAttestation} from '../src/features/card-scanner/prepared-native-attestation';
import {pixelHash} from '../src/features/card-scanner/recording-frame-integrity';
import {nativeYuvDescriptorJson,planNativeYuvFrame} from '../src/features/card-scanner/native-yuv-recipe';
import type {NativeYuvFrameMetadata} from '../src/features/card-scanner/native-yuv-recipe';
import type {MeasuredSourceRasterReceipt} from '../src/features/card-scanner/source-raster-receipt';
import type {SourceSnapshot} from './source-snapshot';
import {loadComparisonOriginal} from './comparison-original';
import {selectPipelineWarmup,pipelineProofStartTime,PIPELINE_PROOF_FRAMES,comparePipelineRows,acquisitionShape,type PipelineProofRow,type PipelineProofWindow} from './prepared-pipeline-proof-core';

type Mode='independent'|'attested';
type Case={id:string;name:string;kind:string;inputs:{url:string;bytes:number;type:string;sha256:string}[]};
type Verified={kind:'verified';id:number;mode:Mode;binding:{sourceFrameId:number;captureTime:number};width:number;height:number;
 hash:string;storage:NativeStorage;pixels:Uint8Array<ArrayBuffer>;workMs:number;attestation?:PreparedNativeAttestation};
type ModeProof={mode:Mode;complete:boolean;rows:PipelineProofRow[];receipts:MeasuredSourceRasterReceipt[];verifications:Omit<Verified,'pixels'>[];restored:{id:number;hash:string}[];
 preparationMs:number;verificationWallMs:number;verificationWorkerMs:number;acquisitionMs:number;validationMs:number;window?:PipelineProofWindow;
 cleanup:{decoder:boolean;preparation:boolean;verification:boolean;acquisition:boolean;target:boolean};error?:string};
const select=document.querySelector<HTMLSelectElement>('#corpus')!,startInput=document.querySelector<HTMLInputElement>('#start')!,run=document.querySelector<HTMLButtonElement>('#run')!,
 stop=document.querySelector<HTMLButtonElement>('#stop')!,save=document.querySelector<HTMLButtonElement>('#save')!,status=document.querySelector<HTMLElement>('#status')!,result=document.querySelector<HTMLElement>('#result')!;
const cases=new Map<string,Case>();let active:AbortController|undefined,reportText='';
const ensure:(condition:unknown,detail:string)=>asserts condition=(condition,detail)=>{if(!condition)throw Error(detail);};
const plain=(value:unknown)=>!!value&&typeof value==='object'&&!Array.isArray(value)&&[Object.prototype,null].includes(Object.getPrototypeOf(value));
async function snapshot(signal:AbortSignal):Promise<SourceSnapshot>{const response=await fetch('/__corpus/environment',{signal,cache:'no-store'});ensure(response.ok,'Source snapshot failed');return response.json();}
function release(value:PreparedAcquisition){for(const cell of value.cells){cell.image.width=cell.image.height=0;if(cell.previewImage)cell.previewImage.width=cell.previewImage.height=0;}}

async function createVerifier(mode:Mode,signal:AbortSignal,identity:{sessionId:string;producerId:string},privatePort?:MessagePort){
 const worker=new Worker(new URL('./prepared-attestation-verifier-worker.ts',import.meta.url),{type:'module'});
 let closed=false,request:{id:number;resolve:(value:Verified)=>void;reject:(cause:unknown)=>void;timer:ReturnType<typeof setTimeout>}|undefined;
 let readyResolve!:()=>void,readyReject!:(cause:unknown)=>void;
 const ready=new Promise<void>((resolve,reject)=>{readyResolve=resolve;readyReject=reject;});void ready.catch(()=>{});
 const close=(cause:unknown)=>{if(closed)return;closed=true;worker.terminate();readyReject(cause);
  if(request){clearTimeout(request.timer);request.reject(cause);request=undefined;}signal.removeEventListener('abort',abort);};
 const abort=()=>close(signal.reason??new DOMException('Verifier aborted','AbortError'));
 signal.addEventListener('abort',abort,{once:true});
 worker.onmessage=event=>{
  const data=event.data;if(closed)return;
  if(data?.kind==='ready'){if(data.mode!==mode)close(Error('Verifier readiness mismatch'));else readyResolve();return;}
  if(data?.kind==='error'){close(Error(String(data.error)));return;}
  if(data?.kind!=='verified'||!request||data.id!==request.id){close(Error('Verifier response identity mismatch'));return;}
  try{
   ensure(data.mode===mode&&plain(data.binding)&&data.binding.sourceFrameId===data.id&&Number.isFinite(data.binding.captureTime),'Verifier result binding');
   const storage=parseFrameStorage(data.storage,data.width,data.height);ensure(storage.kind==='native-yuv420','Verifier native descriptor');
   ensure(data.pixels instanceof Uint8Array&&data.pixels.buffer instanceof ArrayBuffer&&data.pixels.byteOffset===0&&
    data.pixels.byteLength===storage.byteLength&&data.pixels.buffer.byteLength===storage.byteLength,'Verifier output ownership');
   ensure(typeof data.hash==='string'&&/^[a-f0-9]{64}$/.test(data.hash)&&Number.isFinite(data.workMs)&&data.workMs>=0,'Verifier output hash/timing');
   if(mode==='attested')parsePreparedNativeAttestation(data.attestation);else ensure(!Object.hasOwn(data,'attestation'),'Independent result claims attestation');
   const current=request;request=undefined;clearTimeout(current.timer);current.resolve({...data,storage} as Verified);
  }catch(cause){close(cause);}
 };
 worker.onerror=worker.onmessageerror=()=>close(Error('Verification worker failed'));
 const timer=setTimeout(()=>close(Error('Verification worker readiness timeout')),3000);
 try{signal.throwIfAborted();worker.postMessage({kind:'init',mode,...(privatePort?{...identity,port:privatePort}:{})},privatePort?[privatePort]:[]);await ready;signal.throwIfAborted();}
 catch(cause){close(cause);throw cause;}finally{clearTimeout(timer);}
 return {
  verify(id:number,captureTime:number,width:number,height:number,native:{descriptor:NativeYuvFrameMetadata;pixels:Uint8Array<ArrayBuffer>},ticketId?:string){
   if(closed||request)throw Error('Verification worker unavailable');signal.throwIfAborted();
   return new Promise<Verified>((resolve,reject)=>{
    request={id,resolve,reject,timer:setTimeout(()=>close(Error('Verification worker request timeout')),30_000)};
    try{worker.postMessage({kind:'verify',id,binding:{sourceFrameId:id,captureTime},width,height,native,...(mode==='attested'?{ticketId}:{})},[native.pixels.buffer]);}
    catch(cause){close(cause);}
   });
  },dispose(){close(new DOMException('Verifier disposed','AbortError'));},
 };
}

async function modeProof(mode:Mode,blob:Blob,start:number,signal:AbortSignal):Promise<ModeProof>{
 const proof:ModeProof={mode,complete:false,rows:[],receipts:[],verifications:[],restored:[],preparationMs:0,verificationWallMs:0,verificationWorkerMs:0,acquisitionMs:0,validationMs:0,
  cleanup:{decoder:false,preparation:false,verification:false,acquisition:false,target:false}};
 const decoder=preparedDecodedFrames(blob,signal),target=document.createElement('canvas'),identity={sessionId:crypto.randomUUID(),producerId:crypto.randomUUID()},
  channel=mode==='attested'?new MessageChannel():undefined;
 let preparation:Awaited<ReturnType<typeof createSourcePreparation>>|undefined,verification:Awaited<ReturnType<typeof createVerifier>>|undefined,
  acquisition:ReturnType<typeof createAcquisitionClient>|undefined;
 try{
  status.textContent=`${mode} · 작업자 준비`;
  verification=await createVerifier(mode,signal,identity,channel?.port2);
  preparation=await createSourcePreparation(signal,channel?{attestation:{...identity,port:channel.port1}}:{});
  acquisition=createAcquisitionClient(signal,{pixelTransport:true});await acquisition.ready();
  const warmup=await selectPipelineWarmup(decoder,start,signal);proof.window=warmup.window;
  for(let ordinal=0;ordinal<=PIPELINE_PROOF_FRAMES;ordinal++){
   const current=ordinal===0?warmup.frame:(await decoder.next()).value;
   ensure(current?.nativeFrame,'Native consecutive sample unavailable');const frame=current.nativeFrame;
   const at=performance.now(),prepared=await preparation.prepare(frame.clone(),{sourceFrameId:ordinal+1,captureTime:current.time},{attest:mode==='attested'});
   const preparationMs=performance.now()-at;ensure(prepared.storage.kind==='native','This proof requires native support');
   const native=prepared.storage,descriptorJson=nativeYuvDescriptorJson(native.descriptor,planNativeYuvFrame(native.descriptor).layout),expectedHash=prepared.hash;
   ensure(mode==='attested'?typeof native.ticketId==='string':!Object.hasOwn(native,'ticketId'),'Preparation ticket scope mismatch');
   const verifyAt=performance.now(),verificationWork=verification.verify(ordinal+1,current.time,prepared.width,prepared.height,
    {descriptor:native.descriptor,pixels:native.pixels},native.ticketId).then(value=>({value,wallMs:performance.now()-verifyAt}));
   // Join both active owners even when either branch fails.
   const acquisitionAt=performance.now(),acquisitionWork=acquisition.detectPrepared({pixels:prepared.pixels,width:prepared.width,height:prepared.height,binding:prepared.binding},target)
    .then(value=>({value,wallMs:performance.now()-acquisitionAt}));
   const settled=await Promise.allSettled([verificationWork,acquisitionWork]);
   const verified=settled[0],acquired=settled[1];
   if(verified.status==='rejected'||acquired.status==='rejected'){
    if(acquired.status==='fulfilled')release(acquired.value.value);
    throw verified.status==='rejected'?verified.reason:acquired.status==='rejected'?acquired.reason:Error('Unreachable branch');
   }
   const {value:received,wallMs:verificationMs}=verified.value,{value:measured,wallMs:acquisitionMs}=acquired.value;
   try{
    const validationAt=performance.now();ensure(native.pixels.byteLength===0&&prepared.pixels.byteLength===0,'Source ownership not transferred');
    ensure(received.binding.captureTime===current.time&&received.width===prepared.width&&received.height===prepared.height&&received.hash===expectedHash,'Verifier expected-source mismatch');
    ensure(measured.rasterReceipt.hash===expectedHash&&measured.rasterReceipt.sourceFrameId===ordinal+1&&measured.rasterReceipt.captureTime===current.time,'Actual acquisition raster mismatch');
    const restored=await restoreFrameStorage(received.storage,received.width,received.height,received.pixels,received.hash);
    const restoredHash=await pixelHash(restored);ensure(restoredHash===expectedHash,'Independent full RGBA restoration mismatch');
    if(mode==='attested'){
     const receipt=received.attestation!;ensure(receipt.sessionId===identity.sessionId&&receipt.producerId===identity.producerId&&
      receipt.sourceFrameId===ordinal+1&&receipt.captureTime===current.time&&receipt.ticketId===native.ticketId&&
      receipt.nativeSha256===received.storage.nativeSha256&&receipt.generatedRgbaSha256===expectedHash,'Attested tuple join mismatch');
    }
    proof.rows.push({ordinal,sourceFrameId:ordinal+1,acquisitionFrameId:measured.frameId,time:current.time,width:prepared.width,height:prepared.height,hash:expectedHash,
     storageKind:'native',nativeSha256:received.storage.nativeSha256,descriptorJson,acquisition:acquisitionShape(measured)});
    proof.receipts.push(measured.rasterReceipt);
    const {pixels:_pixels,...receipt}=received;proof.verifications.push(receipt);proof.restored.push({id:ordinal+1,hash:restoredHash});
    if(ordinal>0){proof.preparationMs+=preparationMs;proof.verificationWallMs+=verificationMs;proof.verificationWorkerMs+=received.workMs;proof.acquisitionMs+=acquisitionMs;}
    proof.validationMs+=performance.now()-validationAt;
   }finally{release(measured);}
   status.textContent=`${mode} · ${ordinal} / ${PIPELINE_PROOF_FRAMES} · 전체 픽셀 일치`;
  }
  proof.complete=true;
 }catch(cause){proof.error=String(cause);}
 finally{
  try{await decoder.return(undefined);proof.cleanup.decoder=true;}catch(cause){proof.error??=String(cause);}
  try{await preparation?.dispose();proof.cleanup.preparation=true;}catch(cause){proof.error??=String(cause);}
  try{verification?.dispose();proof.cleanup.verification=true;}catch(cause){proof.error??=String(cause);}
  try{acquisition?.dispose();proof.cleanup.acquisition=true;}catch(cause){proof.error??=String(cause);}
  for(const endpoint of channel?[channel.port1,channel.port2]:[])try{endpoint.close();}catch(cause){proof.error??=String(cause);}
  target.width=target.height=0;proof.cleanup.target=true;
 }
 if(proof.error)proof.complete=false;return proof;
}

run.addEventListener('click',async()=>{
 if(active)return;const controller=new AbortController();active=controller;const signal=AbortSignal.any([controller.signal,AbortSignal.timeout(180_000)]);
 const selectedId=select.value,requestedStart=startInput.valueAsNumber;
 run.disabled=select.disabled=startInput.disabled=true;stop.disabled=false;save.disabled=true;reportText='';result.textContent='';
 status.textContent='실행 소스와 원본 manifest를 확인하고 있습니다.';
 const report:{version:1;proof:string;complete:boolean;error:string|null;sourceStart?:SourceSnapshot;sourceEnd?:SourceSnapshot;original?:unknown;modes:ModeProof[];boundaries:unknown}={
  version:1,proof:'prepared-native-private-port-verification',complete:false,error:null,modes:[],boundaries:{
   actualPreparationWorker:true,actualPrivatePort:true,actualVerificationWorker:true,actualAcquisitionRaster:true,independentRgbaRestoration:true,
   opfsStorage:false,storedAck:false,canonicalRecordingContract:false,ocr:false,durableArchive:false,liveOsInput:false,fullMemoryMeasured:false,
   timing:'One ordered independent-then-attested finite observation, warmup excluded. Stages overlap, full validation excluded from stage sums. Not a causal/end-to-end scan speed claim.',
   adoption:'Only this development proof requests attestation. Existing scanner and writer paths remain unchanged.',
   trust:'Trusted same-origin application bootstrap owns the private endpoints and preparation worker. This is not OS-frame authentication against compromised bootstrap or hostile same-origin code.'}};
 try{
  report.sourceStart=await snapshot(signal);const selected=cases.get(selectedId);ensure(selected?.kind==='video','Original video case required');
  const detailResponse=await fetch(`/__corpus/cases/${selected.id}`,{signal});ensure(detailResponse.ok,'Original manifest unavailable');
  const detail:Case=await detailResponse.json();ensure(detail.id===selected.id&&detail.inputs.length===1&&/^[a-f0-9]{64}$/.test(detail.inputs[0].sha256),'Original manifest mismatch');
  const original=await loadComparisonOriginal(detail.inputs[0].url,detail.inputs[0],signal);report.original={caseId:selected.id,...original.verified};
  const start=pipelineProofStartTime(requestedStart);
  for(const mode of ['independent','attested']as const){const proof=await modeProof(mode,original.blob,start,signal);report.modes.push(proof);ensure(proof.complete,proof.error??'Mode incomplete');}
  comparePipelineRows(report.modes[0].rows,report.modes[1].rows);ensure(JSON.stringify(report.modes[0].window)===JSON.stringify(report.modes[1].window),'Original window differs');
  report.sourceEnd=await snapshot(signal);ensure(report.sourceStart.sourceDigest===report.sourceEnd.sourceDigest,'Source changed during proof');report.complete=true;
  status.textContent='30개 표본 일치 · 전용 포트·실제 획득·독립 복원 검증 완료';
 }catch(cause){report.error=String(cause);status.textContent=`검증 미완료 · ${report.error}`;}
 finally{
  reportText=JSON.stringify(report,null,2);result.textContent=JSON.stringify({proof:report.proof,complete:report.complete,error:report.error,
   sourceStart:report.sourceStart?.sourceDigest,sourceEnd:report.sourceEnd?.sourceDigest,original:report.original,
   modes:report.modes.map(value=>({mode:value.mode,complete:value.complete,samples:value.rows.length,preparationMs:value.preparationMs,
    verificationWallMs:value.verificationWallMs,verificationWorkerMs:value.verificationWorkerMs,acquisitionMs:value.acquisitionMs,cleanup:value.cleanup})),
   boundaries:report.boundaries},null,2).slice(0,12000);
  active=undefined;run.disabled=select.disabled=startInput.disabled=false;stop.disabled=true;save.disabled=false;
 }
});
stop.addEventListener('click',()=>active?.abort(new DOMException('User stopped verification','AbortError')));
window.addEventListener('pagehide',()=>active?.abort(new DOMException('Proof page closed','AbortError')));
save.addEventListener('click',()=>{if(!reportText)return;const url=URL.createObjectURL(new Blob([reportText],{type:'application/json'})),anchor=document.createElement('a');
 anchor.href=url;anchor.download=`loacard-native-attestation-${Date.now()}.json`;anchor.click();setTimeout(()=>URL.revokeObjectURL(url),1000);});
void(async()=>{try{const response=await fetch('/__corpus');ensure(response.ok,'Corpus list unavailable');const data=await response.json();
 for(const item of data.cases as Case[])if(item.kind==='video'){cases.set(item.id,item);select.add(new Option(item.name,item.id));}
 const preferred=[...cases.values()].find(item=>item.name==='video-6');if(preferred)select.value=preferred.id;
 ensure(cases.size>0,'No original video case');run.disabled=false;status.textContent='영상과 고정 시작 시각을 선택하세요.';
}catch(cause){status.textContent=String(cause);}})();
