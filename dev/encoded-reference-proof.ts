import {ALL_FORMATS,BlobSource,CanvasSink,Input} from 'mediabunny';
import {createRecordingInputRaster} from '../src/features/card-scanner/recording-input-raster';
import {yieldForCapture} from '../src/features/card-scanner/input-source';
import {MAX_FRAME_BYTES} from '../src/features/card-scanner/exact-recording-codec';
import {copyScannerInput} from '../src/features/card-scanner/scanner-input-frame';
import {createEncodedPixelResidual,restoreEncodedPixels} from '../src/features/card-scanner/encoded-pixel-residual';

const PREPARATION_URL='/work/encoded-reference/video5-reference-preparation.json';
const ALL_PREPARATION_URL='/work/encoded-reference/all-recovery-preparation.json';
const RAW_PROOF_URL='/work/video5-partial-prefix-proof.json';
const VIDEO_URL='/work/encoded-reference/video5-recovery-source.webm';
const DIFF_DESCRIPTOR_URL='/work/encoded-reference/mismatch-rasters/descriptor.json';
const CASE_ID='c8610f98618113b4ce95d74d8c09d59b395daed75921621dadc5f35df95b0609';
const MAX_ENCODED_BYTES=32*1024*1024,MAX_FRAMES=10_000,MAX_MATCHES=32,MAX_CANDIDATES=64;
const digest=(bytes:ArrayBuffer|Uint8Array<ArrayBuffer>)=>crypto.subtle.digest('SHA-256',bytes).then(hash=>Array.from(new Uint8Array(hash),value=>value.toString(16).padStart(2,'0')).join(''));
const object=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value);
const positive=(value:unknown):value is number=>Number.isSafeInteger(value)&&(value as number)>0;
const time=(value:unknown):value is number=>typeof value==='number'&&Number.isFinite(value)&&value>=0;
const sha=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
export interface EncodedCandidate {sourceFrameId:number;captureTime:number;width:number;height:number;pixelSha256:string}
export interface PreparedEncodedReference {
 caseId:string;sourceArchive:{bytes:number;sha256:string;recordState:string;exactComplete:boolean};
 encodedReference:{path:string;bytes:number;type:string;sha256:string;metadataDurationAnnotationSeconds:number};
 candidates:EncodedCandidate[];
}
/** The proof follows one fixed private extraction, never a URL from input JSON. */
export function parsePreparedEncodedReference(value:unknown):PreparedEncodedReference {
 if(!object(value)||value.caseId!==CASE_ID||!object(value.sourceArchive)||!object(value.encodedReference)||!object(value.exactHeaderInspection))throw Error('준비 자료 형식 오류');
 const archive=value.sourceArchive,encoded=value.encodedReference,targets=value.exactHeaderInspection.recoveryCandidates;
 if(!positive(archive.bytes)||!sha(archive.sha256)||archive.manifestMatched!==true||archive.unmodifiedAfterInspection!==true||
  archive.recordState!=='partial'||archive.exactComplete!==false||
  encoded.path!==VIDEO_URL.slice(1)||!positive(encoded.bytes)||encoded.bytes>MAX_ENCODED_BYTES||encoded.type!=='video/webm'||
  !sha(encoded.sha256)||encoded.outputFileSha256!==encoded.sha256||encoded.outputFileMatchesContainedVideo!==true||
  !time(encoded.metadataDurationAnnotationSeconds)||!Array.isArray(targets)||!targets.length||targets.length>MAX_CANDIDATES)throw Error('준비 영상 또는 후보 정보 오류');
 const ids=new Set<number>(),candidates=targets.map((target:unknown)=>{
  if(!object(target)||!positive(target.sourceFrameId)||ids.has(target.sourceFrameId)||!time(target.captureTime)||
   !positive(target.width)||!positive(target.height)||target.width*target.height*4>MAX_FRAME_BYTES||
   !sha(target.pixelSha256)||target.physicalPhase!=='recovery')throw Error('복구 원본 후보 오류');
  ids.add(target.sourceFrameId);return {sourceFrameId:target.sourceFrameId,captureTime:target.captureTime,width:target.width,height:target.height,pixelSha256:target.pixelSha256};
 });
 return {caseId:CASE_ID,sourceArchive:{bytes:archive.bytes,sha256:archive.sha256,recordState:archive.recordState,exactComplete:false},
  encodedReference:{path:encoded.path,bytes:encoded.bytes,type:encoded.type,sha256:encoded.sha256,metadataDurationAnnotationSeconds:encoded.metadataDurationAnnotationSeconds},candidates};
}
/** Link independently decoded raw pixels to this exact source file and targets.
 * The browser still does not reread the entire512MB archive. */
