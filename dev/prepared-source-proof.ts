import {ALL_FORMATS,BlobSource,Input,VideoSampleSink} from 'mediabunny';
import {createExactRecording,type ExactRecorder} from '../src/features/card-scanner/exact-recording';
import {createCanonicalCapture} from '../src/features/card-scanner/canonical-capture';
import {createAcquisitionClient} from '../src/features/card-scanner/acquisition-client';
import {createSourcePreparation} from '../src/features/card-scanner/source-preparation';
import {createReproductionBundle,openReproduction,beginReproduction} from '../src/features/card-scanner/scan-reproduction';
import {createReproductionSessionStore} from '../src/features/card-scanner/reproduction-session-store';
import {exactEntries,exactPixels,executionSummary} from '../src/features/card-scanner/exact-recording-codec';
import {pixelHash} from '../src/features/card-scanner/recording-frame-integrity';
import {CanonicalRasterReplay} from '../src/features/card-scanner/canonical-raster-replay';
import {nativeYuvDescriptorJson,planNativeYuvFrame,type NativeYuvFrameMetadata} from '../src/features/card-scanner/native-yuv-recipe';
import {loadComparisonOriginal} from './comparison-original';
import {acquisitionShape} from './prepared-pipeline-proof-core';
import {parseSourcePreparationMode} from '../src/features/card-scanner/source-preparation-protocol';

const preparationParameter=new URLSearchParams(location.search).get('preparation');
const preparationMode=preparationParameter===null?'auto':parseSourcePreparationMode(preparationParameter);

type CorpusCase={id:string;name:string;kind:string;inputs:{url:string;bytes:number;type:string;sha256:string}[]};
const select=document.querySelector<HTMLSelectElement>('#corpus')!,button=document.querySelector<HTMLButtonElement>('#run')!,
 status=document.querySelector<HTMLElement>('#status')!,result=document.querySelector<HTMLElement>('#result')!,save=document.querySelector<HTMLButtonElement>('#save')!;
