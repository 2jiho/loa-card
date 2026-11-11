import {useCallback,useSyncExternalStore} from 'react';
import {isLiveObstructionHintVisible,subscribeToLiveObstructionHintExpiry,type LiveObstructionHint} from '../session/live-obstruction-hint';

const clock=()=>performance.now();
const schedule=(notify:()=>void,delayMs:number)=>{
  const timer=window.setTimeout(notify,delayMs);
  return ()=>window.clearTimeout(timer);
};
const serverSnapshot=()=>false;

/** Expiry affects display only; it never clears scanner obstruction debt. */
export function useLiveObstructionHint(hint:LiveObstructionHint|undefined,enabled:boolean):boolean {
  const subscribe=useCallback((notify:()=>void)=>subscribeToLiveObstructionHintExpiry(hint,enabled,clock,schedule,notify),[hint,enabled]);
  const getSnapshot=useCallback(()=>isLiveObstructionHintVisible(hint,enabled,clock()),[hint,enabled]);
  return useSyncExternalStore(subscribe,getSnapshot,serverSnapshot);
}
