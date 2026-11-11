/** Observe asynchronous journal registration without delaying card capture.
 * Both callbacks are fenced to the run which created the promise. */
export function watchRecordingReadiness(ready:Promise<unknown>,current:()=>boolean,
  onReady:()=>void,onFailure:(error:unknown)=>void):void {
  void ready.then(()=>{try{if(current())onReady();}catch{/* Reporting must not affect scanning. */}},
    error=>{try{if(current())onFailure(error);}catch{/* Reporting must not affect scanning. */}});
}
