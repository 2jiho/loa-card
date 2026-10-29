import {ALL_FORMATS,BlobSource,Input,VideoSampleSink} from 'mediabunny';
import {MAX_FRAME_BYTES} from '../src/features/card-scanner/exact-recording-codec';
import {waitForInput,yieldForCapture} from '../src/features/card-scanner/input-source';
import type {DecodedRgbaMetadata} from '../src/features/card-scanner/decoded-rgba-client';

export const NATIVE_PLANE_VIDEO_URL='/work/encoded-reference/video5-recovery-source.webm';
export const NATIVE_PLANE_PREPARATION_URL='/work/encoded-reference/video5-reference-preparation.json';
export const MAX_NATIVE_PLANE_ENCODED_BYTES=32*1024*1024;
const CASE_ID='c8610f98618113b4ce95d74d8c09d59b395daed75921621dadc5f35df95b0609';
const MAX_FRAMES=10_000,MAX_METADATA_BYTES=8*1024*1024,MAX_DIFFERENCES=64;
const object=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value);
const natural=(value:unknown):value is number=>typeof value==='number'&&Number.isSafeInteger(value)&&value>=0;
const positive=(value:unknown):value is number=>natural(value)&&value>0;
const sha=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const digest=(value:ArrayBuffer|Uint8Array<ArrayBuffer>)=>crypto.subtle.digest('SHA-256',value)
 .then(hash=>Array.from(new Uint8Array(hash),byte=>byte.toString(16).padStart(2,'0')).join(''));

export interface NativePlaneSource {
 caseId:string;bytes:number;sha256:string;type:'video/webm';sourceArchiveSha256:string;
 sourceArchiveComplete:false;encodedSourceCompleteness:'unknown';metadataDurationAnnotationSeconds:number;
}
/** Only the fixed local, byte-verified extraction is accepted by this proof. */
export function parseNativePlaneSource(value:unknown):NativePlaneSource {
 if(!object(value)||value.caseId!==CASE_ID||!object(value.sourceArchive)||!object(value.encodedReference))throw Error('네이티브 평면 준비 자료 형식 오류');
 const archive=value.sourceArchive,video=value.encodedReference;
 if(archive.manifestMatched!==true||archive.unmodifiedAfterInspection!==true||archive.recordState!=='partial'||archive.exactComplete!==false||!sha(archive.sha256)||
  video.path!==NATIVE_PLANE_VIDEO_URL.slice(1)||!positive(video.bytes)||video.bytes>MAX_NATIVE_PLANE_ENCODED_BYTES||video.type!=='video/webm'||
  !sha(video.sha256)||video.outputFileSha256!==video.sha256||video.outputFileMatchesContainedVideo!==true||
  typeof video.metadataDurationAnnotationSeconds!=='number'||!Number.isFinite(video.metadataDurationAnnotationSeconds)||video.metadataDurationAnnotationSeconds<0)
  throw Error('네이티브 평면 영상 출처·용량 오류');
 return {caseId:CASE_ID,bytes:video.bytes,sha256:video.sha256,type:'video/webm',sourceArchiveSha256:archive.sha256,
  sourceArchiveComplete:false,encodedSourceCompleteness:'unknown',metadataDurationAnnotationSeconds:video.metadataDurationAnnotationSeconds};
}

type ColorSpace={primaries:string|null;transfer:string|null;matrix:string|null;fullRange:boolean|null};
type Rect={x:number;y:number;width:number;height:number};
type ExplicitRgb={status:'supported';bytes:number;sha256:string;layout:{offset:number;stride:number}[];
 repeatSha256:string;repeatLayout:{offset:number;stride:number}[]}|{status:'unsupported';error:string};
