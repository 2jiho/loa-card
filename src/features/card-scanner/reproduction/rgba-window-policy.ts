/** Version gate, explicit RGBA working-window ledger and dependency admission. */
export const RGBA_WINDOW_VERSION=6 as const;
export const RGBA_WINDOW_CODEC='lz4-rgba-window-v1' as const;
export const RGBA_WINDOW_POLICY='rgba-window-32m-eight-v1' as const;
export const RGBA_WINDOW_LIMITS=Object.freeze({workingSetBytes:32*1024*1024,maxChainFrames:8,
  historyBytes:65536,matchScratchBytes:16384,inputBytes:32768,headerBytes:13,
  outerBytes:2*1024*1024,hashBytes:256*1024,maxLegacyFrameBytes:64*1024*1024});

export interface WindowPolicy {
  readonly kind:'rgba-window';readonly version:6;
  readonly codec:typeof RGBA_WINDOW_CODEC;readonly policy:typeof RGBA_WINDOW_POLICY;
}
export interface LegacyPolicy {readonly kind:'legacy-sum';readonly version:1|2|3|4|5}
export type ReplayPolicy=WindowPolicy|LegacyPolicy;
export interface WindowWorkingSet {
  readonly rgbaBytes:number;readonly decoderOwnedBytes:number;readonly publishedCopyBytes:number;
  readonly outerBytes:number;readonly hashBytes:number;readonly totalBytes:number;
  readonly limitBytes:number;readonly admitted:boolean;
}
export interface WindowFrame {
  readonly kind:'frame';readonly id:number;readonly time:number;readonly width:number;readonly height:number;
  readonly key:boolean;readonly hash:string;readonly canonical:true;readonly codec:typeof RGBA_WINDOW_CODEC;
  readonly policy:typeof RGBA_WINDOW_POLICY;readonly xor?:boolean;readonly phase?:'input'|'recovery';
}
export interface DependencyState {
  readonly policy:'rgba-window-32m-eight-v1'|'legacy-rgba-sum-32m-eight';
  readonly lastFrameId:number;readonly keyFrameId:number;readonly width:number;readonly height:number;
  readonly chainFrames:number;readonly historicalRgbaWorkBytes:number;
}
export interface WindowAdmission {
  readonly frame:WindowFrame;readonly state:DependencyState;readonly workingSet:WindowWorkingSet;
}
function bad(message:string):never {throw new TypeError(`Invalid RGBA window policy: ${message}`);}
const natural=(value:unknown,min=0):value is number=>typeof value==='number'&&Number.isSafeInteger(value)&&value>=min;
const own=(value:object,key:string):boolean=>Object.hasOwn(value,key);

/** Do not invoke untrusted accessors. Full application metadata validation is a
 * separate caller responsibility; this helper validates only the format gate. */
function record(value:unknown,label:string):Record<string,unknown> {
  if(!value||typeof value!=='object'||Array.isArray(value)||
    ![Object.prototype,null].includes(Object.getPrototypeOf(value)))bad(label);
  for(const key of Reflect.ownKeys(value as object)){
    const descriptor=Object.getOwnPropertyDescriptor(value as object,key)!;
    if(typeof key!=='string'||!('value'in descriptor))bad(`${label} accessor/symbol`);
  }
  return value as Record<string,unknown>;
}
function absent(value:Record<string,unknown>,keys:readonly string[],label:string):void {
  for(const key of keys)if(key in value)bad(`${label}: ${key} must be absent`);
}
function field(value:Record<string,unknown>,key:string):unknown {
  if(!own(value,key)){if(key in value)bad(`inherited ${key}`);return undefined;}
  return Object.getOwnPropertyDescriptor(value,key)!.value;
}
const WINDOW_POLICY:WindowPolicy=Object.freeze({kind:'rgba-window',version:6,codec:RGBA_WINDOW_CODEC,policy:RGBA_WINDOW_POLICY});

/** Outer v6 tags live at exact.codec/exact.policy. Every inner frame must repeat
 * both. A downgraded outer version must not silently select the legacy reader. */
