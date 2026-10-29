import {parseSourceFrameCorrelation,type SourceFrameCorrelation} from './source-frame-correlation';
import {frameDecodeWorkBytes,frameStorageSignature,parseFrameStorage} from './native-frame-storage';
import type {FrameStorage} from './native-frame-storage';
import {RGBA_WINDOW_CODEC,RGBA_WINDOW_POLICY,windowWorkingSet} from './rgba-window-policy';

export type CanonicalFrameRole='input'|'backup'|'recovery';
export interface CanonicalFrameCommit {
  /** Identity assigned to the immutable source, before asynchronous transport. */
  readonly sourceFrameId:number;
  /** Physical archive order, assigned only when the frame is committed. */
  readonly frameId:number;
  readonly offset:number;
  readonly endOffset:number;
  readonly width:number;
  readonly height:number;
  readonly captureTime:number;
  readonly arrivalOrder:number;
  readonly key:boolean;
  readonly pixelHash:string;
  readonly role:CanonicalFrameRole;
  readonly source?:SourceFrameCorrelation;
  readonly storage?:FrameStorage;
  readonly codec?:typeof RGBA_WINDOW_CODEC;
  readonly policy?:typeof RGBA_WINDOW_POLICY;
}
export type CanonicalFrameDescriptor=Readonly<Omit<CanonicalFrameCommit,'role'> & {
  readonly roles:readonly CanonicalFrameRole[];
  /** Opaque reference only. Mutable analysis/crops live outside this index. */
  readonly analysisReceiptId?:number;
}>;
export interface CanonicalDecodeRange {
  readonly sourceFrameId:number;
  readonly frameId:number;
  readonly keyFrameId:number;
  readonly offset:number;
  readonly endOffset:number;
  readonly frameIds:readonly number[];
  /** Conservative stored-byte plus RGBA restoration work for native frames;
   * legacy RGBA accounting is unchanged. Not simultaneous process memory. */
  readonly decodeBytes:number;
  /** Window-only simultaneous explicit buffer reservation; decodeBytes retains
   * its historical cumulative work meaning even when this is present. */
  readonly workingSetBytes?:number;
  readonly codec?:typeof RGBA_WINDOW_CODEC;
  readonly policy?:typeof RGBA_WINDOW_POLICY;
}
export interface CanonicalFrameIndexOptions {
  readonly maxEntries?:number;
  readonly maxArchiveBytes?:number;
  readonly maxDeltaFrames?:number;
  readonly maxDecodeBytes?:number;
  readonly codecPolicy?:typeof RGBA_WINDOW_POLICY;
}

const ROLES:readonly CanonicalFrameRole[]=['input','backup','recovery'];
const natural=(value:unknown,minimum=0):value is number=>Number.isSafeInteger(value)&&(value as number)>=minimum;
function role(value:unknown):asserts value is CanonicalFrameRole {
  if(!ROLES.includes(value as CanonicalFrameRole))throw new TypeError('Invalid canonical frame role');
}
function sourceId(value:unknown):asserts value is number {
  if(!natural(value,1))throw new TypeError('Invalid canonical source frame identity');
}
function committed(input:CanonicalFrameCommit,codecPolicy:typeof RGBA_WINDOW_POLICY|undefined):CanonicalFrameDescriptor {
  if(!input||typeof input!=='object'||Array.isArray(input)||
    ![Object.prototype,null].includes(Object.getPrototypeOf(input))||Object.keys(input).some(key=>
      !['sourceFrameId','frameId','offset','endOffset','width','height','captureTime','arrivalOrder','key','pixelHash','role','source','storage','codec','policy'].includes(key)))
    throw new TypeError('Invalid canonical frame metadata');
  if(codecPolicy&&Reflect.ownKeys(input).some(key=>typeof key!=='string'||
    !('value'in Object.getOwnPropertyDescriptor(input,key)!)))throw new TypeError('Invalid canonical window metadata accessor');
  sourceId(input.sourceFrameId);
  if(!natural(input.frameId,1)||!natural(input.offset)||!natural(input.endOffset,1)||input.endOffset<=input.offset||
    typeof input.captureTime!=='number'||!Number.isFinite(input.captureTime)||input.captureTime<0||
    !natural(input.arrivalOrder)||typeof input.key!=='boolean'||typeof input.pixelHash!=='string'||!/^[a-f0-9]{64}$/.test(input.pixelHash))
    throw new TypeError('Invalid canonical frame metadata');
  frameDecodeWorkBytes(input.storage,input.width,input.height);
  const storage=input.storage===undefined?undefined:parseFrameStorage(input.storage,input.width,input.height);
  if(codecPolicy===RGBA_WINDOW_POLICY){
    if(Object.hasOwn(input,'storage')||input.codec!==RGBA_WINDOW_CODEC||input.policy!==RGBA_WINDOW_POLICY)
      throw new TypeError('Canonical window codec and policy mismatch');
    if(!windowWorkingSet(input.width,input.height).admitted)throw new RangeError('Canonical window working set exceeds 32 MiB');
  }else if(Object.hasOwn(input,'codec')||Object.hasOwn(input,'policy'))throw new TypeError('Canonical legacy index cannot accept window metadata');
  role(input.role);
  const source=input.source===undefined?undefined:parseSourceFrameCorrelation(input.source);
  return Object.freeze({sourceFrameId:input.sourceFrameId,frameId:input.frameId,offset:input.offset,endOffset:input.endOffset,
    width:input.width,height:input.height,captureTime:input.captureTime,arrivalOrder:input.arrivalOrder,
    key:input.key,pixelHash:input.pixelHash,roles:Object.freeze([input.role]),...(source?{source}:{}),...(storage?{storage}:{}),
    ...(codecPolicy?{codec:RGBA_WINDOW_CODEC,policy:codecPolicy}:{})});
}

