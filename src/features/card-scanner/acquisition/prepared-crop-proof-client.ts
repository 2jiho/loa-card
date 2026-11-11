import type {Box} from './detector';
import type {MeasuredSourceRasterReceipt} from './source-raster-receipt';
import {validateMeasuredSourceRasterReceipt} from './source-raster-receipt';
import {PREPARED_CROP_PROOF_LIMITS,type PreparedCropProof} from './prepared-crop-proof';
import {pixelHash} from '../reproduction/recording-frame-integrity';

type Cell={readonly slot:number;readonly content:Box;readonly complete:boolean;readonly image:HTMLCanvasElement};
type Entry=PreparedCropProof['crops'][number];
export interface PreparedCropCanvasComparison {
  /** checked counts reported crops, including unavailable ones; attempted is readback attempts. */
  readonly scope:'delivery-canvas-snapshot-only';readonly checked:number;readonly attempted:number;readonly matched:number;readonly mismatch:number;
  readonly unavailable:number;readonly bytesRead:number;readonly elapsedMs:number;readonly budgetMs:number;readonly timedOut:boolean;
  readonly slots:readonly {readonly slot:number;readonly status:'matched'|'mismatch'|'unavailable'}[];
}
export type PreparedCropDiagnostic =
  | {readonly status:'accepted';readonly claim:PreparedCropProof;readonly canvas:PreparedCropCanvasComparison}
  | {readonly status:'unavailable'|'invalid';readonly reason:string;readonly elapsedMs:number};

