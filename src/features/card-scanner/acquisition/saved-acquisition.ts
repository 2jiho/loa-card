import type { acquireCards } from './card-acquisition';
import type { Box, Layout } from './detector';
import { obsoleteFieldRetry } from '../session/field-retry';
import type { createRecognizer } from '../recognition/recognizer';
import {parseMeasuredSourceRasterReceipt,type MeasuredSourceRasterReceipt} from './source-raster-receipt';
import type {InventoryEvidence,InventorySource} from '../session/inventory-evidence';
import {parseObservationFact,type ObservationSource} from '../session/observation-execution';

type Cell=ReturnType<typeof acquireCards>[number];
export interface SavedObservation {
  order:number;
  frame:string;
  stable:boolean;
  identity?:NonNullable<Awaited<ReturnType<Awaited<ReturnType<typeof createRecognizer>>['identify']>>>;
}
/** Each newly captured source gets its own chronology, even when a crop has
 * the same pixels as an older source. Recovery may reuse an observation only
 * through the corresponding saved acquisition, not by pixel/group lookup. */
export function newSavedObservation(order:number,stable:boolean,frame:string):SavedObservation {
  return {order,stable,frame};
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

/** Start a slot of a newly captured frame without a previous frame's result.
 * Recovery of the same saved physical frame does not call this: its original
 * observation and capture order must stay attached to that original source. */
export function beginNewCaptureSlot(saved:SavedAcquisition|undefined,slot:number):void {
  if(!saved)return;
  if(!Number.isSafeInteger(slot)||slot<0||slot>=40)throw Error('Invalid captured slot');
  saved.observations[slot]=undefined;
}

// A parsed JSON clone or hand-assembled object is not a live acquisition
// sidecar. This says nothing about whether a caller supplied an honest receipt.
const createdAcquisitions=new WeakSet<SavedAcquisition>();

export function saveAcquisition(width:number,height:number,layout:Layout|null,cells:(Cell&{previewImage?:HTMLCanvasElement})[],receipt?:MeasuredSourceRasterReceipt):SavedAcquisition {
  if(receipt&&(receipt.width!==width||receipt.height!==height))throw Error('저장한 획득 분석의 원본 크기 불일치');
  const saved:SavedAcquisition={width,height,layout:structuredClone(layout),observations:[],
    ...(receipt?{rasterReceipt:parseMeasuredSourceRasterReceipt(receipt)}:{}),
    cells:cells.map(({image:_image,previewImage:_preview,...cell})=>structuredClone(cell))};
  createdAcquisitions.add(saved);
  return saved;
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

/** A capability is intentionally opaque and meaningful only to its issuing
 * live session. Serializing, cloning or reconstructing it loses ownership. */
declare const originalBindingCapability:unique symbol;
export type OriginalBindingCapability={readonly [originalBindingCapability]:never};
export interface OriginalBindingDescription {
  readonly scope:'prepared-source-metadata-only';
  readonly pixelsAuthenticated:false;
  readonly originalSource:ObservationSource;
  readonly originalGroup:number;
  readonly recoverySource:ObservationSource;
  readonly physical:Readonly<{sourceFrameId:number;captureTime:number;width:number;height:number;hash:string}>;
  readonly content:Readonly<Box>;
  readonly preview:Readonly<Box>;
}
type OriginalBindingCell=Pick<Cell,'slot'|'content'|'preview'|'quality'|'intact'|'complete'|'labelVisible'|'alignment'|'borderSides'|'preBorder'>;
type BoundOriginal={observation:SavedObservation;cell:Omit<Cell,'image'>;qualityStamp:string;source:ObservationSource;group:number;receipt:MeasuredSourceRasterReceipt;
  frame:string;order:number;stable:boolean;nominal:Readonly<Box>;area:Readonly<Box>;content:Readonly<Box>;preview:Readonly<Box>};
type IssuedOriginal={saved:WeakRef<SavedAcquisition>;slot:number;recovery:ObservationSource;source:SavedObservationSource;
  current:WeakRef<OriginalBindingCell>;qualityStamp:string};

function observationSource(value:ObservationSource):ObservationSource|undefined {
  try {
    // InventorySource also has a `frame` key; only the explicitly specified
    // observation fields form this independently validated copy.
    const source={sessionId:value.sessionId,frameId:value.frameId,observationId:value.observationId,
      captureOrder:value.captureOrder,captureTime:value.captureTime,phase:value.phase,slot:value.slot};
    return parseObservationFact({version:1,kind:'queued',attemptId:0,source}).source;
  } catch {return;}
}
function inside(first:Box,second:Box):boolean {
  return first.x>=second.x&&first.y>=second.y&&first.x+first.width<=second.x+second.width&&
    first.y+first.height<=second.y+second.height;
}
function sameReceipt(a:MeasuredSourceRasterReceipt,b:MeasuredSourceRasterReceipt):boolean {
  return a.sourceFrameId===b.sourceFrameId&&a.captureTime===b.captureTime&&
    a.acquisitionFrameId===b.acquisitionFrameId&&a.width===b.width&&a.height===b.height&&a.hash===b.hash;
}
function qualityStamp(cell:OriginalBindingCell):string|undefined {
  const q=cell?.quality,pre=cell?.preBorder;
  if(!q||q.usable!==true||typeof q.reason!=='string'||q.reason.length>2048||!Number.isFinite(q.sharpness)||
    cell.intact!==true||cell.complete!==true||cell.labelVisible!==true||!Number.isFinite(cell.alignment)||
    !Array.isArray(cell.borderSides)||cell.borderSides.length!==4||cell.borderSides.some(value=>!Number.isFinite(value))||
    pre!==undefined&&(!pre||pre.kind!=='usable'||typeof pre.reason!=='string'||pre.reason.length>2048))return;
  return JSON.stringify([q.usable,q.reason,q.sharpness,cell.intact,cell.complete,cell.labelVisible,cell.alignment,
    cell.borderSides,pre?{kind:pre.kind,reason:pre.reason}:null]);
}

/** Experimental same-session metadata ownership for the prepared-source path.
 *
 * The scanner, not this class, must supply the ORIGINAL input source at its
 * own candidate commit. A measured receipt/hash and the recovery hash must be
 * obtained from the trusted acquisition and verified restore path; their
 * shapes or equality are not cryptographic authentication by this class.
 * The matching result authorizes neither identity nor field reuse and is not
 * a v1/v2 unknown-retire event. It proves no OCR result, clean pixels or
 * bit-identical Canvas resampling. Recorded metadata cannot restore a token.
 *
 * Per-session counts are bounded. Weak keys and WeakRef avoid retaining a
 * source acquisition or any of its pixel/vector buffers solely for a token.
 * Forgetting a sidecar never revives a previously aliased observation and
 * does not replenish the per-controller input budget. Create one controller
 * per session; uniqueness is scoped to that controller, not global. */
export class SavedOriginalSourceBindings {
  private readonly sessionId:string;
  private readonly maxBindings:number;
  private readonly maxCapabilities:number;
  private bindings=new WeakMap<SavedAcquisition,Map<number,BoundOriginal>>();
  private seenObservations=new WeakSet<SavedObservation>();
  private seenSources=new Set<string>();
  private recoveryUses=new Map<string,string>();
  private issued=new Map<OriginalBindingCapability,IssuedOriginal>();
  private bound=0;
  private closed=false;
  constructor(sessionId:string,maxBindings=5120,maxCapabilities=160) {
    if(typeof sessionId!=='string'||!sessionId.length||sessionId.length>160||
      !Number.isSafeInteger(maxBindings)||maxBindings<1||maxBindings>5120||
      !Number.isSafeInteger(maxCapabilities)||maxCapabilities<1||maxCapabilities>160)
      throw Error('Invalid original observation binding limits');
    this.sessionId=sessionId;this.maxBindings=maxBindings;this.maxCapabilities=maxCapabilities;
  }
  /** Called once for the actual input candidate after it owns this slot. */
  bindInput(saved:SavedAcquisition,group:number,value:ObservationSource):boolean {
    if(this.closed||!createdAcquisitions.has(saved)||!Number.isSafeInteger(group)||group<1||this.seenSources.size>=this.maxBindings)return false;
    const source=observationSource(value);
    if(!source||source.sessionId!==this.sessionId||source.phase!=='input'||source.frameId<1)return false;
    // ObservationExecution identifies an observation by its session and ID;
    // frame, order and geometry changes must not make that ID reusable.
    const sourceKey=source.observationId;
    if(this.seenSources.has(sourceKey))return false;
    const observation=saved.observations[source.slot],cell=saved.cells[source.slot],layout=saved.layout;
    const stamp=cell&&qualityStamp(cell);
    if(!observation||this.seenObservations.has(observation)||!cell||cell.slot!==source.slot||
      !layout||!Array.isArray(layout.cells)||layout.cells.length!==saved.cells.length||layout.cells.length>40||
      !layout.cells[source.slot]||!stamp)return false;
    let receipt:MeasuredSourceRasterReceipt;
    try{receipt=parseMeasuredSourceRasterReceipt(saved.rasterReceipt);}catch{return false;}
    const nominal=layout.cells[source.slot],area=layout.area;
    if(receipt.acquisitionFrameId!==source.frameId||receipt.captureTime!==source.captureTime||
      receipt.width!==saved.width||receipt.height!==saved.height||observation.order!==source.captureOrder||
      typeof observation.stable!=='boolean'||observation.frame!==sourceObservationFrame(this.sessionId,receipt.sourceFrameId,source.frameId)||
      !exactBox(nominal,nominal,saved.width,saved.height)||!exactBox(area,area,saved.width,saved.height)||!inside(nominal,area)||
      !exactBox(cell.content,cell.content,saved.width,saved.height)||!exactBox(cell.preview,cell.preview,saved.width,saved.height))return false;
    let slots=this.bindings.get(saved);
    if(slots?.has(source.slot))return false;
    if(!slots){slots=new Map();this.bindings.set(saved,slots);}
    slots.set(source.slot,Object.freeze({observation,cell,qualityStamp:stamp,source,group,receipt,frame:observation.frame,order:observation.order,
      stable:observation.stable,nominal:Object.freeze({...nominal}),area:Object.freeze({...area}),
      content:Object.freeze({...cell.content}),preview:Object.freeze({...cell.preview})}));
    this.seenObservations.add(observation);this.seenSources.add(sourceKey);this.bound++;return true;
  }
  private matches(saved:SavedAcquisition,slot:number,source:SavedObservationSource,current:OriginalBindingCell,recovery:ObservationSource):BoundOriginal|undefined {
    const original=this.bindings.get(saved)?.get(slot),cell=saved.cells[slot],layout=saved.layout;
    if(this.closed||!original||!cell||!layout||recovery.sessionId!==this.sessionId||recovery.phase!=='recovery'||
      recovery.frameId<1||recovery.frameId===original.source.frameId||recovery.observationId===original.source.observationId||
      recovery.slot!==slot||recovery.captureTime!==original.source.captureTime||recovery.captureOrder!==original.source.captureOrder||
      cell!==original.cell||cell.slot!==slot||current.slot!==slot||qualityStamp(cell)!==original.qualityStamp||!qualityStamp(current)||
      original.observation.order!==original.order||original.observation.frame!==original.frame||original.observation.stable!==original.stable||
      !exactBox(original.nominal,layout.cells?.[slot],saved.width,saved.height)||
      !exactBox(original.area,layout.area,saved.width,saved.height)||
      !exactBox(original.content,cell.content,saved.width,saved.height)||!exactBox(original.preview,cell.preview,saved.width,saved.height)||
      exactSourceSavedObservation(saved,source,current)!==original.observation)return;
    let receipt:MeasuredSourceRasterReceipt;
    try{receipt=parseMeasuredSourceRasterReceipt(saved.rasterReceipt);}catch{return;}
    if(!sameReceipt(original.receipt,receipt))return;
    return original;
  }
  /** Re-check the physical metadata and both crop boxes using the existing
   * prepared-source verifier before returning an in-memory capability. */
  matchRecovery(saved:SavedAcquisition,source:SavedObservationSource,current:OriginalBindingCell,value:ObservationSource):OriginalBindingCapability|undefined {
    const recovery=observationSource(value);
    if(!recovery)return;
    const original=this.matches(saved,recovery.slot,source,current,recovery);
    if(!original)return;
    const stamp=qualityStamp(current);if(!stamp)return;
    // Repeated examination of the same recovery is allowed, but its
    // observation ID can never describe a different input or capture.
    const use=JSON.stringify([original.source.observationId,recovery.frameId,recovery.captureOrder,recovery.captureTime,
      recovery.slot,source.sourceFrameId,source.captureTime,source.width,source.height,source.hash,stamp]);
    if(this.seenSources.has(recovery.observationId)) {
      if(this.recoveryUses.get(recovery.observationId)!==use)return;
    } else {
      if(this.seenSources.size>=this.maxBindings)return;
      this.seenSources.add(recovery.observationId);this.recoveryUses.set(recovery.observationId,use);
    }
    const token=Object.freeze({}) as OriginalBindingCapability;
    this.issued.set(token,{saved:new WeakRef(saved),slot:recovery.slot,recovery,
      source:Object.freeze({sourceFrameId:source.sourceFrameId,captureTime:source.captureTime,width:source.width,height:source.height,hash:source.hash}),
      current:new WeakRef(current),qualityStamp:stamp});
    while(this.issued.size>this.maxCapabilities)this.issued.delete(this.issued.keys().next().value!);
    return token;
  }
  /** A returned description is metadata only. Never treat its clone or a
   * serialized copy as an owned capability or a verified OCR result. */
  read(token:OriginalBindingCapability):OriginalBindingDescription|undefined {
    if(this.closed)return;
    const issued=this.issued.get(token),saved=issued?.saved.deref(),current=issued?.current.deref();
    if(!issued||!saved||!current||qualityStamp(current)!==issued.qualityStamp)return;
    const original=this.matches(saved,issued.slot,issued.source,current,issued.recovery);
    if(!original)return;
    const {sourceFrameId,captureTime,width,height,hash}=original.receipt;
    return Object.freeze({scope:'prepared-source-metadata-only',pixelsAuthenticated:false,
      originalSource:original.source,originalGroup:original.group,recoverySource:issued.recovery,
      physical:Object.freeze({sourceFrameId,captureTime,width,height,hash}),content:original.content,preview:original.preview});
  }
  forget(saved:SavedAcquisition):void {
    const slots=this.bindings.get(saved);if(!slots)return;
    this.bound-=slots.size;this.bindings.delete(saved);
    for(const [token,issued] of this.issued)if(issued.saved.deref()===saved)this.issued.delete(token);
  }
  release(token:OriginalBindingCapability):void {this.issued.delete(token);}
  close():void {this.closed=true;this.bindings=new WeakMap();this.issued.clear();this.seenSources.clear();this.recoveryUses.clear();this.bound=0;}
  get size():number{return this.bound;}
  get capabilities():number{return this.issued.size;}
  get observedSources():number{return this.seenSources.size;}
  get remainingBindings():number{return this.maxBindings-this.seenSources.size;}
}

/** DEV telemetry only: these metadata associations never authorize OCR or completion. */
export class SourceBindingMetadataDiagnostics {
  private readonly bindings:SavedOriginalSourceBindings;
  private counts={inputAttempts:0,inputBound:0,inputUnavailable:0,inputUnavailableAtLimit:0,inputJoinedAtAttempt:0,
    recoveryAttempts:0,recoveryMatched:0,recoveryUnavailable:0,recoveryUnavailableAtLimit:0,
    cachedAttempts:0,reacquiredAttempts:0,cachedMatched:0,reacquiredMatched:0,originalJoinedAtMatch:0,recoveryJoinedAtMatch:0};
  constructor(sessionId:string,maxBindings=5120){this.bindings=new SavedOriginalSourceBindings(sessionId,maxBindings);}
  input(saved:SavedAcquisition|undefined,group:number,source:ObservationSource,joined:boolean):void {
    this.counts.inputAttempts++;if(joined)this.counts.inputJoinedAtAttempt++;
    try{if(saved&&this.bindings.bindInput(saved,group,source)){this.counts.inputBound++;return;}}catch{/* Diagnostic only. */}
    this.counts.inputUnavailable++;if(!this.bindings.remainingBindings)this.counts.inputUnavailableAtLimit++;
  }
  recovery(saved:SavedAcquisition|undefined,physical:SavedObservationSource,current:OriginalBindingCell|undefined,
    source:ObservationSource,path:'cached'|'reacquired',originalJoined:boolean,recoveryJoined:boolean):OriginalBindingDescription|undefined {
    this.counts.recoveryAttempts++;this.counts[path==='cached'?'cachedAttempts':'reacquiredAttempts']++;
    try {
      const token=saved&&current?this.bindings.matchRecovery(saved,physical,current,source):undefined;
      if(token)try {
        const result=this.bindings.read(token);
        if(result){this.counts.recoveryMatched++;this.counts[path==='cached'?'cachedMatched':'reacquiredMatched']++;
          if(originalJoined)this.counts.originalJoinedAtMatch++;if(recoveryJoined)this.counts.recoveryJoinedAtMatch++;return result;}
      }finally{this.bindings.release(token);}
    }catch{/* Diagnostic only. */}
    this.counts.recoveryUnavailable++;if(!this.bindings.remainingBindings)this.counts.recoveryUnavailableAtLimit++;
  }
  snapshot(){return {scope:'prepared-source-metadata-only' as const,pixelsAuthenticated:false as const,...this.counts,
    bindingsIssuedNotForgotten:this.bindings.size,observedSources:this.bindings.observedSources,remainingBindings:this.bindings.remainingBindings,
    capabilities:this.bindings.capabilities};}
  close(){this.bindings.close();}
}

/** Use only the actual result of exactSourceSavedObservation as `verified`.
 * The caller must obtain its hash from the verified prepared recovery path;
 * this function does not authenticate arbitrary supplied objects or pixels. */
export function canReuseVerifiedRecovery(input:{
  verified:SavedObservation|undefined;saved:SavedObservation|undefined;
  identity:{id:string;name:string;review:readonly string[]};source:InventorySource;
  inventory:InventoryEvidence;freshnessSettled:boolean;obstructionNeedsProof:boolean;
}):boolean {
  const {verified,saved,identity,source,inventory}=input;
  return !!verified&&verified===saved&&!!saved.identity&&source.phase==='recovery'&&
    saved.identity.id===identity.id&&saved.identity.name===identity.name&&!saved.identity.review.length&&!identity.review.length&&
    input.freshnessSettled===true&&input.obstructionNeedsProof===false&&
    inventory.hasConfirmedInputForRecovery(identity.id,identity.name,source);
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
