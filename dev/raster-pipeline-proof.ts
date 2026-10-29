import {createRecordingRasterPipeline} from '../src/features/card-scanner/recording-raster-pipeline';
import {copyScannerInput} from '../src/features/card-scanner/scanner-input-frame';

type CorpusCase={id:string;name:string;kind:string;inputs:{url:string}[]};
type NativeSource=ImageBitmap|VideoFrame;
type Pipeline=Awaited<ReturnType<typeof createRecordingRasterPipeline>>;
type Job=ReturnType<Pipeline['submit']>;
type Bytes=Uint8Array<ArrayBuffer>|Uint8ClampedArray<ArrayBuffer>;
const select=document.querySelector<HTMLSelectElement>('#corpus')!,button=document.querySelector<HTMLButtonElement>('#run')!,
  stop=document.querySelector<HTMLButtonElement>('#stop')!,status=document.querySelector<HTMLElement>('#status')!,
  result=document.querySelector<HTMLElement>('#result')!,video=document.querySelector<HTMLVideoElement>('video')!,
  timeInput=document.querySelector<HTMLInputElement>('#time')!;
const cases=new Map<string,CorpusCase>(),pipelines:Pipeline[]=[];
let active:AbortController|undefined;
function cancel(){
  const reason=new DOMException('픽셀 변환 검증 중지','AbortError');active?.abort(reason);
  for(const pipeline of pipelines)void pipeline.dispose(reason).catch(()=>{});
}
window.addEventListener('pagehide',cancel);stop.addEventListener('click',cancel);
const median=(values:number[])=>[...values].sort((a,b)=>a-b)[Math.floor(values.length/2)];
async function hash(pixels:Bytes){return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',pixels)),value=>value.toString(16).padStart(2,'0')).join('');}
function dimensions(source:NativeSource){return 'displayWidth' in source?{width:source.displayWidth,height:source.displayHeight}:{width:source.width,height:source.height};}
async function baseline(source:NativeSource){
  const {width,height}=dimensions(source),canvas=new OffscreenCanvas(width,height),context=canvas.getContext('2d',{willReadFrequently:true})!;
  try{
    const started=performance.now();copyScannerInput(context,source);
    const pixels=context.getImageData(0,0,width,height).data,readbackMs=performance.now()-started;
    return {width,height,bytes:pixels.byteLength,hash:await hash(pixels),readbackMs};
  }finally{canvas.width=canvas.height=0;source.close();}
}
async function clone(source:NativeSource):Promise<NativeSource>{return source instanceof ImageBitmap?createImageBitmap(source):source.clone();}
function stats(pipeline:Pipeline){return JSON.parse(JSON.stringify(pipeline.stats)) as unknown;}
function assertTiming(value:number){if(!Number.isFinite(value)||value<0)throw Error('픽셀 변환 시간 통계 오류');return value;}
async function abortable<T>(value:Promise<T>,signal:AbortSignal):Promise<T>{
  signal.throwIfAborted();let aborted!:()=>void;
  const canceled=new Promise<never>((_,reject)=>{aborted=()=>reject(signal.reason);signal.addEventListener('abort',aborted,{once:true});});
  try{return await Promise.race([value,canceled]);}finally{signal.removeEventListener('abort',aborted);}
}
async function yieldConsumer(signal:AbortSignal){
  signal.throwIfAborted();await new Promise<void>((resolve,reject)=>{
    const channel=new MessageChannel(),clean=()=>{channel.port1.close();channel.port2.close();signal.removeEventListener('abort',abort);};
    const abort=()=>{clean();reject(signal.reason);};channel.port1.onmessage=()=>{clean();resolve();};
    signal.addEventListener('abort',abort,{once:true});channel.port2.postMessage(null);if(signal.aborted)abort();
  });
}
async function check(name:string,kind:string,source:NativeSource,signal:AbortSignal){
  try{
    signal.throwIfAborted();const expected=await baseline(await clone(source)),paths=[];
    for(const [path,pipeline]of pipelines.entries()){
      const trials=[];
      for(let repetition=0;repetition<3;repetition++){
        signal.throwIfAborted();const native=[await clone(source)];
        try{native.push(await clone(source));}catch(error){native[0].close();throw error;}
        const jobs:Job[]=[],started=performance.now(),dispatchedBefore=pipeline.stats.dispatched;
        try{
          // submit() takes ownership, including invalid-input/error paths. The
          // helper never closes or reuses a payload after giving it away.
          for(const bitmap of native)jobs.push(pipeline.submit({...dimensions(bitmap),bitmap}));
          const deferredAt=performance.now();await yieldConsumer(signal);
          const consumerDeferredMs=performance.now()-deferredAt,beforeAnyRead=stats(pipeline),observed=[],
            dispatchedBeforeAnyRead=pipeline.stats.dispatched-dispatchedBefore;
          if(dispatchedBeforeAnyRead!==(pipeline.engine==='nested-worker'?2:0))throw Error('소비자 대기 전 픽셀 전송 수 불일치');
          for(const job of jobs){
            const raw=await abortable(job.read(),signal);signal.throwIfAborted();
            if(!(raw.pixels instanceof Uint8Array)||raw.pixels.byteLength!==expected.bytes)throw Error('픽셀 변환 크기 불일치');
            const actualHash=await hash(raw.pixels);
            observed.push({bytes:raw.pixels.byteLength,hash:actualHash,matched:actualHash===expected.hash,
              readbackMs:assertTiming(raw.readbackMs),queueMs:assertTiming(raw.queueMs),roundTripMs:assertTiming(raw.roundTripMs)});
          }
          trials.push({repetition:repetition+1,submittedBeforeAnyRead:jobs.length,dispatchedBeforeAnyRead,consumerDeferredMs,beforeAnyRead,
            submitToVerifiedMs:performance.now()-started,jobs:observed});
        }finally{await Promise.allSettled(jobs.map(job=>job.release()));}
      }
      if(pipeline.stats.pending!==0||pipeline.stats.pendingBytes!==0)throw Error('소비한 픽셀 작업의 예약 메모리가 남았습니다.');
      paths.push({path:path===0?'forced-inline':'default',engine:pipeline.engine,matched:trials.every(trial=>trial.jobs.every(job=>job.matched)),trials,
        timing:{scope:'median of three two-input trials; per-input readback/queue/roundtrip averages, SHA verification excluded from those three fields; submitToVerified includes deliberate consumer yield and SHA',
          readbackMs:median(trials.map(trial=>trial.jobs.reduce((sum,job)=>sum+job.readbackMs,0)/trial.jobs.length)),
          queueMs:median(trials.map(trial=>trial.jobs.reduce((sum,job)=>sum+job.queueMs,0)/trial.jobs.length)),
          roundTripMs:median(trials.map(trial=>trial.jobs.reduce((sum,job)=>sum+job.roundTripMs,0)/trial.jobs.length)),
          submitToVerifiedMs:median(trials.map(trial=>trial.submitToVerifiedMs))},afterRelease:stats(pipeline)});
    }
    return {name,kind,sourceFormat:'format' in source?source.format:'ImageBitmap',expected,matched:paths.every(path=>path.matched),paths};
  }finally{source.close();}
}
function synthetic(transparent:boolean){
  const canvas=document.createElement('canvas');canvas.width=4;canvas.height=2;
  canvas.getContext('2d')!.putImageData(new ImageData(Uint8ClampedArray.from(transparent?[
    0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,
    0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,
  ]:[
    255,0,0,255,0,255,0,128,0,0,255,1,145,73,201,0,
    25,50,75,255,253,127,61,200,23,241,178,100,255,255,255,255,
  ]),4,2),0,0);return canvas;
}
async function waitMedia(event:string,signal:AbortSignal){await new Promise<void>((resolve,reject)=>{
  const clean=()=>{clearTimeout(timer);video.removeEventListener(event,done);video.removeEventListener('error',fail);signal.removeEventListener('abort',abort);};
  const done=()=>{clean();resolve();},fail=()=>{clean();reject(Error('영상 디코딩 실패'));},abort=()=>{clean();reject(signal.reason);};
  const timer=setTimeout(()=>{clean();reject(Error('영상 디코딩 시간 초과'));},10_000);
  video.addEventListener(event,done,{once:true});video.addEventListener('error',fail,{once:true});signal.addEventListener('abort',abort,{once:true});
  if(signal.aborted)abort();
});}
async function loadVideo(url:string,time:number,signal:AbortSignal){
  video.pause();video.muted=true;video.src=url;video.preload='auto';const loaded=waitMedia('loadedmetadata',signal);video.load();await loaded;
  if(video.readyState<2)await waitMedia('loadeddata',signal);
  const target=Math.min(time,Math.max(0,video.duration-.01));
  if(Math.abs(video.currentTime-target)>.001){const seeked=waitMedia('seeked',signal);video.currentTime=target;await seeked;}
  if(video.readyState<2)await waitMedia('loadeddata',signal);
  if('requestVideoFrameCallback' in video){await new Promise<void>((resolve,reject)=>{
    let handle=0;
    const clean=()=>{clearTimeout(timer);video.cancelVideoFrameCallback(handle);signal.removeEventListener('abort',abort);video.pause();};
    const abort=()=>{clean();reject(signal.reason);};const timer=setTimeout(()=>{clean();reject(Error('영상 표시 프레임 준비 시간 초과'));},5000);
    signal.addEventListener('abort',abort,{once:true});handle=video.requestVideoFrameCallback(()=>{clean();resolve();});
    void video.play().catch(error=>{clean();reject(error);});if(signal.aborted)abort();
  });}
  if(video.readyState<2||!video.videoWidth||!video.videoHeight)throw Error('표시할 영상 프레임이 없습니다.');
}
async function videoBitmap(){
  try{return await createImageBitmap(video);}
  catch(error){if(typeof VideoFrame==='undefined')throw error;const frame=new VideoFrame(video);try{return await createImageBitmap(frame);}finally{frame.close();}}
}
button.addEventListener('click',async()=>{
  if(active)return;active=new AbortController();const signal=active.signal,results:Awaited<ReturnType<typeof check>>[]=[];
  let finalReport:Record<string,unknown>={complete:false,results},finalStatus='픽셀 변환 검증 미완료';
  button.disabled=select.disabled=timeInput.disabled=true;stop.disabled=false;status.textContent='픽셀 변환·원본 소유권·전체 RGBA를 검사하고 있습니다.';result.textContent='';
  const append=async(name:string,kind:string,source:NativeSource)=>{
    results.push(await check(name,kind,source,signal));result.textContent=JSON.stringify({complete:false,results},null,2);
  };
  try{
    pipelines.push(await createRecordingRasterPipeline({createWorker:()=>undefined}));signal.throwIfAborted();
    pipelines.push(await createRecordingRasterPipeline());signal.throwIfAborted();
    for(const kind of ['ImageBitmap','VideoFrame']){
      if(kind==='VideoFrame'&&typeof VideoFrame==='undefined')continue;
      for(const transparent of [false,true]){
        const canvas=synthetic(transparent);
        try{await append(transparent?'합성 RGBA · 앞 프레임 뒤의 완전 투명 입력':'합성 RGBA · 투명도 포함',kind,
          kind==='ImageBitmap'?await createImageBitmap(canvas):new VideoFrame(canvas,{timestamp:transparent?1:0}));}
        finally{canvas.width=canvas.height=0;}
      }
    }
    const input=cases.get(select.value);
    if(input){
      const time=Number(timeInput.value);if(!Number.isFinite(time)||time<0)throw Error('영상 시각을 확인하세요.');
      const response=await fetch(`/__corpus/cases/${input.id}`,{signal});if(!response.ok)throw Error('영상 입력을 불러오지 못했습니다.');
      const detail:CorpusCase=await response.json();await loadVideo(detail.inputs[0].url,time,signal);const actualTime=video.currentTime;
      await append(`${input.name} · ${actualTime.toFixed(3)}초`,'ImageBitmap',await videoBitmap());
      if(typeof VideoFrame!=='undefined')await append(`${input.name} · ${actualTime.toFixed(3)}초`,'VideoFrame',new VideoFrame(video));
    }
    await Promise.all(pipelines.map(pipeline=>pipeline.drain()));signal.throwIfAborted();
    const engines=pipelines.map(pipeline=>pipeline.engine),workerPathAvailable=engines[1]==='nested-worker',matched=workerPathAvailable&&results.every(value=>value.matched);
    finalReport={complete:true,matched,workerPathAvailable,engines,videoFrameSupported:typeof VideoFrame!=='undefined',
      topology:'dev-page -> raster-worker; production exact-worker -> raster-worker is checked by canonical-store-proof separately',
      scope:'Native raster conversion and dispatch-before-read facts, not production nesting, full scanner throughput or physical RAM measurement',results};
    finalStatus=matched?'직접 변환·기본 작업자·대체 경로의 전체 픽셀 일치':workerPathAvailable?'픽셀 변환 검증 불일치':'기본 작업자가 대체 경로로 실행돼 분리 작업자 검증은 미확인입니다.';
  }catch(error){finalStatus=String(error);finalReport={complete:false,error:String(error),results};}
  finally{
    video.pause();const closing=pipelines.splice(0),settled=await Promise.allSettled(closing.map(pipeline=>pipeline.dispose()));
    const cleanupErrors=settled.flatMap(value=>value.status==='rejected'?[String(value.reason)]:[]);
    finalReport.cleanup={joined:true,pipelines:closing.length,errors:cleanupErrors};
    if(cleanupErrors.length){finalReport.complete=finalReport.matched=false;finalStatus=`픽셀 변환 작업 정리 실패: ${cleanupErrors.join(' · ')}`;}
    result.textContent=JSON.stringify(finalReport,null,2);status.textContent=finalStatus;
    active=undefined;button.disabled=select.disabled=timeInput.disabled=false;stop.disabled=true;
  }
});
void fetch('/__corpus').then(async response=>{
  if(!response.ok)throw Error('등록한 입력을 불러오지 못했습니다.');const body=await response.json();
  for(const input of (Array.isArray(body)?body:body.cases??[]) as CorpusCase[]){if(input.kind!=='video')continue;cases.set(input.id,input);select.add(new Option(input.name,input.id));}
}).catch(error=>{status.textContent=`합성 입력만 검사할 수 있습니다. ${String(error)}`;});
