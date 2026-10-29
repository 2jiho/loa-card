import {createRecognizer,cardHasLabel} from '../src/features/card-scanner/recognizer';
import {CardReadBudget,CardReadTimeout} from '../src/features/card-scanner/card-read-budget';
import {inspectCapture} from '../src/features/card-scanner/capture-quality';
import {countReliability} from '../src/features/card-scanner/count-confidence';
import {CARD_CROP_PROOF_LIMITS as LIMITS,verifyCardCropPng,measureCardCropRgba,decodeCardCropBitmap,sha256CardCropBytes} from './card-crop-proof-core';
import {parseCardCropProofRoute,parseSelectedCardCropProof} from './card-crop-proof-routing';
import {runCardCropProofSequence,cardCropProofCompleted} from './card-crop-proof-execution';
import type {CardCropProofMode,CardCropProofModeId} from './card-crop-proof-routing';
import type {CardCropInput,CardCropProofData} from './card-crop-proof-core';
import type {SourceSnapshot} from './source-snapshot';

type Recognizer=Awaited<ReturnType<typeof createRecognizer>>;
type Mode=CardCropProofModeId;
const route=parseCardCropProofRoute(location.search),MODES=route.modes;
const start=document.querySelector<HTMLButtonElement>('#run')!,stop=document.querySelector<HTMLButtonElement>('#stop')!;
const download=document.querySelector<HTMLButtonElement>('#download')!,status=document.querySelector<HTMLElement>('#status')!;
const result=document.querySelector<HTMLElement>('#result')!,table=document.querySelector<HTMLTableSectionElement>('#rows')!;
const page=new AbortController();let active:AbortController|undefined,downloadUrl:string|undefined;
status.textContent=`${route.manifestPath} · ${route.comparison} · 이름 원본 정책 ${route.nameConfiguration.rawResultPolicy}`;

function errorText(error:unknown){return String(error).slice(0,2000);}
/** Abort the caller's wait; a late disposable result is never adopted. */
function untilAbort<T>(operation:Promise<T>,signal:AbortSignal,onLate?:(value:T)=>void):Promise<T>{
  return new Promise((resolve,reject)=>{
    let settled=false;
    const cleanup=()=>signal.removeEventListener('abort',aborted);
    const aborted=()=>{if(settled)return;settled=true;cleanup();reject(signal.reason);};
    operation.then(value=>{
      if(settled){onLate?.(value);return;}
      settled=true;cleanup();resolve(value);
    },error=>{if(settled)return;settled=true;cleanup();reject(error);});
    signal.addEventListener('abort',aborted,{once:true});if(signal.aborted)aborted();
  });
}
async function boundedText(url:string,signal:AbortSignal,limit:number){
  const bounded=AbortSignal.any([signal,AbortSignal.timeout(LIMITS.fetchMs)]);
  const response=await fetch(url,{cache:'no-store',signal:bounded,mode:'same-origin',redirect:'error'});
  if(!response.ok||!response.body)throw Error(`Local input unavailable: ${response.status}`);
  if(Number(response.headers.get('content-length'))>limit)throw Error('Local input exceeds its byte limit.');
  const reader=response.body.getReader(),chunks:Uint8Array[]=[];let bytes=0;
  try{for(;;){bounded.throwIfAborted();const {done,value}=await reader.read();if(done)break;
    bytes+=value.byteLength;if(bytes>limit)throw Error('Local input exceeds its byte limit.');chunks.push(value);
  }}catch(error){await reader.cancel().catch(()=>{});throw error;}finally{reader.releaseLock();}
  const joined=new Uint8Array(bytes);let offset=0;for(const chunk of chunks){joined.set(chunk,offset);offset+=chunk.length;}
  return {text:new TextDecoder('utf-8',{fatal:true}).decode(joined),sha256:await sha256CardCropBytes(joined),bytes};
}
async function snapshot(signal:AbortSignal):Promise<SourceSnapshot>{
  const loaded=await boundedText('/__corpus/environment',signal,256*1024),value=JSON.parse(loaded.text) as SourceSnapshot;
  if(value.version!==1||!/^[a-f0-9]{64}$/.test(value.sourceDigest))throw Error('Source snapshot has no valid digest.');return value;
}
async function dispose(reader:Recognizer){
  try{await untilAbort(reader.dispose(),AbortSignal.timeout(LIMITS.disposeMs));return {completed:true,error:null};}
  catch(error){return {completed:false,error:errorText(error)};}
}
function appendRow(key:string,mode:Mode,value:Record<string,unknown>){
  const fields=value.fields as {awakening:number|null;extraCopies:number|null}|null;
  const identity=value.identity as {name:string}|null;
  const row=document.createElement('tr');
  for(const text of [key,mode,identity?.name??'null',String(fields?.awakening??null),String(fields?.extraCopies??null),
    Array.isArray(value.review)?value.review.join(' · '):'',typeof value.elapsedMs==='number'?value.elapsedMs.toFixed(1):'null',
    typeof value.budgetRemainingMs==='number'?value.budgetRemainingMs.toFixed(1):'null',value.error?String(value.error):'']){
    const cell=document.createElement('td');cell.textContent=text;row.append(cell);
  }
  table.append(row);
}