export interface NativePlaneRecord {
 ordinal:number;
 sample:{timestampSeconds:number;durationSeconds:number;rotation:number;flip:boolean;pixelAspectRatio:{numerator:number;denominator:number};colorSpace:ColorSpace};
 native:{format:string;codedWidth:number;codedHeight:number;displayWidth:number;displayHeight:number;visibleRect:Rect|null;
  timestampMicroseconds:number;durationMicroseconds:number|null;colorSpace:ColorSpace};
 layout:{offset:number;stride:number}[];bytes:number;sha256:string;nativeI420OrNv12:boolean;allocatedBytes:number;explicitRgb:ExplicitRgb;
}
export interface PaintedRgbaRecord {
 ordinal:number;time:number;duration:number;width:number;height:number;workerSha256:string;paintSha256:string;
 nonOpaquePixels:number;metadata:DecodedRgbaMetadata;
}

/** A pre-paint receipt alone cannot certify the reused canvas. Both actual
 * canvas bytes and metadata/order must agree in each pass and across passes. */
export function comparePaintedRgbaPasses(first:readonly PaintedRgbaRecord[],second:readonly PaintedRgbaRecord[]){
 for(const pass of [first,second]){
  if(!Array.isArray(pass)||!pass.length||pass.length>MAX_FRAMES)throw Error('표준 RGBA 입력 검사 수량 오류');
  for(const [index,row]of pass.entries())if(row.ordinal!==index+1||!positive(row.width)||!positive(row.height)||row.width*row.height*4>MAX_FRAME_BYTES||
   !sha(row.workerSha256)||!sha(row.paintSha256)||!natural(row.nonOpaquePixels)||row.nonOpaquePixels>row.width*row.height||
   !row.metadata||row.metadata.recipe!=='webcodecs-rgba-srgb-v1'||row.metadata.ordinal!==row.ordinal||row.metadata.pts!==row.time||
   row.metadata.duration!==row.duration||row.metadata.rgbaSha256!==row.workerSha256||!Number.isFinite(row.time)||!Number.isFinite(row.duration)||row.duration<0)
   throw Error('표준 RGBA 입력 검사 근거 오류');
 }
 const postPaintFirst=first.filter(row=>row.workerSha256!==row.paintSha256).length,postPaintSecond=second.filter(row=>row.workerSha256!==row.paintSha256).length;
 let workerChanges=0,paintChanges=0,metadataChanges=0,changed=0;
 const differences:{ordinal:number;reason:string[]}[]=[];
 for(let index=0;index<Math.max(first.length,second.length);index++){
  const a=first[index],b=second[index],reason:string[]=[];
  if(!a||!b)reason.push('missing-frame');
  else {
   if(a.workerSha256!==b.workerSha256){workerChanges++;reason.push('worker-rgba');}
   if(a.paintSha256!==b.paintSha256){paintChanges++;reason.push('painted-canvas');}
   if(a.width!==b.width||a.height!==b.height||JSON.stringify(a.metadata)!==JSON.stringify(b.metadata)){metadataChanges++;reason.push('metadata-or-size');}
   if(a.workerSha256!==a.paintSha256||b.workerSha256!==b.paintSha256)reason.push('worker-vs-painted-canvas');
  }
  if(reason.length){changed++;if(differences.length<MAX_DIFFERENCES)differences.push({ordinal:index+1,reason});}
 }
 return {framesFirst:first.length,framesSecond:second.length,sameFrameCount:first.length===second.length,
  postPaintMismatchesFirst:postPaintFirst,postPaintMismatchesSecond:postPaintSecond,workerHashChanges:workerChanges,paintHashChanges:paintChanges,
  metadataChanges,matchedAll:changed===0&&!postPaintFirst&&!postPaintSecond,differences,differencesOmitted:Math.max(0,changed-differences.length)};
}

