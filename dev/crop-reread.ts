import {createRecognizer} from '../src/features/card-scanner/recognition/recognizer';
import {CardReadBudget,CardReadTimeout} from '../src/features/card-scanner/recognition/card-read-budget';
import {parseScannerNameConfiguration} from '../src/features/card-scanner/session/scanner-name-configuration';
import {loadCropIndexedDbRun,listCropIndexedDbRuns} from './recognition-crop-indexeddb';
import {replayRecognitionCropJournal,type CropEvent} from './recognition-crop-journal';
import {createDiagnosticReadOwner,cropRereadPlan,diagnosticFieldCandidates,diagnosticIdentityComparison,settleLateDiagnosticPreparation} from './crop-reread-core';
import type {RecognitionInputMeta} from '../src/features/card-scanner/recognition/recognition-input-observer';

const runId=document.querySelector<HTMLInputElement>('#run-id')!,readId=document.querySelector<HTMLInputElement>('#read-id')!;
const list=document.querySelector<HTMLButtonElement>('#list')!,runs=document.querySelector<HTMLSelectElement>('#runs')!;
const start=document.querySelector<HTMLButtonElement>('#start')!,stop=document.querySelector<HTMLButtonElement>('#stop')!;
const status=document.querySelector<HTMLElement>('#status')!,result=document.querySelector<HTMLElement>('#result')!;
const canvas=document.querySelector<HTMLCanvasElement>('#crop')!;
const page=new AbortController();let active:AbortController|undefined,cleanupLocked=false;
const request=new URLSearchParams(location.search),requestedRun=request.get('run'),requestedRead=request.get('read');
if(requestedRun&&/^[a-zA-Z0-9-]{1,160}$/.test(requestedRun))runId.value=requestedRun;
if(requestedRead&&/^[1-9]\d{0,14}$/.test(requestedRead)&&Number.isSafeInteger(Number(requestedRead)))readId.value=requestedRead;
type Reader=Awaited<ReturnType<typeof createRecognizer>>;
function controls(busy:boolean){start.disabled=list.disabled=runId.disabled=readId.disabled=runs.disabled=busy||cleanupLocked;stop.disabled=!busy||cleanupLocked;}
/** Do not reuse the displayed canvas or open another reader until a late
 * operation has actually joined and its owned reader has been disposed. */