export function linkRawPixelProof(value:unknown,prepared:PreparedEncodedReference) {
 if(!object(value)||value.caseId!==prepared.caseId||value.fileSha256!==prepared.sourceArchive.sha256||value.fileBytes!==prepared.sourceArchive.bytes||
  value.inputUnmodified!==true||!object(value.metadata)||value.metadata.version!==4||value.metadata.recordState!=='partial'||
  !object(value.metadata.exact)||value.metadata.exact.complete!==false||!positive(value.metadata.exact.frames)||
  !object(value.pixelVerification)||value.pixelVerification.physicalVerified!==value.metadata.exact.frames||
  !Array.isArray(value.pixelVerification.physicalHashes)||value.pixelVerification.physicalHashes.length!==value.metadata.exact.frames||
  value.pixelVerification.physicalHashes.length>10_000)throw Error('독립 원본 픽셀 검증의 출처·범위 오류');
 const frames=new Map<number,{id:number;time:number;width:number;height:number;hash:string}>();
 for(const row of value.pixelVerification.physicalHashes){
  if(!object(row)||!positive(row.id)||frames.has(row.id)||!time(row.time)||!positive(row.width)||!positive(row.height)||
   row.width*row.height*4>MAX_FRAME_BYTES||!sha(row.hash))throw Error('독립 원본 픽셀 검증의 프레임 정보 오류');
  frames.set(row.id,{id:row.id,time:row.time,width:row.width,height:row.height,hash:row.hash});
 }
 const verifiedCandidates=prepared.candidates.map(candidate=>{
  const frame=frames.get(candidate.sourceFrameId);
  if(!frame||frame.time!==candidate.captureTime||frame.width!==candidate.width||frame.height!==candidate.height||frame.hash!==candidate.pixelSha256)
   throw Error('복구 후보와 독립 원본 픽셀 검증 불일치');
  return {sourceFrameId:frame.id,captureTime:frame.time,width:frame.width,height:frame.height,pixelSha256:frame.hash};
 });
 return {url:RAW_PROOF_URL,caseId:prepared.caseId,sourceArchiveSha256:prepared.sourceArchive.sha256,
  physicalFramesVerified:frames.size,verifiedCandidates,
  scope:'Linked offline file-backed pixel decoding proof; source file SHA and candidate identities/times/dimensions/pixels agree, not a browser raw-archive decode'};
}
export interface DecodedReferenceSample {ordinal:number;ptsSeconds:number;durationSeconds:number;width:number;height:number;pixelSha256:string}

/** Diagnostic only: a timestamp chooses a comparison, never proves identity. */
export function compareReferencePixels(expected:Uint8Array,actual:Uint8Array,width:number,height:number){
 const bytes=width*height*4;
 if(!positive(width)||!positive(height)||bytes>MAX_FRAME_BYTES||expected.byteLength!==bytes||actual.byteLength!==bytes)throw Error('픽셀 차이 비교 크기 오류');
 let changedPixels=0,changedBytes=0,totalDelta=0,minX=width,minY=height,maxX=-1,maxY=-1,expectedNonOpaque=0,actualNonOpaque=0;
 const changedByChannel=[0,0,0,0],maxDeltaByChannel=[0,0,0,0],samples:{x:number;y:number;expected:number[];actual:number[]}[]=[];
 for(let offset=0;offset<bytes;offset+=4){
  let changed=false;
  if(expected[offset+3]!==255)expectedNonOpaque++;if(actual[offset+3]!==255)actualNonOpaque++;
  for(let channel=0;channel<4;channel++){
   const delta=Math.abs(expected[offset+channel]-actual[offset+channel]);
   if(delta){changed=true;changedBytes++;changedByChannel[channel]++;totalDelta+=delta;maxDeltaByChannel[channel]=Math.max(maxDeltaByChannel[channel],delta);}
  }
  if(changed){
   changedPixels++;const index=offset/4,x=index%width,y=Math.floor(index/width);
   minX=Math.min(minX,x);minY=Math.min(minY,y);maxX=Math.max(maxX,x);maxY=Math.max(maxY,y);
   if(samples.length<16)samples.push({x,y,expected:Array.from(expected.subarray(offset,offset+4)),actual:Array.from(actual.subarray(offset,offset+4))});
  }
 }
 return {equal:changedBytes===0,changedPixels,changedBytes,changedByChannel,maxDeltaByChannel,meanAbsoluteByteDelta:totalDelta/bytes,
  expectedNonOpaquePixels:expectedNonOpaque,actualNonOpaquePixels:actualNonOpaque,
  bounds:changedPixels?{x:minX,y:minY,width:maxX-minX+1,height:maxY-minY+1}:null,samples};
}

