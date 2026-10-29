import {packPixels,pixelHash,entryParts,MAX_FRAME_BYTES} from './exact-recording-codec';
import {createRecordingCompression,type RecordingCompression} from './recording-compression';
import type {ExactEvent} from './exact-recording-codec';
import {createArchiveJournalMirror,type ArchiveJournalMirror} from './archive-journal-mirror';
import {recordingInputBytes} from './recording-input-raster';
import {createRecordingRasterPipeline} from './recording-raster-pipeline';
import {CanonicalFrameIndex} from './canonical-frame-index';
import {readCanonicalFrame} from './canonical-frame-reader';
import {parseNativeYuvMetadata,prepareNativeStorage,rgbaFrameStorage,frameStorageSignature,type FrameStorage} from './native-frame-storage';
import {planNativeYuvFrame,type NativeYuvFrameMetadata} from './native-yuv-recipe';
import {SOURCE_STORE_TIMING_LIMIT} from './source-store-timing';
import {createPreparedNativeAttestationInbox,verifyAttestedPreparedNative,type PreparedNativeAttestation} from './prepared-native-attestation';
import {parsePreparationAttestationIdentity,preparationObject,preparationTicketId,type SourcePreparationAttestationIdentity} from './source-preparation-protocol';
import {createRecordingWorkQueue,type RecordingWorkLane} from './recording-work-queue';
import {RGBA_WINDOW_CODEC,RGBA_WINDOW_POLICY,windowWorkingSet} from './rgba-window-policy';
let sync:{write(data:BufferSource,options:{at:number}):number;read(data:BufferSource,options:{at:number}):number;flush():void;close():void}|undefined;
let port:MessagePort, writer:FileSystemWritableFileStream, directory:FileSystemDirectoryHandle, name='';
let previous:Uint8Array<ArrayBuffer>|undefined,width=0,height=0,bytes=0,frames=0,events=0,dropped=0;
let queuedBytes=0,peakQueuedBytes=0,peakWorkingBytes=0,readbackMs=0,encodeMs=0,failed='',requested=false,ended=false,closing=false;
let journal:ArchiveJournalMirror|undefined,finishedBlob:Blob|undefined;
let canonicalIndex=new CanonicalFrameIndex();
let codecPolicy:typeof RGBA_WINDOW_POLICY|undefined;
const reads=new Map<number,AbortController>();
let disposing=false,canonicalObserved=false,canonicalMode:boolean|undefined;
let compactMode=false,nativeFrames=0,rgbaFrames=0,previousStorageSignature='',queuedJobs=0;
let attestationIdentity:SourcePreparationAttestationIdentity|undefined,attestationInbox:ReturnType<typeof createPreparedNativeAttestationInbox>|undefined,nativeAttestedFrames=0;
const attestationAbort=new AbortController();
let sourceRejection:string|undefined,sourceFailureReported=false,drainPending=false;
let eventsFailureReported=false,journalStarted=false,journalStopped=false;
let compression:RecordingCompression;
let rasterPipeline:Awaited<ReturnType<typeof createRecordingRasterPipeline>>;
const LIMIT=1024*1024*1024;
const PENDING_LIMIT=128*1024*1024,MAX_PENDING_JOBS=128;
const workQueue=createRecordingWorkQueue({frame:MAX_PENDING_JOBS,event:4});
interface NativeInput {descriptor:NativeYuvFrameMetadata;pixels:Uint8Array<ArrayBuffer>;bytes:number;ticketId?:string}
/** Validate and detach the small descriptor before the queued task retains its
 * exclusively transferred buffer. Actual raster equality is a later use proof. */
