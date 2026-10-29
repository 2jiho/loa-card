import type {RecognitionInputObserver,RecognitionInputMeta,RecognitionInputOutcome,RecognitionInspection,RecognitionPixels,NameLabelRecipe} from '../src/features/card-scanner/recognition-input-observer';
import type {PairedCropWorkerResult} from './paired-crop-worker';

export interface PairedCropTarget {processingFrame:number;slot:number}
type CropWorker=Pick<Worker,'postMessage'|'terminate'|'onmessage'|'onerror'|'onmessageerror'>;
export interface PairedCropCollectorOptions {
 maxCaptures?:number;maxRawBytes?:number;maxImageBytes?:number;maxMetadataBytes?:number;maxRows?:number;
 encodeTimeoutMs?:number;finishTimeoutMs?:number;disposeTimeoutMs?:number;
 createWorker?:()=>CropWorker;
 now?:()=>number;
}
export const PAIRED_CROP_LIMITS=Object.freeze({maxCaptures:8,maxRawBytes:2*1024*1024,maxImageBytes:1024*1024,maxMetadataBytes:512*1024,
 maxRows:32,encodeTimeoutMs:2000,finishTimeoutMs:5000,disposeTimeoutMs:250});
type Region='recognition-card'|'initial-name-label';
type ImageStatus='queued'|'encoding'|'encoded'|'omitted-budget'|'error'|'timeout'|'disposed';
interface ImageRecord {
 id:string;region:Region;firstDiagnosticReadId:number;processingFrame:number;slot:number;
 observation:Record<string,unknown>;geometry:unknown;width:number;height:number;
 status:ImageStatus;rgbaSha256:string|null;rasterRgbaSha256:string|null;rgbaMatchesRaster:boolean|null;
 pngSha256:string|null;pngBytes:number|null;imageBytes:number|null;image:string|null;error:string|null;
 scope:string;
}
interface ImageReference {imageId:string|null;shared:boolean;exactRegion:boolean;omitted:string|null}
interface ReadRecord {
 diagnosticReadId:number;meta:Record<string,unknown>;card:ImageReference|null;
 labels:{recipe:Record<string,unknown>;reference:ImageReference}[];labelRecipesOmitted:number;
 outcome:Record<string,unknown>|null;finished:boolean;finishConflicts:number;
}
type RawJob={id:number;record:ImageRecord;pixels?:Uint8ClampedArray<ArrayBuffer>;rawBytes:number;done:boolean;timer?:ReturnType<typeof setTimeout>};
const plain=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value)&&[Object.prototype,null].includes(Object.getPrototypeOf(value));
const natural=(value:unknown):value is number=>typeof value==='number'&&Number.isSafeInteger(value)&&value>=0;
const positive=(value:unknown):value is number=>natural(value)&&value>0;
const finite=(value:unknown):value is number=>typeof value==='number'&&Number.isFinite(value);
const text=(value:unknown,limit=160)=>typeof value==='string'?JSON.parse(JSON.stringify(value.slice(0,limit))) as string:null;
const size=(value:unknown)=>new TextEncoder().encode(JSON.stringify(value)).byteLength;
const hash=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const box=(value:unknown)=>plain(value)&&['x','y','width','height'].every(key=>finite(value[key]))?
 {x:value.x,y:value.y,width:value.width,height:value.height}:null;