function validPass(pass:readonly NativePlaneRecord[]){
 if(!Array.isArray(pass)||!pass.length||pass.length>MAX_FRAMES)throw Error('네이티브 평면 검사 수량 오류');
 for(const [index,record]of pass.entries())if(record.ordinal!==index+1||!positive(record.bytes)||record.bytes>MAX_FRAME_BYTES||!sha(record.sha256)||
  !record.sample||!Number.isFinite(record.sample.timestampSeconds)||!Number.isFinite(record.sample.durationSeconds)||record.sample.durationSeconds<0||
  !record.native||typeof record.native.format!=='string'||!positive(record.native.codedWidth)||!positive(record.native.codedHeight)||
  !Array.isArray(record.layout)||!record.layout.length||record.layout.length>4||record.layout.some((plane:NativePlaneRecord['layout'][number])=>!natural(plane.offset)||plane.offset>=record.bytes||!positive(plane.stride)||plane.stride>record.bytes))
  throw Error('네이티브 평면 검사 메타데이터 오류');
}

/** Layout, geometry and metadata must agree as well as native bytes. Equal RGB
 * records do not count as proof that the native I420/NV12 path was exercised. */
export function compareNativePlanePasses(first:readonly NativePlaneRecord[],second:readonly NativePlaneRecord[]){
 validPass(first);validPass(second);
 let changed=0,bytesChanged=0,metadataChanged=0,rgbChanged=0;
 const differences:{ordinal:number;reason:string[]}[]=[];
 for(let index=0;index<Math.max(first.length,second.length);index++){
  const a=first[index],b=second[index],reason:string[]=[];
  if(!a||!b)reason.push('missing-frame');
  else {
   if(a.bytes!==b.bytes||a.sha256!==b.sha256){reason.push('native-bytes');bytesChanged++;}
   if(JSON.stringify({sample:a.sample,native:a.native,layout:a.layout})!==JSON.stringify({sample:b.sample,native:b.native,layout:b.layout})){
    reason.push('metadata-or-layout');metadataChanged++;
   }
   if(a.explicitRgb.status==='supported'&&b.explicitRgb.status==='supported'&&JSON.stringify(a.explicitRgb)!==JSON.stringify(b.explicitRgb))rgbChanged++;
  }
  if(reason.length){changed++;if(differences.length<MAX_DIFFERENCES)differences.push({ordinal:index+1,reason});}
 }
 const allNativeI420OrNv12=[...first,...second].every(record=>record.nativeI420OrNv12&&['I420','NV12'].includes(record.native.format));
 const unsupportedFirst=first.filter(record=>record.explicitRgb.status!=='supported').length,unsupportedSecond=second.filter(record=>record.explicitRgb.status!=='supported').length;
 const allRgbSupported=!unsupportedFirst&&!unsupportedSecond;
 const sameFrameRepeatsMatch=allRgbSupported?[...first,...second].every(record=>record.explicitRgb.status==='supported'&&
  record.explicitRgb.sha256===record.explicitRgb.repeatSha256&&JSON.stringify(record.explicitRgb.layout)===JSON.stringify(record.explicitRgb.repeatLayout)):null;
 return {sameFrameCount:first.length===second.length,framesFirst:first.length,framesSecond:second.length,
  matchingFrames:Math.max(first.length,second.length)-changed,changedFrames:changed,byteDifferences:bytesChanged,metadataDifferences:metadataChanged,
  allNativeI420OrNv12,matchedAll:changed===0,nativeYuvDeterministic:changed===0&&allNativeI420OrNv12,
  differences,differencesOmitted:Math.max(0,changed-differences.length),
  explicitRgb:{allSupported:allRgbSupported,unsupportedFirst,unsupportedSecond,differentFrames:rgbChanged,
   sameFrameRepeatsMatch,matchedAll:allRgbSupported?first.length===second.length&&rgbChanged===0&&sameFrameRepeatsMatch:null}};
}

const color=(value:VideoColorSpaceInit|undefined):ColorSpace=>({primaries:value?.primaries??null,transfer:value?.transfer??null,matrix:value?.matrix??null,fullRange:value?.fullRange??null});
const rect=(value:DOMRectReadOnly|null):Rect|null=>value?{x:value.x,y:value.y,width:value.width,height:value.height}:null;
async function timed<T>(work:Promise<T>,milliseconds:number,message:string):Promise<T>{
 let timer:ReturnType<typeof setTimeout>|undefined;
 try{return await Promise.race([work,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error(message)),milliseconds);})]);}
 finally{clearTimeout(timer);}
}

