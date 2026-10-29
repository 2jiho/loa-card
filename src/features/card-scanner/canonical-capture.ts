import type {SnapshotSource} from './bitmap-dispatch';
import {SavedAcquisitions,type SavedAcquisition} from './saved-acquisition';
import type {ExactRecorder} from './exact-recording';
import {MAX_FRAME_BYTES} from './exact-recording-codec';
import type {CanonicalSourceUse} from './canonical-source-use';
import {parseNativeYuvMetadata} from './native-frame-storage';
import {planNativeYuvFrame,type NativeYuvFrameMetadata} from './native-yuv-recipe';
import {parseSourceRasterReceipt,type MeasuredSourceRasterReceipt,type SourceRasterReceipt} from './source-raster-receipt';
import {SourceStoreTiming,SOURCE_STORE_TIMING_LIMIT,type SourcePreparationTiming,type SourceStoreTimingSnapshot} from './source-store-timing';
import {parsePreparedNativeAttestation,type PreparedNativeAttestation} from './prepared-native-attestation';
import {parsePreparationAttestationIdentity,preparationTicketId,type SourcePreparationAttestationIdentity} from './source-preparation-protocol';

export type SourceRecord=Readonly<{id:number;width:number;height:number;time:number;elapsed:number;role:'input'|'backup'|'recovery'}>;
export interface CanonicalStoredReceipt {readonly id:number;readonly width:number;readonly height:number;readonly time:number;readonly hash:string;readonly attestation?:PreparedNativeAttestation}
/** Byte/count credit only. A physical source ID and bitmap are created on the
 * one commit attempt; releasing a replaced representative stores no source. */
export interface CanonicalRawLease {
  commit(source:SnapshotSource,time:number,elapsed:number,role?:'input'|'backup'):number|undefined;
  release():void;
}
export type CanonicalMeasuredRasterReceipt=MeasuredSourceRasterReceipt;
export type CanonicalRasterReceipt=SourceRasterReceipt;
export type PreparedCanonicalPayload={hash:string}&(
  {native:{descriptor:NativeYuvFrameMetadata;pixels:Uint8Array<ArrayBuffer>;ticketId?:string};pixels?:never}|
  {pixels:ArrayBuffer;native?:never});
type DispatchPayload={bitmap:ImageBitmap}|PreparedCanonicalPayload;
type SourcePort=Pick<MessagePort,'postMessage'|'start'|'close'|'onmessage'>;
type Store=Pick<ExactRecorder,'takePort'|'readFrame'|'incomplete'>;
type RawLeaseReservation={width:number;height:number;bytes:number;state:'held'|'committing'|'committed'|'released'|'invalidated'};
const SOURCE_RECORD_LIMIT=10_000;
const sha=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const wholeBuffer=(value:unknown,bytes:number):value is ArrayBuffer=>value instanceof ArrayBuffer&&
  value.byteLength===bytes&&(value as ArrayBuffer&{resizable?:boolean}).resizable!==true;

/** The main-owned, ordered source producer. Backups and selected inputs share
 * one physical store; acquisition IDs and source IDs remain different domains.
 * Mutable analyses stay here, not in a one-time worker structured clone. */
