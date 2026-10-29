// Development-only proof. Pixels stay in the owned Worker, not in the UI or inventory.
const parameters=new URLSearchParams(window.location.search),theme=parameters.get('theme');
if(theme==='light'||theme==='dark')document.documentElement.style.colorScheme=theme;
if(parameters.get('narrow')==='1')document.body.style.maxWidth='360px';
const MAX_SOURCE_BYTES=256*1024*1024,MAX_JSON_BYTES=256*1024,DEADLINE_MS=180_000,GRACE_MS=5_000;
const select=document.querySelector<HTMLSelectElement>('#corpus')!,run=document.querySelector<HTMLButtonElement>('#run')!,
 stop=document.querySelector<HTMLButtonElement>('#stop')!,status=document.querySelector<HTMLElement>('#status')!,
 summary=document.querySelector<HTMLElement>('#summary')!,result=document.querySelector<HTMLElement>('#result')!;
type Job={id:number;controller:AbortController;worker?:Worker;deadline?:ReturnType<typeof setTimeout>;grace?:ReturnType<typeof setTimeout>;halt?:string;sourceStart?:unknown;finished:boolean};
let active:Job|undefined,nextId=0,disposed=false;
const object=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value);
const natural=(value:unknown):value is number=>typeof value==='number'&&Number.isSafeInteger(value)&&value>=0;
const positive=(value:unknown):value is number=>natural(value)&&value>0;
const sha=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
async function boundedBody(response:Response,cap:number,signal:AbortSignal){
 if(!response.ok||!response.body)throw Error('개인 로컬 입력을 읽지 못했습니다.');
 const reader=response.body.getReader(),chunks:Uint8Array<ArrayBuffer>[]=[];let size=0,ended=false;
 try{while(true){signal.throwIfAborted();const next=await reader.read();signal.throwIfAborted();if(next.done){ended=true;break;}
  size+=next.value.byteLength;if(size>cap)throw Error('검사 입력 크기 한도 초과');chunks.push(next.value);}
  return new Blob(chunks);
 }finally{if(!ended)await reader.cancel().catch(()=>{});reader.releaseLock();}
}
async function json(url:string,signal:AbortSignal){
 const response=await fetch(url,{signal,cache:'no-store'}),blob=await boundedBody(response,MAX_JSON_BYTES,signal);
 const bytes=await blob.arrayBuffer();signal.throwIfAborted();
 return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)) as unknown;
}
async function environment(signal:AbortSignal){return json('/__corpus/environment',AbortSignal.any([signal,AbortSignal.timeout(10_000)]));}
async function finish(job:Job,report:Record<string,unknown>){
 if(active!==job||job.finished)return;job.finished=true;clearTimeout(job.deadline);clearTimeout(job.grace);
 stop.disabled=true;status.textContent='작업자 종료 · 실행 소스 변경 여부를 확인합니다.';
 job.worker?.terminate();job.worker=undefined;
 let sourceEnd:unknown=null,sourceError:string|null=null;
 try{sourceEnd=await environment(AbortSignal.any([page.signal,AbortSignal.timeout(10_000)]));}catch(error){sourceError=String(error).slice(0,500);}
 // A disposed page never publishes a late result or changes the next run's UI.
 if(disposed||active!==job)return;
 const digest=(value:unknown)=>object(value)&&sha(value.sourceDigest)?value.sourceDigest:null;
 const sourceChanged=digest(job.sourceStart)&&digest(sourceEnd)?digest(job.sourceStart)!==digest(sourceEnd):null;
 const output:Record<string,unknown>={...report,...(job.halt?{complete:false,error:job.halt}:{}),
  validation:{sourceStart:job.sourceStart??null,sourceEnd,sourceChanged,sourceError},
  workerCleanup:{terminated:true,scope:'The owned worker is terminated before final source inspection. GPU/physical release latency is not measured.'}};
 result.textContent=JSON.stringify(output,null,2);
 summary.textContent=JSON.stringify({complete:output.complete??false,error:output.error??null,comparison:output.comparison??null,
  sourceVerified:output.sourceVerified??false,limits:output.limits??null,
  passes:Array.isArray(output.passes)?output.passes.map(value=>{if(!object(value))return null;
   const frame=Array.isArray(value.frames)?value.frames[0]:null;
   return {pass:value.pass,profile:object(frame)&&object(frame.profile)?frame.profile.id:null,track:value.track,stats:value.stats,cleanup:value.cleanup};}):[],
  sourceChanged,scope:'평면·고정 색변환의 반복성만 검사. 카드 인식·OS 캡처·전체 기록 성능 검사는 포함하지 않음.'},null,2);
 status.textContent=output.complete===true?'검사가 끝났습니다. 비교 결과와 소스 변경 여부를 확인하세요.':'검사를 완료하지 못했습니다. 실패 상태와 부분 근거를 남겼습니다.';
 active=undefined;run.disabled=select.disabled=false;stop.disabled=true;
}
function halt(reason:string){
 const job=active;if(!job||job.finished||job.halt)return;job.halt=reason;job.controller.abort(new DOMException(reason,'AbortError'));
 stop.disabled=true;status.textContent='중지 요청 중 · 현재 작업을 정리합니다.';
 if(job.worker){job.worker.postMessage({kind:'cancel',id:job.id});job.grace=setTimeout(()=>{void finish(job,{complete:false,error:reason,forcedTermination:true});},GRACE_MS);}
}
function submit(event:Event){
 event.preventDefault();if(active||disposed||!sha(select.value))return;
 const caseId=select.value,job:Job={id:++nextId,controller:new AbortController(),finished:false};active=job;
 run.disabled=select.disabled=true;stop.disabled=false;summary.textContent=result.textContent='';status.textContent='입력과 소스 버전을 확인합니다.';
 job.deadline=setTimeout(()=>halt('네이티브 입력 검사 180초 한도 초과'),DEADLINE_MS);
 void(async()=>{try{
  job.sourceStart=await environment(job.controller.signal);job.controller.signal.throwIfAborted();
  const manifest=await json(`/__corpus/cases/${caseId}`,job.controller.signal);
  if(!object(manifest)||manifest.id!==caseId||manifest.kind!=='video'||!Array.isArray(manifest.inputs)||manifest.inputs.length!==1)throw Error('단일 영상 사례만 지원합니다.');
  const source=manifest.inputs[0];
  if(!object(source)||source.index!==0||!positive(source.bytes)||source.bytes>MAX_SOURCE_BYTES||!sha(source.sha256)||
   typeof source.type!=='string'||!['video/mp4','video/webm'].includes(source.type)||source.url!==`/__corpus/cases/${caseId}/input/0`)throw Error('영상 입력 계약 오류');
  const blob=await boundedBody(await fetch(source.url,{signal:job.controller.signal}),source.bytes,job.controller.signal);
  if(blob.size!==source.bytes)throw Error('영상 입력 길이 불일치');job.controller.signal.throwIfAborted();
  const worker=job.worker=new Worker(new URL('./native-yuv-proof-worker.ts',import.meta.url),{type:'module'});
  worker.onmessage=event=>{if(active!==job||job.finished||event.data?.id!==job.id)return;
   const message=event.data;
   if(message.kind==='progress'&&!job.halt)status.textContent=`평면 검사 ${message.pass??0}/2 · ${message.frames??0}프레임`;
   else if(message.kind==='done'&&object(message.report))void finish(job,message.report);
   else if(message.kind==='error')void finish(job,{...(object(message.report)?message.report:{}),complete:false,error:String(message.error??'작업자 오류').slice(0,2000),code:message.code??null,partial:message.partial??null});
  };
  worker.onerror=event=>{void finish(job,{complete:false,error:String(event.message).slice(0,2000)});};
  worker.postMessage({kind:'run',id:job.id,blob,source:{caseId,index:0,sha256:source.sha256,bytes:source.bytes,type:source.type}});
 }catch(error){void finish(job,{complete:false,error:String(error).slice(0,2000)});}})();
}
function stopProof(){halt('사용자 중지');}
document.querySelector('form')!.addEventListener('submit',submit);
stop.addEventListener('click',stopProof);
const page=new AbortController();
let listController:AbortController|undefined;
function pageHide(){listController?.abort();listController=undefined;halt('페이지 이탈');}
function pageShow(event:PageTransitionEvent){if(event.persisted&&!select.options.length&&!active&&!disposed)void loadCases();}
window.addEventListener('pagehide',pageHide);
window.addEventListener('pageshow',pageShow);
import.meta.hot?.dispose(()=>{disposed=true;page.abort();listController?.abort();document.querySelector('form')!.removeEventListener('submit',submit);stop.removeEventListener('click',stopProof);window.removeEventListener('pagehide',pageHide);window.removeEventListener('pageshow',pageShow);if(active){clearTimeout(active.deadline);clearTimeout(active.grace);active.controller.abort();active.worker?.terminate();active=undefined;}});
async function loadCases(){
 const controller=new AbortController();listController?.abort();listController=controller;
 const previous=select.value;run.disabled=select.disabled=true;
 const signal=AbortSignal.any([page.signal,controller.signal,AbortSignal.timeout(10_000)]);
 try{
 const value=await json('/__corpus',signal);signal.throwIfAborted();if(disposed||listController!==controller)return;
 if(!object(value)||!Array.isArray(value.cases))throw Error('입력 목록 형식 오류');
 select.replaceChildren();
 for(const item of value.cases){if(object(item)&&sha(item.id)&&item.kind==='video'&&item.inputs===1&&typeof item.name==='string')select.add(new Option(item.name.slice(0,100),item.id));}
 if(Array.from(select.options).some(option=>option.value===previous))select.value=previous;
 run.disabled=select.disabled=!select.options.length;status.textContent=select.options.length?'등록한 영상을 선택해 검사하세요.':'단일 영상 검증 사례가 없습니다.';
 }catch(error){if(!disposed&&!controller.signal.aborted)status.textContent=String(error).slice(0,1000);}
 finally{if(listController===controller)listController=undefined;}
}
void loadCases();
