import type {LocalArchiveProgress} from '../src/features/card-scanner/reproduction/dev-replay-archive';

/** Dev recordings are archived only while the page has no scanner work.
 * Starting work aborts the current job; its browser record remains protected. */
export function createIdleSessionArchive(options:{
  idle:()=>boolean;
  archive:(signal:AbortSignal,notify:(value:LocalArchiveProgress)=>void)=>Promise<void>;
  notify:(value:LocalArchiveProgress|{state:'error'})=>void;
  retryMs?:number;
}) {
  const retryMs=options.retryMs??60_000;
  if(!Number.isFinite(retryMs)||retryMs<1)throw new TypeError('Invalid archive retry interval');
  let timer:ReturnType<typeof setTimeout>|undefined,active:AbortController|undefined,disposed=false;
  const cancel=()=>{if(timer!==undefined)clearTimeout(timer);timer=undefined;active?.abort();active=undefined;};
  const schedule=(delay=0)=>{
    if(disposed||active||timer!==undefined||!options.idle())return;
    timer=setTimeout(()=>{
      timer=undefined;if(disposed||active||!options.idle())return;
      const own=new AbortController();active=own;let retry=false;
      const notify=(value:LocalArchiveProgress)=>{
        if(disposed||active!==own||own.signal.aborted)return;
        if(value.state==='failed'||value.state==='waiting')retry=true;
        try{options.notify(value);}catch{/* UI is not part of the archive. */}
      };
      void Promise.resolve().then(()=>options.archive(own.signal,notify)).catch(()=>{
        if(!disposed&&active===own&&!own.signal.aborted){retry=true;try{options.notify({state:'error'});}catch{}}
      }).finally(()=>{
        if(active!==own)return;active=undefined;
        if(retry&&!disposed&&options.idle())schedule(retryMs);
      });
    },delay);
  };
  return {schedule,cancel,dispose(){disposed=true;cancel();}};
}
