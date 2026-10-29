import type {Acquisition} from '../src/features/card-scanner/acquisition-client';

export const PIPELINE_PROOF_FRAMES=30;
export const PIPELINE_PROOF_MAX_START_SECONDS=10;
export const PIPELINE_PROOF_MAX_PREFIX_FRAMES=2048;
export type PipelineMode='serial'|'prefetch'|'raster-control'|'raster-reuse';
export interface CardPixelHash {readonly slot:number;readonly width:number;readonly height:number;readonly hash:string}
export interface PipelineProofWindow {
 readonly requestedStartTime:number;readonly selection:'first-original-PTS-at-or-after';
 readonly skippedFrames:number;readonly skippedFirstPts:number|null;readonly skippedLastPts:number|null;readonly warmupPts:number;
}
export function pipelineProofStartTime(value:number):number {
 if(!Number.isFinite(value)||value<0||value>PIPELINE_PROOF_MAX_START_SECONDS)throw Error('Invalid fixed pipeline window start');return value;
}
/** The production decoder bounds each next()/return(). This adds a fixed
 * prefix-count bound; only the prefix OUTSIDE the measured window is discarded.
 * The returned warmup is the actual first PTS >= start, not an exact seek. */
export async function selectPipelineWarmup<T extends {readonly time:number}>(decoder:AsyncIterator<T>,requestedStartTime:number,signal:AbortSignal){
 pipelineProofStartTime(requestedStartTime);
 let skippedFrames=0,skippedFirstPts:number|null=null,skippedLastPts:number|null=null,lastPts=-Infinity;
 while(true){
  signal.throwIfAborted();const next=await decoder.next();signal.throwIfAborted();
  if(next.done)throw Error('Video ended before the fixed pipeline window');
  const frame=next.value;if(!Number.isFinite(frame.time)||frame.time<0||frame.time<lastPts)throw Error('Invalid prefix sample PTS');lastPts=frame.time;
  if(frame.time>=requestedStartTime)return {frame,window:{requestedStartTime,selection:'first-original-PTS-at-or-after' as const,
   skippedFrames,skippedFirstPts,skippedLastPts,warmupPts:frame.time} satisfies PipelineProofWindow};
  if(skippedFrames>=PIPELINE_PROOF_MAX_PREFIX_FRAMES)throw Error('Pipeline prefix sample bound exceeded');
  skippedFirstPts??=frame.time;skippedLastPts=frame.time;skippedFrames++;
 }
}
export interface PipelineProofRow {
 readonly ordinal:number;readonly sourceFrameId:number;readonly acquisitionFrameId:number;
 readonly time:number;readonly width:number;readonly height:number;readonly hash:string;
 readonly storageKind:'native'|'rgba';readonly nativeSha256:string|null;readonly descriptorJson:string|null;
 readonly acquisition:ReturnType<typeof acquisitionShape>;
 /** Actual materialized OCR-consumer Canvas pixels, not pre-transfer bytes. */
 readonly cardPixelHashes?:readonly CardPixelHash[];
}
function finiteTree(value:unknown):void {
 if(typeof value==='number'&&!Number.isFinite(value))throw Error('Nonfinite acquisition geometry or quality');
 if(Array.isArray(value))value.forEach(finiteTree);
 else if(value&&typeof value==='object')Object.values(value).forEach(finiteTree);
}
/** No per-process pixel-cache UUID, rasters, OCR or timing enters equivalence. */
export function acquisitionShape(value:Pick<Acquisition,'layout'|'cells'>){
 const shape={layout:value.layout??null,cells:value.cells.map(cell=>({slot:cell.slot,content:cell.content,preview:cell.preview,
  alignment:cell.alignment,intact:cell.intact,borderSides:[...cell.borderSides],labelVisible:cell.labelVisible,
  quality:{...cell.quality},width:cell.image.width,height:cell.image.height})),
  detected:value.cells.length,usable:value.cells.filter(cell=>cell.quality.usable).length,intact:value.cells.filter(cell=>cell.intact).length};
 finiteTree(shape);return structuredClone(shape);
}
/** This validates only an actual finite sample pair, never OCR or live speed. */
export function comparePipelineRows(serial:readonly PipelineProofRow[],prefetch:readonly PipelineProofRow[]){
 for(const [name,rows]of [['serial',serial],['prefetch',prefetch]]as const){
  if(rows.length!==PIPELINE_PROOF_FRAMES+1)throw Error(`${name}: finite sample count mismatch`);
  const sources=new Set<number>(),acquisitions=new Set<number>();let previous=-Infinity;
  rows.forEach((row,index)=>{
   if(row.ordinal!==index||!Number.isSafeInteger(row.sourceFrameId)||row.sourceFrameId<1||sources.has(row.sourceFrameId)||
    !Number.isSafeInteger(row.acquisitionFrameId)||row.acquisitionFrameId<1||acquisitions.has(row.acquisitionFrameId)||
    !Number.isFinite(row.time)||row.time<0||row.time<previous||!Number.isSafeInteger(row.width)||row.width<1||
    !Number.isSafeInteger(row.height)||row.height<1||!/^[a-f0-9]{64}$/.test(row.hash))throw Error(`${name}: invalid source/use sample binding`);
   sources.add(row.sourceFrameId);acquisitions.add(row.acquisitionFrameId);previous=row.time;
   if(row.storageKind==='native'){
    if(typeof row.nativeSha256!=='string'||!/^[a-f0-9]{64}$/.test(row.nativeSha256)||typeof row.descriptorJson!=='string'||!row.descriptorJson)
     throw Error(`${name}: missing native byte/profile evidence`);
   }else if(row.storageKind!=='rgba'||row.nativeSha256!==null||row.descriptorJson!==null)throw Error(`${name}: invalid fallback evidence`);
   finiteTree(row.acquisition);
   if(row.cardPixelHashes!==undefined){
    if(!Array.isArray(row.cardPixelHashes)||row.cardPixelHashes.length!==row.acquisition.cells.length)throw Error(`${name}: incomplete card pixel hashes`);
    for(const [cellIndex,pixels]of row.cardPixelHashes.entries()){
     const cell=row.acquisition.cells[cellIndex];
     if(pixels.slot!==cell.slot||pixels.width!==cell.width||pixels.height!==cell.height||!/^[a-f0-9]{64}$/.test(pixels.hash))
       throw Error(`${name}: invalid consumer card pixel hash binding`);
    }
   }
  });
 }
 for(let index=0;index<serial.length;index++){
  const left=serial[index],right=prefetch[index];
  for(const key of ['ordinal','time','width','height','hash','storageKind','nativeSha256','descriptorJson']as const)
   if(left[key]!==right[key])throw Error(`Sample ${index}: ${key} mismatch`);
  if(JSON.stringify(left.acquisition)!==JSON.stringify(right.acquisition))throw Error(`Sample ${index}: layout/crop quality mismatch`);
  if(JSON.stringify(left.cardPixelHashes)!==JSON.stringify(right.cardPixelHashes))throw Error(`Sample ${index}: consumer card pixels mismatch`);
 }
 return {warmupFrames:1,measuredFrames:PIPELINE_PROOF_FRAMES,orderedPtsEqual:true,fullRasterHashesEqual:true,
  storedNativeBytesAndProfilesEqual:true,detectedLayoutAndCropQualityEqual:true,
  ...(serial.every(row=>row.cardPixelHashes!==undefined)?{consumerCardPixelHashesEqual:true}:{})};
}