async function readCard(reader:Recognizer,canvas:HTMLCanvasElement,input:CardCropInput,budget:CardReadBudget,mode:CardCropProofMode,progress:(value:Record<string,unknown>)=>void){
  const captureStable=input.capture.stable===true,structural=(input.capture.borderAlignment??0)>=.8;
  const inspected=await reader.inspect(canvas);progress({inspected});budget.check();
  const identity=await reader.identify(canvas,true,captureStable,structural,budget,mode.portraitRefinement,undefined,mode.grayNameFallback);
  progress({identity:identity??null});
  budget.check();
  // An unknown identity does not authorize any candidate ID. Unbound field
  // readings remain explicit diagnostics, and cannot create an inventory card.
  let fields=await reader.read(canvas,identity?.id,false,true,budget);
  progress({readerFields:{...fields},fields:{awakening:fields.awakening,extraCopies:fields.extraCopies},
    fieldsBoundToIdentity:identity!==null,countDiagnostics:fields.countDiagnostics??null});
  const reliability=()=>countReliability({stable:captureStable,repeatedCount:false,borderAlignment:input.capture.borderAlignment??0,
    awakening:fields.awakening,extraCopies:fields.extraCopies,maxAwakening:identity?.maxAwakening,
    pattern:fields.countDiagnostics?.pattern,iconPresent:fields.countDiagnostics?.iconPresent,
    patternOcrAgreed:fields.countDiagnostics?.patternOcrAgreed,ocrConfirmedValue:fields.countDiagnostics?.ocrConfirmedValue});
  let count=reliability(),corroborationTimedOut=false;
  if(identity&&count==='unconfirmed'&&fields.awakening!==null&&fields.countDiagnostics?.pattern?.value!=null&&!identity.review.length){
    try{fields=await reader.read(canvas,identity.id,true,true,budget);count=reliability();}
    catch(error){if(!(error instanceof CardReadTimeout))throw error;corroborationTimedOut=true;}
  }
  const rawFields={...fields};
  // Apply the existing scanner's absence-of-overlay rule, retaining the exact
  // reader value separately so a raw zero is never disguised as observed truth.
  const extraCopies=fields.extraCopies===0&&count==='unconfirmed'?null:fields.extraCopies;
  const review=identity?[...identity.review]:['이름 확인'];
  if(fields.awakening===null)review.push('각성 확인');
  if(extraCopies===null||count==='unconfirmed')review.push('추가 장수 확인');
  return {identity:identity??null,inspected,readerFields:rawFields,
    fields:{awakening:fields.awakening,extraCopies},fieldsBoundToIdentity:identity!==null,
    countDiagnostics:fields.countDiagnostics??null,countReliability:count,corroborationTimedOut,review};
}

