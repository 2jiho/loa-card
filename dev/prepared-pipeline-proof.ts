import {preparedDecodedFrames,type PreparedDecodedFrame} from '../src/features/card-scanner/prepared-decoded-frames';
import {preparedRecoveryPrefetch} from '../src/features/card-scanner/prepared-recovery-prefetch';
import {createPreparedLiveSource} from '../src/features/card-scanner/prepared-live-source';
import {createSourcePreparation,type PreparedSource} from '../src/features/card-scanner/source-preparation';
import {createAcquisitionClient,type PreparedAcquisition} from '../src/features/card-scanner/acquisition-client';
import {createCanonicalCapture} from '../src/features/card-scanner/canonical-capture';
import {createExactRecording,type ExactRecorder} from '../src/features/card-scanner/exact-recording';
import {exactEntries,exactPixels,executionSummary,type ExactFrame} from '../src/features/card-scanner/exact-recording-codec';
import {CanonicalRasterReplay} from '../src/features/card-scanner/canonical-raster-replay';
import {pixelHash} from '../src/features/card-scanner/recording-frame-integrity';
import {yieldForCapture} from '../src/features/card-scanner/input-source';
import {nativeYuvDescriptorJson,planNativeYuvFrame} from '../src/features/card-scanner/native-yuv-recipe';
import type {PreparedAcquisitionInput,SourceRasterReceipt} from '../src/features/card-scanner/source-raster-receipt';
import type {CanonicalSourceUse} from '../src/features/card-scanner/canonical-source-use';
import type {SourceSnapshot} from './source-snapshot';
import {loadComparisonOriginal} from './comparison-original';
import {PIPELINE_PROOF_FRAMES,PIPELINE_PROOF_MAX_PREFIX_FRAMES,PIPELINE_PROOF_MAX_START_SECONDS,pipelineProofStartTime,selectPipelineWarmup,
 acquisitionShape,comparePipelineRows,type CardPixelHash,type PipelineMode,type PipelineProofRow,type PipelineProofWindow} from './prepared-pipeline-proof-core';

type CorpusCase={id:string;name:string;kind:string;inputs:{url:string;bytes:number;type:string;sha256:string}[]};
type PreparedMetadata=Pick<PipelineProofRow,'sourceFrameId'|'time'|'width'|'height'|'hash'|'storageKind'|'nativeSha256'|'descriptorJson'>&{
 preparation:PreparedSource['timing'];proofNativeHashMs:number;outputBytes:number;fallbackReason:string|null};
type ProofProgress={mode:PipelineMode|null;phase:string;index:number;total:number;elapsedMs:number};
type ModeProof={mode:PipelineMode;complete:boolean;rows:PipelineProofRow[];prepared:PreparedMetadata[];uses:CanonicalSourceUse[];receipts:SourceRasterReceipt[];
 acquisitionSettings?:{pixelTransport:boolean;measuredRasterReuse:boolean|null};
 acquisitionTimings:{ordinal:number;timing:PreparedAcquisition['timing'];wallMs:number}[];physical:ExactFrame[];restored:{id:number;time:number;hash:string}[];
 randomReads:{id:number;time:number;hash:string}[];acks:unknown[];timing?:Record<string,number>;stats?:unknown;capture?:unknown;sources?:unknown;preparation?:unknown;
 prefetch?:unknown;execution?:unknown;rasterReplay?:unknown;error?:string;window?:PipelineProofWindow;progress?:ProofProgress;failedAt?:ProofProgress;
 cleanup:{decoderReturned:boolean;acquisitionDisposed:boolean;preparationDisposed:boolean;recorderDisposed:boolean;targetCleared:boolean;errors:string[]}};
const select=document.querySelector<HTMLSelectElement>('#corpus')!,startInput=document.querySelector<HTMLInputElement>('#start')!,run=document.querySelector<HTMLButtonElement>('#run')!,
 stop=document.querySelector<HTMLButtonElement>('#stop')!,save=document.querySelector<HTMLButtonElement>('#save')!,
 status=document.querySelector<HTMLElement>('#status')!,result=document.querySelector<HTMLElement>('#result')!,cases=new Map<string,CorpusCase>();