const cases=new Map<string,CorpusCase>(),store=createReproductionSessionStore({dbName:'loacard-dev-prepared-source-proof'});
let active:AbortController|undefined,exported:Blob|undefined,exportName='';
window.addEventListener('pagehide',()=>{active?.abort(new DOMException('검증 페이지 종료','AbortError'));exported=undefined;});
const ensure=(condition:unknown,reason:string)=>{if(!condition)throw Error(reason);};
async function sourceSnapshot(signal:AbortSignal){const response=await fetch('/__corpus/environment',{cache:'no-store',signal});ensure(response.ok,'실행 소스 확인 실패');return response.json();}
function releaseAcquisition(value:Pick<Awaited<ReturnType<ReturnType<typeof createAcquisitionClient>['detectNative']>>,'cells'>){
 for(const cell of value.cells){cell.image.width=0;if(cell.previewImage)cell.previewImage.width=0;}
}
button.addEventListener('click',async()=>{
 if(active)return;const controller=active=new AbortController(),signal=AbortSignal.any([controller.signal,AbortSignal.timeout(180_000)]),started=performance.now();
 button.disabled=select.disabled=true;save.disabled=true;save.textContent='검증 파일 저장';exported=undefined;result.textContent='';status.textContent='실제 획득·저장 경로를 준비합니다.';
 let recorder:ExactRecorder|undefined,session:ReturnType<typeof beginReproduction>|undefined,input:Input|undefined,
  capture:ReturnType<typeof createCanonicalCapture>|undefined,preparation:Awaited<ReturnType<typeof createSourcePreparation>>|undefined,
  acquisition:ReturnType<typeof createAcquisitionClient>|undefined,referenceAcquisition:ReturnType<typeof createAcquisitionClient>|undefined;
 let sourceStart:Awaited<ReturnType<typeof sourceSnapshot>>|null=null,sourceEnd:typeof sourceStart=null,original:unknown=null;
 const rows:{id:number;time:number;width:number;height:number;hash:string;mode:string;origin:unknown;timing:unknown;cells:number;
  storage:{kind:'native';nativeSha256:string;descriptor:NativeYuvFrameMetadata}|{kind:'rgba'};fallbackReason?:string;reference?:unknown;acquisitionCards?:unknown}[]=[],joined:unknown[]=[],replayAcquisitions:unknown[]=[],uses:unknown[]=[];
 const target=document.createElement('canvas'),referenceTarget=document.createElement('canvas');
 async function cardProof(value:Awaited<ReturnType<ReturnType<typeof createAcquisitionClient>['detectNative']>>){
  const pixels=[];
  for(const cell of value.cells){const canvas=cell.image;
   const rgba=canvas.getContext('2d',{willReadFrequently:true})!.getImageData(0,0,canvas.width,canvas.height).data;
   pixels.push({slot:cell.slot,complete:cell.complete,width:canvas.width,height:canvas.height,
    hash:await pixelHash(new Uint8Array(rgba.buffer,rgba.byteOffset,rgba.byteLength))});
  }
  return {shape:acquisitionShape(value),pixels};
 }
 async function bounded<T>(promise:Promise<T>,late?:(value:T)=>void):Promise<T>{
  let abandoned=false,onAbort:(()=>void)|undefined,timer:ReturnType<typeof setTimeout>|undefined;
  void promise.then(value=>{if(abandoned)late?.(value);},()=>{});
  try{return await Promise.race([promise,new Promise<never>((_,reject)=>{
   onAbort=()=>reject(signal.reason);signal.addEventListener('abort',onAbort,{once:true});
   timer=setTimeout(()=>reject(Error('검증 작업 15초 한도 초과')),15_000);if(signal.aborted)onAbort();
  })]);}catch(error){abandoned=true;throw error;}finally{clearTimeout(timer);if(onAbort)signal.removeEventListener('abort',onAbort);}
 }
 async function add(frame:VideoFrame|ImageBitmap,time:number,origin:unknown,measure=true){
  let width:number,height:number,reserved:ReturnType<NonNullable<typeof capture>['reserve']>;
  let reference:{hash:string;method:string;cards:Awaited<ReturnType<typeof cardProof>>|null;timing:unknown}|undefined;
  try{signal.throwIfAborted();width='displayWidth' in frame?frame.displayWidth:frame.width;height='displayHeight' in frame?frame.displayHeight:frame.height;
   if(preparationMode==='canvas'){
    referenceTarget.width=width;referenceTarget.height=height;
    if(measure){
     let measured:Awaited<ReturnType<NonNullable<typeof referenceAcquisition>['detectNative']>>;
     if('displayWidth'in frame)measured=await referenceAcquisition!.detectNative(frame,referenceTarget,time);
     else{
      const context=referenceTarget.getContext('2d',{willReadFrequently:true})!;
      context.globalCompositeOperation='copy';context.drawImage(frame,0,0,width,height);
      measured=await referenceAcquisition!.detectAndAcquire(referenceTarget,time);
     }
     try{ensure(measured.pixelProof,'기본 획득 Worker 픽셀 증명 없음');reference={hash:measured.pixelProof!.hash,
      method:'displayWidth'in frame?'same-owned-VideoFrame-default-worker':'same-owned-Bitmap-Canvas-worker',cards:await cardProof(measured),timing:measured.timing};}
     finally{releaseAcquisition(measured);}
    }else{
     const context=referenceTarget.getContext('2d',{willReadFrequently:true})!;
     context.globalCompositeOperation='copy';context.drawImage(frame,0,0,width,height);
     const rgba=context.getImageData(0,0,width,height).data;
     reference={hash:await pixelHash(new Uint8Array(rgba.buffer,rgba.byteOffset,rgba.byteLength)),method:'same-owned-source-Canvas-backup',cards:null,timing:null};
    }
   }
   reserved=capture!.reserve({width,height,time,elapsed:performance.now()-started,role:measure?'input':'backup'});
   if(!reserved)throw Error('원본 예약 실패');
  }catch(error){frame.close();throw error;}
  let prepared:Awaited<ReturnType<NonNullable<typeof preparation>['prepare']>>;
  try{prepared=await preparation!.prepare(frame,{sourceFrameId:reserved.id,captureTime:time});}
  catch(error){capture!.rejectReserved(reserved.id,error);throw error;}
  ensure(prepared.binding.sourceFrameId===reserved.id&&prepared.binding.captureTime===time,'원본 준비 연결 불일치');
  if(reference){ensure(prepared.mode==='rgba'&&prepared.fallbackReason==='canvas-requested','Canvas 준비 선택 불일치');ensure(prepared.hash===reference.hash,'기본 Canvas와 준비 Canvas 전체 픽셀 불일치');}
  const storage=prepared.storage.kind==='native'?{kind:'native' as const,nativeSha256:await pixelHash(prepared.storage.pixels),descriptor:prepared.storage.descriptor}:{kind:'rgba' as const};
  if(prepared.storage.kind==='native')capture!.submitPrepared(reserved.id,{native:{descriptor:prepared.storage.descriptor,pixels:prepared.storage.pixels},hash:prepared.hash});
  else capture!.submitPrepared(reserved.id,{pixels:prepared.storage.pixels,hash:prepared.hash});
  let cells=0,acquisitionCards:Awaited<ReturnType<typeof cardProof>>|undefined;
  if(measure){
   const measured=await acquisition!.detectPrepared({pixels:prepared.pixels,width,height,binding:prepared.binding},target);
   try{ensure(measured.rasterReceipt.hash===prepared.hash,'판독 Worker 내부 픽셀 해시 불일치');cells=measured.cells.length;
    if(reference?.cards){acquisitionCards=await cardProof(measured);ensure(JSON.stringify(acquisitionCards)===JSON.stringify(reference.cards),'기본/준비 최종 카드 픽셀·geometry·quality 불일치');}
    capture!.use(reserved.id,measured.frameId,'input',time,measured.rasterReceipt);
   }finally{releaseAcquisition(measured);}
  }
  const ack=await capture!.stored(reserved.id);ensure(ack.hash===prepared.hash,'저장 ACK 해시 불일치');
  rows.push({id:reserved.id,time,width,height,hash:prepared.hash,mode:prepared.mode,origin,timing:prepared.timing,cells,storage,
   ...(prepared.fallbackReason?{fallbackReason:prepared.fallbackReason}:{}),...(reference?{reference}:{}),...(acquisitionCards?{acquisitionCards}:{})});
  status.textContent=`공통 입력 ${rows.length}개 검증 · 판독·저장 해시 일치`;
 }
 try{
  sourceStart=await sourceSnapshot(signal);recorder=await bounded(createExactRecording({storageVersion:1}),value=>{void value.dispose();});
  preparation=await createSourcePreparation(signal,{mode:preparationMode});acquisition=createAcquisitionClient(signal,{pixelTransport:true});await acquisition.ready();
  if(preparationMode==='canvas'){referenceAcquisition=createAcquisitionClient(signal,{pixelTransport:true,pixelProof:true,measuredRasterReuse:false});await referenceAcquisition.ready();}
  session=beginReproduction([],{browser:navigator.userAgent,catalog:'prepared-source-proof',build:import.meta.env.VITE_BUILD_REVISION??'local'},{record:true,exact:recorder,store});
  recorder.event('canonical-raster-contract',{version:1},0);
  capture=createCanonicalCapture(recorder,message=>{throw Error(message);},{onUse:value=>{uses.push(value);recorder!.event('canonical-source-use',value,value.captureTime);},
   onRasterReceipt:value=>{joined.push(value);recorder!.event('canonical-raster-receipt',value,value.captureTime);}});
  const packed=new Uint8Array(8*8*3/2).fill(128);packed.fill(90,0,64);
  await add(new VideoFrame(packed,{format:'I420',codedWidth:8,codedHeight:8,timestamp:100_000,
   colorSpace:{primaries:'smpte170m',transfer:'smpte170m',matrix:'smpte170m',fullRange:false}}),.1,{kind:'synthetic-I420'});
  const canvas=new OffscreenCanvas(8,8),context=canvas.getContext('2d')!;context.fillStyle='#5381ad';context.fillRect(0,0,8,8);
  await add(canvas.transferToImageBitmap(),.2,{kind:'same-source-raw-fallback'});
  const selected=cases.get(select.value);
  if(selected){
   const response=await fetch(`/__corpus/cases/${selected.id}`,{signal});ensure(response.ok,'입력 사례를 읽지 못했습니다.');
   const detail:CorpusCase=await response.json(),loaded=await loadComparisonOriginal(detail.inputs[0].url,detail.inputs[0],signal);
   original={caseId:selected.id,...loaded.verified};input=new Input({formats:ALL_FORMATS,source:new BlobSource(loaded.blob)});
   const track=await bounded(input.getPrimaryVideoTrack());ensure(track,'영상 트랙 없음');if(!track)throw Error('영상 트랙 없음');
   ensure(await bounded(track.canDecode()),'디코더 미지원');const duration=await bounded(track.computeDuration()),sink=new VideoSampleSink(track);
   for(const at of [1,3,5]){
    const sample=await bounded(sink.getSample(Math.min(at,duration-.1)),value=>value?.close());ensure(sample,'디코딩 표본 없음');if(!sample)throw Error('디코딩 표본 없음');
    try{
     ensure(sample.rotation===0&&!sample.flip&&sample.pixelAspectRatio.num===sample.pixelAspectRatio.den,'샘플 방향/픽셀 종횡비 미지원');
     const frame=sample.toVideoFrame(),origin={kind:'decoded-video',trackId:track.id,pts:sample.timestamp,duration:sample.duration,timestampMicroseconds:frame.timestamp,format:frame.format};
     await add(frame,sample.timestamp,origin);
    }finally{sample.close();}
   }
   input.dispose();input=undefined;
  }
  const backup=new Uint8Array(4*4*3/2).fill(128);
  await add(new VideoFrame(backup,{format:'I420',codedWidth:4,codedHeight:4,timestamp:9_000_000,
   colorSpace:{primaries:'bt709',transfer:'bt709',matrix:'bt709',fullRange:false}}),9,{kind:'unused-backup'},false);
  // A real second acquisition from one earlier stored source. IDs are assigned
  // by the client; neither a timestamp nor a fabricated processing id is used.
  const reused=rows[selected?2:0],read=await recorder.readFrame(reused.id,signal);
  const recovery=await acquisition.detectPrepared({pixels:new Uint8Array(read.pixels.buffer),width:read.width,height:read.height,
   binding:{sourceFrameId:reused.id,captureTime:reused.time}},target);
  try{capture.use(reused.id,recovery.frameId,'recovery',reused.time,recovery.rasterReceipt);}finally{releaseAcquisition(recovery);}
  await capture.finish();const raw=await recorder.finish();ensure(raw.stats.complete&&raw.stats.storageVersion===1,'공통 입력 파일 불완전');
  ensure(joined.length===uses.length&&joined.length===rows.length,'실제 판독·저장 해시 연결 누락');
  const file=await session.finish(undefined,true);ensure(file?.exact,'내구성 있는 파일 없음');if(!file?.exact)throw Error('파일 없음');
  ensure(file.metadata.version===5&&file.metadata.recordState==='complete','저널 또는 세션이 부분 기록');
  const bundle=createReproductionBundle(file);
  // Preserve sealed bytes even if reopening or pixel verification fails. The
  // filename/UI must not promote an unverified archive to a successful proof.
  exported=bundle;exportName=`loacard-prepared-unverified-${file.metadata.sessionId}.loareplay`;
  save.disabled=false;save.textContent='미검증 파일 저장';
  const reopened=await openReproduction(bundle,signal),headers=[],rasterReplay=new CanonicalRasterReplay();
  for await(const {header}of exactEntries(reopened.exact!,signal)){rasterReplay.accept(header);if(header.kind==='frame')headers.push(header);}
  ensure(headers.length===rows.length,'물리 입력 누락');
  for(const [index,header]of headers.entries()){
   const row=rows[index];ensure(header.id===row.id&&header.time===row.time&&header.width===row.width&&header.height===row.height&&header.hash===row.hash,'물리 원본 연결 불일치');
   if(row.storage.kind==='native'){
    ensure(header.storage?.kind==='native-yuv420'&&header.storage.nativeSha256===row.storage.nativeSha256,'복사한 native 바이트 연결 불일치');
    if(header.storage?.kind==='native-yuv420')ensure(nativeYuvDescriptorJson(header.storage.descriptor,planNativeYuvFrame(header.storage.descriptor).layout)===
     nativeYuvDescriptorJson(row.storage.descriptor,planNativeYuvFrame(row.storage.descriptor).layout),'native 프로필 연결 불일치');
   }else ensure(header.storage?.kind==='rgba8','RGBA fallback 저장 형식 불일치');
  }
  let verified=0;
  for await(const frame of exactPixels(reopened.exact!,signal,1)){
   const row=rows[verified++];ensure(frame.id===row.id&&frame.time===row.time&&frame.hash===row.hash&&await pixelHash(frame.pixels)===row.hash,'복원 픽셀 불일치');
   const measured=await acquisition.detectPrepared({pixels:frame.pixels,width:frame.width,height:frame.height,binding:{sourceFrameId:frame.id,captureTime:frame.time}},target);
   try{ensure(measured.rasterReceipt.hash===row.hash,'복원 후 실제 획득 픽셀 불일치');replayAcquisitions.push({...measured.rasterReceipt,cells:measured.cells.length});}
   finally{releaseAcquisition(measured);}
  }
  ensure(verified===rows.length,'복원된 입력 수 불일치');
  const execution=await executionSummary(reopened.exact!,signal,reopened.metadata.exact);ensure(execution.recordingComplete,'전체 파일 구조 미검증');
  sourceEnd=await sourceSnapshot(signal);ensure(sourceStart.sourceDigest===sourceEnd.sourceDigest,'실행 중 소스 변경');
  exportName=`loacard-prepared-proof-${file.metadata.sessionId}.loareplay`;save.textContent='검증 파일 저장';
  result.textContent=JSON.stringify({complete:true,preparationMode,sourceStart,sourceEnd,original,sessionId:session.id,rows,uses,joined,headers,verifiedPhysicalFrames:verified,replayAcquisitions,
   stats:raw.stats,journal:session.journalStats(),metadata:reopened.metadata,preparation:preparation.stats,capture:capture.stats,bundle:{bytes:bundle.size,sha256:null},execution,
   rasterReplay:rasterReplay.summary(true),elapsedMs:performance.now()-started,boundaries:{actualAcquisitionPixelsMeasured:true,actualLiveBinding:false,fullVideoRecordingGate:false,measuredFullMemory:false,
    defaultCanvasCompared:preparationMode==='canvas',claim:'Real preparation, acquisition-internal raster, source/use, committed ACK and reopened physical pixels. Canvas mode also compares the same owned input to default acquisition and final card pixels/geometry/quality. Small serial samples; no full-video/live throughput or recognition-accuracy claim.'}},null,2);
  status.textContent=`판독·저장·복원 일치 · ${verified}개 원본 · 실제 판독 ${uses.length}회`;
 }catch(error){status.textContent=String(error);result.textContent=JSON.stringify({complete:false,preparationMode,error:String(error),sourceStart,sourceEnd,original,sessionId:session?.id??null,
   unverifiedBundle:exported?{bytes:exported.size,name:exportName}:null,rows,uses,joined,replayAcquisitions,elapsedMs:performance.now()-started},null,2);
  recorder?.incomplete(String(error));capture?.cancel();await capture?.finish().catch(()=>{});if(session)await session.finish(undefined,false).catch(()=>{});
 }finally{input?.dispose();acquisition?.dispose();referenceAcquisition?.dispose();await preparation?.dispose();await recorder?.dispose().catch(()=>{});target.width=referenceTarget.width=0;active=undefined;button.disabled=select.disabled=false;}
});
save.addEventListener('click',()=>{if(!exported)return;const url=URL.createObjectURL(exported),link=document.createElement('a');link.href=url;link.download=exportName;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);});
void fetch('/__corpus').then(async response=>{ensure(response.ok,'코퍼스 목록 없음');const body=await response.json();for(const value of body.cases as CorpusCase[])if(value.kind==='video'){
 cases.set(value.id,value);select.add(new Option(value.name,value.id));
}}).catch(error=>{status.textContent=`합성 입력만 검사 가능 · ${String(error)}`;});