interface WorkerScope {onmessage:((event:MessageEvent)=>void)|null;postMessage(value:unknown):void}
function setupWorker(scope:WorkerScope){
 let active:{id:number;controller:AbortController}|undefined;
 scope.onmessage=event=>{
  const message=event.data;
  if(message?.kind==='cancel'){if(active&&active.id===message.id)active.controller.abort(new DOMException('네이티브 평면 검사 중지','AbortError'));return;}
  if(message?.kind!=='run'||active)return;
  if(!positive(message.id)||!(message.blob instanceof Blob)||!['no-preference','prefer-software'].includes(message.decoderPreference))return;
  const controller=new AbortController(),id=message.id;
  active={id,controller};
  void run(message.blob,message.source,message.decoderPreference,controller.signal,(value)=>scope.postMessage({kind:'progress',id,...value}))
   .then(report=>scope.postMessage({kind:'done',id,report}),error=>scope.postMessage({kind:'done',id,report:{complete:false,error:String(error)}}))
   .finally(()=>{if(active?.id===id)active=undefined;});
 };
}

async function run(blob:Blob,suppliedSource:unknown,decoderPreference:'no-preference'|'prefer-software',signal:AbortSignal,progress:(value:Record<string,unknown>)=>void){
 let source:NativePlaneSource|undefined;
 const passes:{pass:number;timingPolicy:string;track:Record<string,unknown>;frames:NativePlaneRecord[];stats:Record<string,unknown>}[]=[];
 const started=performance.now();
 let report:Record<string,unknown>={complete:false};
 try{
  // The parent posts this small, immutable Blob, not decoded pixel buffers.
  if(!object(suppliedSource)||suppliedSource.caseId!==CASE_ID||!positive(suppliedSource.bytes)||suppliedSource.bytes>MAX_NATIVE_PLANE_ENCODED_BYTES||
   suppliedSource.bytes!==blob.size||!sha(suppliedSource.sha256)||!sha(suppliedSource.sourceArchiveSha256)||suppliedSource.type!=='video/webm'||
   suppliedSource.sourceArchiveComplete!==false||suppliedSource.encodedSourceCompleteness!=='unknown'||
   typeof suppliedSource.metadataDurationAnnotationSeconds!=='number'||!Number.isFinite(suppliedSource.metadataDurationAnnotationSeconds)||suppliedSource.metadataDurationAnnotationSeconds<0)
   throw Error('네이티브 평면 영상 작업 계약 오류');
  source={...suppliedSource} as unknown as NativePlaneSource;
  signal.throwIfAborted();progress({status:'봉인된 영상 바이트 SHA-256을 확인하고 있습니다.'});
  const sourceSha256=await digest(await blob.arrayBuffer());signal.throwIfAborted();
  if(sourceSha256!==source.sha256)throw Error('네이티브 평면 영상 SHA 불일치');
  for(let pass=1;pass<=2;pass++)passes.push(await decodePass(blob,pass,decoderPreference,signal,progress));
  const comparison=compareNativePlanePasses(passes[0].frames,passes[1].frames);
  report={complete:true,source:{...source,browserWorkerSha256:sourceSha256,matchedPreparation:true},decoderPreference,
   decoderPreferenceScope:'A requested WebCodecs hint, not proof that a software or hardware implementation was selected.',passes,comparison,
   elapsedMs:performance.now()-started,
   resourceBoundary:{encodedBlobBytes:blob.size,encodedSourceCapBytes:MAX_NATIVE_PLANE_ENCODED_BYTES,encodedDigestArrayBufferCapBytes:MAX_NATIVE_PLANE_ENCODED_BYTES,
    copyBufferAllocationCapBytes:MAX_FRAME_BYTES,appBuffersRetainedAtOnce:1,frameRecordsCapPerPass:MAX_FRAMES,metadataCapBytesPerPass:MAX_METADATA_BYTES,
    decodedPixelsRetained:0,physicalPeakRamMeasured:false,
    libraryPrefetch:'VideoSampleSink may predecode multiple samples internally; one application copy buffer does not bound the decoder or GPU queue.'},
   evidenceBoundary:{scope:'Two sequential passes over the same preserved encoded Blob, comparing native copyTo bytes/layout/metadata before RGB conversion',
    noSeekOrNearestLookup:true,copyToOptions:'{}: format and colorSpace deliberately omitted; native default visibleRect is copied',
    nativeHashUsesRgbConversion:false,explicitRgbProbe:'Separate capability test: copyTo({format:RGBA,colorSpace:srgb}), not Canvas drawing',sourceCompleteness:'unknown',sourceArchiveCompleteness:'partial',
    nativeHashScope:'The full zero-initialized default allocation, including any padding, plus a separate exact layout comparison; not a canonical active-plane hash or I420/NV12 equivalence test.',
    noClaim:'Not proof of all hardware/codec determinism, raw live pixel equality, RGB conversion accuracy or real-time scanner throughput'}};
 }catch(error){report={...report,complete:false,error:String(error),source,passes,elapsedMs:performance.now()-started};}
 return report;
}

