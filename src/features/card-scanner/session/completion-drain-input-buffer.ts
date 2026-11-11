import type {InputStamp} from '../capture/live-input-admission';
import {parseSourceFrameCorrelation} from '../capture/source-frame-correlation';

/** DEV-only retention of delivered callbacks while acquisition drains.
 * It does not prove the browser delivered every physical frame. */
export class CompletionDrainInputBuffer<T extends {width:number;height:number;close():void}> {
 private items:{frame:T;id:number;time:number;bytes:number;stamp?:InputStamp}[]=[];
 private bytes=0;
 private last:{id:number;time:number;observedAtMs?:number}|undefined;
 private transferred=false;
 private readonly maximumItems:number;private readonly maximumBytes:number;
 constructor(maximumItems=2,maximumBytes=32*1024*1024) {
  if(!Number.isSafeInteger(maximumItems)||maximumItems<1||!Number.isSafeInteger(maximumBytes)||maximumBytes<1)
   throw new TypeError('Invalid drain input budget');
  this.maximumItems=maximumItems;this.maximumBytes=maximumBytes;
 }
 get size(){return this.items.length;}
 get retainedBytes(){return this.bytes;}
 /** Takes ownership only on success. The caller must close rejected frames. */
 add(frame:T,id:number,time:number,stamp?:InputStamp):boolean {
  const bytes=frame.width*frame.height*4,old=this.last;
  if(!Number.isSafeInteger(frame.width)||!Number.isSafeInteger(frame.height)||frame.width<1||frame.height<1||
   !Number.isSafeInteger(bytes)||bytes>this.maximumBytes||this.bytes+bytes>this.maximumBytes||this.items.length>=this.maximumItems||
   !Number.isSafeInteger(id)||id<1||!Number.isFinite(time)||time<0||old&&(id<=old.id||time<old.time)||
   this.items.some(item=>item.frame===frame))return false;
  let copied:InputStamp|undefined;
  if(stamp!==undefined)try{
   if(stamp.inputId!==id||stamp.captureTime!==time||!Number.isFinite(stamp.observedAtMs)||stamp.observedAtMs<0||
    old?.observedAtMs!==undefined&&stamp.observedAtMs<old.observedAtMs)return false;
   copied=Object.freeze({inputId:id,captureTime:time,observedAtMs:stamp.observedAtMs,
    ...(stamp.source===undefined?{}:{source:parseSourceFrameCorrelation(stamp.source)})});
  }catch{return false;}
  this.items.push({frame,id,time,bytes,...(copied?{stamp:copied}:{})});
  this.last={id,time,...(copied?{observedAtMs:copied.observedAtMs}:{})};this.bytes+=bytes;return true;
 }
 /** Compare each saved input in arrival order. A failure is never removed as
  * evidence: callers must retain an unresolved loss until separately fixed. */
 verify(match:(frame:T,id:number,time:number,stamp?:InputStamp)=>boolean,valid:()=>boolean):boolean {
  try{if(this.transferred)return false;for(const entry of this.items)if(!valid()||!match(entry.frame,entry.id,entry.time,entry.stamp)||!valid())return false;return valid();}
  catch{return false;}
 }
 /** Move exactly one retained snapshot and its original input metadata to the
  * caller. The caller now owns and must eventually close the frame. A move is
  * not a recognition result and does not clear any external loss debt. */
 takeNext():{frame:T;id:number;time:number;stamp?:InputStamp}|undefined {
  const entry=this.items.shift();if(!entry)return;
  this.bytes-=entry.bytes;this.transferred=true;
  return {frame:entry.frame,id:entry.id,time:entry.time,...(entry.stamp?{stamp:entry.stamp}:{})};
 }
 clear():boolean {const items=this.items;this.items=[];this.bytes=0;this.last=undefined;this.transferred=false;let ok=true;
  for(const item of items)try{item.frame.close();}catch{ok=false;}return ok;}
}
