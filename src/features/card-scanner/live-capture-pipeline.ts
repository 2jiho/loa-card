import type {InputStamp} from './live-input-admission';
import {parseSourceFrameCorrelation,type SourceFrameCorrelation} from './source-frame-correlation';

type DecisionStamp={seq:number;atMs:number};
type FrameIdentity={inputId:number;captureTime:number};
export type LiveCaptureReleaseReason='normal'|'replaced'|'disposed'|'error'|'rejected'|'capacity';
/** A selection hint belongs to the same immutable raster. It is never card,
 * absolute-position or completion evidence. rowStart is zero-based. */
export interface LiveCaptureSelection {readonly rowStart:number;readonly rowCount:number}
type CommonDecision=
  | {kind:'replaced';oldInputId:number;newInputId:number}
  | ({kind:'started'}&FrameIdentity)
  | ({kind:'finished';outcome:'completed'|'error'}&FrameIdentity);
type OfferIdentity={kind:'offered';observedAtMs:number}&FrameIdentity;
type ReleaseDecision<R extends LiveCaptureReleaseReason>={kind:'released';reason:R;failed:boolean}&FrameIdentity;
type VersionTwoOffer=OfferIdentity&{selection:LiveCaptureSelection|null;estimatedBytes:number;
  maxPendingFrames:1|2;maxRetainedBytes:number;source?:SourceFrameCorrelation};
export type LiveCaptureDecision=Readonly<DecisionStamp & (
  | ({version:1}&(OfferIdentity|CommonDecision|ReleaseDecision<Exclude<LiveCaptureReleaseReason,'capacity'>>))
  | ({version:2}&(VersionTwoOffer|CommonDecision|ReleaseDecision<LiveCaptureReleaseReason>))
)>;
type DecisionValue=VersionTwoOffer|CommonDecision|ReleaseDecision<LiveCaptureReleaseReason>;

function selectionCopy(input:unknown):LiveCaptureSelection {
  if(!input||typeof input!=='object'||Array.isArray(input)||![Object.prototype,null].includes(Object.getPrototypeOf(input)))
    throw new TypeError('Invalid input selection hint');
  const value=input as Record<string,unknown>;
  if(Object.keys(value).some(key=>key!=='rowStart'&&key!=='rowCount')||
    !Number.isSafeInteger(value.rowStart)||(value.rowStart as number)<0||
    !Number.isSafeInteger(value.rowCount)||(value.rowCount as number)<1||
    (value.rowStart as number)+(value.rowCount as number)>1_000_000)
    throw new TypeError('Invalid input selection range');
  return Object.freeze({rowStart:value.rowStart as number,rowCount:value.rowCount as number});
}

/** Validate only serialized metadata. Resource ownership stays with the runner.
 * Version 1 remains strict and retains its original latest-only contract. */