let active:AbortController|undefined,reportText='';
const writerAttestation=new URLSearchParams(location.search).get('attest')==='1';
const rasterReuseComparison=new URLSearchParams(location.search).get('raster')==='compare';
const runModes:readonly PipelineMode[]=rasterReuseComparison?['raster-control','raster-reuse']:['serial','prefetch'];
if(rasterReuseComparison)document.querySelector('#comparison-description')!.textContent=
 '같은 30개 원본 프레임을 같은 선행 준비 방식으로 처리합니다. 기존 Bitmap 전송과 측정 픽셀 재사용·독립 픽셀 전송을 비교하며, 판독기에 전달되는 실제 카드 Canvas 픽셀까지 검사합니다.';
const ensure=(condition:unknown,reason:string)=>{if(!condition)throw Error(reason);};
const clock=()=>performance.now();
window.addEventListener('pagehide',()=>active?.abort(new DOMException('검증 페이지 종료','AbortError')));
stop.addEventListener('click',()=>active?.abort(new DOMException('사용자 중단','AbortError')));
async function sourceSnapshot(signal:AbortSignal):Promise<SourceSnapshot>{
 const response=await fetch('/__corpus/environment',{signal,cache:'no-store'});ensure(response.ok,'실행 소스 확인 실패');return response.json();
}
function createMode(mode:PipelineMode):ModeProof{return {mode,complete:false,rows:[],prepared:[],uses:[],receipts:[],acquisitionTimings:[],physical:[],
 restored:[],randomReads:[],acks:[],cleanup:{decoderReturned:false,acquisitionDisposed:false,preparationDisposed:false,recorderDisposed:false,targetCleared:false,errors:[]}};}
function releaseAcquisition(value:PreparedAcquisition){for(const cell of value.cells){cell.image.width=cell.image.height=0;if(cell.previewImage)cell.previewImage.width=cell.previewImage.height=0;}}

/** Actual native decoded input is borrowed until next/return. The finite wrapper
 * stops exactly after 30 consecutive timed frames without reading a 31st one. */