export function parseReplayPolicy(value:unknown):ReplayPolicy {
  const outer=record(value,'outer metadata'),version=field(outer,'version');
  if(!natural(version,1)||version>6)bad('unsupported replay version');
  absent(outer,['codec','policy','storage','storageVersion'],'outer placement');
  const exactValue=field(outer,'exact');
  const exact=exactValue===undefined?undefined:record(exactValue,'exact metadata');
  if(version!==6){
    if(exact)absent(exact,['codec','policy'],'legacy policy tags');
    return Object.freeze({kind:'legacy-sum',version:version as LegacyPolicy['version']});
  }
  if(!exact||field(exact,'canonical')!==true||field(exact,'codec')!==RGBA_WINDOW_CODEC||
    field(exact,'policy')!==RGBA_WINDOW_POLICY)bad('v6 exact tags');
  absent(exact,['storage','storageVersion','nativeFrames','rgbaFrames','nativeAttestedFrames','nativeAttestationBudget'],'v6 RGBA only');
  return WINDOW_POLICY;
}
function requireWindowPolicy(value:WindowPolicy):void {
  const policy=record(value,'selected policy');
  if(Reflect.ownKeys(policy).length!==4||field(policy,'kind')!=='rgba-window'||field(policy,'version')!==6||
    field(policy,'codec')!==RGBA_WINDOW_CODEC||field(policy,'policy')!==RGBA_WINDOW_POLICY)bad('selected policy mismatch');
}
function rgbaBytes(width:unknown,height:unknown):number {
  if(!natural(width,1)||!natural(height,1)||width>RGBA_WINDOW_LIMITS.maxLegacyFrameBytes/4||
    height>RGBA_WINDOW_LIMITS.maxLegacyFrameBytes/4)bad('dimensions');
  const bytes=width*height*4;
  if(!natural(bytes,4)||bytes>RGBA_WINDOW_LIMITS.maxLegacyFrameBytes)bad('RGBA byte limit');
  return bytes;
}
/** Counts current decoder buffers plus one in-flight output-copy reservation.
 * Earlier immutable outputs retained by consumers, native/GC allocations and
 * total process memory are outside this ledger; this API does not restrict a
 * consumer's retention. A random reader can instead transfer its stored target
 * without making an output copy, so that route may use less than this reserve. */
