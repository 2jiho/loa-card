/** UI-only hint from an already-inspected live capture. It cannot establish
 * card identity, an unobstructed frame, or a completion/fence transition. */
export interface LiveObstructionHint {
  readonly sessionId:string;
  readonly inputId:number;
  readonly frameId:number;
  readonly captureTime:number;
  /** Page monotonic clock. The hint expires relative to capture, not delivery. */
  readonly expiresAtMs:number;
}
export const LIVE_OBSTRUCTION_MESSAGE='카드가 가려졌을 수 있어요. 커서를 카드 밖으로 옮겨 주세요.';
export const LIVE_OBSTRUCTION_TTL_MS=2000;
const MAX_DELIVERY_AGE_MS=1000, PUBLISH_INTERVAL_MS=250;

/** Session-local, bounded coalescing. A negative or missing observation never
 * clears the recognition fence and is not proof that occlusion disappeared. */
export function createLiveObstructionHint(sessionId:string,now:()=>number,publish:(hint:LiveObstructionHint)=>void) {
  let latestInput=0,lastNotice=0,lastPublished=-Infinity;
  return {
    begin(inputId:number) {
      if(Number.isSafeInteger(inputId)&&inputId>latestInput)latestInput=inputId;
    },
    notice(input:{inputId:number;frameId:number;captureTime:number;capturedAtMs:number},active:boolean):boolean {
      if(!active||!sessionId||!Number.isSafeInteger(input.inputId)||input.inputId<1||input.inputId!==latestInput||
        !Number.isSafeInteger(input.frameId)||input.frameId<1||!Number.isFinite(input.captureTime)||input.captureTime<0||
        !Number.isFinite(input.capturedAtMs)||input.capturedAtMs<0||input.inputId<=lastNotice)return false;
      let time:number;
      try{time=now();}catch{return false;}
      if(!Number.isFinite(time)||time<input.capturedAtMs||time-input.capturedAtMs>MAX_DELIVERY_AGE_MS)return false;
      lastNotice=input.inputId;
      if(time<lastPublished||time-lastPublished<PUBLISH_INTERVAL_MS)return false;
      lastPublished=time;
      try{publish(Object.freeze({sessionId,inputId:input.inputId,frameId:input.frameId,captureTime:input.captureTime,
        expiresAtMs:input.capturedAtMs+LIVE_OBSTRUCTION_TTL_MS}));}catch{/* Display is never scanner authority. */}
      return true;
    },
  };
}

export function isLiveObstructionHintVisible(hint:LiveObstructionHint|undefined,enabled:boolean,now:number):boolean {
  return !!hint&&enabled&&Number.isFinite(now)&&Number.isFinite(hint.expiresAtMs)&&now<hint.expiresAtMs;
}

/** Schedules display invalidation only; expiry does not affect scan evidence. */
export function subscribeToLiveObstructionHintExpiry(
  hint:LiveObstructionHint|undefined,enabled:boolean,now:()=>number,
  schedule:(notify:()=>void,delayMs:number)=>()=>void,notify:()=>void,
):()=>void {
  const current=now();
  if(!isLiveObstructionHintVisible(hint,enabled,current))return ()=>{};
  return schedule(notify,Math.max(0,hint!.expiresAtMs-current));
}