async function runMode(input:CardCropInput,mode:CardCropProofMode,signal:AbortSignal,say:(message:string)=>void){
  const lifetime=new AbortController(),modeSignal=AbortSignal.any([signal,lifetime.signal]);
  const {image,candidate,...metadata}=input;
  const readerOptions={nameRawResultPolicy:route.nameConfiguration.rawResultPolicy,...(mode.contrastNameFallback?{contrastNameFallback:true}:{})};
  const output:Record<string,unknown>={mode:mode.id,modeOptions:{...mode},input:{...metadata,candidateDiagnosticOnly:candidate??null},
    effectiveCapture:{stable:input.capture.stable===true,structural:(input.capture.borderAlignment??0)>=.8,
      borderAlignment:input.capture.borderAlignment??0,repeatedCount:false,provenance:input.capture.provenance},
    declaredRgbaEvidence:{sha256:input.rgbaSha256,scope:'Producer declaration in selected manifest; not browser-decoded evidence until decodedRgbaVerified=true.'},
    requestedNameConfiguration:{...route.nameConfiguration},passedReaderOptions:null,actualNameRawResultPolicy:null,nameOcrMetrics:null,
    actualPngSha256:null,actualDecodedRgbaSha256:null,decodedRgbaVerified:false,qualityDiagnostic:null,
    preparationMs:null,elapsedMs:null,budgetMs:LIMITS.cardMs,budgetRemainingMs:null,
    identity:null,readerFields:null,fields:{awakening:null,extraCopies:null},fieldsBoundToIdentity:false,
    countDiagnostics:null,countReliability:null,nameAttempts:[],portraitDiagnostics:null,review:[],timedOut:false,error:null,disposal:null};
  const canvas=document.createElement('canvas');canvas.width=140;canvas.height=210;
  let reader:Recognizer|undefined,bitmap:ImageBitmap|undefined,budget:CardReadBudget|undefined,cardStarted:number|undefined;
  const abortReader=()=>{if(reader)void reader.dispose().catch(()=>{});};
  modeSignal.addEventListener('abort',abortReader,{once:true});
  try{
    modeSignal.throwIfAborted();
    const png=await verifyCardCropPng({image,pngSha256:input.pngSha256});output.actualPngSha256=png.sha256;
    modeSignal.throwIfAborted();bitmap=await decodeCardCropBitmap(new Blob([png.bytes],{type:'image/png'}),modeSignal);
    if(bitmap.width!==140||bitmap.height!==210)throw Error('Decoded card must be exactly 140×210.');
    const context=canvas.getContext('2d',{willReadFrequently:true,colorSpace:'srgb'})!;
    context.globalCompositeOperation='copy';context.drawImage(bitmap,0,0);bitmap.close();bitmap=undefined;
    const rgba=context.getImageData(0,0,140,210).data;
    const rgbaEvidence=await measureCardCropRgba(rgba,input.rgbaSha256);
    output.actualDecodedRgbaSha256=rgbaEvidence.sha256;output.decodedRgbaVerified=rgbaEvidence.verified;
    if(!rgbaEvidence.verified)throw Error('Decoded card RGBA SHA-256 mismatch.');
    // Do not turn missing geometry into a fabricated cut/unstable diagnosis.
    // Production quality inspection is possible only when its input flags exist.
    const labelVisible=cardHasLabel(canvas),knownGeometry=input.capture.complete!==null&&input.capture.intact!==null&&input.capture.borderAlignment!==null;
    output.qualityDiagnostic=knownGeometry?{...inspectCapture(rgba,140,210,input.capture.complete===true,labelVisible,input.capture.intact===true,(input.capture.borderAlignment??0)>=.8),
      labelVisible,scope:'Pixel inspection with recorded/recomputed flags. Diagnostic only; not acquisition admission replay.'}:
      {usable:null,labelVisible,reason:'Acquisition geometry unknown; original quality admission is not reconstructed.'};
    modeSignal.throwIfAborted();say(`${input.key} · ${mode.id} · 새 판독기 준비 중`);
    const preparing=performance.now(),prepareSignal=AbortSignal.any([modeSignal,AbortSignal.timeout(LIMITS.prepareMs)]);
    output.passedReaderOptions={...readerOptions};
    reader=await untilAbort(createRecognizer(say,prepareSignal,readerOptions),prepareSignal,late=>{void late.dispose().catch(()=>{});});
    output.preparationMs=performance.now()-preparing;modeSignal.throwIfAborted();
    say(`${input.key} · ${mode.id} · 카드 전체 판독 중`);
    cardStarted=performance.now();budget=new CardReadBudget(LIMITS.cardMs);
    const progress=(value:Record<string,unknown>)=>{if(!modeSignal.aborted)Object.assign(output,value);};
    const reading=await untilAbort(budget.wait(()=>readCard(reader!,canvas,input,budget!,mode,progress),()=>lifetime.abort(new CardReadTimeout())),modeSignal);
    modeSignal.throwIfAborted();Object.assign(output,reading);
  }catch(error){output.error=errorText(error);output.timedOut=error instanceof CardReadTimeout||modeSignal.reason instanceof CardReadTimeout;
    output.review=['판독 미완료'];
  }finally{
    if(cardStarted!==undefined)output.elapsedMs=performance.now()-cardStarted;
    if(budget)output.budgetRemainingMs=budget.remaining();
    // Copy diagnostics before releasing the immutable crop and its reader.
    if(reader){
      output.nameAttempts=reader.nameDiagnostics(canvas);output.portraitDiagnostics=reader.portraitDiagnostics(canvas);
      const metrics=reader.nameOcrMetrics();output.nameOcrMetrics=metrics;output.actualNameRawResultPolicy=metrics.policy;
      if(metrics.policy!==route.nameConfiguration.rawResultPolicy){output.error=output.error??'Actual reader name policy differs from requested policy.';output.review=['판독 설정 불일치'];}
    }
    modeSignal.removeEventListener('abort',abortReader);lifetime.abort();
    if(reader)output.disposal=await dispose(reader);
    bitmap?.close();canvas.width=0;canvas.height=0;
  }
  return output;
}

