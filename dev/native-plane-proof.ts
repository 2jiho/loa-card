import {comparePaintedRgbaPasses,MAX_NATIVE_PLANE_ENCODED_BYTES,NATIVE_PLANE_PREPARATION_URL,NATIVE_PLANE_VIDEO_URL,parseNativePlaneSource} from './native-plane-proof-worker';
import type {NativePlaneSource,PaintedRgbaRecord} from './native-plane-proof-worker';
import {decodedRgbaFrames} from '../src/features/card-scanner/decoded-rgba-client';
import type {DecodedRgbaPreference} from '../src/features/card-scanner/decoded-rgba-client';
import {MAX_FRAME_BYTES} from '../src/features/card-scanner/exact-recording-codec';
import {waitForInput} from '../src/features/card-scanner/input-source';

type Job={id:number;mode:'native'|'postpaint';controller:AbortController;worker?:Worker;halt?:string;deadline?:ReturnType<typeof setTimeout>;grace?:ReturnType<typeof setTimeout>;lastProgress?:unknown};
const run=document.querySelector<HTMLButtonElement>('#run')!,stop=document.querySelector<HTMLButtonElement>('#stop')!,
 status=document.querySelector<HTMLElement>('#status')!,progress=document.querySelector<HTMLElement>('#progress')!,result=document.querySelector<HTMLElement>('#result')!;
const software=document.querySelector<HTMLInputElement>('#software')!;
const clientRun=document.querySelector<HTMLButtonElement>('#client-run')!,clientResult=document.querySelector<HTMLElement>('#client-result')!;
let active:Job|undefined,nextId=0;
function finish(job:Job,report:Record<string,unknown>,forced=false){
 if(active!==job)return;
 clearTimeout(job.deadline);clearTimeout(job.grace);
 const hadWorker=!!job.worker;job.worker?.terminate();job.worker=undefined;active=undefined;
 if(job.halt)report={...report,complete:false,error:job.halt};
 if(job.mode==='native')report.workerTermination={terminated:hadWorker,forced,scope:hadWorker?'The owned decoder Worker was terminated; it cannot publish future frames/results. Physical resource release latency is not measured.':'No decoder Worker was started.'};
 (job.mode==='native'?result:clientResult).textContent=JSON.stringify(report,null,2);
 if(job.mode==='postpaint'){
  const comparison=report.comparison as {matchedAll?:boolean}|undefined;
  status.textContent=report.complete===true?comparison?.matchedAll?'표준 RGBA 입력의 작업자·캔버스 픽셀이 두 검사에서 모두 일치했습니다.':'표준 RGBA 입력 경로에서 픽셀 또는 메타데이터 차이가 있습니다.':String(report.error??'표준 RGBA 입력 검사가 완료되지 않았습니다.');
  run.disabled=clientRun.disabled=false;stop.disabled=true;software.disabled=false;return;
 }
 const comparison=report.comparison as {nativeYuvDeterministic?:boolean;allNativeI420OrNv12?:boolean;explicitRgb?:{allSupported?:boolean;matchedAll?:boolean|null}}|undefined;
 status.textContent=report.complete===true?comparison?.nativeYuvDeterministic?'두 검사에서 네이티브 YUV 바이트·레이아웃·메타데이터가 일치했습니다.':
  comparison?.allNativeI420OrNv12===false?'반복 검사는 끝났지만 I420/NV12 경로를 모두 사용하지 않았습니다.':'반복 검사에서 네이티브 평면 차이가 있습니다.':String(report.error??'검사가 완료되지 않았습니다.');
 if(report.complete===true&&comparison?.explicitRgb)status.textContent+=' · '+(!comparison.explicitRgb.allSupported?'표준 RGBA 복사 미지원':comparison.explicitRgb.matchedAll?'표준 RGBA 반복도 일치':'표준 RGBA 반복은 불일치');
 run.disabled=clientRun.disabled=false;stop.disabled=true;software.disabled=false;
}
function halt(reason:string){
 const job=active;if(!job||job.halt)return;job.halt=reason;job.controller.abort(new DOMException(reason,'AbortError'));stop.disabled=true;
 status.textContent='중지 요청 중 · 현재 작업을 정리하고 있습니다.';
 if(job.mode==='postpaint')return; // The client joins its owned worker in its generator cleanup.
 if(job.worker){
  try{job.worker.postMessage({kind:'cancel',id:job.id});}catch{/* Termination still owns the boundary. */}
  job.grace=setTimeout(()=>finish(job,{complete:false,error:reason,lastProgress:job.lastProgress,
   cleanup:{publicApiReturned:false,scope:'Cooperative cleanup did not finish within2seconds; owned Worker termination is the end boundary.'}},true),2000);
 }else finish(job,{complete:false,error:reason});
}
stop.addEventListener('click',()=>halt('네이티브 평면 검사 중지'));
window.addEventListener('pagehide',()=>{const job=active;if(job){job.controller.abort();clearTimeout(job.deadline);clearTimeout(job.grace);job.worker?.terminate();active=undefined;}});