function parseDiffRasters(value:unknown,prepared:PreparedEncodedReference){
 if(!object(value)||value.caseId!==prepared.caseId||value.sourceArchiveSha256!==prepared.sourceArchive.sha256||value.encodedSha256!==prepared.encodedReference.sha256||
  value.inputUnmodified!==true||!Array.isArray(value.rasters)||!value.rasters.length||value.rasters.length>MAX_CANDIDATES)throw Error('차이 비교 원본 출처 오류');
 const ids=new Set<number>(),times=new Set<number>();return value.rasters.map(row=>{
  if(!object(row)||!positive(row.sourceFrameId)||ids.has(row.sourceFrameId))throw Error('차이 비교 원본 ID 오류');
  const target=prepared.candidates.find(candidate=>candidate.sourceFrameId===row.sourceFrameId),path=`work/encoded-reference/mismatch-rasters/${row.sourceFrameId}.rgba`;
  if(!target||times.has(target.captureTime)||row.captureTime!==target.captureTime||row.width!==target.width||row.height!==target.height||row.pixelSha256!==target.pixelSha256||
   row.bytes!==target.width*target.height*4||row.path!==path&&row.path!==`/${path}`)throw Error('차이 비교 원본 근거 오류');
  ids.add(row.sourceFrameId);times.add(target.captureTime);return {...target,bytes:row.bytes as number,url:`/${path}`};
 });
}
/** Match by complete RGBA and dimensions. Capture time never selects a sample. */
export function createEncodedCandidateSearch(candidates:EncodedCandidate[]) {
 if(!Array.isArray(candidates)||!candidates.length||candidates.length>MAX_CANDIDATES)throw Error('복구 원본 후보 수량 오류');
 const ids=new Set<number>();
 for(const candidate of candidates){
  if(!candidate||!positive(candidate.sourceFrameId)||ids.has(candidate.sourceFrameId)||!time(candidate.captureTime)||
   !positive(candidate.width)||!positive(candidate.height)||candidate.width*candidate.height*4>MAX_FRAME_BYTES||!sha(candidate.pixelSha256))throw Error('복구 원본 후보 오류');
  ids.add(candidate.sourceFrameId);
 }
 const states=candidates.map(candidate=>({candidate:{...candidate},occurrences:0,hashWithWrongDimensions:0,retained:[] as DecodedReferenceSample[],
  lastMatch:null as DecodedReferenceSample|null,annotatedTimeOccurrences:0,annotatedTimeMatch:null as DecodedReferenceSample|null}));
 let count=0,first:DecodedReferenceSample|undefined,last:DecodedReferenceSample|undefined,maxRgbaBytes=0;
 return {
  accept(sample:DecodedReferenceSample){
   if(!positive(sample.ordinal)||sample.ordinal!==count+1||sample.ordinal>MAX_FRAMES||!time(sample.ptsSeconds)||!time(sample.durationSeconds)||
    !positive(sample.width)||!positive(sample.height)||sample.width*sample.height*4>MAX_FRAME_BYTES||!sha(sample.pixelSha256)||
    last&&sample.ptsSeconds<last.ptsSeconds)throw Error('순차 디코드 결과 순서·크기·시각 오류');
   count++;first??={...sample};last={...sample};maxRgbaBytes=Math.max(maxRgbaBytes,sample.width*sample.height*4);
   for(const state of states){
    if(sample.pixelSha256!==state.candidate.pixelSha256)continue;
    if(sample.width!==state.candidate.width||sample.height!==state.candidate.height){state.hashWithWrongDimensions++;continue;}
    state.occurrences++;const match={...sample};state.lastMatch=match;
    if(state.retained.length<MAX_MATCHES)state.retained.push(match);
    if(sample.ptsSeconds===state.candidate.captureTime){state.annotatedTimeOccurrences++;state.annotatedTimeMatch=match;}
   }
  },
  snapshot(){return {decodedFrames:count,maxRgbaBytes,firstSample:first??null,lastSample:last??null,
   observedEndSeconds:last?last.ptsSeconds+last.durationSeconds:null,
   candidates:states.map(state=>({...state.candidate,matched:state.occurrences>0,matchingFrameCount:state.occurrences,
    ambiguousPixelMatch:state.occurrences>1,hashWithWrongDimensions:state.hashWithWrongDimensions,
    matches:state.retained.map(value=>({...value})),matchesOmitted:Math.max(0,state.occurrences-state.retained.length),lastMatch:state.lastMatch?{...state.lastMatch}:null,
    annotatedCaptureTimeMatches:state.annotatedTimeOccurrences,annotatedCaptureTimeMatch:state.annotatedTimeMatch?{...state.annotatedTimeMatch}:null,
    expectedEncodedDurationSeconds:null,durationComparison:'No encoded sample duration exists in the preserved raw-frame header'})),
   matched:states.every(state=>state.occurrences>0)};},
 };
}
async function timed<T>(work:Promise<T>,ms:number,message:string):Promise<T>{
 let timer:ReturnType<typeof setTimeout>|undefined;
 try{return await Promise.race([work,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error(message)),ms);})]);}
 finally{clearTimeout(timer);}
}
async function verifiedVideo(prepared:PreparedEncodedReference,signal:AbortSignal){
 const response=await fetch(VIDEO_URL,{signal,cache:'no-store'});
 if(!response.ok||!response.body)throw Error('준비 영상을 읽을 수 없습니다. 먼저 준비 스크립트를 실행하세요.');
 const length=response.headers.get('content-length');if(length!==null&&Number(length)!==prepared.encodedReference.bytes)throw Error('준비 영상 HTTP 용량 불일치');
 const chunks:Uint8Array<ArrayBuffer>[]=[],reader=response.body.getReader();let bytes=0,maxChunkBytes=0;
 try{
  while(true){signal.throwIfAborted();const next=await reader.read();if(next.done)break;
   bytes+=next.value.byteLength;if(bytes>prepared.encodedReference.bytes||bytes>MAX_ENCODED_BYTES)throw Error('준비 영상 용량 상한 초과');
   chunks.push(new Uint8Array(next.value));maxChunkBytes=Math.max(maxChunkBytes,next.value.byteLength);
  }
 }finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
 if(bytes!==prepared.encodedReference.bytes)throw Error('준비 영상 일부만 도착했습니다.');
 const blob=new Blob(chunks,{type:prepared.encodedReference.type});chunks.length=0;
 // Only this small encoded reference is buffered, under32MiB. The original
 // 512MB replay and decoded frame sequence are never read into an ArrayBuffer.
 const actualHash=await digest(await blob.arrayBuffer());signal.throwIfAborted();
 if(actualHash!==prepared.encodedReference.sha256)throw Error('준비 영상 SHA-256 불일치');
 return {blob,proof:{url:VIDEO_URL,bytes,sha256:actualHash,matchedPreparation:true,maxResponseChunkBytes:maxChunkBytes,encodedBufferCapBytes:MAX_ENCODED_BYTES}};
}

