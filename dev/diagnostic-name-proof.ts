import {createRecognizer} from '../src/features/card-scanner/recognition/recognizer';
import {CardReadBudget,CardReadTimeout} from '../src/features/card-scanner/recognition/card-read-budget';
import {countReliability} from '../src/features/card-scanner/recognition/count-confidence';
import {decodeCardCropBitmap,sha256CardCropBytes} from './card-crop-proof-core';

// A retained diagnostic is partial input. It is not a source-frame replay.
// File names are hashes, not arbitrary paths; no missing capture facts are invented.
const id=new URLSearchParams(location.search).get('id');
if(!id||!/^[a-f0-9]{64}$/.test(id))throw Error('A diagnostic SHA-256 is required.');
const assumeStructural=new URLSearchParams(location.search).get('structural')==='1';
const full=new URLSearchParams(location.search).get('full')==='1';
const comparePolicies=new URLSearchParams(location.search).get('policies')==='abba';
const indicesParam=new URLSearchParams(location.search).get('indices');
if(indicesParam!==null&&!/^\d+(,\d+)*$/.test(indicesParam))throw Error('Invalid diagnostic image indices');
const indices=indicesParam===null?null:new Set(indicesParam.split(',').map(Number));
const run=document.querySelector<HTMLButtonElement>('#run')!;
const download=document.querySelector<HTMLButtonElement>('#download')!;
const status=document.querySelector<HTMLElement>('#status')!;
const result=document.querySelector<HTMLElement>('#result')!;
let url:string|undefined;
type Diagnostic={images:{image:string;source?:string;time:number|null}[];unidentifiedObservations:{recognitionImageIndex?:number|null;source:unknown;time:number|null;group:number|null}[];nameConfiguration?:unknown;inputKind?:string};