const ref=(omitted:string|null=null):ImageReference=>({imageId:null,shared:false,exactRegion:false,omitted});
function metadata(value:RecognitionInputMeta){
 if(!positive(value?.diagnosticReadId)||!positive(value.processingFrame)||!natural(value.slot)||value.slot>=40||!value.source)return null;
 const s=value.source;if(typeof s.sessionId!=='string'||!s.sessionId.length||s.sessionId.length>160||typeof s.observationId!=='string'||!s.observationId.length||s.observationId.length>160||!natural(s.frameId)||!finite(s.captureOrder)||!finite(s.captureTime)||s.captureTime<0||
  s.phase!=='input'&&s.phase!=='recovery'||s.slot!==value.slot||typeof value.pixelKey!=='string'||value.pixelKey.length>4096)return null;
 return {diagnosticReadId:value.diagnosticReadId,processingFrame:value.processingFrame,slot:value.slot,
  source:{sessionId:text(s.sessionId),frameId:s.frameId,observationId:text(s.observationId),captureOrder:s.captureOrder,captureTime:s.captureTime,phase:s.phase,slot:s.slot},
  group:finite(value.group)?value.group:null,trace:finite(value.trace)?value.trace:null,pixelKey:text(value.pixelKey,4096),
  stage:['visual','short','full'].includes(value.stage)?value.stage:null,stable:typeof value.stable==='boolean'?value.stable:null,
  borderAlignment:finite(value.borderAlignment)?value.borderAlignment:null,sourceBox:box(value.sourceBox),
  sourceWidth:positive(value.sourceWidth)?value.sourceWidth:null,sourceHeight:positive(value.sourceHeight)?value.sourceHeight:null,
  cropWidth:positive(value.cropWidth)?value.cropWidth:null,cropHeight:positive(value.cropHeight)?value.cropHeight:null};
}
function recipe(value:NameLabelRecipe){
 if(value?.region!=='initial-name-label'||value.targetWidth!==128||value.targetHeight!==36||!box(value.sourceBox)||!finite(value.offsetY))return null;
 return {region:value.region,sourceBox:box(value.sourceBox),targetWidth:128,targetHeight:36,offsetY:value.offsetY,
  quick:value.quick===true,allowRaw:value.allowRaw===true,bypassCache:value.bypassCache===true};
}
function outcome(value:RecognitionInputOutcome){
 const v=value as unknown as Record<string,unknown>,identified=plain(v.identified)?v.identified:null,accepted=plain(v.acceptedIdentity)?v.acceptedIdentity:null;
 const diagnostics=Array.isArray(v.diagnostics)?v.diagnostics:[];
 return {admitted:v.admitted===true,identifyExecuted:v.identifyExecuted===true,nameMatchCount:natural(v.nameMatchCount)?v.nameMatchCount:null,
  budgetRemainingAtStart:finite(v.budgetRemainingAtStart)?v.budgetRemainingAtStart:null,budgetRemainingAtEnd:finite(v.budgetRemainingAtEnd)?v.budgetRemainingAtEnd:null,
  elapsedMs:finite(v.elapsedMs)?v.elapsedMs:null,timedOut:v.timedOut===true,error:text(v.error,1000),
  identified:identified?{id:text(identified.id),name:text(identified.name),confidence:finite(identified.confidence)?identified.confidence:null,
   review:Array.isArray(identified.review)?identified.review.slice(0,16).map(value=>text(value,200)):null}:null,
  acceptedIdentity:accepted?{id:text(accepted.id),name:text(accepted.name)}:null,status:text(v.status,200),retained:v.retained===true,
  diagnostics:diagnostics.slice(0,24).map(value=>{const a=plain(value)?value:{};return {text:text(a.text,120),confidence:finite(a.confidence)?a.confidence:null,
   engine:text(a.engine,80),variant:text(a.variant,80),reason:text(a.reason,300),
   candidates:Array.isArray(a.candidates)?a.candidates.slice(0,3).map(value=>{const c=plain(value)?value:{};return {id:text(c.id),name:text(c.name),score:finite(c.score)?c.score:null};}):null};}),
  diagnosticsOmitted:Math.max(0,diagnostics.length-24)};
}

/** Copies only selected actual inputs during scanning. SHA/PNG work starts in
 * finish(), after recognition has joined. Shared image references are diagnostic
 * storage reuse, never independent observations or model-tensor evidence. */
