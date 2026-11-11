import type {LiveFrameObservation} from '../capture/live-frame-clock';

/** Metadata is a necessary browser-callback check, not proof that the OS or
 * browser delivered every physical frame. Never accept timer-only fallback. */
export type DrainClockFailure='clock-fallback'|'clock-invalid'|'clock-duplicate'|'clock-regression'|'clock-gap';
export function drainClockObservationFailure(event:LiveFrameObservation):DrainClockFailure|null {
 if(event.kind!=='callback')return 'clock-fallback';
 if(!event.captureEligible||event.mediaRelation==='duplicate'||event.presentedRelation==='duplicate')return 'clock-duplicate';
 if(event.mediaRelation==='regression'||event.presentedRelation==='regression')return 'clock-regression';
 if(event.missedFrames!==null&&event.missedFrames>0)return 'clock-gap';
 if(!Number.isSafeInteger(event.sequence)||event.sequence===null||event.sequence<1||
   event.mediaRelation!=='advance'||event.presentedRelation!=='advance'||event.missedFrames!==0||
   event.mediaTime===null||!Number.isFinite(event.mediaTime)||event.mediaTime<0||
   event.presentedFrames===null||!Number.isSafeInteger(event.presentedFrames)||event.presentedFrames<0)return 'clock-invalid';
 return null;
}
export function drainClockObservationSafe(event:LiveFrameObservation):boolean{return drainClockObservationFailure(event)===null;}
