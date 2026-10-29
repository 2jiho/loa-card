/** Share one successful-submission clock between accepted inputs and backup
 * snapshots. Keep the returned ID with the exact frozen source it describes;
 * a later background snapshot must never replace that association. */
export function createLiveOriginalCapture<T>(
  submit:(source:T,time:number,elapsed:number)=>number|undefined,
  intervalMs=250,
) {
  if(!Number.isFinite(intervalMs)||intervalMs<0)throw new RangeError('Invalid original capture interval');
  let last=-Infinity;
  return {
    /** An independently selected input was accepted by the SAME original
     * store. It covers this backup interval without requesting another copy.
     * A delayed older input must never rewind the successful-source clock. */
    remember(elapsed:number){
      if(!Number.isFinite(elapsed)||elapsed<0)throw new RangeError('Invalid stored original time');
      last=Math.max(last,elapsed);
    },
    /** A due frozen backup may commit its held credit through this override.
     * Not-due arrivals never invoke it or change the successful-source clock. */
    capture(source:T,elapsed:number,submitOverride?:typeof submit):number|undefined {
      if(!Number.isFinite(elapsed)||elapsed<0||elapsed<last||elapsed-last<intervalMs)return;
      const id=(submitOverride??submit)(source,elapsed/1000,elapsed);
      if(id!==undefined)last=elapsed;
      return id;
    },
  };
}
