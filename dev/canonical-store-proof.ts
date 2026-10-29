import {createExactRecording} from '../src/features/card-scanner/exact-recording';
import {createCanonicalCapture} from '../src/features/card-scanner/canonical-capture';
import {exactReplayFrames} from '../src/features/card-scanner/exact-recording-codec';
import {createReproductionBundle,openReproduction} from '../src/features/card-scanner/scan-reproduction';
import type {ScannerInputProvenance} from '../src/features/card-scanner/scanner-input-frame';

type CorpusCase={id:string;name:string;kind:string;inputs:{url:string}[]};
type NativeSource=ImageBitmap|VideoFrame;
const select=document.querySelector<HTMLSelectElement>('#corpus')!,button=document.querySelector<HTMLButtonElement>('#run')!,
  status=document.querySelector<HTMLElement>('#status')!,result=document.querySelector<HTMLElement>('#result')!,
  video=document.querySelector<HTMLVideoElement>('video')!,timeInput=document.querySelector<HTMLInputElement>('#time')!;
const cases=new Map<string,CorpusCase>();
let active:AbortController|undefined;
window.addEventListener('pagehide',()=>active?.abort(new DOMException('검증 페이지 종료','AbortError')));
async function pixelProof(source:CanvasImageSource){
  const width='displayWidth' in source?source.displayWidth:'videoWidth' in source?source.videoWidth:source.width;
  const height='displayHeight' in source?source.displayHeight:'videoHeight' in source?source.videoHeight:source.height;
  if(typeof width!=='number'||typeof height!=='number')throw Error('검증 이미지 크기 오류');
  const canvas=new OffscreenCanvas(width,height),context=canvas.getContext('2d',{willReadFrequently:true})!;
  context.globalCompositeOperation='copy';context.drawImage(source,0,0);
  const pixels=context.getImageData(0,0,width,height).data;
  const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',pixels)),value=>value.toString(16).padStart(2,'0')).join('');
  canvas.width=canvas.height=0;return {hash,width,height};
}
function synthetic(){
  const canvas=document.createElement('canvas');canvas.width=4;canvas.height=2;
  canvas.getContext('2d')!.putImageData(new ImageData(Uint8ClampedArray.from([
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
  video.pause();video.muted=true;video.src=url;video.preload='auto';
  const loaded=waitMedia('loadedmetadata',signal);video.load();await loaded;
  if(video.readyState<2)await waitMedia('loadeddata',signal);
  const target=Math.min(time,Math.max(0,video.duration-.01));
  if(Math.abs(video.currentTime-target)>.001){const seeked=waitMedia('seeked',signal);video.currentTime=target;await seeked;}
  if(video.readyState<2)await waitMedia('loadeddata',signal);
  if('requestVideoFrameCallback' in video){await new Promise<void>((resolve,reject)=>{
    let handle=0;
    const clean=()=>{clearTimeout(timer);video.cancelVideoFrameCallback(handle);signal.removeEventListener('abort',abort);video.pause();};
    const abort=()=>{clean();reject(signal.reason);};
    const timer=setTimeout(()=>{clean();reject(Error('영상 표시 프레임 준비 시간 초과'));},5000);
    signal.addEventListener('abort',abort,{once:true});
    handle=video.requestVideoFrameCallback(()=>{clean();resolve();});
    void video.play().catch(error=>{clean();reject(error);});if(signal.aborted)abort();
  });}
  if(video.readyState<2||!video.videoWidth||!video.videoHeight)throw Error('표시할 영상 프레임이 없습니다.');
}
async function videoBitmap(){
  try{return await createImageBitmap(video);}
  catch(error){if(typeof VideoFrame==='undefined')throw error;const frame=new VideoFrame(video);try{return await createImageBitmap(frame);}finally{frame.close();}}
}
async function check(name:string,kind:string,source:NativeSource,captureTime:number,signal:AbortSignal){
  const expected=await pixelProof(source),recorder=await createExactRecording(),warnings:string[]=[];
  let capture:ReturnType<typeof createCanonicalCapture>|undefined,sourceEnded=false;
  // The adapter carries only dimensions. The producer receives this immutable
  // native payload, so the bitmap path tests actual bitmap transfer, not a
  // canvas redraw that could hide an alpha-conversion difference.
  const dimensions=document.createElement('canvas');dimensions.width=expected.width;dimensions.height=expected.height;
  let bitmapTaken=false;
  try{
    signal.throwIfAborted();if(!recorder.supportsSourceReads)throw Error('이 브라우저는 열린 공통 저장소 읽기를 지원하지 않습니다.');
    capture=createCanonicalCapture(recorder,message=>warnings.push(message),{
      bitmapFactory:async()=>{if(bitmapTaken)throw Error('같은 원본을 두 번 기록했습니다.');bitmapTaken=true;return source instanceof ImageBitmap?source:await createImageBitmap(source);},
      onUse:value=>recorder.event('canonical-source-use',value,value.captureTime*1000),
    });
    const id=capture.submit(dimensions,captureTime,0,'backup');if(id!==1)throw Error('원본 ID가 1부터 시작하지 않습니다.');
    const reused=capture.input(dimensions,captureTime,0,'input',id,true);if(reused!==id)throw Error('입력 원본 재사용 실패');
    capture.use(reused,17,'input',captureTime);
    const openReads:unknown[]=[];
    for await(const frame of capture.frames(signal)){
      const proof=await pixelProof(frame.element);
      openReads.push({canonicalFrameId:frame.canonicalFrameId,time:frame.time,...proof,matched:proof.hash===expected.hash});
      if(frame.canonicalFrameId!==id||proof.hash!==expected.hash)throw Error('열린 저장소 원본 픽셀 불일치');
      capture.use(frame.canonicalFrameId,18,'recovery',frame.time);
    }
    await capture.discard();sourceEnded=true;signal.throwIfAborted();
    const stored=await recorder.finish(),stats=stored.stats;
    if(stats.frames!==1||stats.events!==2||!stats.complete||!stats.canonical)throw Error(`공통 원본 기록 총량 불일치: ${JSON.stringify(stats)}`);
    const bundle=createReproductionBundle({metadata:{version:4,createdAt:new Date().toISOString(),browser:navigator.userAgent,
      catalog:'native-canonical-proof',build:'development',completed:true,warnings:[],exact:stats,duration:0,type:'',bytes:0,seed:[],result:null,recordState:'complete'},video:new Blob(),exact:stored.blob});
    const reopened=await openReproduction(bundle,signal),uses:{time:number;hash:string;provenance:ScannerInputProvenance|undefined}[]=[];
    let verified=0;
    for await(const frame of exactReplayFrames(reopened.exact!,signal,count=>{verified=count;},stats.frames)){
      const proof=await pixelProof(frame.element);uses.push({time:frame.time,hash:proof.hash,provenance:frame.provenance});
    }
    const v4roundtrip=reopened.metadata.version===4&&verified===1&&uses.length===2&&uses.every(use=>use.hash===expected.hash&&use.time===captureTime&&use.provenance?.sourceFrameId===1)&&
      uses[0].provenance?.frameId===17&&uses[0].provenance?.phase==='input'&&uses[1].provenance?.frameId===18&&uses[1].provenance?.phase==='recovery';
    const sourceStats=capture.stats;
    const matched=v4roundtrip&&openReads.length===1&&sourceStats.frames===1&&sourceStats.reusedInputs===1&&sourceStats.processingUses===2&&!warnings.length;
    return {name,kind,matched,expected,openReads,stats,sourceStats,warnings,v4roundtrip:{matched:v4roundtrip,version:reopened.metadata.version,verifiedPhysicalFrames:verified,bundleBytes:bundle.size,uses}};
  }finally{
    if(!sourceEnded)capture?.cancel();
    try{await capture?.discard();}finally{await recorder.dispose();source.close();dimensions.width=dimensions.height=0;}
  }
}
button.addEventListener('click',async()=>{
  if(active)return;active=new AbortController();const signal=active.signal,results:unknown[]=[];
  button.disabled=select.disabled=timeInput.disabled=true;status.textContent='공통 원본 저장과 재현을 검사하고 있습니다.';result.textContent='';
  const append=async(name:string,kind:string,source:NativeSource,time:number)=>{
    try{results.push(await check(name,kind,source,time,signal));result.textContent=JSON.stringify({complete:false,results},null,2);}
    finally{source.close();}
  };
  try{
    const canvas=synthetic();
    try{await append('합성 RGBA · 투명도 포함','ImageBitmap',await createImageBitmap(canvas),0);
      if(typeof VideoFrame!=='undefined')await append('합성 RGBA · 투명도 포함','VideoFrame',new VideoFrame(canvas,{timestamp:0}),0);
    }finally{canvas.width=canvas.height=0;}
    const input=cases.get(select.value);
    if(input){const time=Number(timeInput.value);if(!Number.isFinite(time)||time<0)throw Error('영상 시각을 확인하세요.');
      const response=await fetch(`/__corpus/cases/${input.id}`,{signal});if(!response.ok)throw Error('영상 입력을 불러오지 못했습니다.');const detail:CorpusCase=await response.json();
      await loadVideo(detail.inputs[0].url,time,signal);const actualTime=video.currentTime;
      await append(`${input.name} · ${actualTime.toFixed(3)}초`,'ImageBitmap',await videoBitmap(),actualTime);
      if(typeof VideoFrame!=='undefined')await append(`${input.name} · ${actualTime.toFixed(3)}초`,'VideoFrame',new VideoFrame(video),actualTime);
    }
    const matched=results.every(value=>(value as {matched:boolean}).matched);
    result.textContent=JSON.stringify({complete:true,matched,videoFrameSupported:typeof VideoFrame!=='undefined',results},null,2);
    status.textContent=matched?'공통 저장소 픽셀·재사용·v4 왕복 일치':'공통 저장소 검증 불일치';
  }catch(error){status.textContent=String(error);result.textContent=JSON.stringify({complete:false,error:String(error),results},null,2);}
  finally{video.pause();active=undefined;button.disabled=select.disabled=timeInput.disabled=false;}
});
void fetch('/__corpus').then(async response=>{
  if(!response.ok)throw Error('등록한 입력을 불러오지 못했습니다.');const body=await response.json();
  for(const input of (Array.isArray(body)?body:body.cases??[]) as CorpusCase[]){if(input.kind!=='video')continue;cases.set(input.id,input);select.add(new Option(input.name,input.id));}
}).catch(error=>{status.textContent=`합성 입력만 검사할 수 있습니다. ${String(error)}`;});