function nativeInput(value:unknown,width:number,height:number):NativeInput {
 if(!value||typeof value!=='object'||Array.isArray(value)||
   ![Object.prototype,null].includes(Object.getPrototypeOf(value))||Object.keys(value).some(key=>!['descriptor','pixels','ticketId'].includes(key))||
   !Object.hasOwn(value,'descriptor')||!Object.hasOwn(value,'pixels'))throw Error('기록 native 입력 형식 오류');
 const input=value as {descriptor:unknown;pixels:unknown;ticketId?:unknown},descriptor=parseNativeYuvMetadata(input.descriptor),plan=planNativeYuvFrame(descriptor);
 if(Object.hasOwn(input,'ticketId')&&!preparationTicketId(input.ticketId))throw Error('기록 native 변환 증명 식별 오류');
 const pixels=input.pixels;
 if(plan.width!==width||plan.height!==height||!(pixels instanceof Uint8Array)||!(pixels.buffer instanceof ArrayBuffer)||
   pixels.byteOffset!==0||pixels.byteLength!==plan.nativeByteLength||pixels.buffer.byteLength!==plan.nativeByteLength||
   (pixels.buffer as ArrayBuffer&{resizable?:boolean}).resizable===true)throw Error('기록 native 입력 크기 오류');
 return {descriptor,pixels:new Uint8Array(pixels.buffer),bytes:plan.nativeByteLength+plan.rgbaByteLength,
  ...(input.ticketId?{ticketId:input.ticketId as string}:{})};
}
async function append(parts:BlobPart[]){
 const blobSize=parts.reduce<number>((n,part)=>n+(ArrayBuffer.isView(part)?part.byteLength:part instanceof ArrayBuffer?part.byteLength:part instanceof Blob?part.size:new TextEncoder().encode(part).length),0);
 if(bytes+blobSize>LIMIT)throw Error('무손실 기록 1GB 한도');
 if(parts.length>3){const joined=new Uint8Array(blobSize);let offset=0;for(const part of parts){const data=ArrayBuffer.isView(part)?new Uint8Array(part.buffer,part.byteOffset,part.byteLength):new Uint8Array(part instanceof ArrayBuffer?part:await new Blob([part]).arrayBuffer());joined.set(data,offset);offset+=data.length;}return append([joined]);}
 if(sync){for(const part of parts){const data=ArrayBuffer.isView(part)||part instanceof ArrayBuffer?part:part instanceof Blob?await part.arrayBuffer():new TextEncoder().encode(part);const written=sync.write(data,{at:bytes});if(written!==data.byteLength)throw Error('기록 파일 일부 쓰기 실패');bytes+=written;}}
 else {await writer.write(new Blob(parts));bytes+=blobSize;}
 journal?.update(bytes);
}
function enqueue(lane:RecordingWorkLane,work:()=>Promise<void>,onError?:(error:string)=>void,release?:()=>Promise<void>){
 const accepted=workQueue.enqueue(lane,{
  async run(){if(failed){onError?.(failed);return;}await work();},
  onError(error){failed ||= String(error);onError?.(failed);},release,
 });
 if(accepted)return;
 // Producer windows ordinarily enforce these same bounds. A malformed burst
 // must still preserve the admitted prefix and release any transferred input.
 const error='기록 작업 대기 한도 초과';sourceRejection ??= error;
 if(lane==='event')reportEventsFailure(error);
 void workQueue.barrier(async()=>{
  try{await release?.();}finally{failed ||= error;onError?.(failed);if(canonicalObserved)reportSourceFailure(failed);}
 }).catch(error=>{failed ||= String(error);});
}
function reportSourceFailure(error:string){
 if(sourceFailureReported)return;sourceFailureReported=true;
 // Canonical producers reject every pending source on this one global error.
 // A rejected-frame burst must not manufacture one queued callback per ID.
 port.postMessage({kind:'source-error',canonical:true,error});
}
function reportEventsFailure(error:string){
 if(eventsFailureReported)return;eventsFailureReported=true;
 self.postMessage({kind:'events-error',error:error.slice(0,2000)});
}
function rejectInput(m:{bitmap?:{close():void};native?:unknown;pixels?:unknown},inputBytes:number,error:unknown){
 try{m.bitmap?.close();}catch{/* Ownership ends even if native close fails. */}
 try{m.native=undefined;m.bitmap=undefined;m.pixels=undefined;}catch{/* MessagePort clones are ordinarily mutable. */}
 port.postMessage({kind:'credit',bytes:inputBytes});
 if(sourceRejection!==undefined)return;
 sourceRejection=(failed||String(error)||'기록 원본 입력 거부').slice(0,2000);
 if(failed){if(canonicalObserved)reportSourceFailure(failed);return;}
 // Preserve the already-admitted prefix. This single ordered barrier runs
 // after its writes, ACKs and releases; later rejected inputs add no promises.
 void workQueue.barrier(()=>{failed ||= sourceRejection!;if(canonicalObserved)reportSourceFailure(failed);}).catch(error=>{failed ||= String(error);});
}
function finish(){
 if(!requested||!ended||closing)return;closing=true;
 void workQueue.barrier(async()=>{
  if(disposing)return;
  await rasterPipeline.drain();await rasterPipeline.dispose();
  if(disposing)return;
  if(attestationInbox){
   // A rejected capability makes the recording partial. Preserve and publish
   // already committed bytes rather than hiding the prefix behind finish().
   if(attestationInbox.stats.pending||attestationInbox.stats.waiting||attestationInbox.stats.failed)failed ||= '미사용 또는 실패한 기록 변환 증명';
   attestationInbox.dispose();
  }
  if(sync){sync.flush();sync.close();sync=undefined;}else await writer.close();const blob=await(await directory.getFileHandle(name)).getFile();
  finishedBlob=blob;journal?.seal(bytes);
  self.postMessage({kind:'done',blob,stats:{frames,events,dropped,bytes,peakQueuedBytes,peakWorkingBytes,readbackMs,encodeMs,compressionEngine:compression.engine,
    rasterEngine:rasterPipeline.engine,raster:rasterPipeline.stats,complete:!failed&&!dropped&&frames>0,error:failed,
    ...(canonicalObserved?{canonical:true}:{}),...(compactMode?{storageVersion:1,nativeFrames,rgbaFrames}:{}),
    ...(codecPolicy?{codec:RGBA_WINDOW_CODEC,policy:codecPolicy}:{}),
    ...(attestationIdentity?{nativeAttestedFrames,nativeAttestationBudget:'native-owned-v1'}:{})}});
 }).catch(error=>self.postMessage({kind:'error',error:String(error)}));
}
self.onmessage=async(event:MessageEvent)=>{
 const data=event.data;
 if(data.kind==='init'){
  try{
   if(data.storageVersion!==undefined&&data.storageVersion!==1)throw Error('지원하지 않는 기록 저장 버전');
   if(data.codecPolicy!==undefined&&data.codecPolicy!==RGBA_WINDOW_POLICY||
     data.codecPolicy!==undefined&&(data.storageVersion!==undefined||data.attestation!==undefined))throw Error('지원하지 않는 RGBA 저장 정책');
   codecPolicy=data.codecPolicy;
   canonicalIndex=new CanonicalFrameIndex(codecPolicy?{codecPolicy}:{});
   compactMode=data.storageVersion===1;canonicalObserved=compactMode||codecPolicy!==undefined;
   if(data.attestation!==undefined){
    if(!compactMode)throw Error('native 변환 증명에는 compact 기록이 필요합니다.');
    const capability=preparationObject(data.attestation,['version','sessionId','producerId','port']);
    attestationIdentity=parsePreparationAttestationIdentity({version:capability.version,sessionId:capability.sessionId,producerId:capability.producerId});
    attestationInbox=createPreparedNativeAttestationInbox(capability.port as MessagePort,attestationIdentity);
   }
   compression=await createRecordingCompression();
   rasterPipeline=await createRecordingRasterPipeline();
   directory=await(await navigator.storage.getDirectory()).getDirectoryHandle('loacard-exact',{create:true});
   const entries=directory as FileSystemDirectoryHandle&{keys():AsyncIterable<string>};
   for await(const entry of entries.keys()){const stamp=/^(\d+)-[\da-f-]+\.bin$/.exec(entry);if(stamp&&Date.now()-Number(stamp[1])>86400000)await directory.removeEntry(entry).catch(()=>{});}
   name=`${Date.now()}-${crypto.randomUUID()}.bin`;const handle=await directory.getFileHandle(name,{create:true});
   if('createSyncAccessHandle' in handle)sync=await (handle as FileSystemFileHandle&{createSyncAccessHandle():Promise<NonNullable<typeof sync>>}).createSyncAccessHandle();
   else writer=await handle.createWritable();
   port=data.port;port.onmessage=e=>{
    const m=e.data;
    if(m.kind==='drain'){
      if(!drainPending){drainPending=true;void workQueue.barrier(()=>{drainPending=false;port.postMessage({kind:'drained'});}).catch(error=>{failed ||= String(error);});}return;
    }
    if(m.kind==='end'){peakQueuedBytes=Math.max(peakQueuedBytes,m.peakInFlightBytes??0);ended=true;finish();return;}
    if(m.kind==='gap'){dropped++;return;}
    if(m.kind!=='frame')return;
    // Diagnostic durations stay in this worker's clock domain. They are not
    // capture timestamps, storage proof, or permission to reuse an analysis.
    const timed=compactMode&&Number.isSafeInteger(m.id)&&m.id>=1&&m.id<=SOURCE_STORE_TIMING_LIMIT;
    const receivedAt=timed?performance.now():undefined;
    if(m.canonical===true)canonicalObserved=true;
    const hasNative=Object.hasOwn(m,'native');
    let inputBytes=0,native:NativeInput|undefined,validationError:unknown;
    try{inputBytes=recordingInputBytes(m);}catch(error){validationError=error;}
    if(hasNative&&m.native?.pixels instanceof Uint8Array)inputBytes+=m.native.pixels.byteLength;
    if(sourceRejection!==undefined||failed){rejectInput(m,inputBytes,sourceRejection??failed);return;}
    try{
     if(validationError!==undefined)throw validationError;
     if(ended||disposing)throw Error('종료된 기록에 원본을 추가할 수 없습니다.');
     if(compactMode&&m.canonical!==true)throw Error('공통 원본만 compact 기록에 사용할 수 있습니다.');
     if(codecPolicy&&(m.canonical!==true||hasNative||!windowWorkingSet(m.width,m.height).admitted))throw Error('RGBA window 기록에는 지원 크기의 공통 RGBA 원본이 필요합니다.');
     if(hasNative){
      // Charge the received bytes before validation too. Rejected payloads
      // release immediately and never enter the pending set.
      if(!compactMode||m.canonical!==true)throw Error('native 원본에는 compact 공통 기록이 필요합니다.');
      if(m.bitmap!==undefined||m.pixels!==undefined)throw Error('혼합된 기록 픽셀 입력');
      native=nativeInput(m.native,m.width,m.height);inputBytes=native.bytes;
      if(!!attestationInbox!==!!native.ticketId)throw Error('요청한 native 변환 증명과 입력 티켓 불일치');
      // The attested path has no generated RGBA scratch. Keep the same128MiB
      // admission limit, charging the native bytes this worker actually owns.
      // Other pipeline stages retain their independent RGBA reservations.
      if(attestationInbox)inputBytes=native.bytes=native.pixels.byteLength;
     }
     if(queuedJobs>=MAX_PENDING_JOBS||queuedBytes+inputBytes>PENDING_LIMIT)throw Error('기록 픽셀 작업 한도 초과');
    }catch(error){validationError=error;}
    if(validationError!==undefined){native=undefined;rejectInput(m,inputBytes,validationError);return;}
    queuedJobs++;queuedBytes+=inputBytes;peakQueuedBytes=Math.max(peakQueuedBytes,queuedBytes);
    // Start conversion before the append slot runs. The independent raster
    // worker can prepare the next immutable frame during this frame's codec.
    // Its byte reservation remains owned until the codec slot releases it.
    const rasterJob=!hasNative?rasterPipeline.submit(m):undefined;
    enqueue('frame',async()=>{
     const isCanonical=m.canonical===true;
     if(canonicalMode!==undefined&&canonicalMode!==isCanonical)throw Error('정규 입력과 이전 기록 채널을 함께 사용할 수 없습니다.');
     canonicalMode=isCanonical;
     if(isCanonical&&(!sync||disposing))throw Error('실시간 정규 입력 읽기를 지원하지 않는 저장소입니다.');
     if(!Number.isSafeInteger(m.id)||m.id<1||!Number.isFinite(m.time)||m.time<0||
       isCanonical&&!['input','backup','recovery'].includes(m.role)||
       m.phase!==undefined&&m.phase!=='input'&&m.phase!=='recovery')throw Error('정규 입력 식별 또는 시각 오류');
     const start=performance.now();
     let prepareMs=0,packMs=0,compressMs=0,appendMs=0;
     let pixels:Uint8Array<ArrayBuffer>,hash:string,storage:FrameStorage|undefined,attestation:PreparedNativeAttestation|undefined;
     const prepareStarted=timed?performance.now():0;
     if(native){
      if(attestationInbox){
       const authority=await attestationInbox.take(native.ticketId!,{sourceFrameId:m.id,captureTime:m.time},m.width,m.height,attestationAbort.signal);
       const verified=await verifyAttestedPreparedNative(authority,{descriptor:native.descriptor,pixels:native.pixels},attestationAbort.signal);
       // The verifier transfer-clones before awaiting hashes. Its returned
       // bytes are the sole owner; the caller's old alias is now detached.
       pixels=verified.pixels;hash=verified.hash;storage=verified.storage;attestation=verified.attestation;
      }else{
       const prepared=await prepareNativeStorage(native.descriptor,native.pixels);
       pixels=native.pixels;hash=prepared.rgbaHash;storage=prepared.storage;
      }
     }else{
      const raster=await rasterJob!.read();pixels=raster.pixels;
      readbackMs+=raster.readbackMs+(Number.isFinite(m.readbackMs)?m.readbackMs:0);
      if(!Number.isInteger(m.width)||!Number.isInteger(m.height)||pixels.length!==m.width*m.height*4||pixels.length>MAX_FRAME_BYTES)throw Error('입력 크기 초과');
      hash=await pixelHash(pixels);if(compactMode)storage=rgbaFrameStorage(m.width,m.height);
     }
     if(timed)prepareMs=performance.now()-prepareStarted;
     if(disposing)throw new DOMException('정규 입력 저장소 종료','AbortError');
     const signature=frameStorageSignature(storage,m.width,m.height);
     const key=!previous||width!==m.width||height!==m.height||previousStorageSignature!==signature||
       isCanonical&&canonicalIndex.keyRequired(m.width,m.height,storage);
     const packStarted=timed?performance.now():0;
     const delta=packPixels(pixels,key?undefined:previous,true);
     if(timed)packMs=performance.now()-packStarted;
     peakWorkingBytes=Math.max(peakWorkingBytes,queuedBytes+(previous?.length??0)+delta.length);
     const compressStarted=timed?performance.now():0;
     const compressed=compression.compress(delta);
     if(timed)compressMs=performance.now()-compressStarted;
     peakWorkingBytes=Math.max(peakWorkingBytes,queuedBytes+(previous?.length??0)+delta.length*2+compressed.length+262144);
     const offset=bytes;
     const appendStarted=timed?performance.now():0;
     await append(entryParts({kind:'frame',id:m.id,time:m.time,width:m.width,height:m.height,phase:m.phase,key,hash,codec:codecPolicy?RGBA_WINDOW_CODEC:'lz4',xor:true,
       ...(codecPolicy?{policy:codecPolicy}:{}),
       ...(isCanonical?{canonical:true}:{}),...(storage?{storage}:{})},compressed));
     if(timed)appendMs=performance.now()-appendStarted;
     if(disposing)throw new DOMException('정규 입력 저장소 종료','AbortError');
     if(isCanonical){
       canonicalIndex.append({sourceFrameId:m.id,frameId:m.id,offset,endOffset:bytes,width:m.width,height:m.height,
         captureTime:m.time,arrivalOrder:frames,key,pixelHash:hash,role:m.role,...(storage?{storage}:{}),
         ...(codecPolicy?{codec:RGBA_WINDOW_CODEC,policy:codecPolicy}:{})});
       const ackAt=timed?performance.now():0;
       port.postMessage({kind:attestation?'stored-attested':'stored',id:m.id,width:m.width,height:m.height,time:m.time,hash,
         ...(attestation?{attestation}:{}),
         ...(timed?{timing:{version:1,path:native?'native':'rgba',queuedMs:start-receivedAt!,prepareMs,packMs,compressMs,appendMs,
           workMs:ackAt-start,receiveToAckMs:ackAt-receivedAt!}}:{})});
     }
     previous=pixels;previousStorageSignature=signature;width=m.width;height=m.height;frames++;
     if(native)nativeFrames++;else rgbaFrames++;
     if(attestation)nativeAttestedFrames++;
     encodeMs+=performance.now()-start;
    },m.canonical===true?reportSourceFailure:undefined,async()=>{
     // enqueue skips work after a prior failure. Even then the already-started
     // raster job must settle and release its transferred payload before drain.
     try{await rasterJob?.release();}finally{
      // The predecessor owns native bytes only after commit. Dropped/skipped
      // jobs must also release their original transferred references.
      if(!rasterJob)try{m.bitmap?.close();}catch{/* malformed optional bitmap */}
      native=undefined;try{m.native=undefined;}catch{/* Transferred buffers are not retained after this slot. */}
      queuedJobs--;queuedBytes-=inputBytes;
      port.postMessage({kind:'credit',bytes:inputBytes});
     }
    });
   };port.start();self.postMessage({kind:'ready',supportsSourceReads:!!sync,...(compactMode?{storageVersion:1}:{}),
    ...(codecPolicy?{codecPolicy,codec:RGBA_WINDOW_CODEC}:{}),
    ...(attestationIdentity?{attestation:attestationIdentity}:{})});
  }catch(error){attestationInbox?.dispose(error);await rasterPipeline?.dispose(error);self.postMessage({kind:'error',error:String(error)});}
 }else if(data.kind==='read-frame'){
  const requestId=data.requestId,id=data.id;
  if(!Number.isSafeInteger(requestId)||requestId<1||!Number.isSafeInteger(id)||id<1||reads.has(requestId)||reads.size>=8||disposing){
    self.postMessage({kind:'read-error',requestId,error:'정규 입력 읽기 요청 오류'});return;
  }
  const controller=new AbortController();reads.set(requestId,controller);
  // Serialize this read behind committed writes, but do not alter the writer's
  // delta predecessor. The producer awaits stored ACKs before requesting it.
  void workQueue.barrier(async()=>{
   try{
    controller.signal.throwIfAborted();
    if(!sync&&!finishedBlob)throw Error('실시간 정규 입력 읽기를 지원하지 않는 저장소입니다.');
    const range=canonicalIndex.decodeRange(id);
    const descriptors=range.frameIds.map(frameId=>{
      const descriptor=canonicalIndex.getByFrameId(frameId);
      if(!descriptor)throw Error('정규 입력 기준 프레임 누락');return descriptor;
    });
    const read=async(offset:number,length:number)=>{
      if(offset+length>bytes)throw Error('정규 입력의 저장이 끝나지 않았습니다.');
      if(sync){const buffer=new Uint8Array(length),count=sync.read(buffer,{at:offset});if(count!==length)throw Error('정규 입력 일부 읽기 실패');return buffer;}
      return new Uint8Array(await finishedBlob!.slice(offset,offset+length).arrayBuffer());
    };
    // The write barrier owns this committed prefix until the read/hash returns.
    // Its revision detects archive lifetime/range changes, not source identity.
    const source=codecPolicy?{snapshot:()=>({byteLength:bytes,revision:`${name}:${bytes}`}),read}:undefined;
    const raw=await readCanonicalFrame({frames:descriptors,signal:controller.signal,read,
      ...(codecPolicy?{codecPolicy,source}:{}),});
    controller.signal.throwIfAborted();
    self.postMessage({kind:'read-frame',requestId,raw},{transfer:[raw.pixels.buffer]});
   }catch(error){
    if(!(error instanceof RangeError)&&!controller.signal.aborted)failed ||= String(error);
    self.postMessage({kind:'read-error',requestId,error:String(error)});
   }finally{reads.delete(requestId);}
  }).catch(error=>{failed ||= String(error);});
 }else if(data.kind==='read-cancel'){
  reads.get(data.requestId)?.abort(new DOMException('정규 입력 읽기 취소','AbortError'));
 }else if(data.kind==='journal-start'){
  if(journalStarted){self.postMessage({kind:'journal-error',error:'기록 저널이 이미 연결되었습니다.',mirror:journal?.stats});return;}
  journalStarted=true;
  void workQueue.barrier(()=>{
   if(disposing||journalStopped)return;
   journal=createArchiveJournalMirror({
    read(offset,length){
     if(sync){const buffer=new Uint8Array(length),read=sync.read(buffer,{at:offset});if(read!==length)throw Error('기록 저널 일부 읽기 실패');return new Blob([buffer]);}
     // Writable-stream fallbacks publish committed bytes after close. No full
     // ArrayBuffer is retained while waiting for their final File snapshot.
     return finishedBlob?.slice(offset,offset+length);
    },
    send(sequence,blob){self.postMessage({kind:'journal-chunk',sequence,blob,mirror:journal?.stats});},
    incomplete(error){self.postMessage({kind:'journal-error',error,mirror:journal?.stats});},
    complete(){const mirror=journal?.stats;self.postMessage({kind:'journal-done',stats:mirror,mirror});},
   });
   if(finishedBlob)journal.seal(bytes);else journal.update(bytes);
  }).catch(error=>self.postMessage({kind:'journal-error',error:String(error),mirror:journal?.stats}));
 }else if(data.kind==='journal-credit')journal?.acknowledge(data.sequence,data.bytes);
 else if(data.kind==='journal-stop'){journalStopped=true;journal?.stop(data.error);}
 else if(data.kind==='events'){
  // The admitted prefix may still be running behind its failure barrier.
  // Later rejected batches must not add jobs, barriers or error callbacks.
  if(eventsFailureReported)return;
  if(failed||sourceRejection!==undefined){reportEventsFailure(failed||sourceRejection!);return;}
  if(closing||disposing){failed ||= '종료된 기록에 이벤트를 추가할 수 없습니다.';reportEventsFailure(failed);return;}
  enqueue('event',async()=>{
   const batch=data.events as ExactEvent[];await append(batch.flatMap(entry=>entryParts(entry)));events+=batch.length;
   self.postMessage({kind:'events-written'});
  },reportEventsFailure);
 }else if(data.kind==='finish'){requested=true;if(data.noSource)ended=true;finish();}
 else if(data.kind==='dispose'){
  if(disposing)return;
  disposing=true;for(const read of reads.values())read.abort(new DOMException('정규 입력 저장소 종료','AbortError'));
  attestationAbort.abort(new DOMException('정규 입력 변환 증명 중단','AbortError'));attestationInbox?.dispose(attestationAbort.signal.reason);
  journalStopped=true;journal?.stop();
  const stoppingRaster=rasterPipeline?.dispose(new DOMException('정규 입력 저장소 종료','AbortError'));
  await workQueue.barrier(async()=>{
   await stoppingRaster;if(sync){sync.close();sync=undefined;}else await writer?.abort().catch(()=>{});if(name)await directory?.removeEntry(name).catch(()=>{});self.postMessage({kind:'disposed'});
  });
 }
};