async function bounded<T>(promise:Promise<T>,signal:AbortSignal,onLate?:(result:T)=>void):Promise<T> {
 return new Promise((resolve,reject)=>{
  let done=false;const aborted=()=>{if(!done){done=true;reject(signal.reason);}};
  signal.addEventListener('abort',aborted,{once:true});if(signal.aborted)aborted();
  promise.then(value=>{signal.removeEventListener('abort',aborted);if(done){onLate?.(value);return;}done=true;resolve(value);},error=>{signal.removeEventListener('abort',aborted);if(!done){done=true;reject(error);}});
 });
}
async function sourceSnapshot(){
 const response=await fetch('/__corpus/environment',{cache:'no-store',signal:AbortSignal.timeout(10000)});
 if(!response.ok)throw Error('Source snapshot unavailable');return await response.json() as {sourceDigest:string};
}
run.addEventListener('click',async()=>{
 run.disabled=true;download.disabled=true;result.textContent='';const rows:unknown[]=[];let error:string|null=null;
 const start=await sourceSnapshot().catch(()=>null),begin=new Date().toISOString();let expectedRows=0,inputKind='diagnostic-summary';
 try {
  const response=await fetch(`/work/diagnostic-fragment-${id}.json`,{cache:'no-store',signal:AbortSignal.timeout(10000)});
  if(!response.ok)throw Error('Diagnostic unavailable');
  const bytes=new Uint8Array(await response.arrayBuffer());
  if(bytes.length>2*1024*1024||await sha256CardCropBytes(bytes)!==id)throw Error('Diagnostic digest/size mismatch');
  const data=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)) as Diagnostic;
  if(!Array.isArray(data.images)||!Array.isArray(data.unidentifiedObservations))throw Error('Invalid diagnostic');
  if(data.inputKind)inputKind=data.inputKind;
  // Ordered distinct real observations. This is a fixed local sample, not all possible cards.
  const selected=data.unidentifiedObservations.filter(o=>o.recognitionImageIndex!=null&&(!indices||indices.has(o.recognitionImageIndex))).slice(0,comparePolicies?16:6);
  expectedRows=selected.length*(comparePolicies?4:2);
  for(const observation of selected){
   const idx=observation.recognitionImageIndex!,image=data.images[idx];
   if(!image||image.source!=='recognition'||!/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(image.image))throw Error('Recognition PNG unavailable');
   const raw=Uint8Array.from(atob(image.image.slice('data:image/png;base64,'.length)),c=>c.charCodeAt(0));
   const pngSha256=await sha256CardCropBytes(raw);
   const modes=comparePolicies?[
    {contrast:false,policy:'resample' as const},{contrast:false,policy:'continue' as const},
    {contrast:false,policy:'continue' as const},{contrast:false,policy:'resample' as const},
   ]:[{contrast:false,policy:'resample' as const},{contrast:true,policy:'resample' as const}];
   for(const [block,{contrast,policy}] of modes.entries()){
    status.textContent=`관측 ${idx} · ${comparePolicies?`${policy} ${block+1}/4`:contrast?'대비 보완':'기본'} 판독`;
    const controller=new AbortController(),signal=controller.signal;
    const bitmap=await decodeCardCropBitmap(new Blob([raw],{type:'image/png'}),signal);
    if(bitmap.width!==140||bitmap.height!==210){bitmap.close();throw Error('Unexpected recognition dimensions');}
    const canvas=document.createElement('canvas');canvas.width=140;canvas.height=210;
    const context=canvas.getContext('2d',{willReadFrequently:true})!;context.drawImage(bitmap,0,0);bitmap.close();
    const rgbaSha256=await sha256CardCropBytes(context.getImageData(0,0,140,210).data);
    let reader:Awaited<ReturnType<typeof createRecognizer>>|undefined,identity:Awaited<ReturnType<Awaited<ReturnType<typeof createRecognizer>>['identify']>>=null,attempts:unknown=[],portrait:unknown=null,nameMetrics:unknown=null;
    let fields:Awaited<ReturnType<Awaited<ReturnType<typeof createRecognizer>>['read']>>|null=null,count:string|null=null;
    let failure:string|null=null,disposed=false,elapsedMs:number|null=null;
    const setupStart=performance.now();let preparationMs:number|null=null;
    try {
     reader=await bounded(createRecognizer(()=>{},signal,{nameRawResultPolicy:policy,...(contrast?{contrastNameFallback:true}:{})}),
      AbortSignal.timeout(120000),late=>{void late.dispose().catch(()=>{});});
     preparationMs=performance.now()-setupStart;
     const started=performance.now(),budget=new CardReadBudget(3000);
     try {await budget.wait(async()=>{
       identity=await reader!.identify(canvas,true,false,assumeStructural,budget,false,undefined,false);
       if(!full)return;
       fields=await reader!.read(canvas,identity?.id,false,true,budget);
       const reliability=()=>countReliability({stable:false,repeatedCount:false,borderAlignment:0,
        awakening:fields!.awakening,extraCopies:fields!.extraCopies,maxAwakening:identity?.maxAwakening,
        pattern:fields!.countDiagnostics?.pattern,iconPresent:fields!.countDiagnostics?.iconPresent,
        patternOcrAgreed:fields!.countDiagnostics?.patternOcrAgreed,ocrConfirmedValue:fields!.countDiagnostics?.ocrConfirmedValue});
       count=reliability();
       if(identity&&count==='unconfirmed'&&fields.awakening!==null&&fields.countDiagnostics?.pattern?.value!=null&&!identity.review.length){
        fields=await reader!.read(canvas,identity.id,true,true,budget);count=reliability();
       }
      },()=>controller.abort(new CardReadTimeout()));}
     finally{elapsedMs=performance.now()-started;}
    }catch(e){failure=String(e);}
    finally{
     if(reader){attempts=reader.nameDiagnostics(canvas);portrait=reader.portraitDiagnostics(canvas);nameMetrics=reader.namePerformance(canvas)??null;
      try{await bounded(reader.dispose(),AbortSignal.timeout(5000));disposed=true;}catch{/* Partial result remains explicit. */}}
     canvas.width=0;canvas.height=0;controller.abort();
    }
    rows.push({diagnosticIndex:idx,group:observation.group,source:observation.source,captureTime:observation.time,pngSha256,rgbaSha256,
     mode:comparePolicies?policy:contrast?'contrast-opt-in':'baseline',policy,block,captureAssumptions:{stable:false,structural:assumeStructural,actual:'unknown'},
     preparationMs,elapsedMs,identity,fields,count,attempts,portrait,nameMetrics,error:failure,disposed});
    result.textContent=JSON.stringify(rows,null,2);
    if(!disposed)throw Error('Reader disposal failed; subsequent rows not started');
   }
  }
 }catch(e){error=String(e);}
 const end=await sourceSnapshot().catch(()=>null),sourceChanged=start&&end?start.sourceDigest!==end.sourceDigest:null;
 const report={version:1,kind:'partial-diagnostic-name-proof',diagnosticSha256:id,startedAt:begin,finishedAt:new Date().toISOString(),
  sourceStart:start,sourceEnd:end,sourceChanged,inputKind,completed:error===null&&expectedRows>0&&rows.length===expectedRows&&sourceChanged===false,error,rows,
  allReturned:rows.every(row=>typeof row==='object'&&row!==null&&'error' in row&&row.error===null),
  scope:`Single retained PNG per observation; actual capture stability and geometry unknown. Stability set false, structural set ${assumeStructural}, borderAlignment set 0 as explicit experiments. ${full?'Name and field reader share 3000ms; fields are raw, not an inventory acceptance.':'Name identification only.'} ${comparePolicies?'ABBA resample/continue/continue/resample blocks, fresh recognizers; raw model/provider determinism is not presumed and timing is observational.':'Baseline and contrast are compared.'} No ground truth, acquisition replay, field proof, automatic termination or live timing. Separate modes are not independent observations.`};
 const text=JSON.stringify(report,null,2);result.textContent=text;status.textContent=report.completed?'검사 완료':'부분 검사';
 if(url)URL.revokeObjectURL(url);url=URL.createObjectURL(new Blob([text],{type:'application/json'}));download.disabled=false;run.disabled=false;
});
download.addEventListener('click',()=>{if(!url)return;const a=document.createElement('a');a.href=url;a.download='diagnostic-name-proof.json';a.click();});