async function video(source:NativePlaneSource,signal:AbortSignal){
 const response=await fetch(NATIVE_PLANE_VIDEO_URL,{signal,cache:'no-store'});if(!response.ok||!response.body)throw Error('준비 영상을 읽을 수 없습니다.');
 const length=response.headers.get('content-length');if(length!==null&&Number(length)!==source.bytes)throw Error('준비 영상 HTTP 용량 불일치');
 const reader=response.body.getReader(),chunks:Uint8Array<ArrayBuffer>[]=[];let bytes=0,maxChunkBytes=0;
 try{
  while(true){signal.throwIfAborted();const next=await reader.read();if(next.done)break;
   bytes+=next.value.byteLength;if(bytes>source.bytes||bytes>MAX_NATIVE_PLANE_ENCODED_BYTES)throw Error('네이티브 평면 준비 영상 용량 한도 초과');
   maxChunkBytes=Math.max(maxChunkBytes,next.value.byteLength);chunks.push(next.value);
  }
 }finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
 if(bytes!==source.bytes)throw Error('네이티브 평면 준비 영상 일부만 도착했습니다.');
 const blob=new Blob(chunks,{type:source.type});chunks.length=0;
 return {blob,maxResponseChunkBytes:maxChunkBytes};
}
run.addEventListener('click',async()=>{
 if(active)return;
 const job:Job={id:++nextId,mode:'native',controller:new AbortController()};active=job;const signal=job.controller.signal;
 const decoderPreference=software.checked?'prefer-software':'no-preference';
 run.disabled=clientRun.disabled=true;stop.disabled=false;software.disabled=true;result.textContent='';progress.textContent='';status.textContent='개인 준비 자료와 영상 바이트를 읽고 있습니다.';
 job.deadline=setTimeout(()=>halt('네이티브 평면 검사 120초 한도 초과'),120_000);
 try{
  const response=await fetch(NATIVE_PLANE_PREPARATION_URL,{signal,cache:'no-store'});if(!response.ok)throw Error('개인 준비 자료가 없습니다.');
  const text=await response.text();if(text.length>128*1024)throw Error('네이티브 평면 준비 자료 용량 초과');
  const source=parseNativePlaneSource(JSON.parse(text)),encoded=await video(source,signal);signal.throwIfAborted();
  if(active!==job)return;
  const worker=job.worker=new Worker(new URL('./native-plane-proof-worker.ts',import.meta.url),{type:'module'});
  worker.onmessage=event=>{
   if(active!==job||event.data?.id!==job.id)return;
   if(event.data.kind==='progress'){
    job.lastProgress=event.data;progress.textContent=String(event.data.status??'');
   }else if(event.data.kind==='done')finish(job,{...event.data.report,encodedFetch:{url:NATIVE_PLANE_VIDEO_URL,bytes:source.bytes,maxResponseChunkBytes:encoded.maxResponseChunkBytes}});
  };
  worker.onerror=event=>finish(job,{complete:false,error:`네이티브 평면 작업자 오류: ${event.message}`},true);
  worker.postMessage({kind:'run',id:job.id,blob:encoded.blob,source,decoderPreference});
  status.textContent='작업자에서 영상 SHA와 네이티브 평면을 검사하고 있습니다.';
 }catch(error){finish(job,{complete:false,error:String(error)});}
});

const digest=(bytes:ArrayBuffer|Uint8ClampedArray<ArrayBuffer>)=>crypto.subtle.digest('SHA-256',bytes)
 .then(hash=>Array.from(new Uint8Array(hash),value=>value.toString(16).padStart(2,'0')).join(''));
