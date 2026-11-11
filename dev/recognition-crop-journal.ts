import type {RecognitionInputMeta,RecognitionInputObserver,RecognitionInputOutcome,RecognitionInspection} from '../src/features/card-scanner/recognition/recognition-input-observer';
import {parseScannerNameConfiguration} from '../src/features/card-scanner/session/scanner-name-configuration';

/** This journal is a development observer, not a full frame or acquisition log. */
export type CropEvent =
 | {seq:number;kind:'begin';readId:number;meta:RecognitionInputMeta}
 | {seq:number;kind:'crop';readId:number;width:number;height:number;sha256:string;shared:boolean}
 | {seq:number;kind:'finish';readId:number;outcome:{admitted:boolean;identifyExecuted:boolean;timedOut:boolean;error:string|null;status:string;
     identified:{id:string;name:string}|null;acceptedIdentity:{id:string;name:string}|null}};
export interface CropJournalSeed {version:1|2;captureBoundary?:'recognition-input-v2';sessionId:string|null;build:string;catalog:string;nameConfiguration:unknown;
  modelSignature:string|null;recognitionOptions:{fractionalPortrait:boolean;grayNameFallback:boolean}}
export type CropBatchItem =
 | {kind:'event';event:Exclude<CropEvent,{kind:'crop'}>}
 | {kind:'pixels';seq:number;readId:number;width:number;height:number;sha256:string;pixels:Uint8Array;
     /** Validated restore-only event; preserves original JSON property order. */
     originalEvent?:Extract<CropEvent,{kind:'crop'}>};
export interface CropJournalSink {
  begin(seed:CropJournalSeed):Promise<void>;
  get(key:string):Promise<Uint8Array|undefined>;
  put(key:string,pixels:Uint8Array):Promise<void>;
  append(event:CropEvent):Promise<void>;
  /** Optional atomic batch: on rejection neither events nor pixels commit. */
  appendBatch?(items:readonly CropBatchItem[]):Promise<CropEvent[]>;
  seal(checkpoint:CropCheckpoint):Promise<void>;
}
export interface CropCheckpoint {version:1;complete:boolean;reason:string|null;events:number;chain:string;
  attempts:number;captured:number;unique:number;shared:number;lost:number;nominalBytes:number;storedBytes:number;
  peakPendingBytes:number;copyMs:number;hashMs:number;storageMs:number;maxPendingBytes:number;maxPendingEvents:number;
  batches?:number;peakPendingEvents?:number;peakBatchBytes?:number;peakBatchEvents?:number;
  skipped?:number;scope:'recognition-crops-only'}
