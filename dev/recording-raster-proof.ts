type CorpusCase={id:string;name:string;kind:string;inputs:{url:string}[]};
type Proof={hash:string;sample:number[]};
type CombinedProof={acquisition:Proof;recording:Proof};
const select=document.querySelector<HTMLSelectElement>('#corpus')!,button=document.querySelector<HTMLButtonElement>('#run')!,
  pngButton=document.querySelector<HTMLButtonElement>('#png')!,pngResult=document.querySelector<HTMLElement>('#png-result')!,
  status=document.querySelector<HTMLElement>('#status')!,result=document.querySelector<HTMLElement>('#result')!,
  rows=document.querySelector<HTMLTableSectionElement>('#rows')!,video=document.querySelector<HTMLVideoElement>('video')!;
const cases=new Map<string,CorpusCase>();
async function hash(pixels:Uint8Array<ArrayBuffer>):Promise<string>{return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',pixels)),value=>value.toString(16).padStart(2,'0')).join('');}
async function baseline(source:ImageBitmap|VideoFrame):Promise<Proof>{
 const width='displayWidth' in source?source.displayWidth:source.width,height='displayHeight' in source?source.displayHeight:source.height;
 const canvas=new OffscreenCanvas(width,height),context=canvas.getContext('2d',{willReadFrequently:true})!;context.globalCompositeOperation='copy';context.drawImage(source,0,0);
 const pixels=context.getImageData(0,0,width,height).data;
 const proof={hash:await hash(new Uint8Array(pixels.buffer,pixels.byteOffset,pixels.byteLength)),sample:Array.from(pixels.subarray(0,32))};
 canvas.width=0;return proof;
}
function synthetic(){
 const canvas=new OffscreenCanvas(4,2),context=canvas.getContext('2d',{willReadFrequently:true})!;
 context.putImageData(new ImageData(Uint8ClampedArray.from([
  255,0,0,255,0,255,0,128,0,0,255,1,145,73,201,0,
  25,50,75,255,253,127,61,200,23,241,178,100,255,255,255,255,
 ]),4,2),0,0);return canvas;
}
async function waitMedia(event:string){await new Promise<void>((resolve,reject)=>{
 const cleanup=()=>{clearTimeout(timer);video.removeEventListener(event,done);video.removeEventListener('error',fail);};
 const done=()=>{cleanup();resolve();},fail=()=>{cleanup();reject(Error('영상 디코딩 실패'));};
 const timer=setTimeout(()=>{cleanup();reject(Error('영상 디코딩 시간 초과'));},10_000);
 video.addEventListener(event,done,{once:true});video.addEventListener('error',fail,{once:true});
 });}
async function loadVideo(url:string,time:number){
 video.pause();video.muted=true;video.src=url;video.preload='auto';video.load();await waitMedia('loadedmetadata');
 if(video.readyState<2)await waitMedia('loadeddata');
 const target=Math.min(time,Math.max(0,video.duration-.01));
 if(Math.abs(video.currentTime-target)>.001){video.currentTime=target;await waitMedia('seeked');}
 if(video.readyState<2)await waitMedia('loadeddata');
 if('requestVideoFrameCallback' in video){
  await new Promise<void>((resolve,reject)=>{
   let handle=0;
   const timer=setTimeout(()=>{video.cancelVideoFrameCallback(handle);video.pause();reject(Error('영상 표시 프레임 준비 시간 초과'));},5000);
   handle=video.requestVideoFrameCallback(()=>{clearTimeout(timer);video.pause();resolve();});
   void video.play().catch(error=>{clearTimeout(timer);video.cancelVideoFrameCallback(handle);reject(error);});
  });
 }
 if(video.readyState<2||!video.videoWidth||!video.videoHeight)throw Error('표시할 영상 프레임이 없습니다.');
}
async function videoBitmap(){
 try{return {bitmap:await createImageBitmap(video),kind:'ImageBitmap(video)'};}
 catch(directError){
  if(typeof VideoFrame==='undefined')throw directError;
  const frame=new VideoFrame(video);
  try{return {bitmap:await createImageBitmap(frame),kind:'ImageBitmap(VideoFrame)'};}
  finally{frame.close();}
 }
}
button.addEventListener('click',async()=>{
 button.disabled=true;pngButton.disabled=true;select.disabled=true;status.textContent='변환을 비교하고 있습니다.';rows.replaceChildren();result.textContent='';
 const acquisition=new Worker(new URL('../src/features/card-scanner/acquisition-worker.ts',import.meta.url),{type:'module'}),
  recorder=new Worker(new URL('./recording-raster-proof-worker.ts',import.meta.url),{type:'module'}),channel=new MessageChannel();
 const waiting=new Map<number,{resolve:(value:CombinedProof)=>void;reject:(reason:unknown)=>void;acquisition?:Proof;recording?:Proof;timer:ReturnType<typeof setTimeout>}>();
 const results:unknown[]=[];let id=0;
 const accept=(role:'acquisition'|'recording',value:{id:number;error?:string;pixelProof?:Proof;hash?:string;sample?:number[]})=>{
  const pending=waiting.get(value.id);if(!pending)return;
  if(value.error){clearTimeout(pending.timer);waiting.delete(value.id);pending.reject(Error(value.error));return;}
  const proof=role==='acquisition'?value.pixelProof:{hash:value.hash!,sample:value.sample!};if(!proof)return;pending[role]=proof;
  if(pending.acquisition&&pending.recording){clearTimeout(pending.timer);waiting.delete(value.id);pending.resolve({acquisition:pending.acquisition,recording:pending.recording});}
 };
 acquisition.onmessage=event=>accept('acquisition',event.data);recorder.onmessage=event=>accept('recording',event.data);
 const fail=(error:ErrorEvent)=>{for(const pending of waiting.values()){clearTimeout(pending.timer);pending.reject(Error(error.message));}waiting.clear();};
 acquisition.onerror=fail;recorder.onerror=fail;
 recorder.postMessage({port:channel.port2},[channel.port2]);acquisition.postMessage({kind:'record',port:channel.port1},[channel.port1]);
 const check=async(name:string,kind:string,source:ImageBitmap|VideoFrame,time:number)=>{
  const expected=await baseline(source),current=++id;
  const received=new Promise<CombinedProof>((resolve,reject)=>{const timer=setTimeout(()=>{waiting.delete(current);reject(Error('픽셀 비교 응답 시간 초과'));},10_000);waiting.set(current,{resolve,reject,timer});});
  void received.catch(()=>{});
  const width='displayWidth' in source?source.displayWidth:source.width,height='displayHeight' in source?source.displayHeight:source.height;
  const box={x:0,y:0,width,height};
  acquisition.postMessage({id:current,bitmap:source,time,phase:'input',pixelProof:true,
   layout:{cells:[],header:box,growthPoints:box,sort:box,area:box,scrollbar:box,scale:1,score:1,growthScore:1}},[source]);
  const actual=await received;
  const matched=expected.hash===actual.acquisition.hash&&expected.hash===actual.recording.hash;
  results.push({name,kind,width,height,matched,expected,...actual});
  const row=rows.insertRow();for(const text of [name,kind,matched?'세 경로 일치':'불일치'])row.insertCell().textContent=text;row.className=matched?'ok':'bad';
  result.textContent=JSON.stringify({complete:false,results},null,2);
 };
 try{
  const canvas=synthetic();await check('합성 RGBA · 투명도 포함','ImageBitmap',await createImageBitmap(canvas),0);
  if(typeof VideoFrame!=='undefined')await check('합성 RGBA · 투명도 포함','VideoFrame',new VideoFrame(canvas,{timestamp:0}),0);
  const input=cases.get(select.value);
  if(input){const time=Number(document.querySelector<HTMLInputElement>('#time')!.value);if(!Number.isFinite(time)||time<0)throw Error('영상 시각을 확인하세요.');
   const response=await fetch(`/__corpus/cases/${input.id}`);if(!response.ok)throw Error('영상 입력을 불러오지 못했습니다.');const detail:CorpusCase=await response.json();
   await loadVideo(detail.inputs[0].url,time);const snapshot=await videoBitmap();await check(`${input.name} · ${video.currentTime.toFixed(3)}초`,snapshot.kind,snapshot.bitmap,video.currentTime);
   if(typeof VideoFrame!=='undefined')await check(`${input.name} · ${time}초`,'VideoFrame',new VideoFrame(video),time);
  }
  const matched=results.every(value=>(value as {matched:boolean}).matched);
  status.textContent=matched?'픽셀 변환 일치 · 원본·획득·기록 경로의 전체 RGBA 해시가 같습니다.':'픽셀 변환 불일치';
  result.textContent=JSON.stringify({complete:true,matched,videoFrameSupported:typeof VideoFrame!=='undefined',results},null,2);
 }catch(error){status.textContent=String(error);result.textContent=JSON.stringify({complete:false,error:String(error),results},null,2);}
 finally{acquisition.terminate();recorder.terminate();for(const pending of waiting.values()){clearTimeout(pending.timer);pending.reject(Error('검사 종료'));}waiting.clear();button.disabled=false;pngButton.disabled=false;select.disabled=false;}
});
pngButton.addEventListener('click',async()=>{
 button.disabled=true;pngButton.disabled=true;select.disabled=true;pngResult.textContent='';status.textContent='PNG 기록 비용을 비교하고 있습니다.';
 const worker=new Worker(new URL('./recording-raster-proof-worker.ts',import.meta.url),{type:'module'}),results:unknown[]=[];
 let rejectPending:(reason:unknown)=>void=()=>{},pendingTimer:ReturnType<typeof setTimeout>|undefined,id=0;
 worker.onerror=event=>rejectPending(Error(event.message));
 const check=async(name:string,kind:string,bitmap:ImageBitmap)=>{
  const current=++id;
  const received=new Promise<Record<string,unknown>>((resolve,reject)=>{
   rejectPending=reject;pendingTimer=setTimeout(()=>reject(Error('PNG 기록 비용 응답 시간 초과')),20_000);
   worker.onmessage=event=>{if(event.data.kind==='png-benchmark'&&event.data.id===current){clearTimeout(pendingTimer);if(event.data.error)reject(Error(event.data.error));else resolve(event.data);}};
  });
  void received.catch(()=>{});
  try{worker.postMessage({kind:'png-benchmark',id:current,bitmap},[bitmap]);}
  catch(error){bitmap.close();throw error;}
  const measured=await received;results.push({name,source:kind,...measured});
  pngResult.textContent=JSON.stringify({complete:false,results},null,2);
 };
 try{
  await check('합성 RGBA · 투명도 포함','ImageBitmap(canvas)',await createImageBitmap(synthetic()));
  const input=cases.get(select.value);
  if(input){
   const time=Number(document.querySelector<HTMLInputElement>('#time')!.value);if(!Number.isFinite(time)||time<0)throw Error('영상 시각을 확인하세요.');
   const response=await fetch(`/__corpus/cases/${input.id}`);if(!response.ok)throw Error('영상 입력을 불러오지 못했습니다.');const detail:CorpusCase=await response.json();
   await loadVideo(detail.inputs[0].url,time);const snapshot=await videoBitmap();await check(`${input.name} · ${video.currentTime.toFixed(3)}초`,snapshot.kind,snapshot.bitmap);
  }
  const matched=results.every(value=>(value as {matched:boolean}).matched);
  pngResult.textContent=JSON.stringify({complete:true,matched,results},null,2);
  status.textContent=matched?'PNG 왕복 픽셀 일치 · 크기와 시간은 아래 결과에서 확인하세요.':'PNG 왕복 픽셀 불일치';
 }catch(error){pngResult.textContent=JSON.stringify({complete:false,error:String(error),results},null,2);status.textContent=String(error);}
 finally{clearTimeout(pendingTimer);worker.terminate();button.disabled=false;pngButton.disabled=false;select.disabled=false;}
});
void fetch('/__corpus').then(async response=>{
 if(!response.ok)throw Error('등록한 입력을 불러오지 못했습니다.');const body=await response.json();
 for(const input of (Array.isArray(body)?body:body.cases??[]) as CorpusCase[]){if(input.kind!=='video')continue;cases.set(input.id,input);const option=new Option(input.name,input.id);select.add(option);}
}).catch(error=>{status.textContent=`합성 입력만 검사할 수 있습니다. ${String(error)}`;});