async function runMode(proof:ModeProof,blob:Blob,signal:AbortSignal,startTime:number,progress:(value:Omit<ProofProgress,'elapsedMs'>)=>void){
 const setupAt=clock(),target=document.createElement('canvas'),metadata=new Map<number,PreparedMetadata>(),decoder=preparedDecodedFrames(blob,signal);
 let recorder:ExactRecorder|undefined,preparation:Awaited<ReturnType<typeof createSourcePreparation>>|undefined,
  acquisition:ReturnType<typeof createAcquisitionClient>|undefined,capture:ReturnType<typeof createCanonicalCapture>|undefined,
  sources:ReturnType<typeof createPreparedLiveSource>|undefined,prefetch:ReturnType<typeof preparedRecoveryPrefetch<PreparedDecodedFrame>>|undefined;
 let failed=false,timedAt=0,loopEnd=0,decoderWaitMs=0,serialPreparationWaitMs=0,prefetchDeliveryWaitMs=0,acquisitionWallMs=0,proofNativeHashMs=0,consumerCardHashMs=0;
 const stage=(phase:string,index:number,total:number)=>{proof.progress={mode:proof.mode,phase,index,total,elapsedMs:clock()-setupAt};progress({mode:proof.mode,phase,index,total});};
 async function* timedFrames(){
  try{for(let index=0;index<PIPELINE_PROOF_FRAMES;index++){
   const at=clock(),next=await decoder.next();decoderWaitMs+=clock()-at;
   ensure(!next.done,'이 영상에는 준비 운동 뒤 30개 표본이 없습니다.');if(next.done)throw Error('영상 표본 부족');
   ensure(next.value.nativeFrame,'비교 입력이 native VideoFrame이 아닙니다.');yield next.value;
  }}finally{await decoder.return(undefined);proof.cleanup.decoderReturned=true;}
 }
 async function serialInput(frame:PreparedDecodedFrame):Promise<PreparedAcquisitionInput>{
  const native=frame.nativeFrame;ensure(native,'native 원본 없음');if(!native)throw Error('native 원본 없음');
  await sources!.readyForRecovery(native.displayWidth,native.displayHeight,signal);
  const id=sources!.submit(native,frame.time,clock()-setupAt,'recovery');ensure(id!==undefined,'준비 원본 예약 실패');if(id===undefined)throw Error('준비 원본 예약 실패');
  sources!.retain(id);return sources!.take(id);
 }
 async function acquire(input:PreparedAcquisitionInput,ordinal:number){
  signal.throwIfAborted();const source=metadata.get(input.binding.sourceFrameId);ensure(source,'준비 결과 메타데이터 없음');if(!source)throw Error('메타데이터 없음');
  const at=clock(),measured=await acquisition!.detectPrepared(input,target),wallMs=clock()-at;
  try{
   ensure(input.pixels.byteLength===0,'획득 입력 소유권 미이전');
   ensure(measured.rasterReceipt.hash===source.hash,'실제 획득 Worker 전체 래스터 불일치');
   capture!.use(source.sourceFrameId,measured.frameId,'recovery',source.time,measured.rasterReceipt);
   let cardPixelHashes:CardPixelHash[]|undefined;
   if(rasterReuseComparison){
    cardPixelHashes=[];const hashStarted=clock();
    // These are the actual canvases the OCR consumer receives after the
    // client materializes transport pixels. No pre-transfer bytes are claimed.
    for(const cell of measured.cells){
     signal.throwIfAborted();const canvas=cell.image,context=canvas.getContext('2d',{willReadFrequently:true});
     if(!context)throw Error('실제 카드 소비 Canvas 미지원');
     const rgba=context.getImageData(0,0,canvas.width,canvas.height).data;
     cardPixelHashes.push({slot:cell.slot,width:canvas.width,height:canvas.height,
      hash:await pixelHash(new Uint8Array(rgba.buffer,rgba.byteOffset,rgba.byteLength))});
    }
    if(ordinal>0)consumerCardHashMs+=clock()-hashStarted;
   }
   proof.rows.push({ordinal,...source,acquisitionFrameId:measured.frameId,acquisition:acquisitionShape(measured),
    ...(cardPixelHashes?{cardPixelHashes}:{})});
   proof.acquisitionTimings.push({ordinal,timing:measured.timing,wallMs});if(ordinal>0)acquisitionWallMs+=wallMs;
   stage(ordinal===0?'warmup':'collect',ordinal===0?1:ordinal,ordinal===0?1:PIPELINE_PROOF_FRAMES);
  }finally{releaseAcquisition(measured);}
 }
 try{
  stage('initialize',0,1);
  recorder=await createExactRecording({storageVersion:1,...(writerAttestation?{preparedNativeAttestation:true}:{})});ensure(recorder.supportsSourceReads,'기능 검증에 OPFS random read가 필요합니다.');
  preparation=await createSourcePreparation(signal,writerAttestation?{attestation:recorder.takePreparationAttestation()}:{});
  const pixelTransport=!rasterReuseComparison||proof.mode==='raster-reuse';
  proof.acquisitionSettings={pixelTransport,measuredRasterReuse:rasterReuseComparison?proof.mode==='raster-reuse':null};
  acquisition=createAcquisitionClient(signal,{pixelTransport,
   ...(rasterReuseComparison?{measuredRasterReuse:proof.mode==='raster-reuse'}:{})});await acquisition.ready();
  recorder.event('canonical-raster-contract',{version:1},0);
  if(recorder.nativeAttestationIdentity)recorder.event('canonical-storage-contract',
    {...recorder.nativeAttestationIdentity,mode:'prepared-native-attestation-v1'},0);
  capture=createCanonicalCapture(recorder,message=>{proof.error??=message;},{ownedRgba:true,onUse:value=>{proof.uses.push(value);recorder!.event('canonical-source-use',value,value.captureTime);},
   onRasterReceipt:value=>{proof.receipts.push(value);recorder!.event('canonical-raster-receipt',value,value.captureTime);},
   ...(recorder.nativeAttestationIdentity?{attestation:recorder.nativeAttestationIdentity,
    onStorageAttestation:value=>recorder!.event('canonical-storage-attestation',value,value.captureTime)}:{})});
  sources=createPreparedLiveSource(capture,{async prepare(input,binding,request){
   const prepared=await preparation!.prepare(input,binding,request),at=clock(),nativeSha256=prepared.storage.kind==='native'?await pixelHash(prepared.storage.pixels):null,
    nativeHashMs=clock()-at;
   const row:PreparedMetadata={sourceFrameId:binding.sourceFrameId,time:binding.captureTime,width:prepared.width,height:prepared.height,hash:prepared.hash,
    storageKind:prepared.storage.kind,nativeSha256,descriptorJson:prepared.storage.kind==='native'?nativeYuvDescriptorJson(prepared.storage.descriptor,planNativeYuvFrame(prepared.storage.descriptor).layout):null,
    preparation:prepared.timing,proofNativeHashMs:nativeHashMs,outputBytes:prepared.outputBytes,fallbackReason:prepared.fallbackReason??null};
   ensure(!metadata.has(row.sourceFrameId)&&metadata.size<PIPELINE_PROOF_FRAMES+1,'준비 결과 중복 또는 표본 상한 초과');
   metadata.set(row.sourceFrameId,row);proof.prepared.push(row);if(binding.sourceFrameId>1)proofNativeHashMs+=nativeHashMs;return prepared;
  }},signal,writerAttestation?{attestNative:true}:{});
  // Discard only a statically selected prefix outside the measured window.
  // Neither mode chooses its first sample based on card detection results.
  stage('select-window',0,PIPELINE_PROOF_MAX_PREFIX_FRAMES+1);let prefixReads=0;
  const warmup=await selectPipelineWarmup({next:async()=>{const next=await decoder.next();stage('select-window',++prefixReads,PIPELINE_PROOF_MAX_PREFIX_FRAMES+1);return next;}},startTime,signal);proof.window=warmup.window;
  stage('warmup',0,1);ensure(warmup.frame.nativeFrame,'native 준비 운동 표본 없음');await acquire(await serialInput(warmup.frame),0);await capture.stored(proof.rows[0].sourceFrameId);
  stage('warmup',1,1);
  const setupAndWarmupMs=clock()-setupAt;timedAt=clock();
  stage('collect',0,PIPELINE_PROOF_FRAMES);
  if(proof.mode==='serial'){
   let ordinal=0;for await(const frame of timedFrames()){
    const at=clock(),input=await serialInput(frame);serialPreparationWaitMs+=clock()-at;await acquire(input,++ordinal);
   }
  }else{
   prefetch=preparedRecoveryPrefetch(timedFrames(),sources,signal,{elapsed:()=>clock()-setupAt});
   let ordinal=0,deliveryAt=clock();for await(const frame of prefetch){prefetchDeliveryWaitMs+=clock()-deliveryAt;
    ensure(frame.preparedInput,'실제 선행 준비 픽셀 없음');if(!frame.preparedInput)throw Error('선행 준비 픽셀 없음');await acquire(frame.preparedInput,++ordinal);deliveryAt=clock();}
   const stats=prefetch.stats;ensure(stats.peakRetainedFrames<=2&&stats.pendingReads===0&&stats.retainedFrames===0&&stats.retainedBytes===0&&stats.returned,'선행 준비 소유권 상한 또는 정리 실패');
   proof.prefetch=stats;
  }
  loopEnd=clock();ensure(proof.rows.length===PIPELINE_PROOF_FRAMES+1,'판독된 실제 표본 수 불일치');
  ensure(proof.rows.slice(1).some(row=>row.acquisition.layout!==null&&row.acquisition.detected>0),'측정 구간에 실제 카드 획득 결과가 없습니다.');
  stage('writer-drain',0,PIPELINE_PROOF_FRAMES+1);
  await sources.finish();proof.acks=await Promise.all(proof.rows.map(row=>capture!.stored(row.sourceFrameId)));
  await capture.finish();const raw=await recorder.finish(),writerEnd=clock();
  stage('writer-drain',proof.acks.length,PIPELINE_PROOF_FRAMES+1);
  ensure(raw.stats.complete&&raw.stats.storageVersion===1&&raw.stats.canonical&&raw.stats.frames===PIPELINE_PROOF_FRAMES+1,'원본 기록 불완전');
  if(writerAttestation)ensure(raw.stats.nativeAttestedFrames===raw.stats.nativeFrames,'실제 writer 변환 증명 사용 수 불일치');
  ensure(!sources.stats.persistenceFailed&&!sources.stats.ephemeralSources&&!sources.stats.pending&&!sources.stats.recordingGapSources,'물리 원본 연결 손실');
  ensure(proof.receipts.length===proof.rows.length&&proof.uses.length===proof.rows.length,'실제 획득 원본·사용·측정 연결 누락');
  const rasterReplay=new CanonicalRasterReplay();
  stage('physical-headers',0,proof.rows.length);
  for await(const {header}of exactEntries(raw.blob,signal)){
   rasterReplay.accept(header);if(header.kind==='frame'){
    proof.physical.push(header);stage('physical-headers',proof.physical.length,proof.rows.length);
    if(proof.physical.length%4===0)await yieldForCapture(signal);
   }
  }
  ensure(proof.physical.length===proof.rows.length,'물리 원본 수 불일치');
  stage('random-read',0,proof.physical.length);
  for(let index=0;index<proof.physical.length;index++){
   const header=proof.physical[index],row=proof.rows[index];
   ensure(header.id===row.sourceFrameId&&header.time===row.time&&header.width===row.width&&header.height===row.height&&header.hash===row.hash&&header.canonical,'물리 헤더와 실제 획득 연결 불일치');
   if(row.storageKind==='native'){
    ensure(header.storage?.kind==='native-yuv420'&&header.storage.nativeSha256===row.nativeSha256,'물리 native 바이트 SHA 불일치');
    if(header.storage?.kind==='native-yuv420')ensure(nativeYuvDescriptorJson(header.storage.descriptor,planNativeYuvFrame(header.storage.descriptor).layout)===row.descriptorJson,'물리 native 프로필 불일치');
   }else ensure(header.storage?.kind==='rgba8','명시적 RGBA 대체 형식 불일치');
   // Production OPFS random read is independent of the sequential file parser.
   const restored=await recorder.readFrame(header.id,signal),hash=await pixelHash(new Uint8Array(restored.pixels.buffer,restored.pixels.byteOffset,restored.pixels.byteLength));
   ensure(restored.id===header.id&&restored.time===header.time&&restored.width===header.width&&restored.height===header.height&&restored.hash===header.hash&&hash===header.hash,'OPFS random read 전체 래스터 불일치');
   proof.randomReads.push({id:restored.id,time:restored.time,hash});
   stage('random-read',proof.randomReads.length,proof.physical.length);if(proof.randomReads.length%4===0)await yieldForCapture(signal);
  }
  stage('sequential-pixels',0,proof.rows.length);
  for await(const frame of exactPixels(raw.blob,signal,1)){
   const row=proof.rows[proof.restored.length],hash=await pixelHash(frame.pixels);
   ensure(row&&frame.id===row.sourceFrameId&&frame.time===row.time&&frame.hash===row.hash&&hash===row.hash,'파일 순차 복원 전체 래스터 불일치');
   proof.restored.push({id:frame.id,time:frame.time,hash});
   stage('sequential-pixels',proof.restored.length,proof.rows.length);if(proof.restored.length%4===0)await yieldForCapture(signal);
  }
  ensure(proof.restored.length===proof.rows.length,'전체 물리 바이트 검증 누락');
  stage('execution-replay',0,1);
  proof.rasterReplay=rasterReplay.summary(true);proof.execution=await executionSummary(raw.blob,signal,raw.stats);
  if(writerAttestation)ensure((proof.execution as Awaited<ReturnType<typeof executionSummary>>).storageAttestationProof?.matches===true,
    '실제 저장 변환 증명 메타데이터 연결 불일치');
  ensure((proof.execution as {recordingComplete:boolean}).recordingComplete,'원본 이벤트 기록 불완전');
  proof.stats=raw.stats;proof.capture=capture.stats;proof.sources=sources.stats;proof.preparation=preparation.stats;
  const measuredPreparation=proof.prepared.slice(1),sumPreparation=(key:keyof PreparedSource['timing'])=>measuredPreparation.reduce((sum,row)=>sum+row.preparation[key],0);
  proof.timing={setupAndWarmupMs,producerAndAcquisitionMs:loopEnd-timedAt,writerDrainMs:writerEnd-loopEnd,
   timedIncludingWriterMs:writerEnd-timedAt,decoderWaitMs,serialPreparationWaitMs,prefetchDeliveryWaitMs,acquisitionWallMs,proofNativeHashMs,
   ...(rasterReuseComparison?{consumerCardHashMs}:{}),
   preparationWorkerMs:sumPreparation('totalMs'),preparationCopyMs:sumPreparation('copyMs'),preparationConversionHashMs:sumPreparation('conversionHashMs'),preparationRasterMs:sumPreparation('rasterMs'),
   proofVerificationMs:clock()-writerEnd,framesPerSecond:PIPELINE_PROOF_FRAMES/((loopEnd-timedAt)/1000)};
  proof.complete=true;
  stage('execution-replay',1,1);
 }catch(error){failed=true;proof.failedAt=proof.progress?{...proof.progress}:undefined;proof.error=String(error);recorder?.incomplete(String(error));capture?.cancel();throw error;}
 finally{
  stage('cleanup',0,7);
  const cleanup=async(action:()=>unknown|Promise<unknown>)=>{try{await action();}catch(error){proof.cleanup.errors.push(String(error));}};
  if(prefetch&&!prefetch.stats.returned)await cleanup(()=>prefetch!.return(undefined));
  if(!proof.cleanup.decoderReturned)await cleanup(async()=>{await decoder.return(undefined);proof.cleanup.decoderReturned=true;});
  stage('cleanup',1,7);
  if(sources)await cleanup(()=>sources!.finish());sources?.dispose();
  stage('cleanup',2,7);
  if(capture)await cleanup(()=>capture!.finish());
  stage('cleanup',3,7);
  if(acquisition){acquisition.dispose();proof.cleanup.acquisitionDisposed=true;}
  stage('cleanup',4,7);
  if(preparation)await cleanup(async()=>{await preparation!.dispose();proof.cleanup.preparationDisposed=true;proof.preparation=preparation!.stats;});
  stage('cleanup',5,7);
  if(recorder)await cleanup(async()=>{await recorder!.dispose();proof.cleanup.recorderDisposed=true;});
  stage('cleanup',6,7);
  target.width=target.height=0;proof.cleanup.targetCleared=true;
  stage('cleanup',7,7);
  // Existing acquisition/decoder errors remain authoritative; a successful
  // measurement must still fail if its resource cleanup did not finish.
  // oxlint-disable-next-line no-unsafe-finally
  if(proof.cleanup.errors.length){proof.complete=false;if(!failed)throw Error(`준비 파이프라인 정리 실패: ${proof.cleanup.errors.join(' · ')}`);}
 }
}