export function createCanonicalCapture(store:Store,report:(message:string)=>void,options:{
  bitmapFactory?:(source:SnapshotSource)=>Promise<ImageBitmap>;
  canvasFactory?:()=>HTMLCanvasElement;
  byteLimit?:number;
  onUse?:(value:CanonicalSourceUse)=>void;
  onRasterReceipt?:(value:CanonicalRasterReceipt)=>void;
  /** Explicit trusted-writer capability; it is not a full acquisition hash. */
  attestation?:SourcePreparationAttestationIdentity;
  onStorageAttestation?:(value:PreparedNativeAttestation)=>void;
  /** Return each independently restored RGBA buffer for the owned acquisition adapter. */
  ownedRgba?:boolean;
  /** Serialized recovery producer only; tighter test/platform deadline. */
  recoveryCapacityTimeoutMs?:number;
  /** Bounded optional diagnostics; never acquisition or completion evidence. */
  onTiming?:(value:SourceStoreTimingSnapshot)=>void;
}={}) {
  const byteLimit=options.byteLimit??128*1024*1024;
  const capacityTimeout=options.recoveryCapacityTimeoutMs??30_000;
  const attestationIdentity=options.attestation===undefined?undefined:parsePreparationAttestationIdentity(options.attestation);
  if(!Number.isSafeInteger(byteLimit)||byteLimit<1||byteLimit>128*1024*1024)throw Error('Invalid canonical source budget');
  if(!Number.isSafeInteger(capacityTimeout)||capacityTimeout<1||capacityTimeout>30_000)throw Error('Invalid recovery capacity deadline');
  const port:SourcePort=store.takePort(),analyses=new SavedAcquisitions();
  let remainingOriginalAnalysisIds:Set<number>|undefined;
  const records=new Map<number,SourceRecord>();
  const rawLeases=new Set<RawLeaseReservation>();
  const transferred=new Set<number>(),committed=new Set<number>();
  const acks=new Map<number,CanonicalStoredReceipt>(),expectedHashes=new Map<number,string>();
  const expectedTickets=new Map<number,string>();
  const reservedPrepared=new Set<number>(),submitted=new Set<number>(),queued=new Map<number,DispatchPayload>();
  const measured=new Map<number,MeasuredSourceRasterReceipt>(),reused=new Map<number,CanonicalRasterReceipt>(),waitingRasterReceipts=new Map<number,CanonicalRasterReceipt[]>();
  const rasterAcquisitions=new Set<number>();
  const pending=new Map<number,{bytes:number;reservedAt:number;resolve:(receipt:CanonicalStoredReceipt)=>void;reject:(reason:unknown)=>void;done:Promise<CanonicalStoredReceipt>;timer:ReturnType<typeof setTimeout>}>();
  const timingStarted=performance.now(),timing=options.ownedRgba?new SourceStoreTiming():undefined,timingNow=()=>performance.now()-timingStarted;
  const reportTiming=()=>{if(timing&&options.onTiming)try{options.onTiming(timing.snapshot());}catch{/* Optional timing cannot stop pixel storage. */}};
  let nextId=0,bytes=0,peakBytes=0,leasedBytes=0,peakReservedBytes=0,failed='',ended=false,originalsClosed=false,readStarted=false;
  let nextDispatchId=1,reusedInputs=0,processingUses=0,reads=0,readMs=0,maxReadMs=0,preparedUses=0,rasterReceiptCount=0,waitingRasterCount=0;
  let capacityWaits=0,capacityWaitMs=0,maxCapacityWaitMs=0,closingSource=false,rebatedPreparedBytes=0;
  let capacityWaiter:{bytes:number;signal:AbortSignal;abort:()=>void;resolve:()=>void;reject:(error:unknown)=>void;timer:ReturnType<typeof setTimeout>;started:number}|undefined;
  let ending:Promise<void>|undefined;
  let drain:{done:Promise<void>;resolve:()=>void;timer:ReturnType<typeof setTimeout>}|undefined;
  const release=(payload:DispatchPayload)=>{if('bitmap' in payload)try{payload.bitmap.close();}catch{/* Continue releasing other owned payloads. */}};
  function releaseRawLease(lease:RawLeaseReservation,state:RawLeaseReservation['state'],wake=true){
    if(!rawLeases.delete(lease))return;
    leasedBytes-=lease.bytes;lease.state=state;if(wake)wakeCapacity();
  }
  function invalidateRawLeases(){
    for(const lease of rawLeases)lease.state='invalidated';
    rawLeases.clear();leasedBytes=0;
  }
  function hasRecoveryCapacity(size:number){
    // A permanently full physical index keeps reserve's existing failure path;
    // temporary lease slots must be released before another record can fit.
    return bytes+leasedBytes+size<=byteLimit&&
      (records.size>=SOURCE_RECORD_LIMIT||records.size+rawLeases.size<SOURCE_RECORD_LIMIT);
  }
  function settleCapacity(error?:unknown){
    const waiter=capacityWaiter;if(!waiter)return;capacityWaiter=undefined;
    clearTimeout(waiter.timer);waiter.signal.removeEventListener('abort',waiter.abort);
    const duration=Math.max(0,performance.now()-waiter.started);capacityWaitMs+=duration;maxCapacityWaitMs=Math.max(maxCapacityWaitMs,duration);
    if(error!==undefined)waiter.reject(error);else waiter.resolve();
  }
  function wakeCapacity(){
    if(!capacityWaiter)return;
    // Recording failure releases this wait into the controller's explicit
    // unrecorded-input path. It must not stop valid pixel acquisition.
    if(failed)settleCapacity();
    else if(closingSource||ended)settleCapacity(Error('공통 원본 전송이 종료됐습니다.'));
    else if(hasRecoveryCapacity(capacityWaiter.bytes))settleCapacity();
  }
  function dispatch(){
    while(!failed&&!ended){
      const payload=queued.get(nextDispatchId),record=records.get(nextDispatchId);
      if(!payload||!record)return;
      queued.delete(nextDispatchId++);
      const transfer:Transferable[]='bitmap' in payload?[payload.bitmap]:payload.native?[payload.native.pixels.buffer]:[payload.pixels];
      try{
        transferred.add(record.id);
        timing?.dispatch(record.id,timingNow());
        const data='bitmap' in payload?{bitmap:payload.bitmap}:payload.native?{native:payload.native}:{pixels:payload.pixels};
        port.postMessage({kind:'frame',...record,phase:record.role==='recovery'?'recovery':'input',canonical:true,...data},transfer);
      }catch(reason){release(payload);fail(`공통 원본 전송 실패: ${String(reason)}`);}
    }
  }
  function enqueue(id:number,payload:DispatchPayload){
    if(failed||ended){release(payload);return;}
    queued.set(id,payload);dispatch();
  }
  function fail(message:string){
    if(failed)return;failed=message;
    invalidateRawLeases();
    if(timing){
      const now=performance.now();
      timing.fail(message,timingNow(),(function*(){for(const [id,item]of pending)yield {id,ageMs:Math.max(0,now-item.reservedAt),bytes:item.bytes,
        prepared:submitted.has(id),transferred:transferred.has(id)};})());
      reportTiming();
    }
    for(const payload of queued.values())release(payload);
    queued.clear();waitingRasterReceipts.clear();waitingRasterCount=0;
    for(const item of pending.values()){clearTimeout(item.timer);item.reject(Error(message));}
    pending.clear();bytes=0;wakeCapacity();
    try{store.incomplete(message);}catch{/* Optional reporting cannot own pixels. */}
    try{report(message);}catch{/* Cleanup must still end the source. */}
    try{port.postMessage({kind:'gap'});}catch{/* Source cleanup remains available. */}
  }
  port.onmessage=event=>{
    const value=event.data;
    if(!value||typeof value!=='object'){fail('공통 원본 저장 응답 형식 오류');return;}
    if(value.kind==='drained'){if(drain){clearTimeout(drain.timer);drain.resolve();}return;}
    if(value.kind==='source-error'){fail(`공통 원본 저장 실패: ${String(value.error)}`);return;}
    if(value.kind!=='stored'&&value.kind!=='stored-attested')return;
    // A producer failure cancels unsent copies, not already committed pixels.
    // ACKs from transferred frames may arrive after pending promises rejected.
    if(!records.has(value.id)||!transferred.has(value.id)){if(!failed)fail('공통 원본 저장 응답 불일치');return;}
    const record=records.get(value.id)!;
    if(value.width!==record.width||value.height!==record.height||value.time!==record.time||!sha(value.hash)||
      expectedHashes.has(value.id)&&expectedHashes.get(value.id)!==value.hash){
      if(!failed)fail('공통 원본 저장 픽셀 근거 불일치');return;
    }
    let attestation:PreparedNativeAttestation|undefined;
    try{
      const expectedTicket=expectedTickets.get(record.id);
      if(expectedTicket){
        if(value.kind!=='stored-attested'||!attestationIdentity)throw Error('native 변환 증명 저장 응답 누락');
        attestation=parsePreparedNativeAttestation(value.attestation);
        if(attestation.ticketId!==expectedTicket||attestation.sessionId!==attestationIdentity.sessionId||attestation.producerId!==attestationIdentity.producerId||
          attestation.sourceFrameId!==record.id||attestation.captureTime!==record.time||attestation.width!==record.width||attestation.height!==record.height||
          attestation.generatedRgbaSha256!==value.hash)throw Error('native 변환 증명 저장 응답 불일치');
      }else if(value.kind!=='stored'||Object.hasOwn(value,'attestation'))throw Error('요청하지 않은 native 변환 증명 응답');
    }catch(error){if(!failed)fail(String(error));return;}
    const receipt=Object.freeze({id:record.id,width:record.width,height:record.height,time:record.time,hash:value.hash,
      ...(attestation?{attestation}:{})});
    const firstAck=!acks.has(record.id);
    if(firstAck)timing?.ack(record.id,timingNow(),value.timing);
    committed.add(value.id);acks.set(value.id,receipt);
    const item=pending.get(value.id);
    if(!item){if(!failed)fail('공통 원본 저장 응답 불일치');if(firstAck&&record.id<=SOURCE_STORE_TIMING_LIMIT)reportTiming();return;}
    clearTimeout(item.timer);pending.delete(value.id);bytes-=item.bytes;item.resolve(receipt);wakeCapacity();
    const waiting=waitingRasterReceipts.get(value.id);
    waitingRasterReceipts.delete(value.id);
    if(waiting){waitingRasterCount-=waiting.length;for(const measured of waiting)joinRasterReceipt(measured,receipt);}
    if(firstAck&&attestation)try{options.onStorageAttestation?.(attestation);}catch(error){fail(`변환 증명 기록 실패: ${String(error)}`);}
    // Release storage credits and proof joins before optional diagnostic sinks.
    if(firstAck&&record.id<=SOURCE_STORE_TIMING_LIMIT)reportTiming();
  };
  port.start();
  function reserve(input:Omit<SourceRecord,'id'|'role'>&{role?:SourceRecord['role']},reservationBytes?:number,prepared=true){
    const {width,height,time,elapsed}=input,role=input.role??'backup';
    if(failed||ended||closingSource||ending||originalsClosed&&role!=='recovery')return;
    const rgbaBytes=width*height*4,size=reservationBytes??rgbaBytes*(prepared?2:1);
    if(!Number.isSafeInteger(width)||width<1||!Number.isSafeInteger(height)||height<1||!Number.isFinite(time)||time<0||!Number.isFinite(elapsed)||elapsed<0||
      !['input','backup','recovery'].includes(role)||!Number.isSafeInteger(size)||size<rgbaBytes)return;
    if(rgbaBytes>MAX_FRAME_BYTES||bytes+leasedBytes+size>byteLimit||records.size+rawLeases.size>=SOURCE_RECORD_LIMIT){fail('공통 원본 캡처 용량 한도 초과 · 연속 영상 보완은 계속됩니다.');return;}
    const id=++nextId,record:SourceRecord=Object.freeze({id,width,height,time,elapsed,role});
    let resolve!:(receipt:CanonicalStoredReceipt)=>void,reject!:(reason:unknown)=>void;
    const done=new Promise<CanonicalStoredReceipt>((yes,no)=>{resolve=yes;reject=no;});void done.catch(()=>{});
    pending.set(id,{bytes:size,reservedAt:performance.now(),resolve,reject,done,timer:setTimeout(()=>fail('공통 원본 저장 시간 초과'),30_000)});
    records.set(id,record);if(prepared)reservedPrepared.add(id);
    bytes+=size;peakBytes=Math.max(peakBytes,bytes);peakReservedBytes=Math.max(peakReservedBytes,bytes+leasedBytes);
    timing?.reserve(record,size,bytes,timingNow());return record;
  }
  function submitRaw(source:SnapshotSource,width:number,height:number,time:number,elapsed:number,role:SourceRecord['role']) {
    const record=reserve({width,height,time,elapsed,role},width*height*4,false);
    if(!record)return;submitted.add(record.id);
    // Start the immutable snapshot now, but dispatch only after all earlier
    // source reservations are ready. Rejections never wait behind an older copy.
    try{void (options.bitmapFactory??(source=>createImageBitmap(source)))(source).then(
      bitmap=>{timing?.prepared(record.id,timingNow());enqueue(record.id,{bitmap});},reason=>fail(`공통 원본 전송 실패: ${String(reason)}`));
    }catch(reason){fail(`공통 원본 전송 실패: ${String(reason)}`);}
    return record.id;
  }
  function submit(source:SnapshotSource,time:number,elapsed:number,role:SourceRecord['role']='backup') {
    const width='displayWidth' in source?source.displayWidth:'videoWidth' in source?source.videoWidth:source.width;
    const height='displayHeight' in source?source.displayHeight:'videoHeight' in source?source.videoHeight:source.height;
    return submitRaw(source,width,height,time,elapsed,role);
  }
  function rawCapacity(width:number,height:number,role:SourceRecord['role']='input'):'available'|'busy'|'unavailable'{
    if(failed||ended||closingSource||ending||originalsClosed&&role!=='recovery'||records.size>=SOURCE_RECORD_LIMIT||
      !['input','backup','recovery'].includes(role))return 'unavailable';
    const size=width*height*4;
    if(!Number.isSafeInteger(width)||width<1||!Number.isSafeInteger(height)||height<1||
      !Number.isSafeInteger(size)||size>MAX_FRAME_BYTES||size>byteLimit)return 'unavailable';
    return bytes+leasedBytes+size>byteLimit||records.size+rawLeases.size>=SOURCE_RECORD_LIMIT?'busy':'available';
  }
  function leaseRaw(width:number,height:number):CanonicalRawLease|undefined{
    if(rawCapacity(width,height)!=='available')return;
    const lease:RawLeaseReservation={width,height,bytes:width*height*4,state:'held'};
    rawLeases.add(lease);leasedBytes+=lease.bytes;peakReservedBytes=Math.max(peakReservedBytes,bytes+leasedBytes);
    return Object.freeze({
      commit(source:SnapshotSource,time:number,elapsed:number,role:'input'|'backup'='input'){
        if(lease.state!=='held'||!rawLeases.has(lease))return;
        lease.state='committing';let id:number|undefined;
        try{
          const actualWidth='displayWidth' in source?source.displayWidth:'videoWidth' in source?source.videoWidth:source.width;
          const actualHeight='displayHeight' in source?source.displayHeight:'videoHeight' in source?source.videoHeight:source.height;
          if(actualWidth!==lease.width||actualHeight!==lease.height||!Number.isFinite(time)||time<0||
            !Number.isFinite(elapsed)||elapsed<0||!['input','backup'].includes(role)||!rawLeases.has(lease))return;
          // No wake occurs between dropping the held credit and reserve taking
          // that same credit. No caller or recovery waiter can steal the slot.
          releaseRawLease(lease,'committed',false);
          id=submitRaw(source,lease.width,lease.height,time,elapsed,role);return id;
        }finally{
          if(lease.state==='committing')releaseRawLease(lease,'released');
          else if(id===undefined)wakeCapacity();
        }
      },
      release(){if(lease.state==='held')releaseRawLease(lease,'released');},
    });
  }
  function submitPrepared(id:number,payload:PreparedCanonicalPayload){
    if(failed||ended)throw Error(failed||'공통 원본 종료');
    const record=records.get(id),item=pending.get(id);
    try{
      if(!record||!item||!reservedPrepared.has(id)||submitted.has(id)||!payload||typeof payload!=='object'||Array.isArray(payload)||
        ![Object.prototype,null].includes(Object.getPrototypeOf(payload))||!sha(payload.hash)||Object.keys(payload).length!==2)
        throw Error('공통 준비 원본 근거 오류');
      const rgbaBytes=record.width*record.height*4;
      let data:PreparedCanonicalPayload,requiredBytes:number;
      if(payload.native){
        if(!Object.hasOwn(payload,'native')||Object.hasOwn(payload,'pixels')||Object.keys(payload.native).some(key=>!['descriptor','pixels','ticketId'].includes(key))||
          !Object.hasOwn(payload.native,'descriptor')||!Object.hasOwn(payload.native,'pixels'))throw Error('중복 공통 원본 표현');
        const hasTicket=Object.hasOwn(payload.native,'ticketId');
        if(attestationIdentity?!hasTicket||!preparationTicketId(payload.native.ticketId):hasTicket)throw Error('준비된 native 변환 증명 요청 불일치');
        const descriptor=parseNativeYuvMetadata(payload.native.descriptor),plan=planNativeYuvFrame(descriptor),native=payload.native.pixels;
        if(plan.width!==record.width||plan.height!==record.height||!(native instanceof Uint8Array)||native.byteOffset!==0||
          !wholeBuffer(native.buffer,plan.nativeByteLength)||native.byteLength!==plan.nativeByteLength)throw Error('준비된 native 원본 크기 오류');
        // This explicitly configured writer verifies native bytes without
        // allocating RGBA. Preparation/acquisition keep their own unchanged
        // RGBA reservations; this store owns only the transferred native data.
        requiredBytes=attestationIdentity?native.byteLength:rgbaBytes+native.byteLength;
        data={hash:payload.hash,native:{descriptor,pixels:native,...(hasTicket?{ticketId:payload.native.ticketId}:{})}};
        if(hasTicket)expectedTickets.set(id,payload.native.ticketId!);
      }else{
        if(!Object.hasOwn(payload,'pixels')||Object.hasOwn(payload,'native')||!wholeBuffer(payload.pixels,rgbaBytes))throw Error('준비된 RGBA 원본 크기 오류');
        requiredBytes=rgbaBytes*2;data={hash:payload.hash,pixels:payload.pixels};
      }
      if(requiredBytes>item.bytes)throw Error('준비 원본 예약 바이트 부족');
      // Detach caller aliases immediately even if an earlier source is still
      // preparing. Queued bytes now have exactly one owner until port transfer.
      const owned=structuredClone(data,{transfer:data.native?[data.native.pixels.buffer]:[data.pixels]});
      if(attestationIdentity&&data.native){
        const rebate=item.bytes-requiredBytes;
        item.bytes=requiredBytes;bytes-=rebate;rebatedPreparedBytes+=rebate;wakeCapacity();
      }
      submitted.add(id);expectedHashes.set(id,data.hash);timing?.prepared(id,timingNow());enqueue(id,owned);
    }catch(reason){fail(`공통 준비 원본 전송 실패: ${String(reason)}`);throw reason;}
  }
  function verifyReusedOrigin(value:Extract<CanonicalRasterReceipt,{kind:'analysis-reused'}>){
    const origin=measured.get(value.originAcquisitionFrameId);
    if(value.originAcquisitionFrameId>=value.acquisitionFrameId||!origin||
      origin.sourceFrameId!==value.sourceFrameId||origin.captureTime!==value.captureTime||origin.width!==value.width||origin.height!==value.height||
      origin.hash!==value.hash||acks.get(value.sourceFrameId)?.hash!==value.hash)
      throw Error('공통 재사용 판독 원본 근거 불일치');
  }
  function joinRasterReceipt(value:CanonicalRasterReceipt,stored:CanonicalStoredReceipt){
    if(failed)return;
    if(value.hash!==stored.hash){fail('판독 픽셀과 저장 원본 해시 불일치');return;}
    if(value.kind==='measured')measured.set(value.acquisitionFrameId,value);
    else{verifyReusedOrigin(value);reused.set(value.acquisitionFrameId,value);}
    try{options.onRasterReceipt?.(value);}catch(reason){fail(`공통 픽셀 근거 기록 실패: ${String(reason)}`);}
  }
  const flush=async()=>{
    if(failed)throw Error(failed);
    await Promise.all([...pending.values()].map(item=>item.done));if(failed)throw Error(failed);
  };
  const drainTransferred=async(signal:AbortSignal)=>{
    signal.throwIfAborted();
    if(!drain){
      let resolve!:()=>void;
      const done=new Promise<void>(yes=>{resolve=yes;});
      drain={done,resolve,timer:setTimeout(()=>resolve(),10_000)};
      // This shares the producer port with frame messages. Its response joins
      // all preceding writes/ACKs even though the control port is independent.
      try{port.postMessage({kind:'drain'});}catch{clearTimeout(drain.timer);resolve();}
    }
    let aborted!:()=>void;
    const canceled=new Promise<never>((_,reject)=>{aborted=()=>reject(signal.reason);signal.addEventListener('abort',aborted,{once:true});});
    try{await Promise.race([drain.done,canceled]);signal.throwIfAborted();}
    finally{signal.removeEventListener('abort',aborted);}
  };
  const endSource=()=>{closingSource=true;invalidateRawLeases();wakeCapacity();return ending??=(async()=>{
    try{await flush();}catch{
      // Joining the producer port also protects finish() on the independent
      // control port from overtaking already transferred partial-source writes.
      await drainTransferred(new AbortController().signal);
    }
    if(ended)return;ended=true;port.postMessage({kind:'end',peakInFlightBytes:peakBytes});port.close();
  })();};
  return {
    submit,reserve,submitPrepared,leaseRaw,
    /** Advisory raw-byte credit only. Call submit in the same stack; the query
     * neither reserves an ID nor replaces submit's own fail-closed validation. */
    rawCapacity,
    notePreparation(id:number,value:SourcePreparationTiming){timing?.preparation(id,value);},
    /** A saved acquisition can outlive recording failure before its ACK. Its
     * measured raster is still useful input, but only an actually joined
     * measurement may be cited as an analysis-reuse origin. Otherwise acquire
     * the restored pixels again rather than inventing a committed origin. */
    canReuseAnalysis(receipt:unknown):boolean{
      try{
        const value=parseSourceRasterReceipt(receipt);if(value.kind!=='measured')return false;
        const origin=measured.get(value.acquisitionFrameId),stored=acks.get(value.sourceFrameId);
        return !!origin&&!!stored&&origin.sourceFrameId===value.sourceFrameId&&origin.captureTime===value.captureTime&&
          origin.width===value.width&&origin.height===value.height&&origin.hash===value.hash&&stored.hash===value.hash;
      }catch{return false;}
    },
    /** One serialized recovery caller may wait for existing ACK credits before
     * allocating a new source. This is not a reservation or a live FPS gate. */
    waitForRecoveryCapacity(size:number,signal:AbortSignal):Promise<void>{
      signal.throwIfAborted();
      if(!Number.isSafeInteger(size)||size<1||size>byteLimit)throw Error('복구 원본 예약 크기 오류');
      if(failed)return Promise.resolve();
      if(closingSource||ended)throw Error('공통 원본 전송이 종료됐습니다.');
      if(capacityWaiter)throw Error('동시 복구 원본 용량 대기는 허용되지 않습니다.');
      if(hasRecoveryCapacity(size))return Promise.resolve();
      capacityWaits++;
      return new Promise<void>((resolve,reject)=>{
        const abort=()=>settleCapacity(signal.reason??new DOMException('Recovery capacity wait aborted','AbortError'));
        capacityWaiter={bytes:size,signal,abort,resolve,reject,started:performance.now(),
          timer:setTimeout(()=>fail('공통 원본 저장 대기 시간 초과'),capacityTimeout)};
        signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();
      });
    },
    rejectReserved(id:number,reason:unknown){
      if(!records.has(id)||!reservedPrepared.has(id)||transferred.has(id))throw Error('공통 준비 원본 취소 근거 오류');
      fail(`공통 원본 준비 실패: ${String(reason)}`);
    },
    stored(id:number):Promise<CanonicalStoredReceipt>{
      const ack=acks.get(id);if(ack)return Promise.resolve(ack);
      const item=pending.get(id);if(item)return item.done;
      return Promise.reject(Error(failed||'공통 원본 저장 근거 없음'));
    },
    /** A caller may reuse only the receipt carried with these exact pixels. */
    input(source:SnapshotSource,time:number,elapsed:number,phase:'input'|'recovery',receipt:number|undefined,persist:boolean) {
      if(!Number.isFinite(time)||time<0||!Number.isFinite(elapsed)||elapsed<0||!['input','recovery'].includes(phase))throw Error('공통 원본 사용 시각 오류');
      if(receipt!==undefined){const old=records.get(receipt);
        const width='displayWidth' in source?source.displayWidth:'videoWidth' in source?source.videoWidth:source.width;
        const height='displayHeight' in source?source.displayHeight:'videoHeight' in source?source.videoHeight:source.height;
        if(!old||old.width!==width||old.height!==height||Math.abs(old.time-time)>1e-9)throw Error('공통 원본 재사용 근거 불일치');reusedInputs++;return receipt;
      }
      return persist?submit(source,time,elapsed,phase):undefined;
    },
    use(sourceFrameId:number|undefined,acquisitionFrameId:number,phase:'input'|'recovery',captureTime:number,receipt?:CanonicalRasterReceipt){
      if(sourceFrameId===undefined)return;
      const record=records.get(sourceFrameId);
      if(!record||!Number.isSafeInteger(acquisitionFrameId)||acquisitionFrameId<1||!Number.isFinite(captureTime)||captureTime<0||!['input','recovery'].includes(phase)||Math.abs(record.time-captureTime)>1e-9)throw Error('공통 원본 사용 근거 불일치');
      if(receipt){
        const parsed=parseSourceRasterReceipt(receipt);
        if(parsed.sourceFrameId!==sourceFrameId||parsed.acquisitionFrameId!==acquisitionFrameId||
          parsed.captureTime!==record.time||parsed.width!==record.width||parsed.height!==record.height)throw Error('공통 판독 픽셀 근거 불일치');
        if(rasterReceiptCount>=10_000||rasterAcquisitions.has(acquisitionFrameId))
          throw Error('중복 또는 한도 초과 공통 판독 근거');
        // A reuse must name a completed actual measurement, not another reuse,
        // a future/self use, or a hash/clock match from a different source.
        if(parsed.kind==='analysis-reused')verifyReusedOrigin(parsed);
        rasterReceiptCount++;rasterAcquisitions.add(acquisitionFrameId);
        const value=parsed;
        const ack=acks.get(sourceFrameId);
        if(ack)joinRasterReceipt(value,ack);
        else if(!failed){const waiting=waitingRasterReceipts.get(sourceFrameId)??[];waiting.push(value);waitingRasterReceipts.set(sourceFrameId,waiting);waitingRasterCount++;}
      }
      if(reservedPrepared.has(sourceFrameId))preparedUses++;
      processingUses++;
      options.onUse?.({sourceFrameId,acquisitionFrameId,phase,captureTime});
    },
    attachAnalysis(id:number,analysis:SavedAcquisition){
      const record=records.get(id);
      // Only originals still waiting for this single read pass consume a
      // sidecar. Recovery/current/spent analyses must not evict those originals.
      if(record&&record.role!=='recovery'&&(!readStarted||remainingOriginalAnalysisIds?.has(id)))analyses.set(id,analysis);
    },
    async *frames(signal:AbortSignal,completion?:{ready:()=>boolean;covered:(analysis:SavedAcquisition|undefined)=>boolean;skipped:(count:number)=>void}){
      if(readStarted)throw Error('공통 원본 읽기는 한 번만 시작할 수 있습니다.');
      readStarted=originalsClosed=true;
      invalidateRawLeases();wakeCapacity();
      // Detach the finite original set BEFORE recovery can append other input.
      const snapshot=[...records.values()].filter(value=>value.role!=='recovery').sort((a,b)=>a.time-b.time||a.id-b.id);
      remainingOriginalAnalysisIds=new Set(snapshot.map(record=>record.id));
      let canvas:HTMLCanvasElement|undefined;
      const abort=()=>fail('스캔 중지로 공통 원본 읽기를 종료했습니다.');
      signal.addEventListener('abort',abort,{once:true});
      try{
        signal.throwIfAborted();
        try{await flush();}catch{
          signal.throwIfAborted();await drainTransferred(signal);
        }
        signal.throwIfAborted();
        const available=snapshot.filter(record=>committed.has(record.id));
        if(!available.length&&failed)throw Error(failed);
        canvas=(options.canvasFactory??(()=>document.createElement('canvas')))();const context=canvas.getContext('2d')!;
        for(const [index,record]of available.entries()){
        signal.throwIfAborted();
        const saved=analyses.get(record.id),analysis=saved?.width===record.width&&saved.height===record.height?saved:undefined;
        // The yielded object keeps its live observation references. Remove map
        // ownership before collect can attach another analysis for this ID.
        analyses.delete(record.id);remainingOriginalAnalysisIds.delete(record.id);
        if(completion?.ready()&&completion.covered(analysis)){completion.skipped(1);continue;}
        const started=performance.now(),value=await store.readFrame(record.id,signal),duration=performance.now()-started;
        reads++;readMs+=duration;maxReadMs=Math.max(maxReadMs,duration);
        if(value.id!==record.id||value.width!==record.width||value.height!==record.height||value.time!==record.time||value.pixels.length!==record.width*record.height*4)
          throw Error('공통 원본 픽셀 또는 시각 불일치');
        if(canvas.width!==value.width||canvas.height!==value.height){canvas.width=value.width;canvas.height=value.height;}
        context.putImageData(new ImageData(value.pixels,value.width,value.height),0,0);
        if(options.ownedRgba&&(!wholeBuffer(value.pixels.buffer,record.width*record.height*4)||value.pixels.byteOffset!==0||
          !sha(value.hash)||acks.get(record.id)?.hash!==value.hash))throw Error('복원된 공통 RGBA 근거 불일치');
        yield {element:canvas,time:value.time,percent:(index+1)/available.length*100,analysis,canonicalFrameId:record.id,
          ...(options.ownedRgba?{rgba:new Uint8Array(value.pixels.buffer),sourceHash:value.hash}:{})};
      }}finally{remainingOriginalAnalysisIds.clear();analyses.clear();signal.removeEventListener('abort',abort);if(canvas)canvas.width=canvas.height=0;}
    },
    finish:endSource,discard:async()=>{await endSource();analyses.clear();},
    cancel:()=>fail('스캔 중지로 공통 원본을 종료했습니다.'),
    get active(){return !failed&&!ended&&!closingSource&&!originalsClosed;},
    get captured(){return nextId;},
    get stats(){return {frames:records.size,storedFrames:committed.size,pending:pending.size,pendingBytes:bytes,peakPendingBytes:peakBytes,
      leasedFrames:rawLeases.size,leasedBytes,peakReservedBytes,reusedInputs,processingUses,
      preparedFrames:reservedPrepared.size,preparedUses,measuredRasterUses:measured.size,reusedRasterUses:reused.size,
      pendingRasterUses:waitingRasterCount,unverifiedRasterUses:rasterReceiptCount-measured.size-reused.size-waitingRasterCount,
      capacityWaits,capacityWaitMs,maxCapacityWaitMs,waitingForCapacity:!!capacityWaiter,reads,readMs,maxReadMs,error:failed,
      ...(attestationIdentity?{nativeAttestationBudget:'native-owned-v1' as const,rebatedPreparedBytes}:{}),
      ...(timing?{timing:timing.snapshot()}:{})};},
  };
}