function dataObject(value:unknown,keys:readonly string[]):Record<string,unknown>{
  if(!value||typeof value!=='object'||Array.isArray(value)||![Object.prototype,null].includes(Object.getPrototypeOf(value)))throw Error('Invalid crop proof object');
  const descriptors=Object.getOwnPropertyDescriptors(value);
  if(Reflect.ownKeys(descriptors).length!==keys.length||keys.some(key=>!Object.hasOwn(descriptors,key)||!Object.hasOwn(descriptors[key],'value')))
    throw Error('Invalid crop proof fields');
  return Object.fromEntries(keys.map(key=>[key,descriptors[key].value]));
}
function natural(value:unknown):number{
 if(!Number.isSafeInteger(value)||(value as number)<0)throw Error('Invalid crop proof count');return value as number;
}
function box(value:unknown,frame:MeasuredSourceRasterReceipt):Readonly<Box>{
 const raw=dataObject(value,['x','y','width','height']);
 const x=natural(raw.x),y=natural(raw.y),width=natural(raw.width),height=natural(raw.height);
 if(!width||!height||x+width>frame.width||y+height>frame.height)throw Error('Invalid crop proof geometry');
 return Object.freeze({x,y,width,height});
}
function sameBox(a:Box,b:Box){return a.x===b.x&&a.y===b.y&&a.width===b.width&&a.height===b.height;}
function dataArray(value:unknown):unknown[]{
 if(!Array.isArray(value)||Object.getPrototypeOf(value)!==Array.prototype)throw Error('Invalid crop proof array');
 const descriptors=Object.getOwnPropertyDescriptors(value) as unknown as Record<string,PropertyDescriptor>,length=descriptors.length?.value;
 if(!Number.isSafeInteger(length)||length<0||length>40||Reflect.ownKeys(descriptors).length!==length+1)throw Error('Invalid crop proof array');
 return Array.from({length},(_,index)=>{const d=descriptors[String(index)];if(!d||!Object.hasOwn(d,'value'))throw Error('Invalid crop proof array');return d.value;});
}
/** A validated Worker assertion; not physical-source, name or completion proof. */
export function parsePreparedCropProof(value:unknown,frame:MeasuredSourceRasterReceipt,cells:readonly Cell[]):PreparedCropProof{
 const raw=dataObject(value,['version','scope','frame','frameCheck','frameBytesHashed','timedOut','hashBusy','total','checked','unsupported','mismatch','overBudget','hashFailed','bytesHashed','crops']);
 if(raw.version!==1||raw.scope!=='prepared-worker-crop')throw Error('Invalid crop proof version');
 if(typeof raw.timedOut!=='boolean'||typeof raw.hashBusy!=='boolean')throw Error('Invalid crop proof deadline');
 const normalizedFrame=dataObject(raw.frame,['version','kind','sourceFrameId','captureTime','acquisitionFrameId','width','height','hash']);
 const bound=validateMeasuredSourceRasterReceipt(normalizedFrame,frame);
 const frameCheck=raw.frameCheck,frameBytesHashed=natural(raw.frameBytesHashed);
 if(!['match','mismatch','failed','unsupported','not-needed'].includes(frameCheck as string)||
   (frameCheck==='match'||frameCheck==='mismatch'?frameBytesHashed!==bound.width*bound.height*4:
     frameCheck==='failed'?frameBytesHashed!==0&&frameBytesHashed!==bound.width*bound.height*4:frameBytesHashed!==0)||
   frameBytesHashed>32*1024*1024)
   throw Error('Invalid crop proof frame check');
 if(!Array.isArray(cells)||cells.length>PREPARED_CROP_PROOF_LIMITS.cells)throw Error('Invalid crop proof cells');
 const bySlot=new Map<number,Cell>();
 for(const cell of cells){if(!cell||!Number.isSafeInteger(cell.slot)||cell.slot<0||cell.slot>=40||bySlot.has(cell.slot))throw Error('Invalid crop proof slot');bySlot.set(cell.slot,cell);}
 const total=natural(raw.total),checked=natural(raw.checked),unsupported=natural(raw.unsupported),mismatch=natural(raw.mismatch),
   overBudget=natural(raw.overBudget),hashFailed=natural(raw.hashFailed),bytesHashed=natural(raw.bytesHashed);
 const entries=dataArray(raw.crops);
 if(total!==cells.length||checked+unsupported+mismatch+overBudget+hashFailed!==total||bytesHashed>PREPARED_CROP_PROOF_LIMITS.totalBytes||
   raw.timedOut===true&&raw.hashBusy===true||(raw.timedOut===true||raw.hashBusy===true)&&(frameCheck!=='failed'||checked!==0)||
   checked>0&&frameCheck!=='match'||entries.length!==checked)throw Error('Invalid crop proof totals');
 const crops:Entry[]=[],seen=new Set<number>();let checkedBytes=0;
 for(const item of entries){
  const entry=dataObject(item,['slot','content','sha256']),slot=natural(entry.slot),cell=bySlot.get(slot),content=box(entry.content,bound);
  if(!cell||seen.has(slot)||cell.complete!==true||!sameBox(content,cell.content)||cell.image.width!==content.width||cell.image.height!==content.height||
    typeof entry.sha256!=='string'||!/^[a-f0-9]{64}$/.test(entry.sha256))throw Error('Invalid crop proof entry');
  const bytes=content.width*content.height*4;
  if(!Number.isSafeInteger(bytes)||bytes>PREPARED_CROP_PROOF_LIMITS.cellBytes)throw Error('Invalid crop proof size');
  checkedBytes+=bytes;seen.add(slot);crops.push(Object.freeze({slot,content,sha256:entry.sha256}));
 }
 if(bytesHashed<checkedBytes||bytesHashed>checkedBytes+hashFailed*PREPARED_CROP_PROOF_LIMITS.cellBytes)throw Error('Invalid crop proof hash budget');
 return Object.freeze({version:1,scope:'prepared-worker-crop',frame:bound,frameCheck:frameCheck as PreparedCropProof['frameCheck'],frameBytesHashed,
   timedOut:raw.timedOut,hashBusy:raw.hashBusy,
   total,checked,unsupported,mismatch,overBudget,hashFailed,bytesHashed,crops:Object.freeze(crops)});
}
/** A hung digest retains at most its single bounded input; subsequent requests
 * fail immediately until it settles. This is per acquisition-client lifetime. */
export function createPreparedCanvasHasher(hash:(bytes:Uint8Array<ArrayBuffer>)=>Promise<string>=pixelHash){
 let busy=false;
 return (bytes:Uint8Array<ArrayBuffer>):Promise<string>=>{
  if(busy)return Promise.reject(Error('Canvas digest busy'));
  busy=true;
  return Promise.resolve().then(()=>hash(bytes)).finally(()=>{busy=false;});
 };
}

/** Re-reads a bounded number of materialized canvases once, before delivery.
 * Matches only describe this snapshot and do not authorize later OCR/state. */
