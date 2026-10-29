import type {ExactEvent} from './exact-recording-codec';
import {JOURNAL_PENDING_BYTES,MAX_JOURNAL_CHUNK_BYTES} from './recording-journal';
import type {RecordingJournal,StreamJournalStats} from './recording-journal';
import type {ArchiveJournalMirror} from './archive-journal-mirror';
import type {CanonicalReadFrame} from './canonical-frame-reader';
import type {RecordingCompressionEngine} from './recording-compression';
import type {createRecordingRasterPipeline} from './recording-raster-pipeline';
import {parsePreparationAttestationIdentity,type SourcePreparationAttestationIdentity} from './source-preparation-protocol';
import {RGBA_WINDOW_CODEC,RGBA_WINDOW_POLICY} from './rgba-window-policy';
export interface ExactEventQueueFailure {
 readonly reason:'pending-byte-limit'|'finish-timeout'|'worker-write'|'serialization'|'transport-send';
 readonly seq:number|null;readonly eventType:string|null;readonly estimatedBytes:number|null;
 readonly pendingEvents:number;readonly pendingBytes:number;readonly inFlightBatches:number;
 readonly observedAtMs:number;readonly error:string|null;
}
/** Small client-side queue diagnostics, never an event persistence receipt. */
export interface ExactEventQueueStats {
 readonly version:1;readonly acceptedEvents:number;readonly postedBatches:number;readonly acknowledgedBatches:number;
 readonly pendingEvents:number;readonly pendingBytes:number;readonly peakPendingBytes:number;
 readonly inFlightBatches:number;readonly peakInFlightBatches:number;readonly firstFailure:Readonly<ExactEventQueueFailure>|null;
}
export interface ExactRecordingStats {frames:number;events:number;dropped:number;bytes:number;peakQueuedBytes:number;peakWorkingBytes:number;readbackMs:number;encodeMs:number;complete:boolean;error:string;canonical?:true;storageVersion?:1;nativeFrames?:number;rgbaFrames?:number;compressionEngine?:RecordingCompressionEngine;
 codec?:typeof RGBA_WINDOW_CODEC;policy?:typeof RGBA_WINDOW_POLICY;
 rasterEngine?:'nested-worker'|'inline';raster?:Awaited<ReturnType<typeof createRecordingRasterPipeline>>['stats'];nativeAttestedFrames?:number;nativeAttestationBudget?:'native-owned-v1';eventQueue?:ExactEventQueueStats}
