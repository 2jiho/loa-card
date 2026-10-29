import {createNeuralReader} from '../src/features/card-scanner/neural-reader';
import {CardReadBudget} from '../src/features/card-scanner/card-read-budget';
import {NAME_LABEL_PROOF_LIMITS,assertNameLabelPngHeader,decodeNameLabelBitmap} from './name-label-proof-core';
import type {NameLabelProofData} from './name-label-proof-core';
import {parseNameLabelProofRoute,parseSelectedNameLabels,nameLabelProofVariant,type NameLabelProofRoute} from './name-label-proof-routing';
import type {SourceSnapshot} from './source-snapshot';
const start=document.querySelector<HTMLButtonElement>('#run')!,stop=document.querySelector<HTMLButtonElement>('#stop')!;
const save=document.querySelector<HTMLButtonElement>('#save')!;
const status=document.querySelector<HTMLElement>('#status')!,result=document.querySelector<HTMLElement>('#result')!;
const page=new AbortController();let active:AbortController|undefined,reportBlob:Blob|undefined;
const hash=async(data:Uint8Array<ArrayBuffer>|Uint8ClampedArray<ArrayBuffer>)=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',data)),v=>v.toString(16).padStart(2,'0')).join('');
async function boundedText(url:string,signal:AbortSignal,limit:number){
  const response=await fetch(url,{cache:'no-store',signal,redirect:'error'});
  if(!response.ok||!response.body)throw Error(`Local input unavailable: ${response.status}`);
  if(Number(response.headers.get('content-length'))>limit)throw Error('Local input exceeds its byte limit.');
  const reader=response.body.getReader(),chunks:Uint8Array[]=[];let bytes=0;
  try{for(;;){const {done,value}=await reader.read();if(done)break;bytes+=value.byteLength;if(bytes>limit)throw Error('Local input exceeds its byte limit.');chunks.push(value);}}
  catch(error){await reader.cancel().catch(()=>{});throw error;}finally{reader.releaseLock();}
  const joined=new Uint8Array(bytes);let offset=0;for(const chunk of chunks){joined.set(chunk,offset);offset+=chunk.length;}
  return {text:new TextDecoder('utf-8',{fatal:true}).decode(joined),sha256:await hash(joined),bytes};
}
async function snapshot(signal:AbortSignal):Promise<SourceSnapshot>{
  const loaded=await boundedText('/__corpus/environment',AbortSignal.any([signal,AbortSignal.timeout(10000)]),256*1024);
  const value=JSON.parse(loaded.text) as SourceSnapshot;
  if(!/^[a-f0-9]{64}$/.test(value.sourceDigest))throw Error('Source snapshot has no valid digest.');return value;
}
start.addEventListener('click',async()=>{
  if(active)return;
  const controller=new AbortController();active=controller;const signal=AbortSignal.any([page.signal,controller.signal,AbortSignal.timeout(NAME_LABEL_PROOF_LIMITS.runMs)]);
  start.disabled=true;stop.disabled=false;save.disabled=true;reportBlob=undefined;result.textContent='';
  const rows:unknown[]=[];let input:NameLabelProofData|undefined,inputFile:unknown=null;
  let route:NameLabelProofRoute|undefined;
  let sourceStart:SourceSnapshot|null=null,sourceEnd:SourceSnapshot|null=null,reader:ReturnType<typeof createNeuralReader>|undefined;
  let preparationMs:number|null=null,error:string|null=null,completed=false;
  const startedAt=new Date().toISOString();
  const ownsRun=()=>active===controller&&!page.signal.aborted;
  const say=(text:string)=>{if(ownsRun())status.textContent=text;};
  try{
    route=parseNameLabelProofRoute(location.search);
    say('로컬 입력과 소스를 확인하고 있습니다.');sourceStart=await snapshot(signal);
    const loaded=await boundedText(route.manifestPath,AbortSignal.any([signal,AbortSignal.timeout(10000)]),NAME_LABEL_PROOF_LIMITS.fileBytes);
    inputFile={path:route.manifestPath,sha256:loaded.sha256,bytes:loaded.bytes};input=parseSelectedNameLabels(route,loaded.text,loaded.sha256);signal.throwIfAborted();
    reader=createNeuralReader('korean',undefined,say);
    const preparing=performance.now(),dispose=()=>reader?.dispose();signal.addEventListener('abort',dispose,{once:true});
    try{await reader.ready();}finally{signal.removeEventListener('abort',dispose);}
    signal.throwIfAborted();preparationMs=performance.now()-preparing;
    for(const item of input.inputs){
      signal.throwIfAborted();say(`${rows.length+1} / ${input.inputs.length} 이름 영역 검증 중`);
      const {image,...identity}=item;
      const binary=atob(image.slice(22)),png=new Uint8Array(binary.length);for(let i=0;i<binary.length;i++)png[i]=binary.charCodeAt(i);
      assertNameLabelPngHeader(png);
      if(await hash(png)!==item.pngSha256)throw Error(`PNG hash mismatch: ${item.key}`);
      let bitmap:ImageBitmap|undefined;const canvas=document.createElement('canvas');canvas.width=128;canvas.height=36;
      const variants:unknown[]=[],row={...identity,decodedRgbaVerified:false,variants};rows.push(row);
      try{
        bitmap=await decodeNameLabelBitmap(new Blob([png],{type:'image/png'}),signal);signal.throwIfAborted();
        if(bitmap.width!==128||bitmap.height!==36)throw Error(`PNG dimensions mismatch: ${item.key}`);
        const context=canvas.getContext('2d',{willReadFrequently:true,colorSpace:'srgb'})!;
        context.globalCompositeOperation='copy';context.drawImage(bitmap,0,0);bitmap.close();bitmap=undefined;
        const rgba=context.getImageData(0,0,128,36).data;
        if(await hash(rgba)!==item.rgbaSha256)throw Error(`Decoded RGBA hash mismatch: ${item.key}`);
        row.decodedRgbaVerified=true;
        for(const variant of route.variants){
          signal.throwIfAborted();say(`${item.key} · ${variant} 판독 중`);
          const variantStarted=performance.now(),pixels=nameLabelProofVariant(rgba,variant),preprocessMs=performance.now()-variantStarted;
          const hashPaintStarted=performance.now(),variantSha256=await hash(pixels.data);
          const target=document.createElement('canvas');target.width=pixels.width;target.height=pixels.height;
          try{
            const targetContext=target.getContext('2d',{willReadFrequently:true,colorSpace:'srgb'})!;
            targetContext.putImageData(new ImageData(pixels.data,pixels.width,pixels.height),0,0);
            if(await hash(targetContext.getImageData(0,0,target.width,target.height).data)!==variantSha256)throw Error(`Variant paint changed pixels: ${item.key}/${variant}`);
            const hashPaintMs=performance.now()-hashPaintStarted;
            const started=performance.now(),budget=new CardReadBudget(3000);
            const dispose=()=>reader?.dispose();signal.addEventListener('abort',dispose,{once:true});
            try{
              const reading=await reader.recognize(target,false,undefined,budget);signal.throwIfAborted();
              if(!reading||typeof reading.text!=='string'||reading.text.length>1024||!Number.isFinite(reading.confidence)||reading.confidence<0||reading.confidence>1||reading.joined!==undefined||reading.candidates!==undefined)throw Error('Unexpected greedy OCR response.');
              variants.push({variant,recipe:pixels.recipe,width:pixels.width,height:pixels.height,inputRgbaSha256:variantSha256,
                preprocessMs,hashPaintMs,ocrAwaitMs:performance.now()-started,totalVariantMs:performance.now()-variantStarted,
                elapsedMs:performance.now()-started,budgetRemainingMs:budget.remaining(),reading});
            }catch(failure){variants.push({variant,inputRgbaSha256:variantSha256,error:String(failure).slice(0,1000),elapsedMs:performance.now()-started});throw failure;}
            finally{signal.removeEventListener('abort',dispose);}
          }finally{target.width=0;target.height=0;}
        }
      }finally{bitmap?.close();canvas.width=0;canvas.height=0;}
    }
    completed=true;
  }catch(failure){error=String(failure).slice(0,2000);}
  finally{
    reader?.dispose();
    try{sourceEnd=await snapshot(page.signal);}catch{/* Unverified source remains explicit. */}
    const sourceChanged=sourceStart&&sourceEnd?sourceStart.sourceDigest!==sourceEnd.sourceDigest:null;
    if(sourceChanged!==false||signal.aborted)completed=false;
    const report={version:1,kind:'isolated-name-label-greedy-proof',completed,cancelled:signal.aborted,error,startedAt,finishedAt:new Date().toISOString(),
      sourceStart,sourceEnd,sourceChanged,inputFile,inputSourceDigest:input?.sourceDigest??null,runReferences:input?.runReferences??[],preparationMs,
      settings:{model:'korean',useLexicon:false,nameLine:null,sequence:route?.family==='legacy'?'input order then six variants':'input order then fixed first-line family',
        recipeFamily:route?.family??null,variants:route?.variants??[],budgetMsPerVariant:3000,runDeadlineMs:NAME_LABEL_PROOF_LIMITS.runMs,
        decodeDeadlineMs:NAME_LABEL_PROOF_LIMITS.decodeMs,lateDecode:'closed on arrival; native decoding itself is not cancellable'},rows,
      scope:'Isolated greedy OCR of a verified initial Canvas label. Each variant has an independent 3-second budget. Not the complete card pipeline, human truth, model-tensor bytes, live throughput or UI-latency proof.'};
    if(ownsRun()){
      const encoded=JSON.stringify(report,null,2);
      result.textContent=new TextEncoder().encode(encoded).byteLength<=NAME_LABEL_PROOF_LIMITS.resultBytes?encoded:JSON.stringify({completed:false,error:'Result exceeded its bound.'});
      reportBlob=new Blob([result.textContent],{type:'application/json'});save.disabled=false;
      status.textContent=completed?`비교 완료 · ${rows.length}개 이름 영역 · 소스 일치`:`부분 결과 · ${signal.aborted?'중지됨':error??'소스 확인 실패'}`;
      active=undefined;start.disabled=false;stop.disabled=true;
    }
  }
});
stop.addEventListener('click',()=>active?.abort());
save.addEventListener('click',()=>{if(!reportBlob||active)return;const url=URL.createObjectURL(reportBlob),link=document.createElement('a');
  link.href=url;link.download='loacard-name-label-proof.json';link.click();setTimeout(()=>URL.revokeObjectURL(url),0);});
window.addEventListener('pagehide',()=>{page.abort();active?.abort();});
if(import.meta.hot){const invalidate=()=>active?.abort();import.meta.hot.on('vite:beforeUpdate',invalidate);import.meta.hot.dispose(()=>{page.abort();active?.abort();import.meta.hot?.off('vite:beforeUpdate',invalidate);});}