export async function comparePreparedCropCanvases(claim:PreparedCropProof,cells:readonly Cell[],signal:AbortSignal,
 hash:(bytes:Uint8Array<ArrayBuffer>)=>Promise<string>=pixelHash,budgetMs=250):Promise<PreparedCropCanvasComparison>{
 if(!Number.isFinite(budgetMs)||budgetMs<=0||budgetMs>250)throw Error('Invalid canvas comparison budget');
 const start=performance.now(),deadline=start+budgetMs,bySlot=new Map(cells.map(cell=>[cell.slot,cell]));
 let matched=0,mismatch=0,unavailable=0,bytesRead=0,attempted=0,timedOut=false;
 const slots:{slot:number;status:'matched'|'mismatch'|'unavailable'}[]=[];
 for(const crop of claim.crops){
  signal.throwIfAborted();const cell=bySlot.get(crop.slot);let status:'matched'|'mismatch'|'unavailable'='unavailable';
  const bytes=crop.content.width*crop.content.height*4;
  if(!timedOut&&performance.now()>=deadline)timedOut=true;
  if(!timedOut&&cell&&bytesRead+bytes<=PREPARED_CROP_PROOF_LIMITS.totalBytes&&cell.image.width===crop.content.width&&cell.image.height===crop.content.height){
   try{
    attempted++;
    const ctx=cell.image.getContext('2d',{willReadFrequently:true});if(!ctx)throw Error('Canvas unavailable');
    const rgba=ctx.getImageData(0,0,crop.content.width,crop.content.height).data;
    if(rgba.byteLength!==bytes)throw Error('Canvas pixel size');
    const snapshot=new Uint8Array(rgba);bytesRead+=bytes;
    const remaining=deadline-performance.now();if(remaining<=0){timedOut=true;throw Error('Canvas comparison deadline');}
    const digest=await new Promise<string>((resolve,reject)=>{
     let done=false;
     const finish=(value:string|undefined,error?:unknown)=>{if(done)return;done=true;clearTimeout(timer);signal.removeEventListener('abort',abort);
      if(error!==undefined)reject(error);else resolve(value!);};
     const abort=()=>finish(undefined,signal.reason??new DOMException('Aborted','AbortError'));
     const timer=setTimeout(()=>{timedOut=true;finish(undefined,Error('Canvas comparison deadline'));},remaining);
     signal.addEventListener('abort',abort,{once:true});
     if(signal.aborted)abort();
     else Promise.resolve().then(()=>hash(snapshot)).then(value=>finish(value),error=>finish(undefined,error));
    });signal.throwIfAborted();
    if(cell.image.width===crop.content.width&&cell.image.height===crop.content.height)status=digest===crop.sha256?'matched':'mismatch';
   }catch{signal.throwIfAborted();}
  }
  if(status==='matched')matched++;else if(status==='mismatch')mismatch++;else unavailable++;
  slots.push(Object.freeze({slot:crop.slot,status}));
 }
 return Object.freeze({scope:'delivery-canvas-snapshot-only',checked:claim.crops.length,attempted,matched,mismatch,unavailable,bytesRead,
  elapsedMs:Math.max(0,performance.now()-start),budgetMs,timedOut,slots:Object.freeze(slots)});
}

/** Diagnostics cannot fail a successful acquisition. Cancellation remains an
 * actual acquisition cancellation and is never converted into an invalid claim. */
export async function preparedCropDiagnostic(value:unknown,frame:MeasuredSourceRasterReceipt|undefined,
 cells:readonly Cell[],signal:AbortSignal,hash?:(bytes:Uint8Array<ArrayBuffer>)=>Promise<string>):Promise<PreparedCropDiagnostic>{
 const start=performance.now();
 try{
  signal.throwIfAborted();if(!frame||value===undefined)throw Error('Worker crop proof missing');
  const claim=parsePreparedCropProof(value,frame,cells),canvas=await comparePreparedCropCanvases(claim,cells,signal,hash);
  signal.throwIfAborted();return {status:'accepted',claim,canvas};
 }catch(error){
  signal.throwIfAborted();return {status:'invalid',reason:String(error).slice(0,300),elapsedMs:Math.max(0,performance.now()-start)};
 }
}
