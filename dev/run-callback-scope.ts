/** A watchdog may return before an uncooperative native promise settles.
 * These callbacks belong to one run and never publish after its ownership ends. */
export function createRunCallbackScope(ownsRun:()=>boolean){
 let open=true;
 return {
  wrap<Args extends unknown[]>(callback:(...args:Args)=>void){return (...args:Args)=>{if(open&&ownsRun())callback(...args);};},
  close(){open=false;},
 };
}