start.addEventListener('click',async()=>{
  if(active)return;const controller=new AbortController();active=controller;
  const signal=AbortSignal.any([page.signal,controller.signal,AbortSignal.timeout(LIMITS.runMs)]);
  const ownsRun=()=>active===controller&&!page.signal.aborted;
  const say=(message:string)=>{if(ownsRun())status.textContent=message;};
  start.disabled=true;stop.disabled=false;download.disabled=true;result.textContent='';table.replaceChildren();
  if(downloadUrl){URL.revokeObjectURL(downloadUrl);downloadUrl=undefined;}
  const startedAt=new Date().toISOString(),rows:Record<string,unknown>[]=[];
  let input:CardCropProofData|undefined,inputFile:unknown=null,sourceStart:SourceSnapshot|null=null,sourceEnd:SourceSnapshot|null=null;
  let error:string|null=null,completed=false;
  try{
    say('고정 로컬 입력과 실행 소스 확인 중');sourceStart=await snapshot(signal);
    const loaded=await boundedText(route.manifestPath,signal,LIMITS.fileBytes);
    inputFile={path:route.manifestPath,expectedSha256:route.expectedManifestSha256,sha256:loaded.sha256,bytes:loaded.bytes};
    input=parseSelectedCardCropProof(route,loaded.text,loaded.sha256);
    await runCardCropProofSequence({inputs:input.inputs,modes:MODES,signal,
      run:(item,mode)=>runMode(item,mode,signal,say),
      onRow:(item,mode,row)=>{rows.push(row);if(ownsRun())appendRow(item.key,mode.id,row);}});
  }catch(failure){error=errorText(failure);}
  finally{
    try{sourceEnd=await snapshot(page.signal);}catch{/* Missing source evidence remains explicit. */}
    const sourceChanged=sourceStart&&sourceEnd?sourceStart.sourceDigest!==sourceEnd.sourceDigest:null;
    completed=cardCropProofCompleted({rows,expectedRows:(input?.inputs.length??0)*MODES.length,
      sourceChanged,cancelled:signal.aborted,error});
    const report={version:1,kind:'full-card-crop-recognizer-comparison',completed,cancelled:signal.aborted,error,
      startedAt,finishedAt:new Date().toISOString(),sourceStart,sourceEnd,sourceChanged,inputFile,
      inputSourceDigest:input?.sourceDigest??null,runReferences:input?.runReferences??[],
      settings:{comparison:route.comparison,modes:MODES.map(mode=>mode.id),modeOptions:MODES,
        nameConfiguration:route.nameConfiguration,manifestSchema:'existing strict v1; no adaptation',
        order:'input order, then explicitly listed modes',freshRecognizer:'per input and mode; no cross-mode or cross-input recognizer cache',
        budgetMsPerCard:LIMITS.cardMs,sharedCardBudget:'identify + awakening/count + conditional count corroboration',
        preparation:'createRecognizer awaits Korean/digit neural model sessions before card timer. Lazy Tesseract fallback initialization and first inference remain inside the card budget; no test-crop warmup.',
        api:'createRecognizer with explicit resample options; identify(full=true, recorded capture flags, shared budget, modeOptions.portraitRefinement, modeOptions.grayNameFallback); read(actual identity ID or undefined)',
        candidatePolicy:'Diagnostic annotation only; never used as a recognizer argument, identity truth, expected result or catalog filter.',
        temporalEvidence:'One input crop, repeatedCount=false. Modes, cached results and alternate registration are not independent observations or votes. Unknown stable/structural metadata uses conservative false, explicitly reported.',
        modelConfiguration:{name:'korean_PP-OCRv5_mobile_rec_onnx',nameAsset:'ocr/korean-v5-92f0b778.onnx',digits:'PP-OCRv6_tiny_rec_onnx',digitsAsset:'ocr/digits-v6-9ef676d6.onnx',
          engine:'production onnxruntime-web/wasm',executionProviders:['wasm'],wasmThreads:1,wasmProxy:false,graphOptimizationLevel:'all',
          catalog:'production scanner/cards.json, unfiltered',fallback:'production Tesseract kor/eng when reached',integrity:'Source preparation pins are covered by source snapshot; this report does not independently reread model binaries.'},
        limits:LIMITS,lateDecode:'Native PNG decode is not cancellable; late bitmap is closed on arrival.'},rows,
      scope:'Verified 140×210 crop replay through the actual full recognizer. Reader fields for a null identity are unbound diagnostics. Raw reader values and production zero-absence normalization are separate. No human truth, acquisition/scheduler replay, inventory merge, live throughput, OS sharing or UI latency proof.'};
    if(ownsRun()){
      const encoded=JSON.stringify(report,null,2),bytes=new TextEncoder().encode(encoded).byteLength;
      if(bytes<=LIMITS.resultBytes){
        result.textContent=encoded;downloadUrl=URL.createObjectURL(new Blob([encoded],{type:'application/json'}));download.disabled=false;
      }else{completed=false;result.textContent=JSON.stringify({completed:false,error:'Result exceeded its fixed byte bound.'});}
      status.textContent=completed?`카드 비교 완료 · ${rows.length}개 모드 결과 · 실행 전후 소스 일치`:
        `부분 결과 · ${signal.aborted?'중지 또는 전체 실행 기한 초과':error??'일부 판독·소스·정리 확인 실패'}`;
      active=undefined;start.disabled=false;stop.disabled=true;
    }
  }
});
stop.addEventListener('click',()=>active?.abort());
download.addEventListener('click',()=>{if(!downloadUrl)return;const anchor=document.createElement('a');anchor.href=downloadUrl;anchor.download='card-crop-proof.json';anchor.click();});
window.addEventListener('pagehide',()=>{page.abort();active?.abort();if(downloadUrl)URL.revokeObjectURL(downloadUrl);});
if(import.meta.hot){const invalidate=()=>active?.abort();import.meta.hot.on('vite:beforeUpdate',invalidate);
  import.meta.hot.dispose(()=>{page.abort();active?.abort();if(downloadUrl)URL.revokeObjectURL(downloadUrl);import.meta.hot?.off('vite:beforeUpdate',invalidate);});}