const MAX_CROP_BYTES=4*1024*1024,MAX_PENDING_BYTES=16*1024*1024,MAX_EVENTS=50_000,MAX_PENDING_EVENTS=512;
const encoder=new TextEncoder(),ZERO='0'.repeat(64);
const identifier=(v:unknown):v is string=>typeof v==='string'&&v.length>0&&v.length<=160;
const natural=(v:unknown):v is number=>Number.isSafeInteger(v)&&(v as number)>=0;
const finite=(v:unknown):v is number=>typeof v==='number'&&Number.isFinite(v)&&v>=0;
export async function cropJournalHash(bytes:Uint8Array):Promise<string>{
  const value=await crypto.subtle.digest('SHA-256',Uint8Array.from(bytes));
  return [...new Uint8Array(value)].map(n=>n.toString(16).padStart(2,'0')).join('');
}
export async function cropJournalChain(previous:string,event:CropEvent):Promise<string>{
  return cropJournalHash(encoder.encode(previous+'\n'+JSON.stringify(event)));
}
function copyMeta(meta:RecognitionInputMeta):RecognitionInputMeta {
 const s=meta?.source,b=meta?.sourceBox;
 if(!natural(meta?.diagnosticReadId)||meta.diagnosticReadId<1||!natural(meta.processingFrame)||meta.processingFrame<1||
   !natural(meta.slot)||meta.slot>=40||!natural(meta.group)||!natural(meta.trace)||typeof meta.pixelKey!=='string'||meta.pixelKey.length>4096||
   !['visual','short','full'].includes(meta.stage)||typeof meta.stable!=='boolean'||!finite(meta.borderAlignment)||meta.borderAlignment>1||
   !natural(meta.sourceWidth)||meta.sourceWidth<1||!natural(meta.sourceHeight)||meta.sourceHeight<1||
   !natural(meta.cropWidth)||!natural(meta.cropHeight)||meta.cropWidth<1||meta.cropHeight<1||meta.cropWidth*meta.cropHeight*4>MAX_CROP_BYTES||
   !b||!finite(b.x)||!finite(b.y)||!finite(b.width)||!finite(b.height)||b.width<=0||b.height<=0||
   b.x+b.width>meta.sourceWidth||b.y+b.height>meta.sourceHeight||!s||!identifier(s.sessionId)||!identifier(s.observationId)||
   !natural(s.frameId)||!natural(s.captureOrder)||!finite(s.captureTime)||!['input','recovery'].includes(s.phase)||s.slot!==meta.slot)
   throw Error('Invalid crop observation metadata');
 return {diagnosticReadId:meta.diagnosticReadId,processingFrame:meta.processingFrame,slot:meta.slot,group:meta.group,trace:meta.trace,
   pixelKey:meta.pixelKey,stage:meta.stage,stable:meta.stable,borderAlignment:meta.borderAlignment,
   source:{sessionId:s.sessionId,frameId:s.frameId,observationId:s.observationId,captureOrder:s.captureOrder,captureTime:s.captureTime,phase:s.phase,slot:s.slot},
   sourceBox:{x:b.x,y:b.y,width:b.width,height:b.height},sourceWidth:meta.sourceWidth,sourceHeight:meta.sourceHeight,cropWidth:meta.cropWidth,cropHeight:meta.cropHeight};
}
function seedCopy(seed:CropJournalSeed):CropJournalSeed {
 if(!seed||![1,2].includes(seed.version)||seed.version===1&&seed.captureBoundary!==undefined||seed.version===2&&seed.captureBoundary!=='recognition-input-v2'||!(seed.sessionId===null||identifier(seed.sessionId))||!identifier(seed.build)||!identifier(seed.catalog)||
   !(seed.modelSignature===null||identifier(seed.modelSignature))||!seed.recognitionOptions||
   typeof seed.recognitionOptions.fractionalPortrait!=='boolean'||typeof seed.recognitionOptions.grayNameFallback!=='boolean')throw Error('Invalid crop journal seed');
 return {version:seed.version,...(seed.version===2?{captureBoundary:'recognition-input-v2' as const}:{}),sessionId:seed.sessionId,build:seed.build,catalog:seed.catalog,nameConfiguration:parseScannerNameConfiguration(seed.nameConfiguration),
   modelSignature:seed.modelSignature,recognitionOptions:{...seed.recognitionOptions}};
}

/** The sink serializes persistent writes; callbacks only copy bounded RGBA and
 * never await them. Once a limit/write fails no later event can fill the gap. */