export function parseLiveCaptureDecision(input:unknown):LiveCaptureDecision {
  if(!input||typeof input!=='object'||Array.isArray(input)||![Object.prototype,null].includes(Object.getPrototypeOf(input)))
    throw new TypeError('Invalid input pipeline decision');
  const value=input as Record<string,unknown>;
  const finite=(field:string)=>{if(typeof value[field]!=='number'||!Number.isFinite(value[field])||(value[field] as number)<0)throw new TypeError('Invalid decision time');};
  const id=(field:string)=>{if(!Number.isSafeInteger(value[field])||(value[field] as number)<1)throw new TypeError('Invalid decision identity');};
  if(value.version!==1&&value.version!==2)throw new TypeError('Invalid decision version');
  id('seq');finite('atMs');
  const base={version:value.version as 1|2,seq:value.seq as number,atMs:value.atMs as number};
  let result:LiveCaptureDecision,keys:string[];
  if(value.kind==='replaced'){
    id('oldInputId');id('newInputId');
    if((value.oldInputId as number)>=(value.newInputId as number))throw new TypeError('Invalid replacement identities');
    keys=['oldInputId','newInputId'];
    result={...base,kind:'replaced',oldInputId:value.oldInputId as number,newInputId:value.newInputId as number};
  }else{
    id('inputId');finite('captureTime');keys=['inputId','captureTime'];
    const identity={inputId:value.inputId as number,captureTime:value.captureTime as number};
    if(value.kind==='offered'){
      finite('observedAtMs');keys.push('observedAtMs');
      const offered={kind:'offered' as const,...identity,observedAtMs:value.observedAtMs as number};
      if(value.version===1)result={...base,version:1,...offered};
      else{
        id('estimatedBytes');id('maxRetainedBytes');
        if(value.maxPendingFrames!==1&&value.maxPendingFrames!==2||(value.maxRetainedBytes as number)>=Number.MAX_SAFE_INTEGER)
          throw new TypeError('Invalid input selection budget');
        const selection=value.selection===null?null:selectionCopy(value.selection);
        const source=value.source===undefined?undefined:parseSourceFrameCorrelation(value.source);
        keys.push('selection','estimatedBytes','maxPendingFrames','maxRetainedBytes','source');
        result={...base,version:2,...offered,selection,estimatedBytes:value.estimatedBytes as number,
          maxPendingFrames:value.maxPendingFrames,maxRetainedBytes:value.maxRetainedBytes as number,...(source?{source}:{})};
      }
    }else if(value.kind==='started')result={...base,kind:'started',...identity};
    else if(value.kind==='finished'){
      if(value.outcome!=='completed'&&value.outcome!=='error')throw new TypeError('Invalid decision outcome');
      keys.push('outcome');result={...base,kind:'finished',...identity,outcome:value.outcome};
    }else if(value.kind==='released'){
      const reasons:readonly string[]=value.version===1?['normal','replaced','disposed','error','rejected']:['normal','replaced','disposed','error','rejected','capacity'];
      if(!reasons.includes(value.reason as string)||typeof value.failed!=='boolean')throw new TypeError('Invalid release decision');
      keys.push('reason','failed');
      result={...base,kind:'released',...identity,reason:value.reason as LiveCaptureReleaseReason,failed:value.failed} as LiveCaptureDecision;
    }else throw new TypeError('Unknown input pipeline decision');
  }
  if(Object.keys(value).some(key=>!['version','seq','atMs','kind',...keys].includes(key)))throw new TypeError('Unexpected decision field');
  return Object.freeze(result);
}

export interface LiveCapturePipelineOptions<T> {
  consume(frame:T,capturedAt:number):void|Promise<void>;
  /** Synchronously release an owned frame. The consumer must not release it. */
  release(frame:T):void;
  /** Yield to a later task/render opportunity before starting heavy work. */
  yieldTask():Promise<void>;
  onError(error:unknown):void;
  /** Bound representatives; one preserves the former latest-only strategy. */
  maxPendingFrames?:1|2;
  /** Estimated active + pending raster bytes. The incoming transient is separate. */
  maxRetainedBytes?:number;
  /** Supply width*height*4 for raster resources; abstract resources default to 1. */
  frameBytes?(frame:T):number;
  /** Optional caller-owned session clock. Used only for decision recording. */
  now?():number;
  onDecision?(event:LiveCaptureDecision):void|Promise<void>;
  /** Recording loss does not stop capture or alter owned-frame cleanup. */
  onRecordError?(error:unknown):void|Promise<void>;
}

export interface LiveCapturePipeline<T> {
  readonly busy:boolean;
  /** Transfer an already frozen frame and its capture timestamp together. */
  offer(frame:T,capturedAt:number,stamp?:InputStamp,hint?:LiveCaptureSelection):void;
  /** Drain accepted work, including retained representative frames. */
  flush():Promise<void>;
  /** Reject future input and release pending input; an active consumer may finish. */
  dispose():void;
}

