import {ALL_FORMATS,BlobSource,Input,VideoSampleSink} from 'mediabunny';
import {createExactRecording,type ExactRecorder} from '../src/features/card-scanner/exact-recording';
import {createReproductionBundle,openReproduction,beginReproduction} from '../src/features/card-scanner/scan-reproduction';
import {createReproductionSessionStore} from '../src/features/card-scanner/reproduction-session-store';
import {exactEntries,exactPixels,exactReplayFrames,executionSummary} from '../src/features/card-scanner/exact-recording-codec';
import {prepareNativeStorage,parseNativeYuvMetadata,type FrameStorage} from '../src/features/card-scanner/native-frame-storage';
import {planNativeYuvFrame,type NativeYuvFrameMetadata} from '../src/features/card-scanner/native-yuv-recipe';
import {pixelHash} from '../src/features/card-scanner/recording-frame-integrity';
import {loadComparisonOriginal} from './comparison-original';

type CorpusCase={id:string;name:string;kind:string;inputs:{url:string;bytes:number;type:string;sha256:string}[]};
type Expected={id:number;time:number;width:number;height:number;hash:string;storage:FrameStorage;origin:'synthetic'|'decoded-video';source?:unknown};
const select=document.querySelector<HTMLSelectElement>('#corpus')!,button=document.querySelector<HTMLButtonElement>('#run')!,
 status=document.querySelector<HTMLElement>('#status')!,result=document.querySelector<HTMLElement>('#result')!,save=document.querySelector<HTMLButtonElement>('#save')!;