function setup(){
 const params=new URLSearchParams(location.search),diagnose=params.get('diff')==='1';
 const preparationUrl=params.get('all')==='1'||diagnose?ALL_PREPARATION_URL:PREPARATION_URL;
 const frameComposition:GlobalCompositeOperation=params.get('compose')==='source-over'?'source-over':'copy';
 const run=document.querySelector<HTMLButtonElement>('#run')!,stop=document.querySelector<HTMLButtonElement>('#stop')!,
  status=document.querySelector<HTMLElement>('#status')!,progress=document.querySelector<HTMLElement>('#progress')!,result=document.querySelector<HTMLElement>('#result')!;
 let active:AbortController|undefined,currentInput:Input|undefined;
 const cancel=()=>{active?.abort(new DOMException('복구 영상 참조 검증 중지','AbortError'));currentInput?.dispose();};
 stop.addEventListener('click',cancel);window.addEventListener('pagehide',cancel);
 run.addEventListener('click',async()=>{
  if(active)return;const controller=active=new AbortController(),signal=controller.signal,started=performance.now();
  const deadline=setTimeout(()=>{controller.abort(Error('복구 영상 참조 검증 120초 한도'));currentInput?.dispose();},120_000);
  run.disabled=true;stop.disabled=false;status.textContent='준비 자료와 영상 바이트를 확인하고 있습니다.';result.textContent='';progress.textContent='';
  const frame=document.createElement('canvas'),frameContext=frame.getContext('2d',{willReadFrequently:true})!;
  let rasterCanvas:OffscreenCanvas|undefined;
  const raster=createRecordingInputRaster((width,height)=>rasterCanvas=new OffscreenCanvas(width,height));
  const canvases=new Set<HTMLCanvasElement|OffscreenCanvas>();
  let iterator:ReturnType<CanvasSink['canvases']>|undefined,report:Record<string,unknown>={complete:false},finalStatus='복구 영상 참조 검증 미완료';
  let converted=0,rgbaReadbackMs=0,pixelHashMs=0,prepareMs=0;
  const abortInput=()=>currentInput?.dispose();signal.addEventListener('abort',abortInput,{once:true});
  try{
   const response=await fetch(preparationUrl,{signal,cache:'no-store'});if(!response.ok)throw Error('준비 보고서를 읽을 수 없습니다. 먼저 준비 스크립트를 실행하세요.');
   const text=await response.text();if(text.length>128*1024)throw Error('준비 보고서 용량 초과');
   const prepared=parsePreparedEncodedReference(JSON.parse(text));
   const rawResponse=await fetch(RAW_PROOF_URL,{signal,cache:'no-store'});if(!rawResponse.ok)throw Error('독립 원본 픽셀 검증 자료가 필요합니다.');
   const rawText=await rawResponse.text();if(rawText.length>2*1024*1024)throw Error('독립 원본 픽셀 검증 자료 용량 초과');
   const rawPixelProof=linkRawPixelProof(JSON.parse(rawText),prepared),encoded=await verifiedVideo(prepared,signal),search=createEncodedCandidateSearch(prepared.candidates);
   let diffRasters:ReturnType<typeof parseDiffRasters>=[];
   const differences:Record<string,unknown>[]=[],compared=new Set<number>();
   if(diagnose){const descriptor=await fetch(DIFF_DESCRIPTOR_URL,{signal,cache:'no-store'});if(!descriptor.ok)throw Error('픽셀 차이 비교 원본이 준비되지 않았습니다.');
    const text=await descriptor.text();if(text.length>128*1024)throw Error('차이 비교 원본 색인 크기 초과');diffRasters=parseDiffRasters(JSON.parse(text),prepared);}
   currentInput=new Input({formats:ALL_FORMATS,source:new BlobSource(encoded.blob)});
   const track=await timed(currentInput.getPrimaryVideoTrack(),10_000,'영상 트랙 확인 시간 초과');signal.throwIfAborted();
   if(!track||!await timed(track.canDecode(),10_000,'영상 디코더 준비 시간 초과'))throw Error('브라우저가 이 영상의 디코딩을 지원하지 않습니다.');
   const [duration,metadataDuration,firstTimestamp,codec,codecParameterString,width,height]=await timed(Promise.all([
    track.computeDuration(),track.getDurationFromMetadata(),track.getFirstTimestamp(),track.getCodec(),track.getCodecParameterString(),track.getDisplayWidth(),track.getDisplayHeight(),
   ]),10_000,'영상 메타데이터 확인 시간 초과');signal.throwIfAborted();
   prepareMs=performance.now()-started;
   const sink=new CanvasSink(track,{poolSize:2});iterator=sink.canvases();
   status.textContent='모든 디코드 프레임을 순서대로 검사하고 있습니다.';
   for await(const sample of iterator){
    signal.throwIfAborted();canvases.add(sample.canvas);if(canvases.size>2)throw Error('디코더 캔버스 풀 상한을 초과했습니다.');
    const sampleWidth=sample.canvas.width,sampleHeight=sample.canvas.height;
    if(!positive(sampleWidth)||!positive(sampleHeight)||sampleWidth*sampleHeight*4>MAX_FRAME_BYTES)throw Error('디코드 프레임 크기 초과');
    if(frame.width!==sampleWidth||frame.height!==sampleHeight){frame.width=sampleWidth;frame.height=sampleHeight;}
    const readStarted=performance.now();
    if(frameComposition==='copy')copyScannerInput(frameContext,sample.canvas);
    else {frameContext.globalCompositeOperation=frameComposition;frameContext.drawImage(sample.canvas,0,0);}
    let bitmap:ImageBitmap|undefined;let pixels:Uint8Array<ArrayBuffer>;
    try{bitmap=await createImageBitmap(frame);pixels=raster.read({width:sampleWidth,height:sampleHeight,bitmap});}
    finally{bitmap?.close();}
    rgbaReadbackMs+=performance.now()-readStarted;
    const hashStarted=performance.now(),pixelSha256=await digest(pixels!);pixelHashMs+=performance.now()-hashStarted;
    search.accept({ordinal:++converted,ptsSeconds:sample.timestamp,durationSeconds:sample.duration,width:sampleWidth,height:sampleHeight,pixelSha256});
    for(const target of diffRasters){
     if(target.captureTime!==sample.timestamp||compared.has(target.sourceFrameId))continue;
     const response=await fetch(target.url,{signal,cache:'no-store'});if(!response.ok||Number(response.headers.get('content-length'))!==target.bytes)throw Error('차이 비교 원본 용량 오류');
     const raw=new Uint8Array(await response.arrayBuffer());signal.throwIfAborted();
     if(raw.byteLength!==target.bytes||await digest(raw)!==target.pixelSha256)throw Error('차이 비교 원본 SHA 불일치');
     signal.throwIfAborted();compared.add(target.sourceFrameId);
     const difference=compareReferencePixels(raw,pixels,sampleWidth,sampleHeight);
     const residual=await createEncodedPixelResidual(pixels,raw);signal.throwIfAborted();
     let roundTrip:Record<string,unknown>={rawFallback:true};
     if(residual){
      if(residual.baseSha256!==pixelSha256||residual.resultSha256!==target.pixelSha256)throw Error('잔차 생성 해시 불일치');
      const restored=await restoreEncodedPixels(pixels,residual);signal.throwIfAborted();
      const restoredSha256=await digest(restored),exactBytes=compareReferencePixels(raw,restored,sampleWidth,sampleHeight).equal;
      if(restoredSha256!==target.pixelSha256||!exactBytes)throw Error('잔차 왕복 원본 픽셀 불일치');
      roundTrip={rawFallback:false,byteEdits:residual.edits.length,patchJsonBytes:new TextEncoder().encode(JSON.stringify(residual)).byteLength,
       exactBytes,returnedOwnedBuffer:restored===pixels,restoredSha256,residual};
     }
     differences.push({sourceFrameId:target.sourceFrameId,annotatedCaptureTime:target.captureTime,diagnosticSample:{ordinal:converted,pts:sample.timestamp,duration:sample.duration,pixelSha256},
      ...difference,residualRoundTrip:roundTrip});
    }
    if(converted%10===0){const found=search.snapshot().candidates.filter(candidate=>candidate.matched).length;progress.textContent=`${converted}프레임 · 후보 ${found}/${prepared.candidates.length}개 일치`;}await yieldForCapture(signal);
   }
   signal.throwIfAborted();const found=search.snapshot();if(!converted)throw Error('디코드된 프레임이 없습니다.');
   report={complete:true,matched:found.matched,preparationUrl,frameComposition,preparedSource:prepared,rawPixelProof,encodedBytes:encoded.proof,
    decoder:{library:'installed mediabunny from package-lock',path:'Input(ALL_FORMATS,BlobSource) -> primary video track -> CanvasSink({poolSize:2}).canvases()',
     lookupPolicy:'Sequential traversal of every decoded sample; no getCanvas/getSample/nearest-time lookup',trackId:track.id,trackNumber:track.number,
     codec,codecParameterString,displayWidth:width,displayHeight:height,firstPacketTimestampSeconds:firstTimestamp,
     computedTrackEndSeconds:duration,containerMetadataEndSeconds:metadataDuration,
     preparedMetadataDurationAnnotationSeconds:prepared.encodedReference.metadataDurationAnnotationSeconds,decodedToIteratorEnd:true,poolSize:2,
     observedPoolCanvases:canvases.size},
    rgbaPath:`CanvasSink canvas -> scanner-shaped canvas(${frameComposition} draw) -> ImageBitmap -> createRecordingInputRaster(copy draw/getImageData) -> SHA-256`,
    search:found,timing:{boundary:'Preparation and sequential decode+RGBA+hash+cooperative yields; not live scan throughput',prepareMs,
     sequentialMs:performance.now()-started-prepareMs,rgbaReadbackMs,pixelHashMs},
    resourceBoundary:{encodedBytesBuffered:encoded.blob.size,encodedBufferCapBytes:MAX_ENCODED_BYTES,decoderCanvasPool:2,
     extraConversionCanvases:2,atMostTransientBitmap:1,atMostHashRgbaBuffer:1,decodedFramesRetained:0,physicalPeakRamMeasured:false},
    evidenceBoundary:{originalArchiveRehashedInBrowser:false,rawPixelProofLinked:true,rawArchiveDecodedInBrowser:false,
     archiveIntegrity:'Linked streamed-preparation and independent raw-pixel reports with matching archive/candidate SHA and unchanged input',
     originalContinuousVideoCompleteness:'unknown',preservedVideoCopiedAndBrowserShaVerified:true,
     liveNativePixelEqualityProven:false,nearestTimestampMatchingUsed:false,captureTimeUsedToSelectSamples:false,
     matchingPixelsProve:'Only these preserved recovery frame pixels can be referenced by the discovered encoded decode positions'}};
   if(diagnose)report.pixelDifferences={scope:'Compare only exact annotated PTS for diagnosis; timestamp equality is not a source identity proof or reference promotion',
    rawRgbaBuffersRetainedAtOnce:1,residualAppliedInProduction:false,missingExactTimestamp:diffRasters.filter(target=>!compared.has(target.sourceFrameId)).map(target=>target.sourceFrameId),differences};
   finalStatus=found.matched?`${prepared.candidates.length}개 복구 원본의 전체 RGBA 해시가 순차 디코드에서 일치했습니다.`:'전체 순차 디코드를 마쳤지만 일치하지 않는 복구 원본이 있습니다.';
  }catch(error){report={...report,complete:false,error:String(error),partialDecodedFrames:converted};finalStatus=String(error);}
  finally{
   const cleanupErrors:string[]=[];signal.removeEventListener('abort',abortInput);
   try{currentInput?.dispose();}catch(error){cleanupErrors.push(String(error));}currentInput=undefined;
   if(iterator)try{await timed(iterator.return(undefined),5000,'영상 반복자 종료 시간 초과');}catch(error){cleanupErrors.push(String(error));}
   frame.width=frame.height=0;if(rasterCanvas)rasterCanvas.width=rasterCanvas.height=0;
   for(const canvas of canvases)canvas.width=canvas.height=0;canvases.clear();clearTimeout(deadline);
   report.cleanup={joined:cleanupErrors.length===0,errors:cleanupErrors};if(cleanupErrors.length){report.complete=report.matched=false;finalStatus=`자원 정리 오류: ${cleanupErrors.join(' · ')}`;}
   result.textContent=JSON.stringify(report,null,2);status.textContent=finalStatus;progress.textContent=`${converted}프레임 검사 종료`;
   active=undefined;run.disabled=false;stop.disabled=true;
  }
 });
}
if(typeof document!=='undefined')setup();