async function decodePass(blob:Blob,pass:number,decoderPreference:'no-preference'|'prefer-software',signal:AbortSignal,progress:(value:Record<string,unknown>)=>void){
 const input=new Input({formats:ALL_FORMATS,source:new BlobSource(blob)}),frames:NativePlaneRecord[]=[];
 const abort=()=>input.dispose();signal.addEventListener('abort',abort,{once:true});
 let iterator:ReturnType<VideoSampleSink['samples']>|undefined;
 const started=performance.now();let copied=0,hashed=0,rgbCopied=0,rgbHashed=0,samplesClosed=0,nativeFramesClosed=0,maxNativeBytes=0,maxAllocatedBytes=0,maxRgbBytes=0,metadataBytes=0,jitterCount=0;
 let trackFacts:Record<string,unknown>={};
 const cleanupErrors:string[]=[];let failed=false,failure:unknown;
 try{
  signal.throwIfAborted();const track=await timed(input.getPrimaryVideoTrack(),10_000,'네이티브 평면 영상 트랙 시간 초과');signal.throwIfAborted();
  if(!track||!await timed(track.canDecode(),10_000,'네이티브 디코더 준비 시간 초과'))throw Error('이 브라우저가 네이티브 영상 디코딩을 지원하지 않습니다.');
  const [duration,metadataDuration,codec,decoderConfig,width,height]=await timed(Promise.all([
   track.computeDuration(),track.getDurationFromMetadata(),track.getCodec(),track.getDecoderConfig(),track.getDisplayWidth(),track.getDisplayHeight(),
  ]),10_000,'네이티브 평면 트랙 메타데이터 시간 초과');signal.throwIfAborted();
  if(!positive(width)||!positive(height)||width*height*4>MAX_FRAME_BYTES||decoderConfig?.codedWidth&&decoderConfig.codedHeight&&decoderConfig.codedWidth*decoderConfig.codedHeight*4>MAX_FRAME_BYTES)
   throw Error('네이티브 평면 영상 크기 한도 초과');
  trackFacts={id:track.id,number:track.number,codec,displayWidth:width,displayHeight:height,computedTrackEndSeconds:duration,metadataTrackEndSeconds:metadataDuration,
   trackDecoderConfigColorSpace:color(decoderConfig?.colorSpace),trackDecoderConfigScope:'Library-returned track config before the sink decoder wrapper; not a raw container field dump. Effective sample/native color spaces are recorded per frame.',
   decoderConfigCodedWidth:decoderConfig?.codedWidth??null,decoderConfigCodedHeight:decoderConfig?.codedHeight??null};
  iterator=new VideoSampleSink(track,{hardwareAcceleration:decoderPreference}).samples();
  for await(const sample of iterator){
   let frame:VideoFrame|undefined;
   try{
    signal.throwIfAborted();if(frames.length>=MAX_FRAMES)throw Error('네이티브 평면 프레임 상한 초과');
    frame=sample.toVideoFrame();
    if(!frame.format)throw Error('네이티브 프레임 format이 null이라 평면을 확인할 수 없습니다.');
    if(!positive(frame.codedWidth)||!positive(frame.codedHeight)||frame.codedWidth*frame.codedHeight*4>MAX_FRAME_BYTES)throw Error('네이티브 프레임 coded 크기 한도 초과');
    const options:VideoFrameCopyToOptions={},rgbOptions:VideoFrameCopyToOptions={format:'RGBA',colorSpace:'srgb'};
    const bytes=frame.allocationSize(options);if(!positive(bytes)||bytes>MAX_FRAME_BYTES)throw Error('네이티브 평면 복사 크기 한도 초과');
    let rgbBytes=0,rgbError='';
    try{rgbBytes=frame.allocationSize(rgbOptions);if(!positive(rgbBytes)||rgbBytes>MAX_FRAME_BYTES)throw Error('표준 RGBA 복사 크기 한도 초과');}
    catch(error){rgbBytes=0;rgbError=String(error).slice(0,500);}
    // Do not ask for RGBA or even an explicit native format: the API's default
    // format avoids the color-conversion path being investigated here.
    const allocatedBytes=Math.max(bytes,rgbBytes),buffer=new Uint8Array(allocatedBytes),pixels=buffer.subarray(0,bytes),copyStarted=performance.now();
    const layout=await frame.copyTo(pixels,options);copied+=performance.now()-copyStarted;signal.throwIfAborted();
    if(!Array.isArray(layout)||!layout.length||layout.length>4||layout.some(plane=>!natural(plane.offset)||plane.offset>=bytes||!positive(plane.stride)||plane.stride>bytes))throw Error('네이티브 평면 복사 레이아웃 오류');
    const hashStarted=performance.now(),sha256=await digest(pixels);hashed+=performance.now()-hashStarted;signal.throwIfAborted();
    let explicitRgb:ExplicitRgb={status:'unsupported',error:rgbError||'표준 RGBA allocationSize 미지원'};
    if(rgbBytes){
     try{
      const rgb=buffer.subarray(0,rgbBytes);rgb.fill(0);
      const rgbStarted=performance.now(),rgbLayout=await frame.copyTo(rgb,rgbOptions);rgbCopied+=performance.now()-rgbStarted;signal.throwIfAborted();
      if(!Array.isArray(rgbLayout)||!rgbLayout.length||rgbLayout.length>4||rgbLayout.some(plane=>!natural(plane.offset)||plane.offset>=rgbBytes||!positive(plane.stride)||plane.stride>rgbBytes))throw Error('표준 RGBA 복사 레이아웃 오류');
      const hashStarted=performance.now(),rgbSha256=await digest(rgb);rgbHashed+=performance.now()-hashStarted;signal.throwIfAborted();
      // Repeating the copy on the same owned native frame distinguishes RGB
      // conversion variability from changes between the two decoder passes.
      rgb.fill(0);const repeatedCopyStarted=performance.now(),repeatLayout=await frame.copyTo(rgb,rgbOptions);
      rgbCopied+=performance.now()-repeatedCopyStarted;signal.throwIfAborted();
      if(!Array.isArray(repeatLayout)||!repeatLayout.length||repeatLayout.length>4||repeatLayout.some(plane=>!natural(plane.offset)||plane.offset>=rgbBytes||!positive(plane.stride)||plane.stride>rgbBytes))throw Error('표준 RGBA 반복 복사 레이아웃 오류');
      const repeatedHashStarted=performance.now(),repeatSha256=await digest(rgb);rgbHashed+=performance.now()-repeatedHashStarted;signal.throwIfAborted();
      explicitRgb={status:'supported',bytes:rgbBytes,sha256:rgbSha256,layout:rgbLayout.map(plane=>({offset:plane.offset,stride:plane.stride})),
       repeatSha256,repeatLayout:repeatLayout.map(plane=>({offset:plane.offset,stride:plane.stride}))};
     }catch(error){signal.throwIfAborted();explicitRgb={status:'unsupported',error:String(error).slice(0,500)};}
    }
    const record:NativePlaneRecord={ordinal:frames.length+1,
     sample:{timestampSeconds:sample.timestamp,durationSeconds:sample.duration,rotation:sample.rotation,flip:sample.flip,
      pixelAspectRatio:{numerator:sample.pixelAspectRatio.num,denominator:sample.pixelAspectRatio.den},colorSpace:color(sample.colorSpace.toJSON())},
     native:{format:frame.format,codedWidth:frame.codedWidth,codedHeight:frame.codedHeight,displayWidth:frame.displayWidth,displayHeight:frame.displayHeight,
      visibleRect:rect(frame.visibleRect),timestampMicroseconds:frame.timestamp,durationMicroseconds:frame.duration,colorSpace:color(frame.colorSpace.toJSON())},
     layout:layout.map(plane=>({offset:plane.offset,stride:plane.stride})),bytes,sha256,nativeI420OrNv12:frame.format==='I420'||frame.format==='NV12',allocatedBytes,explicitRgb};
    maxNativeBytes=Math.max(maxNativeBytes,bytes);maxAllocatedBytes=Math.max(maxAllocatedBytes,allocatedBytes);maxRgbBytes=Math.max(maxRgbBytes,rgbBytes);
    metadataBytes+=new TextEncoder().encode(JSON.stringify(record)).byteLength;
    if(metadataBytes>MAX_METADATA_BYTES)throw Error('네이티브 평면 메타데이터 한도 초과');frames.push(record);
    if(frames.length%10===0)progress({status:`네이티브 평면 ${pass}/2회차 · ${frames.length}프레임 검사 중`,pass,frames:frames.length});
   }finally{try{if(frame){frame.close();nativeFramesClosed++;}}finally{sample.close();samplesClosed++;}}
   // Timing changes the consumer, never sample selection/order. Both passes
   // give cancellation messages a task boundary; only pass2 adds small jitter.
   if(pass===2&&frames.length%5===0){jitterCount++;await waitForInput(signal,1+frames.length%3);}
   await yieldForCapture(signal);
  }
  signal.throwIfAborted();if(!frames.length)throw Error('디코드된 네이티브 평면 프레임이 없습니다.');
 }catch(error){failed=true;failure=error;}finally{
  signal.removeEventListener('abort',abort);
  try{input.dispose();}catch(error){cleanupErrors.push(String(error));}
  if(iterator)try{await timed(iterator.return(undefined),5000,'네이티브 평면 반복자 종료 시간 초과');}catch(error){cleanupErrors.push(String(error));}
 }
 if(cleanupErrors.length)throw Error(`네이티브 평면 공개 API 정리 실패: ${cleanupErrors.join(' · ')}${failed?` · 원래 오류: ${String(failure)}`:''}`);
 if(failed)throw failure;
 return {pass,timingPolicy:pass===1?'cooperative yield after each sample':'same sequential samples, cooperative yield plus1–3ms delay every fifth sample',
  track:trackFacts,frames,stats:{elapsedMs:performance.now()-started,nativeCopyToMs:copied,nativeHashMs:hashed,explicitRgbCopyToMs:rgbCopied,explicitRgbHashMs:rgbHashed,
   maxNativeBytes,maxAllocatedBytes,maxRgbRequestedBytes:maxRgbBytes,bufferReuse:'One zero-initialized allocation per frame; native SHA settles before explicit RGB overwrites the same buffer.',metadataBytes,jitterCount,samplesClosed,nativeFramesClosed,
   cleanup:{publicApiReturned:true,currentSampleAndFrameClosed:true,scope:'Current copyTo settled before frame/sample close; Input.dispose and iterator.return completed. Internal decoder pump completion is not publicly exposed.'}}};
}

if(typeof document==='undefined'&&typeof self!=='undefined')setupWorker(self as unknown as WorkerScope);