export function createRecognitionCropJournal(seedValue:CropJournalSeed,sink:CropJournalSink,options:{maxPendingBytes?:number;maxPendingEvents?:number;now?:()=>number}={}) {
 const seed=seedCopy(seedValue),now=options.now??(()=>performance.now());
 const maxPendingBytes=options.maxPendingBytes??MAX_PENDING_BYTES,maxPendingEvents=options.maxPendingEvents??MAX_PENDING_EVENTS;
 if(!natural(maxPendingBytes)||maxPendingBytes<1||maxPendingBytes>MAX_PENDING_BYTES||
   !natural(maxPendingEvents)||maxPendingEvents<1||maxPendingEvents>MAX_PENDING_EVENTS)throw Error('Invalid crop journal limits');
 let chain=ZERO,seq=0,persisted=0,attempts=0,captured=0,skipped=0,unique=0,shared=0,lost=0,nominalBytes=0,storedBytes=0;
 let pendingBytes=0,pendingEvents=0,peakPendingBytes=0,copyMs=0,hashMs=0,storageMs=0,closed=false,halted=false,reason:string|null=null;
 let batches=0,peakPendingEvents=0,peakBatchBytes=0,peakBatchEvents=0;
 let tail:Promise<void>=Promise.resolve().then(async()=>{
  chain=await cropJournalHash(encoder.encode(JSON.stringify(seed)));await sink.begin(seed);
 }).catch(error=>{halted=true;reason=String(error);});
 const active=new Set<number>();let lastRead=0,boundSession=seed.sessionId;
 const reject=(why:string)=>{lost++;reason??=why.slice(0,1000);};
 type Job={seq:number;bytes:number;event?:Exclude<CropEvent,{kind:'crop'}>;pixels?:Uint8Array;readId?:number;width?:number;height?:number};
 const queue:Job[]=[];let scheduled=false;
 async function fallback(items:CropBatchItem[]):Promise<CropEvent[]>{
  const result:CropEvent[]=[];
  for(const item of items){
   if(item.kind==='event'){await sink.append(item.event);result.push(item.event);continue;}
   const key=`${item.width}x${item.height}:${item.sha256}`,prior=await sink.get(key);
   if(prior){if(prior.length!==item.pixels.length||prior.some((value,index)=>value!==item.pixels[index]))throw Error('digest collision or stored pixel corruption');}
   else await sink.put(key,item.pixels);
   const event:CropEvent={seq:item.seq,kind:'crop',readId:item.readId,width:item.width,height:item.height,sha256:item.sha256,shared:!!prior};
   await sink.append(event);result.push(event);
  }
  return result;
 }
 async function drain(){
  while(queue.length){
   const jobs:Job[]=[];let batchBytes=0;
   while(queue.length&&jobs.length<(sink.appendBatch?32:1)&&(jobs.length===0||batchBytes+queue[0].bytes<=4*1024*1024)){
    const job=queue.shift()!;jobs.push(job);batchBytes+=job.bytes;
   }
   peakBatchBytes=Math.max(peakBatchBytes,batchBytes);peakBatchEvents=Math.max(peakBatchEvents,jobs.length);
   try{
    if(halted){lost+=jobs.length;continue;}
    const prepared=await Promise.all(jobs.map(async(job):Promise<CropBatchItem>=>{
     if(job.event)return {kind:'event',event:job.event};
     const start=now(),sha256=await cropJournalHash(job.pixels!);hashMs+=Math.max(0,now()-start);
     return {kind:'pixels',seq:job.seq,readId:job.readId!,width:job.width!,height:job.height!,sha256,pixels:job.pixels!};
    }));
    const write=now(),events=await (sink.appendBatch?sink.appendBatch(prepared):fallback(prepared));storageMs+=Math.max(0,now()-write);batches++;
    if(events.length!==jobs.length)throw Error('Crop batch result count mismatch');
    for(let i=0;i<events.length;i++){
     const event=events[i],item=prepared[i];
     if(event.seq!==jobs[i].seq||item.kind==='event'&&JSON.stringify(event)!==JSON.stringify(item.event)||
       item.kind==='pixels'&&(event.kind!=='crop'||event.readId!==item.readId||event.width!==item.width||event.height!==item.height||event.sha256!==item.sha256||typeof event.shared!=='boolean'))
       throw Error('Crop batch result mismatch');
     const start=now();chain=await cropJournalChain(chain,event);hashMs+=Math.max(0,now()-start);persisted++;
     if(item.kind==='pixels'&&event.kind==='crop'){captured++;if(event.shared)shared++;else{unique++;storedBytes+=item.pixels.byteLength;}}
    }
   }catch(error){halted=true;reject(String(error));lost+=Math.max(0,jobs.length-1);}
   finally{pendingBytes-=batchBytes;pendingEvents-=jobs.length;}
  }
  scheduled=false;
 }
 function enqueue(job:Omit<Job,'seq'>):boolean {
  if(closed||reason){reject('recording unavailable');return false;}
  if(pendingEvents>=maxPendingEvents){reject('crop event queue limit exceeded');return false;}
  if(pendingBytes+job.bytes>maxPendingBytes){reject('crop pixel queue limit exceeded');return false;}
  if(seq>=MAX_EVENTS){reject('crop event count limit exceeded');return false;}
  const id=++seq;queue.push({...job,seq:id,...(job.event?{event:{...job.event,seq:id}}:{})});
  pendingEvents++;pendingBytes+=job.bytes;peakPendingBytes=Math.max(peakPendingBytes,pendingBytes);
  peakPendingEvents=Math.max(peakPendingEvents,pendingEvents);
  if(!scheduled){scheduled=true;tail=tail.then(drain);}
  return true;
 }
 const observer:RecognitionInputObserver={begin(input){
  attempts++;
  let meta:RecognitionInputMeta;
  try{meta=copyMeta(input);boundSession??=meta.source.sessionId;if(meta.source.sessionId!==boundSession||meta.diagnosticReadId<=lastRead)throw Error('Crop source or invocation order mismatch');lastRead=meta.diagnosticReadId;}
  catch(error){reject(String(error));return;}
  const readId=meta.diagnosticReadId;if(!enqueue({bytes:0,event:{seq:0,kind:'begin',readId,meta}}))return;
  active.add(readId);let copied=false,finished=false;
  const capture=(canvas:HTMLCanvasElement)=>{
    if(finished||copied||closed){reject('invalid crop capture lifecycle');return;}copied=true;
    const bytes=canvas.width*canvas.height*4;
    if(canvas.width!==meta.cropWidth||canvas.height!==meta.cropHeight||!natural(bytes)||bytes<1||bytes>MAX_CROP_BYTES){reject('crop dimensions differ');return;}
    nominalBytes+=bytes;
    if(reason){reject('recording unavailable');return;}
    if(pendingEvents>=maxPendingEvents){reject('crop event queue limit exceeded');return;}
    if(pendingBytes+bytes>maxPendingBytes){reject('crop pixel queue limit exceeded');return;}
    let pixels:Uint8Array;
    try{const started=now(),context=canvas.getContext('2d',{willReadFrequently:true});if(!context)throw Error('crop context unavailable');
      pixels=Uint8Array.from(context.getImageData(0,0,canvas.width,canvas.height).data);copyMs+=Math.max(0,now()-started);
      if(pixels.byteLength!==bytes)throw Error('crop pixel size mismatch');}
    catch(error){reject(String(error));return;}
    const width=canvas.width,height=canvas.height;
    enqueue({bytes,pixels,readId,width,height});
   };
  const inspection:RecognitionInspection={
   captureInput(canvas){if(seed.version===2)capture(canvas);},
   captureCard(canvas){if(seed.version===1)capture(canvas);},
   captureLabel(){/* Card pixels are sufficient input; labels are derived data. */},
   finish(value:RecognitionInputOutcome){
    if(finished||closed){reject('invalid crop finish lifecycle');return;}finished=true;active.delete(readId);
    if(!copied){if(seed.version===2&&!value.admitted)skipped++;else reject('missing card crop');}
    const identity=(candidate:{id:string;name:string}|null)=>candidate&&identifier(candidate.id)&&identifier(candidate.name)?{id:candidate.id,name:candidate.name}:null;
    const outcome={admitted:value.admitted===true,identifyExecuted:value.identifyExecuted===true,timedOut:value.timedOut===true,
      error:typeof value.error==='string'?value.error.slice(0,1000):null,status:typeof value.status==='string'?value.status.slice(0,160):'',
      identified:identity(value.identified),acceptedIdentity:identity(value.acceptedIdentity)};
    enqueue({bytes:0,event:{seq:0,kind:'finish',readId,outcome}});
   },
  };return inspection;
 }};
 return {observer,async finish():Promise<CropCheckpoint>{
  if(closed)throw Error('Crop journal already closed');closed=true;await tail;
  if(active.size)reject('unfinished recognition attempts');
  if((captured+skipped!==attempts||attempts===0)&&!reason)reject('one or more attempts lack persisted pixels');
  const checkpoint:CropCheckpoint={version:1,complete:!reason&&active.size===0&&captured+skipped===attempts,reason,events:persisted,chain,attempts,captured,...(seed.version===2?{skipped}:{}),unique,shared,lost,
    nominalBytes,storedBytes,peakPendingBytes,copyMs,hashMs,storageMs,maxPendingBytes,maxPendingEvents,batches,
    peakPendingEvents,peakBatchBytes,peakBatchEvents,scope:'recognition-crops-only'};
  try{await sink.seal(checkpoint);}catch(error){return {...checkpoint,complete:false,reason:String(error).slice(0,1000),lost:checkpoint.lost+1};}
  return checkpoint;
 }};
}