export function createPairedCropCollector(targets:readonly PairedCropTarget[],options:PairedCropCollectorOptions={}){
 const limits={...PAIRED_CROP_LIMITS,...Object.fromEntries(Object.entries(options).filter(([key])=>key in PAIRED_CROP_LIMITS))};
 for(const key of Object.keys(PAIRED_CROP_LIMITS) as (keyof typeof PAIRED_CROP_LIMITS)[])
  if(!positive(limits[key])||limits[key]>PAIRED_CROP_LIMITS[key])throw Error('Invalid paired crop collector limits.');
 if(!Array.isArray(targets)||!targets.length||targets.length>4||targets.some(t=>!positive(t.processingFrame)||!natural(t.slot)||t.slot>=40)||
  new Set(targets.map(t=>`${t.processingFrame}/${t.slot}`)).size!==targets.length)throw Error('Invalid paired crop targets.');
 targets=targets.map(target=>({...target}));
 const selected=new Set(targets.map(t=>`${t.processingFrame}/${t.slot}`));
 const rows:ReadRecord[]=[],images:ImageRecord[]=[],rowSizes=new Map<ReadRecord,number>(),imageKeys=new Map<string,{record:ImageRecord;geometry:string}>();
 const jobs=new Map<number,RawJob>(),queue:RawJob[]=[];let active:RawJob|undefined,worker:CropWorker|undefined,nextId=0;
 const now=options.now??(()=>performance.now()),workerFactory=options.createWorker??(()=>new Worker(new URL('./paired-crop-worker.ts',import.meta.url),{type:'module'}));
 const stats={beginCalls:0,selectedReads:0,invalidMeta:0,rowsOmitted:0,metadataUpdatesOmitted:0,captureLimitOmitted:0,rawBudgetOmitted:0,
  sharedImages:0,differentRegionOmitted:0,lateCallsIgnored:0,lateResponsesIgnored:0,snapshotCopyMs:0,peakRawReservedBytes:0,imageBytes:0,
  encodeErrors:0,timeouts:0,workerStarts:0,workerTerminations:0};
 const baseMetaBytes=4096+targets.length*128;if(limits.maxMetadataBytes<baseMetaBytes)throw Error('Paired crop metadata bound is too small for its targets.');
 let metadataReservedBytes=baseMetaBytes,sealed=false,stopping=false,finished=false,finishWork:Promise<ReturnType<typeof snapshot>>|undefined,disposeWork:Promise<void>|undefined,stopWork:Promise<void>|undefined;
 let drainResolve:(()=>void)|undefined,disposeAck:{id:number;resolve:(value:boolean)=>void}|undefined;
 const workerCleanup={acknowledged:null as boolean|null,forced:false,workerTerminated:true,error:null as string|null};
 const imageMeta=(record:ImageRecord)=>({...record,image:undefined});
 function rowCommit(row:ReadRecord,next:ReadRecord){
  next={...next,outcome:next.outcome?{...next.outcome,diagnostics:Array.isArray(next.outcome.diagnostics)?[...next.outcome.diagnostics]:next.outcome.diagnostics}:null};
  const before=rowSizes.get(row)??0;
  while(size(next)>64*1024||metadataReservedBytes-before+size(next)>limits.maxMetadataBytes){
   const value=next.outcome;
   if(value&&Array.isArray(value.diagnostics)&&value.diagnostics.length){value.diagnostics.pop();value.diagnosticsOmitted=Number(value.diagnosticsOmitted??0)+1;continue;}
   stats.metadataUpdatesOmitted++;return false;
  }
  const bytes=size(next);Object.assign(row,next);rowSizes.set(row,bytes);metadataReservedBytes+=bytes-before;return true;
 }
 function rawReservation(extra=0){const values=[...jobs.values()].filter(job=>!job.done).map(job=>job.rawBytes);if(extra)values.push(extra);return values.reduce((a,b)=>a+b,0)+2*Math.max(0,...values);}
 const observeRaw=()=>{stats.peakRawReservedBytes=Math.max(stats.peakRawReservedBytes,rawReservation());};
 function release(job:RawJob){clearTimeout(job.timer);job.pixels=undefined;job.done=true;jobs.delete(job.id);if(active===job)active=undefined;}
 const drained=()=>{if(!active&&!queue.length){drainResolve?.();drainResolve=undefined;}};
 function fail(job:RawJob,status:ImageStatus,error:string){if(job.done)return;job.record.status=status;job.record.error=error.slice(0,1000);if(status==='timeout')stats.timeouts++;else if(status==='error')stats.encodeErrors++;release(job);}
 function terminate(forced=true){const old=worker;if(!old)return;worker=undefined;old.onmessage=old.onerror=old.onmessageerror=null;try{old.terminate();}catch{/* Only diagnostic cleanup. */}
  stats.workerTerminations++;workerCleanup.workerTerminated=true;workerCleanup.forced ||= forced;}
 function getWorker(){
  if(worker)return worker;
  const created=workerFactory();worker=created;stats.workerStarts++;workerCleanup.workerTerminated=false;
  created.onmessage=event=>{
   const value=event.data;
   if(created!==worker){stats.lateResponsesIgnored++;return;}
   const ack=disposeAck;
   if(value?.kind==='disposed'&&ack&&ack.id===value.id){ack.resolve(value.acknowledged===true);return;}
   const job=active;
   if(!job||value?.kind!=='result'||value.id!==job.id||job.done){stats.lateResponsesIgnored++;return;}
   try{
    const result=value as PairedCropWorkerResult;
    if(result.width!==job.record.width||result.height!==job.record.height||
     !['encoded','omitted-budget','error','cancelled'].includes(result.status))throw Error('Invalid paired-crop worker reply.');
    job.record.rgbaSha256=hash(result.rgbaSha256)?result.rgbaSha256:null;
    job.record.rasterRgbaSha256=hash(result.rasterRgbaSha256)?result.rasterRgbaSha256:null;
    job.record.rgbaMatchesRaster=typeof result.rgbaMatchesRaster==='boolean'?result.rgbaMatchesRaster:null;
    job.record.pngSha256=hash(result.pngSha256)?result.pngSha256:null;job.record.pngBytes=natural(result.pngBytes)?result.pngBytes:null;
    job.record.error=text(result.error,1000);
    if(result.status==='encoded'){
     if(!job.record.rgbaSha256||job.record.rgbaSha256!==job.record.rasterRgbaSha256||result.rgbaMatchesRaster!==true||!job.record.pngSha256||
      typeof result.image!=='string'||!/^data:image\/png;base64,[A-Za-z0-9+/]*={0,2}$/.test(result.image)||result.image.length!==result.imageBytes||
      !positive(result.pngBytes)||22+4*Math.ceil(result.pngBytes/3)!==result.image.length||stats.imageBytes+result.image.length>limits.maxImageBytes)throw Error('Paired PNG is not verified or exceeds its byte budget.');
     job.record.image=result.image;job.record.imageBytes=result.image.length;stats.imageBytes+=result.image.length;job.record.status='encoded';
    }else{job.record.status=result.status==='omitted-budget'?'omitted-budget':'error';if(job.record.status==='error')stats.encodeErrors++;}
    if(size(imageMeta(job.record))>imageMetadataReservation(job.record))throw Error('Paired image metadata exceeds its reserved bound.');
    release(job);pump();drained();
   }catch(error){fail(job,'error',String(error));terminate();pump();drained();}
  };
  created.onerror=created.onmessageerror=()=>{if(created!==worker)return;if(active)fail(active,'error','Paired crop worker failed.');terminate();pump();drained();};
  return created;
 }
 function pump(){
  if(!sealed||stopping||active)return;
  const job=queue.shift();if(!job){drained();return;}if(job.done){pump();return;}active=job;job.record.status='encoding';
  try{
   const current=getWorker(),pixels=job.pixels;if(!pixels)throw Error('Paired crop pixels are unavailable.');
   job.timer=setTimeout(()=>{if(job.done)return;fail(job,'timeout','Paired crop encode deadline exceeded.');terminate();pump();drained();},limits.encodeTimeoutMs);
   current.postMessage({kind:'encode-rgba',id:job.id,width:job.record.width,height:job.record.height,pixels:pixels.buffer,maxImageBytes:Math.max(0,limits.maxImageBytes-stats.imageBytes)},[pixels.buffer]);
   job.pixels=undefined;
  }catch(error){fail(job,'error',String(error));terminate();pump();drained();}
 }
 function observation(meta:Record<string,unknown>){return {source:meta.source,pixelKey:meta.pixelKey};}
 function capture(row:ReadRecord,region:Region,width:number,height:number,geometry:unknown,copy:()=>Uint8ClampedArray<ArrayBuffer>):ImageReference {
  if(sealed){stats.lateCallsIgnored++;return ref('collector-sealed');}
  const raw=width*height*4,key=JSON.stringify([observation(row.meta),region]),shape=JSON.stringify(geometry),existing=imageKeys.get(key);
  if(existing){if(existing.geometry!==shape){stats.differentRegionOmitted++;return ref('region-already-captured-with-different-geometry');}
   stats.sharedImages++;return {imageId:existing.record.id,shared:true,exactRegion:true,omitted:null};}
  if(!positive(width)||!positive(height)||!Number.isSafeInteger(raw)){return ref('invalid-image-size');}
  if(images.length>=limits.maxCaptures){stats.captureLimitOmitted++;return ref('capture-count-bound');}
  if(rawReservation(raw)>limits.maxRawBytes){stats.rawBudgetOmitted++;return ref('raw-byte-bound');}
  const record:ImageRecord={id:`image-${images.length+1}`,region,firstDiagnosticReadId:row.diagnosticReadId,processingFrame:Number(row.meta.processingFrame),slot:Number(row.meta.slot),
   observation:observation(row.meta),geometry,width,height,status:'queued',rgbaSha256:null,rasterRgbaSha256:null,rgbaMatchesRaster:null,pngSha256:null,pngBytes:null,imageBytes:null,
   image:null,error:null,scope:region==='recognition-card'?'Actual recognition card RGBA read once after its attempt budget closed.':
    'Copied actual initial 128x36 name-label RGBA before masks/resizing; not a model tensor.'};
  const reservation=imageMetadataReservation(record);
  if(metadataReservedBytes+reservation>limits.maxMetadataBytes){stats.metadataUpdatesOmitted++;return ref('metadata-byte-bound');}
  images.push(record);imageKeys.set(key,{record,geometry:shape});metadataReservedBytes+=reservation;
  try{
   const at=now(),pixels=copy();stats.snapshotCopyMs+=now()-at;
   if(!(pixels instanceof Uint8ClampedArray)||!(pixels.buffer instanceof ArrayBuffer)||pixels.byteLength!==raw||pixels.byteOffset!==0||pixels.buffer.byteLength!==raw||(pixels.buffer as ArrayBuffer&{resizable?:boolean}).resizable)throw Error('Invalid owned paired-crop RGBA.');
   const job:RawJob={id:++nextId,record,pixels,rawBytes:raw,done:false};jobs.set(job.id,job);queue.push(job);observeRaw();
  }catch(error){record.status='error';record.error=String(error).slice(0,1000);stats.encodeErrors++;}
  return {imageId:record.id,shared:false,exactRegion:true,omitted:null};
 }
 // A bounded error can JSON-escape to 6000 bytes. Reserve its worst-case growth
 // plus final hashes/counts before allocating any pixels, even for a long key.
 function imageMetadataReservation(record:ImageRecord){return size({...imageMeta(record),status:'queued',rgbaSha256:null,rasterRgbaSha256:null,rgbaMatchesRaster:null,pngSha256:null,pngBytes:null,imageBytes:null,error:null})+8192;}
 function snapshot(){const missingTargets=targets.filter(target=>!rows.some(row=>row.meta.processingFrame===target.processingFrame&&row.meta.slot===target.slot));
  return structuredClone({version:1,targets:targets.map(t=>({...t})),missingTargets:missingTargets.map(t=>({...t})),rows,images,stats:{...stats,rows:rows.length,images:images.length,
  storedImages:images.filter(image=>image.status==='encoded').length,rawReservedBytes:rawReservation(),metadataReservedBytes,
  metadataBytes:baseMetaBytes+rows.reduce((sum,row)=>sum+size(row),0)+images.reduce((sum,image)=>sum+size(imageMeta(image)),0),
  pending:queue.length+(active?1:0),sealed,finished},workerCleanup:{...workerCleanup},
  complete:finished&&!jobs.size&&!!rows.length&&!!images.length&&!missingTargets.length&&!stats.invalidMeta&&!stats.encodeErrors&&!stats.timeouts&&!stats.captureLimitOmitted&&!stats.rawBudgetOmitted&&!stats.metadataUpdatesOmitted&&!stats.rowsOmitted&&!stats.differentRegionOmitted&&
   images.every(image=>image.status==='encoded')&&rows.every(row=>row.finished&&!row.finishConflicts&&row.card?.imageId&&!row.card.omitted&&row.outcome&&!row.outcome.diagnosticsOmitted&&
    row.outcome.nameMatchCount===row.labels.length&&!row.labelRecipesOmitted&&row.labels.every(label=>!!label.reference.imageId&&!label.reference.omitted))&&
   workerCleanup.workerTerminated&&workerCleanup.acknowledged===true&&!workerCleanup.forced,
  scopes:{encoding:'All SHA/PNG work starts only after collector.finish(), not inside recognition budgets.',rawReservation:'Owned input arrays plus two nominal active raster scratch sizes; excludes PNG bytes, digest internals and physical GPU/process memory.',
   diagnosticReadId:'Diagnostic invocation ordinal, not canonical attempt ID.',sharedReferences:'Same observation/region references reuse storage and are not independent evidence.',
   pixelHashes:'SHA of copied raw input and separately measured PNG canvas raster. PNG byte SHA is independent; no acquisition Worker or model-tensor hash is implied.'}});}
 function stopWorker(){return stopWork??=(async()=>{
  if(!worker){workerCleanup.workerTerminated=true;return;}
  const current=worker,id=++nextId;
  let timer:ReturnType<typeof setTimeout>|undefined;
  try{const ack=await new Promise<boolean>(resolve=>{disposeAck={id,resolve};timer=setTimeout(()=>resolve(false),limits.disposeTimeoutMs);try{current.postMessage({kind:'dispose',id});}catch{resolve(false);}});
   workerCleanup.acknowledged=ack;workerCleanup.forced ||= !ack;
  }finally{clearTimeout(timer);disposeAck=undefined;terminate(workerCleanup.forced);}
 })();}
 const observer:RecognitionInputObserver={begin(value){
  stats.beginCalls++;if(sealed){stats.lateCallsIgnored++;return;}
  try{
   const meta=metadata(value);if(!meta){stats.invalidMeta++;return;}if(!selected.has(`${meta.processingFrame}/${meta.slot}`))return;
   if(rows.some(row=>row.diagnosticReadId===meta.diagnosticReadId)){stats.invalidMeta++;return;}
   if(rows.length>=limits.maxRows){stats.rowsOmitted++;return;}
   const row:ReadRecord={diagnosticReadId:meta.diagnosticReadId,meta,card:null,labels:[],labelRecipesOmitted:0,outcome:null,finished:false,finishConflicts:0};
   if(!rowCommit(row,row)){stats.rowsOmitted++;return;}rows.push(row);stats.selectedReads++;
   const inspection:RecognitionInspection={
    captureCard(canvas){try{if(sealed||row.finished){stats.lateCallsIgnored++;return;}
     if(row.card)return;const width=canvas.width,height=canvas.height;
     const reference=width!==meta.cropWidth||height!==meta.cropHeight?ref('source-dimensions-mismatch'):
      capture(row,'recognition-card',width,height,{width,height,sourceBox:meta.sourceBox},()=>{
       const context=canvas.getContext('2d',{willReadFrequently:true});if(!context)throw Error('Recognition crop context unavailable.');
       return context.getImageData(0,0,width,height).data as Uint8ClampedArray<ArrayBuffer>;
      });rowCommit(row,{...row,card:reference});
    }catch{stats.metadataUpdatesOmitted++;}},
    captureLabel(pixels:RecognitionPixels,value:NameLabelRecipe){try{if(sealed||row.finished){stats.lateCallsIgnored++;return;}
     const parsed=recipe(value);if(!parsed){stats.invalidMeta++;return;}if(row.labels.length>=24){rowCommit(row,{...row,labelRecipesOmitted:row.labelRecipesOmitted+1});return;}
     const reference=pixels.width!==128||pixels.height!==36?ref('label-dimensions-mismatch'):
      capture(row,'initial-name-label',pixels.width,pixels.height,{sourceBox:parsed.sourceBox,targetWidth:128,targetHeight:36,offsetY:parsed.offsetY},()=>{
       if(!(pixels.data instanceof Uint8ClampedArray)||!(pixels.data.buffer instanceof ArrayBuffer)||pixels.data.byteLength!==pixels.width*pixels.height*4)throw Error('Invalid borrowed name-label RGBA.');
       const copy=new Uint8ClampedArray(pixels.data.length);copy.set(pixels.data);return copy;
      });rowCommit(row,{...row,labels:[...row.labels,{recipe:parsed,reference}]});
    }catch{stats.metadataUpdatesOmitted++;}},
    finish(value:RecognitionInputOutcome){try{if(sealed){stats.lateCallsIgnored++;return;}const parsed=outcome(value);
     if(row.finished){if(JSON.stringify(row.outcome)!==JSON.stringify(parsed))rowCommit(row,{...row,finishConflicts:row.finishConflicts+1});return;}
     rowCommit(row,{...row,outcome:parsed,finished:true});
    }catch{stats.metadataUpdatesOmitted++;}},
   };return inspection;
  }catch{stats.invalidMeta++;return;}
 }};
 return {...observer,snapshot,
  finish(){return finishWork??=(async()=>{
   sealed=true;
   if(!stopping){let timer:ReturnType<typeof setTimeout>|undefined;
    const drainedWork=new Promise<void>(resolve=>{drainResolve=resolve;});pump();drained();
    try{await Promise.race([drainedWork,new Promise<void>(resolve=>{timer=setTimeout(()=>{stopping=true;for(const job of [...jobs.values()])fail(job,'timeout','Paired collector finish deadline exceeded.');queue.length=0;terminate();drained();resolve();},limits.finishTimeoutMs);})]);}
    finally{clearTimeout(timer);}
   }
   await stopWorker();finished=true;return snapshot();
  })();},
  dispose(){return disposeWork??=(async()=>{
   sealed=stopping=true;for(const job of [...jobs.values()])fail(job,'disposed','Paired collector disposed.');queue.length=0;drained();await stopWorker();finished=true;
  })();},
 };
}