const cases=new Map<string,CorpusCase>(),store=createReproductionSessionStore({dbName:'loacard-dev-compact-proof'});
let active:AbortController|undefined,exported:Blob|undefined,exportName='';
window.addEventListener('pagehide',()=>{active?.abort(new DOMException('검증 페이지 종료','AbortError'));exported=undefined;});
const ensure=(condition:unknown,reason:string)=>{if(!condition)throw Error(reason);};
async function sourceSnapshot(signal:AbortSignal){const response=await fetch('/__corpus/environment',{cache:'no-store',signal});ensure(response.ok,'실행 소스 확인 실패');return response.json();}
function descriptor(format:'I420'|'NV12',size:number,name:'smpte170m'|'bt709'):NativeYuvFrameMetadata{
 return {format,codedWidth:size,codedHeight:size,displayWidth:size,displayHeight:size,
  visibleRect:{x:0,y:0,width:size,height:size},rotation:0,flip:false,colorSpace:{primaries:name,transfer:name,matrix:name,fullRange:false}};
}
function nativeDescriptor(frame:VideoFrame){
 const oriented=frame as VideoFrame&{rotation?:number;flip?:boolean},rect=frame.visibleRect,color=frame.colorSpace.toJSON();
 return parseNativeYuvMetadata({format:frame.format,codedWidth:frame.codedWidth,codedHeight:frame.codedHeight,
  displayWidth:frame.displayWidth,displayHeight:frame.displayHeight,visibleRect:rect?{x:rect.x,y:rect.y,width:rect.width,height:rect.height}:null,
  rotation:oriented.rotation,flip:oriented.flip,colorSpace:{primaries:color.primaries??null,transfer:color.transfer??null,matrix:color.matrix??null,fullRange:color.fullRange??null}});
}
button.addEventListener('click',async()=>{
 if(active)return;const controller=active=new AbortController(),signal=AbortSignal.any([controller.signal,AbortSignal.timeout(180_000)]),
  started=performance.now(),expected:Expected[]=[],openReads:unknown[]=[],closedReads:unknown[]=[];
 button.disabled=select.disabled=true;save.disabled=true;exported=undefined;result.textContent='';status.textContent='저장·복원을 검사하고 있습니다.';
 let recorder:ExactRecorder|undefined,session:ReturnType<typeof beginReproduction>|undefined,input:Input|undefined,port:MessagePort|undefined,
  sourceEnded=false,pending:{id:number;resolve:()=>void;reject:(error:unknown)=>void}|undefined,credits=0,drainDone:(()=>void)|undefined;
 let original:unknown=null,sourceStart:Awaited<ReturnType<typeof sourceSnapshot>>|null=null,sourceEnd:typeof sourceStart=null;
 const abortPending=()=>pending?.reject(signal.reason);signal.addEventListener('abort',abortPending);
 async function bounded<T>(promise:Promise<T>,late?:(value:T)=>void):Promise<T>{
  let abandoned=false,onAbort:(()=>void)|undefined,timer:ReturnType<typeof setTimeout>|undefined;
  void promise.then(value=>{if(abandoned)late?.(value);},()=>{});
  try{return await Promise.race([promise,new Promise<never>((_,reject)=>{
   onAbort=()=>reject(signal.reason);signal.addEventListener('abort',onAbort,{once:true});
   timer=setTimeout(()=>reject(Error('검증 작업 15초 한도 초과')),15_000);if(signal.aborted)onAbort();
  })]);}catch(error){abandoned=true;throw error;}finally{clearTimeout(timer);if(onAbort)signal.removeEventListener('abort',onAbort);}
 }
 async function send(row:Expected,payload:Record<string,unknown>,transfer:Transferable[]){
  signal.throwIfAborted();ensure(expected.length<16,'물리 프레임 검사 상한');expected.push(row);
  const stored=new Promise<void>((resolve,reject)=>{pending={id:row.id,resolve,reject};});
  try{port!.postMessage({kind:'frame',canonical:true,id:row.id,time:row.time,width:row.width,height:row.height,role:'backup',...payload},transfer);await bounded(stored);}
  finally{pending=undefined;}
 }
 async function addNative(meta:NativeYuvFrameMetadata,bytes:Uint8Array<ArrayBuffer>,time:number,origin:Expected['origin'],source?:unknown){
  const {storage,rgbaHash}=await prepareNativeStorage(meta,bytes),plan=planNativeYuvFrame(meta),id=expected.length+1;
  await send({id,time,width:plan.width,height:plan.height,hash:rgbaHash,storage,origin,...(source?{source}:{})},
   {native:{descriptor:meta,pixels:bytes}},[bytes.buffer]);ensure(bytes.byteLength===0,'native 바이트 소유권 미이전');
 }
 async function addRgba(size:number,value:number,time:number){
  const bytes=new Uint8Array(size*size*4).fill(value);for(let at=3;at<bytes.length;at+=4)bytes[at]=255;
  const hash=await pixelHash(bytes),id=expected.length+1;
  await send({id,time,width:size,height:size,hash,storage:{version:1,kind:'rgba8',byteLength:bytes.length},origin:'synthetic'},
   {pixels:bytes.buffer},[bytes.buffer]);ensure(bytes.byteLength===0,'RGBA 바이트 소유권 미이전');
 }
 try{
  sourceStart=await sourceSnapshot(signal);recorder=await bounded(createExactRecording({storageVersion:1}),value=>{void value.dispose();});
  ensure(recorder.supportsSourceReads,'열린 원본 파일 읽기 미지원');
  session=beginReproduction([],{browser:navigator.userAgent,catalog:'compact-storage-proof',build:import.meta.env.VITE_BUILD_REVISION??'local'},
   {record:true,exact:recorder,store});
  port=recorder.takePort();port.onmessage=event=>{
   const value=event.data;if(value.kind==='credit')credits+=value.bytes;if(value.kind==='drained')drainDone?.();
   if(value.kind==='source-error')pending?.reject(Error(value.error));
   if(value.kind==='stored'){
    const row=expected.find(row=>row.id===value.id);
    if(!row||row.hash!==value.hash||row.time!==value.time)pending?.reject(Error('저장 ACK와 원본 불일치'));
    else if(pending&&pending.id===value.id)pending.resolve();
   }
  };port.start();
  for(const value of [90,110]){const meta=descriptor('I420',8,'smpte170m');await addNative(meta,new Uint8Array(planNativeYuvFrame(meta).nativeByteLength).fill(value),value/1000,'synthetic');}
  const nv=descriptor('NV12',8,'bt709');await addNative(nv,new Uint8Array(planNativeYuvFrame(nv).nativeByteLength).fill(140),.14,'synthetic');
  await addRgba(8,50,.2);await addRgba(8,70,.3);
  const selected=cases.get(select.value);
  if(selected){
   const response=await fetch(`/__corpus/cases/${selected.id}`,{signal});ensure(response.ok,'입력 사례를 읽지 못했습니다.');
   const detail:CorpusCase=await response.json(),loaded=await loadComparisonOriginal(detail.inputs[0].url,detail.inputs[0],signal);
   original={caseId:selected.id,...loaded.verified};input=new Input({formats:ALL_FORMATS,source:new BlobSource(loaded.blob)});
   const track=await bounded(input.getPrimaryVideoTrack());ensure(track,'영상 트랙 없음');if(!track)throw Error('영상 트랙 없음');
   ensure(await bounded(track.canDecode()),'디코더 미지원');const duration=await bounded(track.computeDuration()),sink=new VideoSampleSink(track);
   for(const at of [1,3,5]){
    const sample=await bounded(sink.getSample(Math.min(at,duration-.1)),sample=>sample?.close());ensure(sample,'디코딩한 표본 없음');if(!sample)throw Error('표본 없음');
    let frame:VideoFrame|undefined,sampleClosed=false;
    try{
     ensure(sample.rotation===0&&!sample.flip&&sample.pixelAspectRatio.num===sample.pixelAspectRatio.den,'샘플 방향/픽셀 종횡비 미지원');
     frame=sample.toVideoFrame();const meta=nativeDescriptor(frame),plan=planNativeYuvFrame(meta),pixels=new Uint8Array(plan.nativeByteLength);
     ensure(frame.allocationSize({layout:[...plan.layout]})===pixels.length,'native 할당 크기 불일치');
     const layout=await bounded(frame.copyTo(pixels,{layout:[...plan.layout]}));
     ensure(layout.length===plan.layout.length&&layout.every((plane,index)=>plane.offset===plan.layout[index].offset&&plane.stride===plan.layout[index].stride),'native 평면 배치 불일치');
     const captured=sample.timestamp,receipt={trackId:track.id,pts:captured,duration:sample.duration,
      timestampMicroseconds:frame.timestamp,format:frame.format};
     frame.close();frame=undefined;sample.close();sampleClosed=true;
     await addNative(meta,pixels,captured,'decoded-video',receipt);
    }finally{frame?.close();if(!sampleClosed)sample.close();}
   }
   input.dispose();input=undefined;
  }
  const small=descriptor('I420',4,'smpte170m');await addNative(small,new Uint8Array(planNativeYuvFrame(small).nativeByteLength).fill(120),10,'synthetic');
  await bounded(new Promise<void>(resolve=>{drainDone=resolve;port!.postMessage({kind:'drain'});}));drainDone=undefined;
  for(const id of [expected.length,1,3]){const read=await bounded(recorder.readFrame(id,signal)),row=expected[id-1];
   ensure(read.hash===row.hash&&await pixelHash(new Uint8Array(read.pixels.buffer))===row.hash,'열린 파일 복원 해시 불일치');openReads.push({id,hash:read.hash});}
  const useRows=[expected[0],expected[3],expected.at(-2)!,expected[0]];
  const uses=useRows.map((row,index)=>({sourceFrameId:row.id,acquisitionFrameId:17+index,phase:index===3?'recovery' as const:'input' as const,captureTime:row.time}));
  uses.forEach(use=>recorder!.event('canonical-source-use',use,use.captureTime));
  port.postMessage({kind:'end'});sourceEnded=true;
  const raw=await bounded(recorder.finish());ensure(raw.stats.complete&&raw.stats.storageVersion===1,'완전한 compact 파일이 아님');
  for(const id of [2,expected.length]){const read=await bounded(recorder.readFrame(id,signal));
   ensure(read.hash===expected[id-1].hash&&await pixelHash(new Uint8Array(read.pixels.buffer))===expected[id-1].hash,'닫힌 파일 복원 해시 불일치');closedReads.push({id,hash:read.hash});}
  const file=await bounded(session.finish(undefined,true));ensure(file?.exact,'내구성 있는 입력 파일이 없음');if(!file?.exact)throw Error('파일 없음');
  ensure(file.metadata.version===5&&file.metadata.recordState==='complete'&&file.metadata.exact?.complete,'저널 또는 세션이 부분 기록');
  const bundle=createReproductionBundle(file),reopened=await openReproduction(bundle,signal),headers=[];
  for await(const {header}of exactEntries(reopened.exact!,signal))if(header.kind==='frame'){
   const row=expected[headers.length];ensure(row&&header.id===row.id&&header.time===row.time&&header.width===row.width&&header.height===row.height&&
    header.hash===row.hash&&JSON.stringify(header.storage)===JSON.stringify(row.storage),'물리 원본의 형식·프로필·내용 연결 불일치');headers.push(header);
  }
  let verified=0;for await(const frame of exactPixels(reopened.exact!,signal,1)){
   const row=expected[verified++];ensure(frame.hash===row.hash&&await pixelHash(frame.pixels)===row.hash,'내보낸 물리 입력 픽셀 불일치');
  }ensure(verified===expected.length,'물리 프레임 수 불일치');
  const replayed=[];for await(const frame of exactReplayFrames(reopened.exact!,signal,undefined,expected.length,false,1)){
   const use=uses[replayed.length],row=expected[use.sourceFrameId-1];
   ensure(frame.provenance?.sourceFrameId===use.sourceFrameId&&frame.provenance.frameId===use.acquisitionFrameId&&
    frame.provenance.phase===use.phase&&frame.time===use.captureTime&&frame.provenance.pixelHash===row.hash,'재사용 순서/원본 연결 불일치');
   const painted=frame.element.getContext('2d',{willReadFrequently:true})!.getImageData(0,0,row.width,row.height).data,
    paintedHash=await pixelHash(new Uint8Array(painted.buffer,painted.byteOffset,painted.byteLength));
   ensure(paintedHash===row.hash,'브라우저 재생 Canvas 픽셀 불일치');
   replayed.push({...frame.provenance,paintedHash});
  }ensure(replayed.length===uses.length,'원본 사용 누락');
  const execution=await executionSummary(reopened.exact!,signal,reopened.metadata.exact);ensure(execution.recordingComplete,'파일 전체성 미확인');
  const reservedBytes=expected.reduce((total,row)=>total+row.storage.byteLength+(row.storage.kind==='native-yuv420'?row.width*row.height*4:0),0);
  ensure(credits===reservedBytes,'입력 바이트 credit 해제 불일치');
  sourceEnd=await sourceSnapshot(signal);ensure(sourceStart.sourceDigest===sourceEnd.sourceDigest,'실행 중 소스 변경');
  exported=bundle;exportName=`loacard-compact-proof-${file.metadata.sessionId}.loareplay`;save.disabled=false;
  result.textContent=JSON.stringify({complete:true,sourceStart,sourceEnd,original,sessionId:session.id,expected,headers,openReads,closedReads,
   verifiedPhysicalFrames:verified,replayed,credits,stats:raw.stats,journal:session.journalStats(),metadata:reopened.metadata,
   bundle:{bytes:bundle.size,sha256:null},execution,elapsedMs:performance.now()-started,
   boundaries:{actualAcquisitionPixelsMeasured:false,actualLiveBinding:false,fullVideoRecordingGate:false,measuredFullMemory:false,
    claim:'Small mixed-payload production-worker/IDB/export/reopen proof. Constructed use events are not actual scanner acquisitions or card recognition.'}},null,2);
  status.textContent=`저장·복원 일치 · ${verified}개 물리 입력 · native ${raw.stats.nativeFrames} / RGBA ${raw.stats.rgbaFrames}`;
 }catch(error){status.textContent=String(error);result.textContent=JSON.stringify({complete:false,error:String(error),sourceStart,sourceEnd,original,
  expected,openReads,closedReads,elapsedMs:performance.now()-started},null,2);
  recorder?.incomplete(String(error));
  if(port&&!sourceEnded)try{port.postMessage({kind:'end'});sourceEnded=true;}catch{/* Worker may have stopped. */}
  if(session)await session.finish(undefined,false).catch(()=>{});
 }finally{
  signal.removeEventListener('abort',abortPending);input?.dispose();
  if(port&&!sourceEnded)try{port.postMessage({kind:'end'});}catch{/* Worker may have stopped. */}
  port?.close();await recorder?.dispose().catch(()=>{});active=undefined;button.disabled=select.disabled=false;
 }
});
save.addEventListener('click',()=>{if(!exported)return;const url=URL.createObjectURL(exported),link=document.createElement('a');
 link.href=url;link.download=exportName;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);});
void fetch('/__corpus').then(async response=>{
 ensure(response.ok,'코퍼스 목록 없음');const body=await response.json();for(const value of body.cases as CorpusCase[])if(value.kind==='video'){
  cases.set(value.id,value);select.add(new Option(value.name,value.id));
 }
}).catch(error=>{status.textContent=`합성 입력만 검사 가능 · ${String(error)}`;});