run.addEventListener('click',async()=>{
 if(active)return;const controller=active=new AbortController(),signal=AbortSignal.any([controller.signal,AbortSignal.timeout(240_000)]),started=clock();
 run.disabled=select.disabled=startInput.disabled=true;stop.disabled=false;save.disabled=true;reportText='';result.textContent='';
 const modes:ModeProof[]=[],visibility:{atMs:number;state:DocumentVisibilityState}[]=[{atMs:0,state:document.visibilityState}],
  changed=()=>visibility.push({atMs:clock()-started,state:document.visibilityState});document.addEventListener('visibilitychange',changed);
 let sourceStart:SourceSnapshot|null=null,sourceEnd:SourceSnapshot|null=null,
  original:({caseId:string;manifestInput:CorpusCase['inputs'][number];sha256:string;bytes:number})|null=null,
  comparison:unknown=null,error:string|null=null,progress:ProofProgress={mode:null,phase:'start',index:0,total:1,elapsedMs:0},failurePhase:ProofProgress|null=null;
 const phases:(ProofProgress&{startedAtMs:number})[]=[];
 function renderCompact(state:'running'|'pass'|'fail'){
  // Never expose the complete per-cell evidence as one giant AX text node.
  // The full report remains in the downloadable JSON, outside the DOM.
  const compact={proof:'prepared-pipeline-finite-native',writerAttestation,rasterReuseComparison,state,progress,failurePhase,error:error?.slice(0,1500)??null,
   sourceStart:sourceStart?.sourceDigest??null,sourceEnd:sourceEnd?.sourceDigest??null,
   original:original?{caseId:original.caseId,sha256:original.sha256,bytes:original.bytes}:null,
   modes:modes.map(value=>({mode:value.mode,acquisitionSettings:value.acquisitionSettings??null,complete:value.complete,progress:value.progress??null,failedAt:value.failedAt??null,
    frames:value.rows.length,physical:value.physical.length,restored:value.restored.length,randomReads:value.randomReads.length,
    uses:value.uses.length,receipts:value.receipts.length,window:value.window??null,
    timing:value.timing?{producerAndAcquisitionMs:value.timing.producerAndAcquisitionMs,writerDrainMs:value.timing.writerDrainMs,proofVerificationMs:value.timing.proofVerificationMs}:null,
    cleanupErrors:value.cleanup.errors.map(message=>message.slice(0,300)),error:value.error?.slice(0,500)??null})),comparison,
   fullEvidence:'검증 결과 저장 버튼의 JSON 파일',elapsedMs:clock()-started};
  const encoded=JSON.stringify(compact,null,2);result.textContent=encoded.length<=12_000?encoded:`${encoded.slice(0,11_800)}\n[요약 표시 한도 · 전체 근거는 JSON 저장]`;
 }
 function update(value:Omit<ProofProgress,'elapsedMs'>){
  progress={...value,elapsedMs:clock()-started};
  const previous=phases.at(-1);
  if(previous&&previous.mode===value.mode&&previous.phase===value.phase)Object.assign(previous,progress);
  else if(phases.length<64)phases.push({...progress,startedAtMs:progress.elapsedMs});
  status.textContent=`${value.mode??'전체'} · ${value.phase} · ${value.index} / ${value.total}`;renderCompact('running');
 }
 try{
  update({mode:null,phase:'source-start',index:0,total:1});
  const startTime=pipelineProofStartTime(startInput.valueAsNumber);sourceStart=await sourceSnapshot(signal);const selected=cases.get(select.value);ensure(selected,'등록한 원본 영상을 선택하세요.');if(!selected)throw Error('입력 없음');
  const response=await fetch(`/__corpus/cases/${selected.id}`,{signal});ensure(response.ok,'입력 사례 확인 실패');
  const detail:CorpusCase=await response.json();ensure(detail.id===selected.id&&detail.inputs.length===1&&/^[a-f0-9]{64}$/.test(detail.inputs[0].sha256),'원본 manifest 불일치');
  update({mode:null,phase:'original-integrity',index:0,total:1});
  const loaded=await loadComparisonOriginal(detail.inputs[0].url,detail.inputs[0],signal);original={caseId:selected.id,manifestInput:detail.inputs[0],...loaded.verified};
  for(const mode of runModes){
   const proof=createMode(mode);modes.push(proof);await runMode(proof,loaded.blob,signal,startTime,update);
  }
  update({mode:null,phase:'compare',index:0,total:1});
  comparison=comparePipelineRows(modes[0].rows,modes[1].rows);ensure(JSON.stringify(modes[0].window)===JSON.stringify(modes[1].window),'고정 검증 구간의 실제 표본 불일치');
  update({mode:null,phase:'source-end',index:0,total:1});sourceEnd=await sourceSnapshot(signal);
  ensure(sourceStart.sourceDigest===sourceEnd.sourceDigest,'비교 실행 중 소스 변경');
  update({mode:null,phase:'complete',index:1,total:1});
  status.textContent='30개 표본 일치 · 실제 획득·원본 기록·전체 픽셀 검증 완료';
 }catch(cause){failurePhase=modes.at(-1)?.failedAt??{...progress};error=String(cause);status.textContent=error;
  try{sourceEnd=await sourceSnapshot(new AbortController().signal);}catch{/* Preserve actual failure. */}}
 finally{
  document.removeEventListener('visibilitychange',changed);
  const complete=!error&&modes.length===2&&modes.every(mode=>mode.complete),serial=modes[0]?.timing,prefetch=modes[1]?.timing;
  const report={version:1,proof:'prepared-pipeline-finite-native',writerAttestation,rasterReuseComparison,complete,error,progress,failurePhase,phases,sourceStart,sourceEnd,original,modes,comparison,
   observedTimingRatio:complete&&serial&&prefetch?serial.producerAndAcquisitionMs/prefetch.producerAndAcquisitionMs:null,visibility,elapsedMs:clock()-started,
   limits:{timedFrames:PIPELINE_PROOF_FRAMES,warmupFrames:1,maxPrefixFrames:PIPELINE_PROOF_MAX_PREFIX_FRAMES,maxStartSeconds:PIPELINE_PROOF_MAX_START_SECONDS,maxPrefetchExtraFrames:1,
    prefetchRetainedBytes:128*1024*1024,sourceQueueBytes:128*1024*1024,canonicalPendingBytes:128*1024*1024,defaultBudgetsUnchanged:true},
   timingScope:{order:runModes,windowSelection:'fixed start time, first original PTS at or after; only the prefix outside the window is discarded',
    ...(rasterReuseComparison?{bothUseIdenticalSourcePrefetch:true,consumerCardReadbackAndHashIncluded:true,
     comparisonChanges:['bitmap transport to owned pixels','measured-raster reuse'],
     cardPixelHashScope:'actual main OCR-consumer Canvas pixels after materialization, not raw pre-transfer bytes'}:{}),
    workerAndWaitDurationsAreOverlappingSums:true,sourceAndWriterCapacityWaitsInCaptureStats:true,readinessWarmupAndVerificationExcluded:true,
    perFrameStatusUpdatesIncluded:true,explicitBrowserTaskYieldsOnlyDuringUntimedVerification:true,progressClock:'page elapsedMs at top level; mode-local elapsedMs in modes'},
   boundaries:{actualNativeVideoSamples:true,actualAcquisitionRasterMeasured:true,rawOpfsRecording:true,durableIdbJournal:false,ocrExecuted:false,
    actualLiveBinding:false,fullVideoRecordingGate:false,measuredFullMemory:false,causalSpeedClaim:false,actualWriterNativeAttestation:writerAttestation,
    claim:'One ordered 30-frame sample pair after identical first-PTS-at-or-after-start warmup. Prefix samples outside this statically selected window are decoded and discarded, without detection-dependent selection or drops inside the window. Both record ON; preparation proof adds the same native hashing work. Exact physical bytes, OPFS reads and actual acquisition receipts are checked. Timing excludes readiness/prefix/warmup and verification; writer drain is separate. Not exact-timestamp seek, OS capture latency, full-video recognition, durable archive, or statistically causal throughput proof.'}};
  reportText=JSON.stringify(report,null,2);renderCompact(complete?'pass':'fail');save.disabled=false;stop.disabled=true;run.disabled=select.disabled=startInput.disabled=false;active=undefined;
 }
});
save.addEventListener('click',()=>{if(!reportText)return;const url=URL.createObjectURL(new Blob([reportText],{type:'application/json'})),link=document.createElement('a');
 link.href=url;link.download=`loacard-prepared-pipeline-${Date.now()}.json`;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);});
void fetch('/__corpus').then(async response=>{ensure(response.ok,'입력 코퍼스 없음');const body=await response.json();
 for(const value of body.cases as CorpusCase[])if(value.kind==='video'){cases.set(value.id,value);select.add(new Option(value.name,value.id));}
 const sixth=[...cases.values()].find(value=>/6(?:\D|$)/.test(value.name));if(sixth)select.value=sixth.id;
 ensure(cases.size,'등록한 영상 없음');status.textContent='원본 영상을 선택하고 비교를 실행하세요.';
}).catch(error=>{status.textContent=String(error);run.disabled=true;});
