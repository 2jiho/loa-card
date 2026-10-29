import type { acquireCards } from './card-acquisition';
import type { Box, Layout } from './detector';
import { obsoleteFieldRetry } from './field-retry';
import type { createRecognizer } from './recognizer';
import {parseMeasuredSourceRasterReceipt,type MeasuredSourceRasterReceipt} from './source-raster-receipt';

type Cell=ReturnType<typeof acquireCards>[number];
export interface SavedObservation {
  order:number;
  frame:string;
  stable:boolean;
  identity?:NonNullable<Awaited<ReturnType<Awaited<ReturnType<typeof createRecognizer>>['identify']>>>;
}
/** Bound to one lossless encoder frame ID, never a nearby timestamp or video decode. */
export interface SavedAcquisition {
  width:number;
  height:number;
  layout:Layout|null;
  cells:Omit<Cell,'image'>[];
  observations:(SavedObservation|undefined)[];
  /** Actual measured origin; a cache hit is never a new raster measurement. */
  rasterReceipt?:MeasuredSourceRasterReceipt;
}

export function saveAcquisition(width:number,height:number,layout:Layout|null,cells:(Cell&{previewImage?:HTMLCanvasElement})[],receipt?:MeasuredSourceRasterReceipt):SavedAcquisition {
  if(receipt&&(receipt.width!==width||receipt.height!==height))throw Error('저장한 획득 분석의 원본 크기 불일치');
  return {width,height,layout:structuredClone(layout),observations:[],
    ...(receipt?{rasterReceipt:parseMeasuredSourceRasterReceipt(receipt)}:{}),
    cells:cells.map(({image:_image,previewImage:_preview,...cell})=>structuredClone(cell))};
}

export type ObservationSourceKind='canonical'|'prepared'|'unbound';

/** Select only a source ID already supplied by the canonical/prepared store.
 * Legacy PNG IDs and independently decoded inputs have no physical binding,
 * even when their local numeric ID happens to equal a stored source ID.
 * This selection does not attest pixels or borrow an analysis/receipt. */
export function selectObservationSourceFrameId(kind:ObservationSourceKind,savedId:number|undefined):number|undefined {
  if(kind==='unbound')return undefined;
  if(kind!=='canonical'&&kind!=='prepared')throw Error('Invalid observation source kind');
  if(savedId===undefined)return undefined;
  if(!Number.isSafeInteger(savedId)||savedId<1)throw Error('Invalid physical observation source identity');
  return savedId;
}

/** Physical-source identity survives cache eviction, crop refinement and a new
 * processing attempt. Missing legacy provenance retains its processing key.
 * Neither clock proximity nor matching artwork can create a shared key. */
export function sourceObservationFrame(sessionId:string,sourceFrameId:number|undefined,processingFrameId:number,
  domain:'source'|'raw-source'|'archive-source'='source'):string {
  const validId=(value:unknown)=>Number.isSafeInteger(value)&&(value as number)>=1;
  if(typeof sessionId!=='string'||!sessionId.length||!validId(processingFrameId)||sourceFrameId!==undefined&&!validId(sourceFrameId))
    throw Error('Invalid observation source identity');
  if(!['source','raw-source','archive-source'].includes(domain)||sourceFrameId===undefined&&domain!=='source')
    throw Error('Invalid observation source domain');
  const session=encodeURIComponent(sessionId);
  return sourceFrameId===undefined?`${session}/${processingFrameId}`:`${session}/${domain}/${sourceFrameId}`;
}

export interface SavedObservationSource {
  readonly sourceFrameId?:number;readonly captureTime:number;readonly width:number;readonly height:number;readonly hash?:string;
}
type ObservationCell=Pick<Cell,'slot'|'content'|'preview'>;
function exactBox(first:Box|undefined,second:Box|undefined,width:number,height:number):boolean {
  if(!first||!second)return false;
  const valid=(box:Box)=>[box.x,box.y,box.width,box.height].every(Number.isFinite)&&box.x>=0&&box.y>=0&&box.width>0&&box.height>0&&
    box.x+box.width<=width&&box.y+box.height<=height;
  return valid(first)&&valid(second)&&first.x===second.x&&first.y===second.y&&first.width===second.width&&first.height===second.height;
}

