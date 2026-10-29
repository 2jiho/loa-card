import type {InputStamp} from './live-input-admission';
import {MAX_FRAME_BYTES} from './recording-frame-integrity';

/** Coordinates of an arrival reaching admission, never evidence of frozen
 * pixels, card freshness, or an original-video decoded ordinal. */
export interface InputArrival {
 readonly version:1;readonly inputId:number;readonly captureTime:number;readonly observedAtMs:number;
 readonly delivery:'video-callback'|'track-frame'|'video-poll';
 readonly callback?:Readonly<{mediaTime:number;presentedFrames:number;missedFrames:number}>;
 readonly nativeTimestampUs?:number;
}
/** A reservation can be absent, replaced or fail storage later. Its ID belongs
 * to this live-original store, not the acquisition-frame ID namespace. */
export interface InputBackupReservation {
 readonly version:1;readonly inputId:number;readonly captureTime:number;
 readonly store:'prepared-native'|'capture-originals';readonly reservationId:number|null;
}
/** Planned backup metadata when source capacity is busy. No pixels were
 * frozen or reserved; this cannot identify a source, card or position. */
export interface BackupCapacityDeferral {
 readonly version:1;readonly reason:'source-capacity';readonly captureTime:number;readonly observedAtMs:number;
 readonly width:number;readonly height:number;readonly pendingBytes:number;
}
function record(input:unknown,allowed:readonly string[],required:readonly string[]=allowed):Record<string,unknown>{
 if(!input||typeof input!=='object'||Array.isArray(input)||![Object.prototype,null].includes(Object.getPrototypeOf(input)))
  throw TypeError('Invalid input arrival diagnostic');
 const value=input as Record<string,unknown>;
 if(Object.keys(value).some(key=>!allowed.includes(key))||required.some(key=>!Object.hasOwn(value,key)))
  throw TypeError('Invalid input arrival diagnostic fields');
 return value;
}
function positive(value:unknown):value is number{return Number.isSafeInteger(value)&&(value as number)>0;}
function time(value:unknown):value is number{return typeof value==='number'&&Number.isFinite(value)&&value>=0;}
export function parseInputArrival(input:unknown):InputArrival{
 const value=record(input,['version','inputId','captureTime','observedAtMs','delivery','callback','nativeTimestampUs'],
  ['version','inputId','captureTime','observedAtMs','delivery']);
 if(value.version!==1||!positive(value.inputId)||!time(value.captureTime)||!time(value.observedAtMs)||
  !['video-callback','track-frame','video-poll'].includes(value.delivery as string))throw TypeError('Invalid input arrival diagnostic identity');
 const callback=value.callback===undefined?undefined:record(value.callback,['mediaTime','presentedFrames','missedFrames']);
 if(callback&&(!time(callback.mediaTime)||!Number.isSafeInteger(callback.presentedFrames)||(callback.presentedFrames as number)<0||
  !Number.isSafeInteger(callback.missedFrames)||(callback.missedFrames as number)<0))throw TypeError('Invalid arrival callback coordinates');
 if(value.nativeTimestampUs!==undefined&&!Number.isSafeInteger(value.nativeTimestampUs))throw TypeError('Invalid arrival native timestamp');
 if((value.delivery==='video-callback')!==!!callback||value.delivery==='track-frame'&&value.nativeTimestampUs===undefined||
  value.delivery==='video-poll'&&value.nativeTimestampUs!==undefined)throw TypeError('Inconsistent arrival delivery coordinates');
 return Object.freeze({version:1,inputId:value.inputId,captureTime:value.captureTime,observedAtMs:value.observedAtMs,
  delivery:value.delivery as InputArrival['delivery'],...(callback?{callback:Object.freeze({mediaTime:callback.mediaTime as number,
   presentedFrames:callback.presentedFrames as number,missedFrames:callback.missedFrames as number})}:{}),
  ...(value.nativeTimestampUs===undefined?{}:{nativeTimestampUs:value.nativeTimestampUs as number})});
}
export function inputArrival(stamp:InputStamp,nativeTimestampUs?:number,callback?:InputArrival['callback']):InputArrival{
 return parseInputArrival({version:1,inputId:stamp.inputId,captureTime:stamp.captureTime,observedAtMs:stamp.observedAtMs,
  delivery:callback?'video-callback':nativeTimestampUs===undefined?'video-poll':'track-frame',
  ...(callback?{callback}:{}),...(nativeTimestampUs===undefined?{}:{nativeTimestampUs})});
}
export function parseInputBackupReservation(input:unknown):InputBackupReservation{
 const value=record(input,['version','inputId','captureTime','store','reservationId']);
 if(value.version!==1||!positive(value.inputId)||!time(value.captureTime)||!['prepared-native','capture-originals'].includes(value.store as string)||
  value.reservationId!==null&&!positive(value.reservationId))throw TypeError('Invalid input backup reservation');
 return Object.freeze({version:1,inputId:value.inputId,captureTime:value.captureTime,
  store:value.store as InputBackupReservation['store'],reservationId:value.reservationId as number|null});
}
export function parseBackupCapacityDeferral(input:unknown):BackupCapacityDeferral{
 const fields=['version','reason','captureTime','observedAtMs','width','height','pendingBytes'] as const;
 const value=record(input,fields);
 if(Reflect.ownKeys(value).length!==fields.length)throw TypeError('Invalid backup capacity deferral fields');
 const {version,reason,captureTime,observedAtMs,width,height,pendingBytes}=value;
 if(version!==1||reason!=='source-capacity'||!time(captureTime)||!time(observedAtMs)||!positive(width)||!positive(height)||
  !Number.isSafeInteger(pendingBytes)||(pendingBytes as number)<0)throw TypeError('Invalid backup capacity deferral');
 const bytes=width*height*4;
 if(!Number.isSafeInteger(bytes)||bytes>MAX_FRAME_BYTES)throw TypeError('Invalid deferred backup dimensions');
 return Object.freeze({version:1,reason:'source-capacity',captureTime,observedAtMs,width,height,pendingBytes:pendingBytes as number});
}