export interface ExactRecording {blob:Blob;stats:ExactRecordingStats;dispose():Promise<void>}
/** Worker transport telemetry only, never a durable persistence receipt. */
export type ExactJournalMirrorStats=Readonly<ArchiveJournalMirror['stats']>;
export interface ExactJournalStats extends StreamJournalStats {
 readonly mirror?:ExactJournalMirrorStats;
 /** Main-thread event clock; a failure at zero is a valid observation. */
 readonly firstErrorAtMs?:number;
 /** Time the latest valid mirror snapshot reached this client, on the same clock. */
 readonly mirrorObservedAtMs?:number;
}
function parseJournalMirror(value:unknown):ExactJournalMirrorStats|undefined {
 try{
  if(!value||typeof value!=='object'||Array.isArray(value)||![Object.prototype,null].includes(Object.getPrototypeOf(value)))return;
  const keys=['availableBytes','sentBytes','acknowledgedBytes','pendingBytes','peakPendingBytes','chunks','complete','error'] as const;
  if(Reflect.ownKeys(value).length!==keys.length)return;
  const fields=Object.getOwnPropertyDescriptors(value);
  if(keys.some(key=>!fields[key]||!Object.hasOwn(fields[key],'value')))return;
  const mirror=Object.fromEntries(keys.map(key=>[key,fields[key].value])) as unknown as ExactJournalMirrorStats;
  if(keys.slice(0,6).some(key=>!Number.isSafeInteger(mirror[key])||(mirror[key] as number)<0)||
    typeof mirror.complete!=='boolean'||typeof mirror.error!=='string'||mirror.error.length>2000||
    mirror.sentBytes>mirror.availableBytes||mirror.acknowledgedBytes>mirror.sentBytes||
    mirror.pendingBytes!==mirror.sentBytes-mirror.acknowledgedBytes||mirror.peakPendingBytes<mirror.pendingBytes||
    mirror.peakPendingBytes>JOURNAL_PENDING_BYTES||mirror.chunks>mirror.sentBytes||
    mirror.complete&&(mirror.pendingBytes!==0||mirror.sentBytes!==mirror.availableBytes||mirror.error!==''))return;
  return Object.freeze(mirror);
 }catch{/* Malformed diagnostic data cannot interrupt the journal protocol. */}
}
export async function createExactRecording(options:{storageVersion?:1;preparedNativeAttestation?:true;codecPolicy?:typeof RGBA_WINDOW_POLICY}={}){
 if(!options||typeof options!=='object'||Array.isArray(options)||Object.keys(options).some(key=>!['storageVersion','preparedNativeAttestation','codecPolicy'].includes(key))||
  options.storageVersion!==undefined&&options.storageVersion!==1||options.preparedNativeAttestation!==undefined&&options.preparedNativeAttestation!==true||
  options.preparedNativeAttestation===true&&options.storageVersion!==1||
  options.codecPolicy!==undefined&&options.codecPolicy!==RGBA_WINDOW_POLICY||
  options.codecPolicy!==undefined&&(options.storageVersion!==undefined||options.preparedNativeAttestation!==undefined))throw Error('무손실 저장 형식 설정 오류');
 const attestationIdentity:SourcePreparationAttestationIdentity|undefined=options.preparedNativeAttestation?
  Object.freeze({version:1,sessionId:crypto.randomUUID(),producerId:crypto.randomUUID()}):undefined;
 const attestationChannel=attestationIdentity?new MessageChannel():undefined;
 let preparationPort=attestationChannel?.port1;
 const releasePreparationPort=()=>{try{preparationPort?.close();}finally{preparationPort=undefined;}};
 let worker:Worker;
 try{worker=new Worker(new URL('./exact-recording-worker.ts',import.meta.url),{type:'module'});}
 catch(error){releasePreparationPort();attestationChannel?.port2.close();throw error;}
 const channel=new MessageChannel();
 let attached=false,closed=false,finished=false,recordingDone=false,supportsSourceReads=false,sequence=0,pending:ExactEvent[]=[],pendingBytes=0,inFlight=0,overflow=false,incompleteReason='';
 const eventClockStarted=performance.now();
 let acceptedEvents=0,postedBatches=0,acknowledgedBatches=0,peakEventPendingBytes=0,peakEventInFlight=0,eventAdmissionClosed=false;
 let firstEventFailure:Readonly<ExactEventQueueFailure>|null=null;
 const eventFailure=(reason:ExactEventQueueFailure['reason'],entry?:ExactEvent,size?:number,error?:string)=>{
  firstEventFailure??=Object.freeze({reason,seq:entry?.seq??null,eventType:typeof entry?.type==='string'?entry.type.slice(0,128):null,
   estimatedBytes:size??null,pendingEvents:pending.length,pendingBytes,inFlightBatches:inFlight,
   observedAtMs:Math.max(0,performance.now()-eventClockStarted),error:error?.slice(0,2000)??null});
 };
 const eventQueueStats=():Readonly<ExactEventQueueStats>=>Object.freeze({version:1,acceptedEvents,postedBatches,acknowledgedBatches,
  pendingEvents:pending.length,pendingBytes,peakPendingBytes:peakEventPendingBytes,inFlightBatches:inFlight,
  peakInFlightBatches:peakEventInFlight,firstFailure:firstEventFailure});
 let nextReadRequest=0;
 let finishedStats:Readonly<ExactRecordingStats>|undefined;
 let sourceRead:{requestId:number;id:number;resolve:(raw:CanonicalReadFrame)=>void;reject:(error:unknown)=>void;
   timer:ReturnType<typeof setTimeout>;signal?:AbortSignal;abort:()=>void}|undefined;
 const cancelSourceRead=(error:unknown,cancelWorker=true)=>{
  const read=sourceRead;if(!read)return;sourceRead=undefined;
  clearTimeout(read.timer);read.signal?.removeEventListener('abort',read.abort);
  if(cancelWorker&&!closed)try{worker.postMessage({kind:'read-cancel',requestId:read.requestId});}catch{/* Worker failed independently. */}
  read.reject(error);
 };
 let resolveReady!:()=>void,rejectReady!:(e:unknown)=>void,resolveDone!:(value:ExactRecording)=>void,rejectDone!:(e:unknown)=>void,resolveDispose:(()=>void)|undefined;
 const ready=new Promise<void>((r,j)=>{resolveReady=r;rejectReady=j;});
 let done:Promise<ExactRecording>|undefined;
 let journal:RecordingJournal|undefined,journalSequence=0,journalChunks=0,journalBytes=0,journalPendingBytes=0,journalPeak=0,journalError='';
 const journalAbort=new AbortController(),journalWrites=new Set<Promise<void>>();
 let journalTail=Promise.resolve();
 let journalFinished=false,resolveJournal:()=>void=()=>{};
 const journalDone=new Promise<void>(resolve=>{resolveJournal=resolve;});
 let journalFinishing:Promise<ExactJournalStats>|undefined;
 let journalMirror:ExactJournalMirrorStats|undefined,journalMirrorObservedAtMs:number|undefined,journalFirstErrorAtMs:number|undefined;
 const observeJournalMirror=(value:unknown)=>{
  const mirror=parseJournalMirror(value);if(!mirror)return;
  journalMirror=mirror;journalMirrorObservedAtMs=Math.max(0,performance.now()-eventClockStarted);
 };
 const journalFailure=(reason:unknown)=>{
  if(journalError)return;journalError=String(reason).slice(0,2000);
  journalFirstErrorAtMs??=Math.max(0,performance.now()-eventClockStarted);
  try{void Promise.resolve(journal?.incomplete(journalError)).catch(()=>{});}catch{/* Reporting cannot stop recognition. */}
  try{worker.postMessage({kind:'journal-stop',error:journalError});}catch{/* Worker may already be gone. */}
  resolveJournal();
 };
 const journalStats=():ExactJournalStats=>({enabled:!!journal,complete:!!journal&&journalFinished&&!journalError,
  chunks:journalChunks,bytes:journalBytes,peakPendingBytes:journalPeak,error:journalError,
  ...(journalMirror?{mirror:journalMirror,mirrorObservedAtMs:journalMirrorObservedAtMs}:{}),
  ...(journalFirstErrorAtMs!==undefined?{firstErrorAtMs:journalFirstErrorAtMs}:{})});
 const flush=()=>{
  if(!pending.length||inFlight>=4)return;
  try{worker.postMessage({kind:'events',events:pending});}
  catch{
   eventFailure('transport-send',undefined,pendingBytes,'이벤트 전송 실패');
   incompleteReason ||= '이벤트 전송 실패';eventAdmissionClosed=true;pending=[];pendingBytes=0;return;
  }
  pending=[];pendingBytes=0;inFlight++;postedBatches++;peakEventInFlight=Math.max(peakEventInFlight,inFlight);
 };
 worker.onmessage=event=>{const m=event.data;
  if(m.kind==='ready'){
   if(m.storageVersion!==options.storageVersion){rejectReady(Error('무손실 저장 형식 준비 응답 불일치'));return;}
   if(m.codecPolicy!==options.codecPolicy||m.codec!==(options.codecPolicy?RGBA_WINDOW_CODEC:undefined)){
    rejectReady(Error('RGBA 저장 정책 준비 응답 불일치'));return;
   }
   try{
    if(attestationIdentity){const identity=parsePreparationAttestationIdentity(m.attestation);
     if(identity.sessionId!==attestationIdentity.sessionId||identity.producerId!==attestationIdentity.producerId)throw Error('기록 변환 증명 준비 응답 불일치');}
    else if(m.attestation!==undefined)throw Error('요청하지 않은 기록 변환 증명');
   }catch(error){rejectReady(error);return;}
   supportsSourceReads=m.supportsSourceReads===true;resolveReady();
  }
  else if(m.kind==='events-written'){if(inFlight>0)acknowledgedBatches++;inFlight=Math.max(0,inFlight-1);flush();}
  else if(m.kind==='events-error'){
   eventFailure('worker-write',undefined,undefined,String(m.error));
   incompleteReason ||= '이벤트 기록 실패: '+String(m.error).slice(0,2000);
   // A failed writer has explicitly abandoned this event stream. Do not call
   // these batches persisted, or wait ten seconds for ACKs it cannot produce.
   eventAdmissionClosed=true;pending=[];pendingBytes=0;inFlight=0;
  }
  else if(m.kind==='error'){cancelSourceRead(Error(m.error),false);rejectReady(Error(m.error));rejectDone?.(Error(m.error));}
  else if(m.kind==='read-error'){
   if(sourceRead?.requestId===m.requestId)cancelSourceRead(Error(m.error),false);
  }else if(m.kind==='read-frame'){
   const read=sourceRead;
   if(!read||read.requestId!==m.requestId)return;
   const raw=m.raw as CanonicalReadFrame;
   if(!raw||raw.id!==read.id||!Number.isSafeInteger(raw.width)||!Number.isSafeInteger(raw.height)||raw.width<1||raw.height<1||
     !(raw.pixels instanceof Uint8ClampedArray)||raw.width*raw.height*4!==raw.pixels.byteLength||raw.pixels.byteLength>64*1024*1024||
     !Number.isFinite(raw.time)||raw.time<0||typeof raw.hash!=='string'||!/^[a-f0-9]{64}$/.test(raw.hash)||
     raw.phase!==undefined&&raw.phase!=='input'&&raw.phase!=='recovery'){
    cancelSourceRead(Error('정규 입력 읽기 응답 오류'),false);return;
   }
   sourceRead=undefined;clearTimeout(read.timer);read.signal?.removeEventListener('abort',read.abort);read.resolve(raw);
  }
  else if(m.kind==='disposed')resolveDispose?.();
  else if(m.kind==='journal-error'){observeJournalMirror(m.mirror);journalFailure(m.error);}
  else if(m.kind==='journal-done'){observeJournalMirror(m.mirror);journalFinished=true;resolveJournal();}
  else if(m.kind==='journal-chunk'){
   observeJournalMirror(m.mirror);
   if(!journal||journalError||closed)return;
   if(!Number.isSafeInteger(m.sequence)||m.sequence!==journalSequence||!(m.blob instanceof Blob)||!m.blob.size||m.blob.size>MAX_JOURNAL_CHUNK_BYTES){journalFailure('기록 저널 청크 오류');return;}
   const chunk={kind:'exact' as const,sequence:journalSequence++,blob:m.blob as Blob};
   journalPendingBytes+=chunk.blob.size;journalPeak=Math.max(journalPeak,journalPendingBytes);
   // Worker credit is returned after persistence, so at most its bounded
   // transport window is referenced while a storage transaction is stalled.
   const write=journalTail.then(()=>{
    if(journalError)throw Error(journalError);
    return journal!.write(chunk,journalAbort.signal);
   }).then(()=>{
    journalChunks++;journalBytes+=chunk.blob.size;if(!closed)worker.postMessage({kind:'journal-credit',sequence:chunk.sequence,bytes:chunk.blob.size});
   }).catch(journalFailure).finally(()=>{journalPendingBytes-=chunk.blob.size;journalWrites.delete(write);});
   journalWrites.add(write);journalTail=write;
  }
  else if(m.kind==='done'){
   recordingDone=true;
   if(m.stats.storageVersion!==options.storageVersion)incompleteReason ||= '무손실 저장 형식 결과 불일치';
   if(m.stats.policy!==options.codecPolicy||m.stats.codec!==(options.codecPolicy?RGBA_WINDOW_CODEC:undefined)||
     options.codecPolicy&&(m.stats.canonical!==true||m.stats.storageVersion!==undefined||m.stats.nativeFrames!==undefined||m.stats.rgbaFrames!==undefined))
     incompleteReason ||= 'RGBA 저장 정책 결과 불일치';
   if(attestationIdentity?(!Number.isSafeInteger(m.stats.nativeAttestedFrames)||m.stats.nativeAttestedFrames<0||
     m.stats.nativeAttestedFrames!==m.stats.nativeFrames):m.stats.nativeAttestedFrames!==undefined)
     incompleteReason ||= 'native 변환 증명 결과 수 불일치';
   if(attestationIdentity?m.stats.nativeAttestationBudget!=='native-owned-v1':m.stats.nativeAttestationBudget!==undefined)
     incompleteReason ||= 'native 변환 증명 예약 정책 불일치';
   finishedStats=Object.freeze({...m.stats,eventQueue:eventQueueStats(),complete:m.stats.complete&&!overflow&&!incompleteReason,
    error:incompleteReason||(overflow?'이벤트 기록 대기 한도 초과':m.stats.error)});
   resolveDone({blob:m.blob,stats:finishedStats!,dispose});
  }
 };
 worker.onerror=event=>{cancelSourceRead(Error(event.message),false);rejectReady(Error(event.message));rejectDone?.(Error(event.message));};
 const timer=setTimeout(()=>rejectReady(Error('무손실 기록 준비 시간 초과')),10000);
 try{
  worker.postMessage({kind:'init',port:channel.port2,...(options.storageVersion?{storageVersion:options.storageVersion}:{}),
   ...(options.codecPolicy?{codecPolicy:options.codecPolicy}:{}),
   ...(attestationChannel?{attestation:{...attestationIdentity,port:attestationChannel.port2}}:{})},
   attestationChannel?[channel.port2,attestationChannel.port2]:[channel.port2]);
  await ready;
 }catch(error){releasePreparationPort();attestationChannel?.port2.close();worker.terminate();channel.port1.close();throw error;}finally{clearTimeout(timer);}
 async function dispose(){
  if(closed)return;cancelSourceRead(new DOMException('정규 입력 저장소 종료','AbortError'));closed=true;channel.port1.close();releasePreparationPort();
  if(journal&&!journalFinished)journalFailure('기록 저널이 종료 전에 중단되었습니다.');
  journalAbort.abort(new DOMException('기록 저널 중단','AbortError'));
  await new Promise<void>(resolve=>{const timeout=setTimeout(resolve,2000);resolveDispose=()=>{clearTimeout(timeout);resolve();};worker.postMessage({kind:'dispose'});});worker.terminate();
 }
 return {
  /** Capability of the live temporary file. Unsupported browsers keep their
   * previous backup path rather than pretending canonical reads will work. */
  get supportsSourceReads(){return supportsSourceReads;},
  /** Trusted bootstrap only: this endpoint is handed directly to the actual
   * preparation Worker once. Imported JSON and ordinary frame ports cannot
   * mint conversion authority. Same-origin bootstrap code remains trusted. */
  get nativeAttestationIdentity(){return attestationIdentity;},
  takePreparationAttestation(){
   if(closed||finished||!attestationIdentity||!preparationPort)throw Error('준비 변환 증명 채널을 연결할 수 없습니다.');
   const port=preparationPort;preparationPort=undefined;
   return {port,sessionId:attestationIdentity.sessionId,producerId:attestationIdentity.producerId};
  },
  /** Producer telemetry describes the temporary file, even if a smaller durable
   * prefix was saved. It cannot certify the separately persisted archive. */
  get finishedStats(){return finishedStats;},
  get eventQueueStats(){return eventQueueStats();},
  readFrame(id:number,signal?:AbortSignal):Promise<CanonicalReadFrame>{
   if(!Number.isSafeInteger(id)||id<1)return Promise.reject(Error('정규 입력 식별 오류'));
   if(closed||!supportsSourceReads&&!recordingDone||finished&&!recordingDone)return Promise.reject(Error('정규 입력을 읽을 수 없는 저장소 상태입니다.'));
   if(sourceRead)return Promise.reject(Error('정규 입력은 한 번에 한 프레임씩 읽습니다.'));
   if(signal?.aborted)return Promise.reject(signal.reason);
   if(nextReadRequest===Number.MAX_SAFE_INTEGER)return Promise.reject(Error('정규 입력 읽기 식별 한도 초과'));
   const requestId=++nextReadRequest;
   return new Promise<CanonicalReadFrame>((resolve,reject)=>{
    const abort=()=>cancelSourceRead(signal?.reason??new DOMException('정규 입력 읽기 취소','AbortError'));
    sourceRead={requestId,id,resolve,reject,signal,abort,
      timer:setTimeout(()=>cancelSourceRead(Error('정규 입력 읽기 시간 초과')),10_000)};
    signal?.addEventListener('abort',abort,{once:true});
    try{worker.postMessage({kind:'read-frame',requestId,id});}catch(error){cancelSourceRead(error,false);}
   });
  },
  setJournal(target:RecordingJournal){
   if(journal||closed||finished)throw Error('기록 저널을 연결할 수 없습니다.');
   journal=target;worker.postMessage({kind:'journal-start'});
  },
  finishJournal(timeoutMs=15_000){
   if(!Number.isFinite(timeoutMs)||timeoutMs<1||timeoutMs>60_000)throw Error('기록 저널 종료 시간 설정 오류');
   if(journalFinishing)return journalFinishing;
   journalFinishing=(async()=>{
    if(!journal)return journalStats();
    let timer:ReturnType<typeof setTimeout>|undefined;
    try{
     // This is called by background session finalization, never frame capture.
     await Promise.race([journalDone.then(async()=>{await Promise.allSettled([...journalWrites]);}),new Promise<void>(resolve=>{
      timer=setTimeout(()=>{journalFailure('기록 저널 저장 시간 초과');journalAbort.abort(Error(journalError));resolve();},timeoutMs);
     })]);
     return journalStats();
    }finally{clearTimeout(timer);}
   })();return journalFinishing;
  },
  get journalStats(){return journalStats();},
  incomplete(reason:string){incompleteReason=reason;},
  takePort(){if(attached)throw Error('재현 기록이 이미 연결되었습니다.');attached=true;return channel.port1;},
  event(type:string,value:unknown,time:number){
   if(closed||finished||overflow||eventAdmissionClosed)return;
   const entry:ExactEvent={kind:'event',seq:++sequence,time:Math.max(0,time),type,value};
   let size:number;
   try{size=JSON.stringify(entry).length*2;}
   catch{eventFailure('serialization',entry,undefined,'이벤트를 JSON으로 변환할 수 없습니다.');
    eventAdmissionClosed=true;incompleteReason ||= '이벤트 직렬화 실패';return;}
   if(pendingBytes+size>1024*1024){eventFailure('pending-byte-limit',entry,size);overflow=true;return;}
   pending.push(entry);pendingBytes+=size;acceptedEvents++;peakEventPendingBytes=Math.max(peakEventPendingBytes,pendingBytes);
   if(pending.length>=64||pendingBytes>=64*1024)flush();
  },
  async finish(){
   if(done)return done;finished=true;releasePreparationPort();
   done=new Promise<ExactRecording>((r,j)=>{resolveDone=r;rejectDone=j;});
   // Wait only for small event batches; source frames are drained by their port's end marker.
   const deadline=performance.now()+10000;
   void done.catch(()=>{});
   while((pending.length||inFlight)&&performance.now()<deadline){flush();await new Promise(r=>setTimeout(r,10));}
   if(pending.length||inFlight){eventFailure('finish-timeout');overflow=true;}
   worker.postMessage({kind:'finish',noSource:!attached||!!incompleteReason});
   const timeout=setTimeout(()=>rejectDone(Error('무손실 기록 종료 시간 초과')),Math.max(1,deadline-performance.now()));
   try{return await done;}finally{clearTimeout(timeout);}
  },dispose,
 };
}
export type ExactRecorder=Awaited<ReturnType<typeof createExactRecording>>;