/** Borrow observation lineage only after independently re-acquiring the same
 * physical pixels and the exact per-slot crop geometry. This does not reuse a
 * crop, detector result or measured-raster receipt, and needs no store ACK.
 * Confirmation and latest-field gates still decide whether readers may skip. */
export function exactSourceSavedObservation(saved:SavedAcquisition|undefined,source:SavedObservationSource,current:ObservationCell):SavedObservation|undefined {
  if(!saved||!source||!current||!Number.isSafeInteger(source.sourceFrameId)||(source.sourceFrameId as number)<1||
    !Number.isFinite(source.captureTime)||source.captureTime<0||!Number.isSafeInteger(source.width)||source.width<1||
    !Number.isSafeInteger(source.height)||source.height<1||typeof source.hash!=='string'||!/^[a-f0-9]{64}$/.test(source.hash)||
    saved.width!==source.width||saved.height!==source.height||!Number.isSafeInteger(current.slot)||current.slot<0||current.slot>=40)return;
  let receipt:MeasuredSourceRasterReceipt;
  try{receipt=parseMeasuredSourceRasterReceipt(saved.rasterReceipt);}catch{return;}
  if(receipt.sourceFrameId!==source.sourceFrameId||receipt.captureTime!==source.captureTime||receipt.width!==source.width||
    receipt.height!==source.height||receipt.hash!==source.hash)return;
  const previous=saved.cells[current.slot];
  if(!previous||previous.slot!==current.slot||!exactBox(previous.content,current.content,source.width,source.height)||
    !exactBox(previous.preview,current.preview,source.width,source.height))return;
  return saved.observations[current.slot];
}

/** Only exact, accepted identities can let newer fully confirmed evidence retire a replay. */
export function resolvedSavedObservation(observation:SavedObservation|undefined,confirmed:ReadonlyMap<string,number>) {
  return !!observation?.identity && !observation.identity.review.length &&
    obsoleteFieldRetry({needsIdentity:false,fieldTarget:{id:observation.identity.id,order:observation.order}},confirmed);
}

/** A completed old group is not the latest proof for this card after a newer
 * name-only capture. Seed/uncertain identities cannot request a reconfirmation. */
export function needsLatestSavedProof(observation:SavedObservation|undefined,
  latest:ReadonlyMap<string,number>,confirmed:ReadonlyMap<string,number>) {
  if(!resolvedSavedObservation(observation,confirmed))return false;
  const id=observation!.identity!.id,order=latest.get(id),proof=confirmed.get(id);
  return order!==undefined&&proof!==undefined&&Number.isFinite(order)&&Number.isFinite(proof)&&order>proof;
}

export function coveredSavedAcquisition(saved:SavedAcquisition|undefined,confirmed:ReadonlyMap<string,number>) {
  return !!saved?.layout && saved.cells.length>0 && saved.cells.every((cell,index)=>
    cell.quality.reason==='미보유 카드 뒷면 · 빈 슬롯' ||
    (cell.quality.usable && resolvedSavedObservation(saved.observations[index],confirmed)));
}

/** Analysis is optional: eviction means reacquire, never discard source frames. */
export class SavedAcquisitions {
  private entries=new Map<number,SavedAcquisition>();
  private limit:number;
  constructor(limit=128){
    if(!Number.isInteger(limit)||limit<1)throw Error('Invalid acquisition cache limit');
    this.limit=limit;
  }
  set(id:number,value:SavedAcquisition){
    this.entries.delete(id);this.entries.set(id,value);
    while(this.entries.size>this.limit)this.entries.delete(this.entries.keys().next().value!);
  }
  get(id:number){return this.entries.get(id);}
  delete(id:number){this.entries.delete(id);}
  clear(){this.entries.clear();}
  coveredFrom(first:number,last:number,covered:(value:SavedAcquisition|undefined)=>boolean){
    for(let id=first;id<=last;id++)if(!covered(this.entries.get(id)))return false;
    return true;
  }
}