/** Replays only retained recognition RGBA; it cannot reconstruct acquisition,
 * loss before the observer, execution timing, or independent observations. */
export async function replayRecognitionCropJournal(seedValue:CropJournalSeed,events:readonly CropEvent[],checkpoint:CropCheckpoint|null,
  read:(key:string)=>Promise<Uint8Array|undefined>,onCrop:(event:Extract<CropEvent,{kind:'crop'}>,meta:RecognitionInputMeta,pixels:Uint8Array,scope:{complete:boolean})=>void|Promise<void>,
  signal:AbortSignal):Promise<{complete:boolean;events:number;crops:number;unique:number;shared:number;chain:string}> {
 const seed=seedCopy(seedValue);
 if(!Array.isArray(events)||events.length>MAX_EVENTS)throw Error('Invalid crop event count');
 let chain=await cropJournalHash(encoder.encode(JSON.stringify(seed))),seq=0,crops=0,unique=0,shared=0,lastRead=0,boundSession=seed.sessionId;
 let nominalBytes=0,storedBytes=0,skipped=0,finished=0;
 const active=new Map<number,{meta:RecognitionInputMeta;crop:boolean}>(),seen=new Set<string>();
 const planned:{event:Extract<CropEvent,{kind:'crop'}>;meta:RecognitionInputMeta}[]=[];
 for(const event of events){
  signal.throwIfAborted();
  if(!event||!natural(event.seq)||event.seq!==++seq||!natural(event.readId)||event.readId<1)throw Error('Invalid crop event sequence');
  const names=Object.keys(event).sort().join(',');
  if(event.kind==='begin'){
   if(names!=='kind,meta,readId,seq'||active.has(event.readId)||event.readId<=lastRead)throw Error('Invalid crop begin');
   const meta=copyMeta(event.meta);
   boundSession??=meta.source.sessionId;
   if(meta.diagnosticReadId!==event.readId||meta.source.sessionId!==boundSession)throw Error('Crop source mismatch');
   lastRead=event.readId;active.set(event.readId,{meta,crop:false});
  }else if(event.kind==='crop'){
   if(names!=='height,kind,readId,seq,sha256,shared,width'||!natural(event.width)||!natural(event.height)||
     event.width<1||event.height<1||event.width*event.height*4>MAX_CROP_BYTES||
     typeof event.sha256!=='string'||!/^[a-f0-9]{64}$/.test(event.sha256)||typeof event.shared!=='boolean')throw Error('Invalid crop payload');
   const entry=active.get(event.readId);if(!entry||entry.crop||entry.meta.cropWidth!==event.width||entry.meta.cropHeight!==event.height)throw Error('Crop has no matching attempt');
   const key=`${event.width}x${event.height}:${event.sha256}`;
   if(event.shared!==seen.has(key))throw Error('Crop sharing sequence mismatch');
   const stored=await read(key);signal.throwIfAborted();
   if(!(stored instanceof Uint8Array)||stored.byteLength!==event.width*event.height*4||await cropJournalHash(stored)!==event.sha256)
    throw Error('Crop pixel integrity mismatch');
   planned.push({event,meta:entry.meta});
   entry.crop=true;crops++;nominalBytes+=event.width*event.height*4;
   if(event.shared)shared++;else {unique++;storedBytes+=event.width*event.height*4;seen.add(key);}
  }else if(event.kind==='finish'){
   if(names!=='kind,outcome,readId,seq'||!event.outcome||typeof event.outcome!=='object'||
     Object.keys(event.outcome).sort().join(',')!=='acceptedIdentity,admitted,error,identified,identifyExecuted,status,timedOut'||
     typeof event.outcome.admitted!=='boolean'||typeof event.outcome.identifyExecuted!=='boolean'||typeof event.outcome.timedOut!=='boolean'||
     !(event.outcome.error===null||typeof event.outcome.error==='string'&&event.outcome.error.length<=1000)||
     typeof event.outcome.status!=='string'||event.outcome.status.length>160||
     ![event.outcome.identified,event.outcome.acceptedIdentity].every(value=>value===null||
       !!value&&Object.keys(value).sort().join(',')==='id,name'&&identifier(value.id)&&identifier(value.name)))throw Error('Invalid crop outcome');
   const entry=active.get(event.readId);if(!entry||!entry.crop&&(seed.version!==2||event.outcome.admitted))throw Error('Finish without retained crop');
   if(!entry.crop)skipped++;finished++;active.delete(event.readId);
  }else throw Error('Unknown crop event');
  chain=await cropJournalChain(chain,event);
 }
 if(checkpoint){
  if(checkpoint.version!==1||checkpoint.scope!=='recognition-crops-only'||typeof checkpoint.complete!=='boolean'||
    !natural(checkpoint.events)||typeof checkpoint.chain!=='string'||!/^[a-f0-9]{64}$/.test(checkpoint.chain)||
    checkpoint.events!==seq||checkpoint.chain!==chain)throw Error('Crop checkpoint mismatch');
  if(checkpoint.complete&&(active.size||checkpoint.captured!==crops||checkpoint.attempts!==finished||finished!==crops+skipped||seed.version===2&&checkpoint.skipped!==skipped||seed.version===1&&checkpoint.skipped!==undefined||
    checkpoint.unique!==unique||checkpoint.shared!==shared||checkpoint.nominalBytes!==nominalBytes||checkpoint.storedBytes!==storedBytes||
    checkpoint.lost!==0||checkpoint.reason!==null))throw Error('Incomplete crop checkpoint');
 }
 const complete=!!checkpoint?.complete&&active.size===0;
 for(const {event,meta} of planned){
  signal.throwIfAborted();const pixels=await read(`${event.width}x${event.height}:${event.sha256}`);
  if(!(pixels instanceof Uint8Array)||pixels.byteLength!==event.width*event.height*4||await cropJournalHash(pixels)!==event.sha256)
   throw Error('Crop pixel integrity mismatch');
  await onCrop(event,meta,pixels.slice(),{complete});
 }
 return {complete,events:seq,crops,unique,shared,chain};
}
