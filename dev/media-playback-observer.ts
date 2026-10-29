/** Metadata from callbacks on one original source video element. These facts
 * do not prove decoded-frame coverage or immutable pixels. */
export type MediaPlaybackEndReason = 'ended'|'stopped'|'disposed'|'aborted'|'error';
type PlaybackBase = {readonly version:1;readonly playbackId:string;readonly observedAtMs:number};
export type MediaPlaybackFact = PlaybackBase & (
  | {readonly type:'start';readonly callbackSupported:boolean}
  | {readonly type:'frame';readonly callbackOrdinal:number;readonly mediaTime:number;
    readonly presentedFrames:number;readonly width:number;readonly height:number}
  | {readonly type:'end';readonly reason:MediaPlaybackEndReason;readonly naturalEnd:boolean;readonly callbacks:number}
);
export interface MediaPlaybackOptions {
  readonly onPlayback:(fact:MediaPlaybackFact)=>void;
  readonly onPlaybackError?:(error:unknown)=>void;
}
export interface MediaPlaybackObserver {stop(reason:MediaPlaybackEndReason):void;}

function object(input:unknown,keys:readonly string[]):Record<string,unknown> {
  if(!input||typeof input!=='object'||Array.isArray(input)||
    ![Object.prototype,null].includes(Object.getPrototypeOf(input)))throw TypeError('Invalid media playback fact');
  const value=input as Record<string,unknown>;
  if(Object.keys(value).length!==keys.length||keys.some(key=>!Object.hasOwn(value,key)))
    throw TypeError('Invalid media playback fact fields');
  return value;
}
function time(value:unknown):value is number {return typeof value==='number'&&Number.isFinite(value)&&value>=0;}
function count(value:unknown):value is number {return Number.isSafeInteger(value)&&(value as number)>=0;}
function positive(value:unknown):value is number {return count(value)&&value>0;}

export function parseMediaPlaybackFact(input:unknown):MediaPlaybackFact {
  const type=input&&typeof input==='object'?(input as Record<string,unknown>).type:undefined;
  const common=['version','type','playbackId','observedAtMs'];
  const keys=type==='start'?['callbackSupported']:type==='frame'?
    ['callbackOrdinal','mediaTime','presentedFrames','width','height']:type==='end'?['reason','naturalEnd','callbacks']:null;
  if(!keys)throw TypeError('Invalid media playback fact type');
  const value=object(input,[...common,...keys]);
  if(value.version!==1||typeof value.playbackId!=='string'||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.playbackId)||
    !time(value.observedAtMs))throw TypeError('Invalid media playback fact identity');
  const base={version:1 as const,playbackId:value.playbackId,observedAtMs:value.observedAtMs};
  if(type==='start') {
    if(typeof value.callbackSupported!=='boolean')throw TypeError('Invalid media playback callback support');
    return Object.freeze({...base,type,callbackSupported:value.callbackSupported});
  }
  if(type==='frame') {
    if(!positive(value.callbackOrdinal)||!time(value.mediaTime)||!count(value.presentedFrames)||
      !positive(value.width)||!positive(value.height))throw TypeError('Invalid media playback callback coordinates');
    return Object.freeze({...base,type,callbackOrdinal:value.callbackOrdinal,mediaTime:value.mediaTime,
      presentedFrames:value.presentedFrames,width:value.width,height:value.height});
  }
  if(!['ended','stopped','disposed','aborted','error'].includes(value.reason as string)||
    typeof value.naturalEnd!=='boolean'||value.naturalEnd!==(value.reason==='ended')||!count(value.callbacks))
    throw TypeError('Invalid media playback end');
  return Object.freeze({...base,type:'end',reason:value.reason as MediaPlaybackEndReason,
    naturalEnd:value.naturalEnd,callbacks:value.callbacks});
}

/** Observe only the adapter-owned original element; no polling or media reads.
 * callbackOrdinal counts this observer's rVFC invocations. presentedFrames is
 * copied from the browser and is never an original decoded-frame ordinal. */
export function observeMediaPlayback(source:HTMLVideoElement,options:MediaPlaybackOptions):MediaPlaybackObserver {
  let playbackId='',beganAt=0,callbacks=0,pending:number|undefined,done=false,disabled=false,errorReported=false;
  const cancel=()=>{
    const handle=pending;pending=undefined;
    if(handle!==undefined&&typeof source.cancelVideoFrameCallback==='function')source.cancelVideoFrameCallback(handle);
  };
  const disable=(error:unknown)=>{
    disabled=true;done=true;
    try{cancel();}catch{/* A late native callback is also guarded by done. */}
    if(errorReported)return;errorReported=true;
    try{
      const result=options.onPlaybackError?.(error) as unknown;
      if(result!==undefined)void Promise.resolve(result).catch(()=>{});
    }catch{/* Diagnostics cannot affect playback. */}
  };
  const observedAtMs=()=>Math.max(0,performance.now()-beganAt);
  const emit=(fact:MediaPlaybackFact)=>{
    if(disabled)return;
    try{
      // Observe async failures without awaiting a sink or retaining a queue.
      const result=options.onPlayback(parseMediaPlaybackFact(fact)) as unknown;
      if(result!==undefined)void Promise.resolve(result).catch(disable);
    }catch(error){disable(error);}
  };
  const schedule=()=>{
    if(done||disabled)return;
    try{pending=source.requestVideoFrameCallback((_now,metadata)=>{
      pending=undefined;
      if(done||disabled)return;
      try{
        callbacks++;
        emit({version:1,type:'frame',playbackId,observedAtMs:observedAtMs(),callbackOrdinal:callbacks,
          mediaTime:metadata.mediaTime,presentedFrames:metadata.presentedFrames,width:metadata.width,height:metadata.height});
        schedule();
      }catch(error){disable(error);}
    });}catch(error){disable(error);}
  };
  const observer:MediaPlaybackObserver={stop(reason){
    if(done)return;done=true;
    try{cancel();
      emit({version:1,type:'end',playbackId,observedAtMs:observedAtMs(),reason,naturalEnd:reason==='ended',callbacks});
    }catch(error){disable(error);}
  }};
  try{
    playbackId=crypto.randomUUID();beganAt=performance.now();
    if(!time(beganAt))throw TypeError('Invalid media playback start clock');
    const callbackSupported=typeof source.requestVideoFrameCallback==='function';
    emit({version:1,type:'start',playbackId,observedAtMs:0,callbackSupported});
    if(callbackSupported)schedule();
  }catch(error){disable(error);}
  return observer;
}