function holdUntilReleased(work:Promise<void>){
 cleanupLocked=true;controls(true);
 void work.then(()=>{if(page.signal.aborted)return;cleanupLocked=false;controls(false);
  status.textContent='이전 판독기 정리가 끝났습니다. 다시 시도할 수 있습니다.';},()=>{
  if(!page.signal.aborted)status.textContent='이전 판독기 종료를 확인하지 못해 재판독을 잠갔습니다.';
 });
}
function untilAbort<T>(operation:Promise<T>,signal:AbortSignal,onLate?:(value:T)=>void):Promise<T>{
 return new Promise((resolve,reject)=>{let done=false;const cleanup=()=>signal.removeEventListener('abort',abort);
  const abort=()=>{if(done)return;done=true;cleanup();reject(signal.reason);};
  operation.then(value=>{if(done){onLate?.(value);return;}done=true;cleanup();resolve(value);},error=>{if(done)return;done=true;cleanup();reject(error);});
  signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();});
}
async function currentDigest(signal:AbortSignal):Promise<string|null>{
 try{const response=await fetch('/__corpus/environment',{cache:'no-store',signal:AbortSignal.any([signal,AbortSignal.timeout(10000)])});
  if(!response.ok)return null;const data=await response.json();return typeof data?.sourceDigest==='string'&&/^[a-f0-9]{64}$/.test(data.sourceDigest)?data.sourceDigest:null;
 }catch{return null;}
}
runs.addEventListener('change',()=>{if(runs.value)runId.value=runs.value;});
list.addEventListener('click',async()=>{if(active||cleanupLocked)return;controls(true);stop.disabled=true;
 try{const loaded=await listCropIndexedDbRuns();runs.replaceChildren(new Option('기록 선택',''),...loaded.runs.map(run=>new Option(
  `${run.id} · ${run.status==='open'?'미봉인':run.status==='complete'?'저널 봉인':'부분 기록'} · ${run.events}개 이벤트`,run.id)));
  status.textContent=`기록 ${loaded.runs.length}개${loaded.truncated?' · 일부만 표시':''}`;
 }catch(error){status.textContent=`기록 목록 오류 · ${String(error).slice(0,500)}`;}finally{controls(false);}
});
start.addEventListener('click',async()=>{
 if(active||cleanupLocked)return;const id=runId.value.trim(),ordinal=Number(readId.value);
 if(!/^[a-zA-Z0-9-]{1,160}$/.test(id)||!Number.isSafeInteger(ordinal)||ordinal<1){status.textContent='기록 ID와 유효한 판독 호출 번호를 입력하세요.';return;}
 const controller=new AbortController();active=controller;const signal=AbortSignal.any([page.signal,controller.signal,AbortSignal.timeout(180000)]);
 controls(true);result.textContent='';canvas.width=canvas.height=1;
 let saved:Awaited<ReturnType<typeof loadCropIndexedDbRun>>|undefined,reader:Reader|undefined;
 const reads=createDiagnosticReadOwner();
 let report:Record<string,unknown>={version:1,kind:'single-recorded-crop-reread',runId:id,readId:ordinal,completed:false,
  scope:'저장된 픽셀 한 건의 판독기 진단. 원본 프레임·획득·상태 병합·실시간 성능·정답은 검증하지 않음.',
  recordedPixelTiming:'기록된 픽셀 시점을 확인하기 전입니다.',
  modelIntegrity:'기록된 모델 바이너리 해시 없음. 소스 해시가 같아도 실제 모델 바이너리 일치 미검증.',
  replayEnvironment:'새 판독기와 3000ms 예산을 사용. 원래 캐시·남은 예산·worker 경로 및 인접 관측은 재현하지 않음.'};
 const started=performance.now();
 try{
  status.textContent='저장된 이벤트와 크롭 픽셀의 순서·해시를 검사 중입니다.';
  saved=await loadCropIndexedDbRun(id);signal.throwIfAborted();
  let chosen:{event:Extract<CropEvent,{kind:'crop'}>;meta:RecognitionInputMeta;pixels:Uint8Array}|undefined;
  const verified=await replayRecognitionCropJournal(saved.seed,saved.events,saved.checkpoint,saved.read,(event,meta,pixels)=>{
   if(event.readId===ordinal){if(chosen)throw Error('같은 판독 호출에 크롭이 여러 개 있습니다.');chosen={event,meta,pixels};}
  },signal);
  const selected=chosen as typeof chosen;
  if(!selected)throw Error('해당 판독 호출의 저장된 픽셀이 없습니다.');
  const finishes=saved.events.filter((event):event is Extract<CropEvent,{kind:'finish'}>=>event.kind==='finish'&&event.readId===ordinal);
  if(finishes.length!==1)throw Error('선택한 판독 호출의 종료 기록이 없습니다. 부분 기록을 확인하세요.');
  const outcome=finishes[0].outcome,plan=cropRereadPlan(selected.meta,outcome);
  const digest=await currentDigest(signal),configuration=parseScannerNameConfiguration(saved.seed.nameConfiguration);
  const pixelTiming=saved.seed.version===2&&saved.seed.captureBoundary==='recognition-input-v2'?
   '승인된 호출에서 첫 시각/OCR 판독에 넘기기 직전 픽셀. 뒤의 모든 세부 분기와 입력 일치는 미검증.':
   'v1 기록은 판독 종료 시점 픽셀. 원래 판독 입력과 동일한지 미확인.';
  report={...report,recordedPixelTiming:pixelTiming,recording:{id,version:saved.seed.version,checkpointComplete:verified.complete,events:verified.events,crops:verified.crops,
   sourceDigest:saved.seed.build,currentSourceDigest:digest,sourceMatches:digest===null?null:digest===saved.seed.build,
   configuration,recognitionOptions:saved.seed.recognitionOptions,modelSignature:saved.seed.modelSignature},
   selected:{meta:selected.meta,sha256:selected.event.sha256,shared:selected.event.shared,originalOutcome:outcome},plan};
  canvas.width=selected.event.width;canvas.height=selected.event.height;
  const context=canvas.getContext('2d',{willReadFrequently:true});if(!context)throw Error('캔버스를 사용할 수 없습니다.');
  context.putImageData(new ImageData(new Uint8ClampedArray(selected.pixels),canvas.width,canvas.height),0,0);
  if(plan.kind==='unsupported')throw Error(plan.reason);
  signal.throwIfAborted();status.textContent='새 판독기와 모델을 준비하고 있습니다.';
  const prepare=performance.now(),prepareSignal=AbortSignal.any([signal,AbortSignal.timeout(90000)]);
  let initializationCleanupUncertain=false;
  const preparing=createRecognizer(text=>{if(!signal.aborted)status.textContent=text;},prepareSignal,
   {nameRawResultPolicy:configuration.rawResultPolicy,contrastNameFallback:configuration.contrastNameFallback,
    onInitializationCleanupError:()=>{initializationCleanupUncertain=true;}});
  try{reader=await untilAbort(preparing,prepareSignal);}
  catch(error){
   // An aborted public wait is not proof that asynchronous initialization or
   // its cleanup ended. Retain the gate until a late reader is disposed.
   if(prepareSignal.aborted||initializationCleanupUncertain)
    holdUntilReleased(settleLateDiagnosticPreparation(preparing,late=>late.dispose(),()=>initializationCleanupUncertain));
   throw error;
  }
  const preparationMs=performance.now()-prepare;signal.throwIfAborted();status.textContent='선택한 크롭을 다시 판독하고 있습니다.';
  const budget=new CardReadBudget(3000),reading=performance.now();
  const runRead=<T>(operation:()=>Promise<T>|T):Promise<T>=>{
   signal.throwIfAborted();budget.check();
   const owned=reads.run(operation);
   return untilAbort(budget.wait(()=>owned,()=>controller.abort(new CardReadTimeout())),signal);
  };
  const identity=await runRead(()=>plan.kind==='visual'?reader!.identifyVisual(canvas):
   reader!.identify(canvas,selected.meta.stage==='full',selected.meta.stable,selected.meta.borderAlignment>=.8,budget,
    selected.meta.stage==='full'&&saved!.seed.recognitionOptions.fractionalPortrait,undefined,
    selected.meta.stage==='full'&&saved!.seed.recognitionOptions.grayNameFallback));
  const identityMs=performance.now()-reading,current=identity?{id:identity.id,name:identity.name}:null;
  const actualNamePolicy=reader.nameOcrMetrics().policy;
  if(actualNamePolicy!==configuration.rawResultPolicy)throw Error('실제 판독기 이름 정책이 기록된 설정과 다릅니다.');
  report={...report,preparationMs,identityMs,currentIdentity:current,identityReview:identity?.review??[],
   comparison:plan.kind==='identity'?diagnosticIdentityComparison(outcome,current):null,
   diagnostics:{name:reader.nameDiagnostics(canvas),portrait:reader.portraitDiagnostics(canvas),actualNamePolicy},
   fields:{status:'unavailable',awakening:null,extraCopies:null,comparison:'원래 각성·장수 판독 결과가 기록되지 않아 비교할 수 없습니다.'}};
  if(!identity)throw Error('이름을 식별하지 못해 각성·장수를 판독하지 않았습니다.');
  signal.throwIfAborted();status.textContent='각성·추가 장수 후보를 판독하고 있습니다.';
  const fieldStarted=performance.now();
  const readFields=(corroborate:boolean)=>runRead(()=>reader!.read(canvas,identity.id,corroborate,plan.kind!=='visual',budget));
  let values=await readFields(false);
  let fields=diagnosticFieldCandidates(selected.meta,identity.maxAwakening,values);
  report={...report,fields:{...fields,status:'partial',comparison:'원래 각성·장수 판독 결과가 기록되지 않아 비교할 수 없습니다.'}};
  if(plan.kind!=='visual'&&fields.countReliability==='unconfirmed'&&values.awakening!==null&&
    values.countDiagnostics?.pattern?.value!=null&&!identity.review.length){
   values=await readFields(true);fields=diagnosticFieldCandidates(selected.meta,identity.maxAwakening,values);
  }
  const confirmedCandidates=!identity.review.length&&fields.awakening!==null&&fields.extraCopies!==null&&fields.countReliability!=='unconfirmed';
  report={...report,completed:confirmedCandidates,fieldMs:performance.now()-fieldStarted,elapsedMs:performance.now()-reading,
   fields:{...fields,status:confirmedCandidates?'candidate':'partial',comparison:'원래 각성·장수 판독 결과가 기록되지 않아 비교할 수 없습니다.'}};
  status.textContent=confirmedCandidates?`단건 판독 완료 · ${identity.name} · 각성·장수는 현재 판독 후보입니다.`:
   `단건 판독 부분 완료 · ${identity.name} · 확인되지 않은 값이 있습니다.`;
 }catch(error){const timedOut=error instanceof CardReadTimeout||signal.reason instanceof CardReadTimeout||
   error instanceof DOMException&&error.name==='TimeoutError';
  report={...report,completed:false,error:String(error).slice(0,2000),timedOut,cancelled:signal.aborted&&!timedOut};
  status.textContent=`단건 검사 미완료 · ${String(error).slice(0,300)}${cleanupLocked?' · 이전 판독기 정리 대기':''}`;}
 finally{
  if(reader){
   const ownedReader=reader;
   // Timeout releases the caller, not the operation's ownership. Join the
   // actual read before clearing reader-owned canvases or reusing this crop.
   const disposing=reads.join().then(()=>ownedReader.dispose());
   try{await untilAbort(disposing,AbortSignal.timeout(10000));}
   catch(error){report={...report,completed:false,disposalError:String(error).slice(0,500)};
    status.textContent='판독기 정리가 지연돼 재판독을 잠갔습니다.';holdUntilReleased(disposing);}
  }
  saved?.close();report={...report,totalMs:performance.now()-started};result.textContent=JSON.stringify(report,null,2);
  if(active===controller)active=undefined;controls(false);
 }
});
stop.addEventListener('click',()=>active?.abort());window.addEventListener('pagehide',()=>{active?.abort();page.abort();});
if(import.meta.hot){const invalidate=()=>active?.abort();import.meta.hot.on('vite:beforeUpdate',invalidate);
 import.meta.hot.dispose(()=>{invalidate();page.abort();import.meta.hot?.off('vite:beforeUpdate',invalidate);});}