/** Count a union of hint intervals, rather than adding overlapping views. */
function coveredRows(hints:readonly LiveCaptureSelection[]):number {
  const ranges=hints.map(hint=>[hint.rowStart,hint.rowStart+hint.rowCount]).sort((a,b)=>a[0]-b[0]);
  let total=0,end=-Infinity;
  for(const [start,last]of ranges){total+=Math.max(0,last-Math.max(start,end));end=Math.max(end,last);}
  return total;
}

/** One active frame plus at most two pending representatives. Input freezing
 * stays on the callback; heavy consumption starts only after it returns. A
 * distinct row range may survive an overload; hints never become OCR evidence. */
export function createLiveCapturePipeline<T>(options:LiveCapturePipelineOptions<T>):LiveCapturePipeline<T> {
  const maxPendingFrames=options.maxPendingFrames??2,maxRetainedBytes=options.maxRetainedBytes??64*1024*1024;
  if((maxPendingFrames!==1&&maxPendingFrames!==2)||!Number.isSafeInteger(maxRetainedBytes)||maxRetainedBytes<1||maxRetainedBytes>=Number.MAX_SAFE_INTEGER)
    throw new TypeError('Invalid capture retention budget');
  type Entry={frame:T;capturedAt:number;inputId:number;estimatedBytes:number;selection:LiveCaptureSelection|null};
  let pending:Entry[]=[],active:Entry|undefined;
  let running=false,scheduled=false,stopped=false,failed=false;
  let nextInputId=0,sequence=0,lastDecisionAt=-Infinity,recordFailed=false;
  const recordError=(error:unknown)=>{
    if(recordFailed)return;recordFailed=true;
    try{void Promise.resolve(options.onRecordError?.(error)).catch(()=>{});}catch{}
  };
  const record=(value:DecisionValue|((atMs:number)=>DecisionValue))=>{
    if(!options.onDecision||recordFailed)return;
    try{
      const atMs=options.now?.()??performance.now();
      if(!Number.isFinite(atMs)||atMs<0||atMs<lastDecisionAt)throw new Error('Invalid input decision clock');
      lastDecisionAt=atMs;
      const event=Object.freeze({...(typeof value==='function'?value(atMs):value),version:2 as const,seq:++sequence,atMs});
      void Promise.resolve(options.onDecision(event)).catch(recordError);
    }catch(error){recordError(error);}
  };
  const identity=(entry:Entry):FrameIdentity=>({inputId:entry.inputId,captureTime:entry.capturedAt});
  let drained:Promise<void>|undefined,resolveDrained:(()=>void)|undefined;
  const busy=()=>running||pending.length>0;
  const settle=()=>{
    if(busy())return;
    const resolve=resolveDrained;
    drained=undefined;resolveDrained=undefined;resolve?.();
  };
  const release=(entry:Entry,reason:LiveCaptureReleaseReason)=>{
    let releaseFailed=false;
    try{options.release(entry.frame);}catch(error){releaseFailed=true;fail(error);}
    finally{record({kind:'released',...identity(entry),reason,failed:releaseFailed});}
  };
  const dropPending=(reason:LiveCaptureReleaseReason)=>{
    const old=pending;pending=[];
    for(const entry of old)release(entry,reason);
  };
  const fail=(error:unknown)=>{
    if(failed)return;
    failed=true;stopped=true;dropPending('error');
    // Even failing reporting/cleanup callbacks must not orphan a frozen input.
    try{void Promise.resolve(options.onError(error)).catch(()=>{});}catch{}
    settle();
  };
  const start=()=>{
    if(stopped||scheduled||running||pending.length===0)return;
    scheduled=true;
    void Promise.resolve().then(async()=>{
      try{
        await options.yieldTask();
        if(stopped)return;
        const entry=pending.shift();
        if(!entry)return;
        active=entry;running=true;
        record({kind:'started',...identity(entry)});
        let completed=false;
        try{await options.consume(entry.frame,entry.capturedAt);completed=true;}
        finally{
          record({kind:'finished',...identity(entry),outcome:completed?'completed':'error'});
          release(entry,completed?'normal':'error');active=undefined;running=false;
        }
      }catch(error){fail(error);}
      finally{scheduled=false;start();settle();}
    }).catch(fail);
  };
  const select=(incoming:Entry):Entry[]=>{
    const budget=maxRetainedBytes-(active?.estimatedBytes??0);
    if(incoming.estimatedBytes>budget)return [];
    if(maxPendingFrames===1)return [incoming];
    // An equal row hint cannot establish equal readable pixels: a later view
    // may be covered or transitional. Keep an older same-range raster when it
    // fits, while preserving the existing preference for a distinct view.
    const fitting=pending.filter(entry=>entry.estimatedBytes<=budget-incoming.estimatedBytes);
    const distinct=fitting.filter(entry=>!entry.selection||!incoming.selection||
      entry.selection.rowStart!==incoming.selection.rowStart||entry.selection.rowCount!==incoming.selection.rowCount);
    const older=distinct.length?distinct:fitting;
    if(older.length===0)return [incoming];
    let chosen=older[0];
    if(incoming.selection&&older.every(entry=>entry.selection)){
      const fixed=[incoming.selection,...(active?.selection?[active.selection]:[])];
      let coverage=coveredRows([...fixed,chosen.selection!]);
      for(const entry of older.slice(1)){
        const score=coveredRows([...fixed,entry.selection!]);
        // Oldest wins a tie: overload fallback retains an earlier representative
        // and the newest raster, rather than repeatedly replacing both.
        if(score>coverage){coverage=score;chosen=entry;}
      }
    }
    return [chosen,incoming];
  };
  return {
    get busy(){return busy();},
    offer(frame,capturedAt,stamp,hint){
      let inputId=nextInputId+1;
      if(stamp){
        if(!Number.isSafeInteger(stamp.inputId)||stamp.inputId<=nextInputId||stamp.captureTime!==capturedAt||
          !Number.isFinite(stamp.observedAtMs)||stamp.observedAtMs<0)recordError(new Error('Invalid input decision identity'));
        else inputId=stamp.inputId;
      }
      if(!Number.isSafeInteger(inputId)||!Number.isFinite(capturedAt)||capturedAt<0)recordError(new Error('Invalid input decision metadata'));
      nextInputId=inputId;
      let estimatedBytes:number,selection:LiveCaptureSelection|null=null,source:SourceFrameCorrelation|undefined;
      try{
        estimatedBytes=options.frameBytes?.(frame)??1;
        if(!Number.isSafeInteger(estimatedBytes)||estimatedBytes<1)throw new TypeError('Invalid raster byte estimate');
      }catch(error){recordError(error);estimatedBytes=maxRetainedBytes+1;}
      try{if(hint!==undefined)selection=selectionCopy(hint);if(stamp?.source!==undefined)source=parseSourceFrameCorrelation(stamp.source);}
      catch(error){recordError(error);}
      const entry:Entry={frame,capturedAt,inputId,estimatedBytes,selection};
      record(atMs=>({kind:'offered',...identity(entry),observedAtMs:stamp?.observedAtMs??atMs,
        selection,estimatedBytes,maxPendingFrames,maxRetainedBytes,...(source?{source}:{})}));
      if(stopped){release(entry,'rejected');return;}
      const keep=select(entry);
      if(keep.length===0){release(entry,'capacity');return;}
      const old=pending;pending=keep;
      for(const previous of old){
        if(keep.includes(previous))continue;
        record({kind:'replaced',oldInputId:previous.inputId,newInputId:entry.inputId});release(previous,'replaced');
      }
      start();
    },
    flush(){
      if(!busy())return Promise.resolve();
      return drained??=new Promise<void>(resolve=>{resolveDrained=resolve;});
    },
    dispose(){stopped=true;dropPending('disposed');settle();},
  };
}