async function paintedPass(blob:Blob,signal:AbortSignal,preference:DecodedRgbaPreference,pass:number,job:Job){
 const records:PaintedRgbaRecord[]=[];let metadataBytes=0,maxRgbaBytes=0;
 const started=performance.now();
 for await(const frame of decodedRgbaFrames(blob,signal,{decoderPreference:preference})){
  signal.throwIfAborted();const {width,height}=frame.element,bytes=width*height*4;
  if(!Number.isSafeInteger(bytes)||bytes<4||bytes>MAX_FRAME_BYTES||records.length>=10_000)throw Error('표준 RGBA 입력 검사 크기·수량 한도 초과');
  const context=frame.element.getContext('2d',{willReadFrequently:true,colorSpace:'srgb'}) as CanvasRenderingContext2D|OffscreenCanvasRenderingContext2D|null;
  if(!context)throw Error('표준 RGBA 입력 검사 컨텍스트 없음');
  const data=context.getImageData(0,0,width,height).data,paintSha256=await digest(data);signal.throwIfAborted();
  let nonOpaquePixels=0;for(let offset=3;offset<data.length;offset+=4)if(data[offset]!==255)nonOpaquePixels++;
  const row:PaintedRgbaRecord={ordinal:frame.decoded.ordinal,time:frame.time,duration:frame.decoded.duration,width,height,
   workerSha256:frame.decoded.rgbaSha256,paintSha256,nonOpaquePixels,metadata:frame.decoded};
  metadataBytes+=new TextEncoder().encode(JSON.stringify(row)).byteLength;if(metadataBytes>8*1024*1024)throw Error('표준 RGBA 입력 검사 메타데이터 한도 초과');
  records.push(row);maxRgbaBytes=Math.max(maxRgbaBytes,bytes);
  if(active===job&&records.length%10===0)progress.textContent=`표준 RGBA 입력 ${pass}/2회차 · ${records.length}프레임 검사 중`;
  if(pass===2&&records.length%5===0)await waitForInput(signal,1+records.length%3);
 }
 signal.throwIfAborted();if(!records.length)throw Error('표준 RGBA 입력 프레임 없음');
 return {pass,records,metadataBytes,maxRgbaBytes,elapsedMs:performance.now()-started,
  cleanup:{generatorReturned:true,scope:'decodedRgbaFrames completed its own worker disposal/termination and released its borrowed canvas.'}};
}
clientRun.addEventListener('click',async()=>{
 if(active)return;const job:Job={id:++nextId,mode:'postpaint',controller:new AbortController()};active=job;
 const signal=job.controller.signal,preference:DecodedRgbaPreference=software.checked?'prefer-software':'no-preference';
 run.disabled=clientRun.disabled=true;stop.disabled=false;software.disabled=true;clientResult.textContent='';progress.textContent='';
 status.textContent='표준 RGBA 입력 경로와 캔버스 픽셀을 검사하고 있습니다.';
 job.deadline=setTimeout(()=>halt('표준 RGBA 입력 경로 검사 120초 한도 초과'),120_000);
 const passes:Awaited<ReturnType<typeof paintedPass>>[]=[];const started=performance.now();
 try{
  const response=await fetch(NATIVE_PLANE_PREPARATION_URL,{signal,cache:'no-store'});if(!response.ok)throw Error('개인 준비 자료가 없습니다.');
  const text=await response.text();if(text.length>128*1024)throw Error('표준 RGBA 준비 자료 용량 초과');
  const source=parseNativePlaneSource(JSON.parse(text)),encoded=await video(source,signal),encodedSha256=await digest(await encoded.blob.arrayBuffer());signal.throwIfAborted();
  if(encodedSha256!==source.sha256)throw Error('표준 RGBA 입력 원본 영상 SHA 불일치');
  for(let pass=1;pass<=2;pass++)passes.push(await paintedPass(encoded.blob,signal,preference,pass,job));
  finish(job,{complete:true,kind:'decoded-rgba-client-postpaint-proof',source:{...source,verifiedEncodedSha256:encodedSha256},decoderPreference:preference,
   passes,comparison:comparePaintedRgbaPasses(passes[0].records,passes[1].records),elapsedMs:performance.now()-started,
   evidenceBoundary:{scope:'Actual experimental client worker copyTo+SHA -> transferred RGBA -> reused canvas putImageData -> full getImageData SHA, twice in decoder order',
    includesOcr:false,includesCanonicalRecording:false,reproductionFormatChanged:false,sourceCompleteness:'unknown',
    workerHashIsPrePaintReceipt:true,paintedHashMeasured:true,decoderPreferenceIsOnlyHint:true,
    stopScope:'Abort stops client requests and joins its worker cleanup; a current main-page getImageData/SHA operation settles before the probe returns.',
    memory:'No image sequence is retained. Client transfer buffer and this single readback coexist per sample; library prefetch/GPU queues and physical peak memory are not measured.'}});
 }catch(error){finish(job,{complete:false,kind:'decoded-rgba-client-postpaint-proof',error:String(error),passes,elapsedMs:performance.now()-started,
  cleanup:{scope:'The for-await iterator closes the experimental client on failure/abort before this result is published.'}});}
});