/** Bounded metadata for an append-only lossless archive. This owns neither
 * pixels nor files and never infers identity from matching hashes/artwork.
 * There is deliberately no eviction: once full, append fails before mutation.
 * The writer must separately bound the whole archive, including trailing events. */
export class CanonicalFrameIndex {
  private readonly maxEntries:number;
  private readonly maxArchiveBytes:number;
  private readonly maxDeltaFrames:number;
  private readonly maxDecodeBytes:number;
  private readonly codecPolicy:typeof RGBA_WINDOW_POLICY|undefined;
  private readonly entries:CanonicalFrameDescriptor[]=[];
  private readonly sources=new Map<number,number>();
  private readonly physicalFrames=new Map<number,number>();
  private readonly keys:number[]=[];
  private readonly decodeBytes:number[]=[];
  private indexedBytes=0;

  constructor(options:CanonicalFrameIndexOptions={}) {
    this.maxEntries=options.maxEntries??10_000;
    this.maxArchiveBytes=options.maxArchiveBytes??1024*1024*1024;
    this.maxDeltaFrames=options.maxDeltaFrames??7;
    this.maxDecodeBytes=options.maxDecodeBytes??32*1024*1024;
    this.codecPolicy=options.codecPolicy;
    if(!natural(this.maxEntries,1)||this.maxEntries>100_000||!natural(this.maxArchiveBytes,1)||
      !natural(this.maxDeltaFrames)||this.maxDeltaFrames>7||!natural(this.maxDecodeBytes,1)||this.maxDecodeBytes>32*1024*1024||
      this.codecPolicy!==undefined&&this.codecPolicy!==RGBA_WINDOW_POLICY||
      this.codecPolicy===RGBA_WINDOW_POLICY&&options.maxDecodeBytes!==undefined&&options.maxDecodeBytes!==32*1024*1024)
      throw new TypeError('Invalid canonical frame index limits');
  }
  /** Call before compression. A large single key may exceed the chain byte
   * budget, but a delta never extends such a frame into an unbounded chain. */
  keyRequired(width:number,height:number,storage?:FrameStorage):boolean {
    if(this.codecPolicy){
      if(storage!==undefined)throw new TypeError('Canonical window storage must be RGBA');
      if(!windowWorkingSet(width,height).admitted)throw new RangeError('Canonical window working set exceeds 32 MiB');
    }
    const bytes=frameDecodeWorkBytes(storage,width,height),signature=frameStorageSignature(storage,width,height),
      previous=this.entries.at(-1),last=this.entries.length-1;
    return !previous||previous.width!==width||previous.height!==height||
      frameStorageSignature(previous.storage,previous.width,previous.height)!==signature||
      this.entries.length-this.keys[last]>this.maxDeltaFrames||!this.codecPolicy&&this.decodeBytes[last]+bytes>this.maxDecodeBytes;
  }
  append(input:CanonicalFrameCommit):CanonicalFrameDescriptor {
    const value=committed(input,this.codecPolicy),previous=this.entries.at(-1);
    if(this.sources.has(value.sourceFrameId))throw new Error('Canonical source frame was already committed');
    if(previous&&(value.frameId<=previous.frameId||value.offset<previous.endOffset))
      throw new Error('Canonical archive frame order or byte range conflict');
    if(previous&&(previous.storage===undefined)!==(value.storage===undefined))
      throw new Error('Canonical compact and legacy frame storage cannot be mixed');
    if(!value.key&&this.keyRequired(value.width,value.height,value.storage))
      throw new Error('Canonical delta requires a matching bounded keyframe');
    if(this.entries.length>=this.maxEntries||value.endOffset>this.maxArchiveBytes)
      throw new RangeError('Canonical frame index capacity exceeded');
    const index=this.entries.length;
    this.sources.set(value.sourceFrameId,index);this.physicalFrames.set(value.frameId,index);this.entries.push(value);
    this.keys.push(value.key?index:this.keys[index-1]);this.indexedBytes+=value.endOffset-value.offset;
    this.decodeBytes.push(frameDecodeWorkBytes(value.storage,value.width,value.height)+(value.key?0:this.decodeBytes[index-1]));
    return value;
  }
  get(sourceFrameId:number):CanonicalFrameDescriptor|undefined {
    sourceId(sourceFrameId);
    const index=this.sources.get(sourceFrameId);
    return index===undefined?undefined:this.entries[index];
  }
  /** Physical wire-order lookup. get() deliberately remains a source-ID lookup. */
  getByFrameId(frameId:number):CanonicalFrameDescriptor|undefined {
    sourceId(frameId);
    const index=this.physicalFrames.get(frameId);
    return index===undefined?undefined:this.entries[index];
  }
  private require(sourceFrameId:number):number {
    sourceId(sourceFrameId);
    const index=this.sources.get(sourceFrameId);
    if(index===undefined)throw new RangeError('Unknown canonical source frame');
    return index;
  }
  /** Reusing a source for recovery changes its role, never its archived pixels. */
  addRole(sourceFrameId:number,nextRole:CanonicalFrameRole):CanonicalFrameDescriptor {
    role(nextRole);
    const index=this.require(sourceFrameId),old=this.entries[index];
    if(old.roles.includes(nextRole))return old;
    const roles=Object.freeze(ROLES.filter(value=>value===nextRole||old.roles.includes(value)));
    return this.entries[index]=Object.freeze({...old,roles});
  }
  attachAnalysisReceipt(sourceFrameId:number,receiptId:number):CanonicalFrameDescriptor {
    if(!natural(receiptId,1))throw new TypeError('Invalid canonical analysis receipt');
    const index=this.require(sourceFrameId),old=this.entries[index];
    if(old.analysisReceiptId===receiptId)return old;
    // Analysis is an optional cache reference, not source identity or freshness
    // proof. Reanalysis can replace it without changing an earlier snapshot.
    return this.entries[index]=Object.freeze({...old,analysisReceiptId:receiptId});
  }
  /** A finite immutable cut. New recovery appends/roles/receipts cannot extend
   * or mutate an in-progress original iterator that uses this snapshot. */
  snapshotOriginals():readonly CanonicalFrameDescriptor[] {
    return Object.freeze(this.entries.filter(value=>value.roles.includes('input')||value.roles.includes('backup'))
      .sort((a,b)=>a.captureTime-b.captureTime||a.arrivalOrder-b.arrivalOrder||a.frameId-b.frameId));
  }
  /** Decode sequentially from this key through the requested physical entry.
   * Event entries between these offsets may be skipped by the pixel decoder. */
  decodeRange(sourceFrameId:number):CanonicalDecodeRange {
    const index=this.require(sourceFrameId),value=this.entries[index],keyIndex=this.keys[index],key=this.entries[keyIndex];
    return Object.freeze({sourceFrameId:value.sourceFrameId,frameId:value.frameId,keyFrameId:key.frameId,
      offset:key.offset,endOffset:value.endOffset,frameIds:Object.freeze(this.entries.slice(keyIndex,index+1).map(frame=>frame.frameId)),
      decodeBytes:this.decodeBytes[index],...(this.codecPolicy?{codec:RGBA_WINDOW_CODEC,policy:this.codecPolicy,
        workingSetBytes:windowWorkingSet(value.width,value.height).totalBytes}:{})});
  }
  stats() {
    return Object.freeze({entries:this.entries.length,indexedFrameBytes:this.indexedBytes,indexedEndOffset:this.entries.at(-1)?.endOffset??0,
      maxEntries:this.maxEntries,maxArchiveBytes:this.maxArchiveBytes,maxDeltaFrames:this.maxDeltaFrames,maxDecodeBytes:this.maxDecodeBytes,
      ...(this.codecPolicy?{codec:RGBA_WINDOW_CODEC,policy:this.codecPolicy,maxWorkingSetBytes:32*1024*1024}:{})});
  }
}