export function windowWorkingSet(width:number,height:number):WindowWorkingSet {
  const bytes=rgbaBytes(width,height),limits=RGBA_WINDOW_LIMITS;
  const decoderOwnedBytes=bytes+limits.historyBytes+limits.matchScratchBytes+limits.inputBytes+limits.headerBytes;
  const totalBytes=decoderOwnedBytes+bytes+limits.outerBytes+limits.hashBytes;
  return Object.freeze({rgbaBytes:bytes,decoderOwnedBytes,publishedCopyBytes:bytes,outerBytes:limits.outerBytes,
    hashBytes:limits.hashBytes,totalBytes,limitBytes:limits.workingSetBytes,admitted:totalBytes<=limits.workingSetBytes});
}
const FRAME_FIELDS=['kind','id','time','width','height','key','hash','canonical','codec','policy','xor','phase'];
function commonFrame(value:unknown):Record<string,unknown> {
  const frame=record(value,'frame');
  if(Reflect.ownKeys(frame).some(key=>!FRAME_FIELDS.includes(key as string)))bad('unknown frame field');
  if(field(frame,'kind')!=='frame'||!natural(field(frame,'id'),1)||typeof field(frame,'time')!=='number'||
    !Number.isFinite(field(frame,'time'))||(field(frame,'time') as number)<0||typeof field(frame,'key')!=='boolean'||
    field(frame,'canonical')!==true||typeof field(frame,'hash')!=='string'||!/^[a-f0-9]{64}$/.test(field(frame,'hash') as string))bad('frame metadata');
  rgbaBytes(field(frame,'width'),field(frame,'height'));
  if(own(frame,'xor')&&typeof field(frame,'xor')!=='boolean'||
    own(frame,'phase')&&!['input','recovery'].includes(field(frame,'phase') as string))bad('optional frame field');
  return frame;
}
export function parseWindowFrame(value:unknown,payloadBytes:number,selected:WindowPolicy):WindowFrame {
  requireWindowPolicy(selected);
  const frame=commonFrame(value);
  if(field(frame,'codec')!==selected.codec||field(frame,'policy')!==selected.policy)bad('outer/inner codec-policy conflict');
  const budget=windowWorkingSet(frame.width as number,frame.height as number);
  if(!budget.admitted)bad('working set exceeds 32 MiB');
  const maximum=budget.rgbaBytes+Math.ceil(budget.rgbaBytes/16384)*8+4+5;
  if(!natural(payloadBytes,9)||payloadBytes>maximum)bad('fast wrapper payload length');
  return Object.freeze({...frame}) as unknown as WindowFrame;
}
const STATE_FIELDS=['policy','lastFrameId','keyFrameId','width','height','chainFrames','historicalRgbaWorkBytes'];
function previousState(value:DependencyState|null,expected:DependencyState['policy']):DependencyState|null {
  if(value===null)return null;
  const state=record(value,'dependency state');
  if(Reflect.ownKeys(state).length!==STATE_FIELDS.length||STATE_FIELDS.some(key=>!own(state,key))||
    field(state,'policy')!==expected||!natural(field(state,'lastFrameId'),1)||!natural(field(state,'keyFrameId'),1)||
    (state.keyFrameId as number)>(state.lastFrameId as number)||!natural(field(state,'chainFrames'),1)||
    (state.chainFrames as number)>RGBA_WINDOW_LIMITS.maxChainFrames)bad('dependency state mismatch');
  if((state.chainFrames===1&&state.keyFrameId!==state.lastFrameId)||
    (state.lastFrameId as number)-(state.keyFrameId as number)<(state.chainFrames as number)-1)bad('dependency frame span');
  // These numeric constraints are consistency guards, not proof that an archive
  // actually contains the claimed key/ancestors. A validated index supplies that.
  const bytes=rgbaBytes(field(state,'width'),field(state,'height'));
  if(field(state,'historicalRgbaWorkBytes')!==bytes*(state.chainFrames as number))bad('historical work state');
  if(expected===RGBA_WINDOW_POLICY&&!windowWorkingSet(state.width as number,state.height as number).admitted)bad('previous working set');
  if(expected==='legacy-rgba-sum-32m-eight'&&(state.chainFrames as number)>1&&
    (state.historicalRgbaWorkBytes as number)>RGBA_WINDOW_LIMITS.workingSetBytes)bad('previous legacy SUM');
  return value;
}
function nextState(previous:DependencyState|null,frame:Record<string,unknown>|WindowFrame,
  policy:DependencyState['policy']):DependencyState {
  const old=previousState(previous,policy),id=frame.id as number,key=frame.key as boolean;
  if(old&&id<=old.lastFrameId)bad('frame order');
  if(!key&&(!old||old.width!==frame.width||old.height!==frame.height))bad('missing matching key');
  const chainFrames=key?1:old!.chainFrames+1;
  if(chainFrames>RGBA_WINDOW_LIMITS.maxChainFrames)bad('dependency exceeds key plus seven deltas');
  const bytes=rgbaBytes(frame.width,frame.height),historicalRgbaWorkBytes=bytes*chainFrames;
  if(policy==='legacy-rgba-sum-32m-eight'&&chainFrames>1&&historicalRgbaWorkBytes>RGBA_WINDOW_LIMITS.workingSetBytes)
    bad('legacy SUM exceeds 32 MiB');
  return Object.freeze({policy,lastFrameId:id,keyFrameId:key?id:old!.keyFrameId,width:frame.width as number,
    height:frame.height as number,chainFrames,historicalRgbaWorkBytes});
}
export function admitWindowFrame(selected:WindowPolicy,previous:DependencyState|null,value:unknown,payloadBytes:number):WindowAdmission {
  const frame=parseWindowFrame(value,payloadBytes,selected);
  return Object.freeze({frame,state:nextState(previous,frame,RGBA_WINDOW_POLICY),workingSet:windowWorkingSet(frame.width,frame.height)});
}
/** Legacy canonical RGBA accounting only. Native-storage and noncanonical paths
 * remain with their existing production readers; they are not silently upgraded. */
export function admitLegacyRgbaFrame(previous:DependencyState|null,value:unknown):DependencyState {
  const frame=commonFrame(value);
  absent(frame,['policy'],'legacy policy');
  if(field(frame,'codec')!==undefined&&field(frame,'codec')!=='lz4')bad('legacy codec');
  return nextState(previous,frame,'legacy-rgba-sum-32m-eight');
}
