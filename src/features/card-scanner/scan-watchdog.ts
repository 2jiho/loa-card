import type {ScannerState} from './scanner';

export class ScanStalledError extends Error {
  constructor(message:string){super(message);this.name='ScanStalledError';}
}
export const scanLimits={stall:15_000,cleanup:15_000,initialization:180_000,warning:7_000};

/** Progress is completed work, not status text, a spinner or a shrinking queue. */
export class ScanProgressClock {
  private high:number[]=[];
  private last:number;
  private phase:ScannerState['workPhase'];
  private cleanupAt:number|undefined;
  private started:number;
  constructor(started:number){this.started=started;this.last=started;}
  ready(now:number){this.last=now;}
  observe(state:ScannerState,now:number){
    if(state.workPhase!==this.phase){this.phase=state.workPhase;this.last=now;}
    if(state.workPhase==='cleanup')this.cleanupAt??=now;
    const stages=state.ledger?.stages;
    const values=[state.sampled,state.stable,state.recoveryFrames??0,state.currentRunRead??0,
      ...( ['identified','unidentified','rejected','duplicate','superseded'] as const).map(k=>stages?.[k]??0)];
    if(values.some((value,i)=>value>(this.high[i]??0)))this.last=now;
    this.high=values.map((value,i)=>Math.max(value,this.high[i]??0));
  }
  check(now:number,ready:boolean,idleSharing:boolean,limits=scanLimits){
    if(this.cleanupAt!==undefined&&now-this.cleanupAt>=limits.cleanup)return 'cleanup';
    if(!ready)return now-this.started>=limits.initialization?'initialization':null;
    // A person may keep sharing a stationary window. Do not time out that wait.
    if(idleSharing){this.last=now;return null;}
    return now-this.last>=limits.stall?'stalled':null;
  }
  delayed(now:number){return this.phase!=='cleanup'&&now-this.last>=scanLimits.warning;}
}

/** Bounds the caller even if a browser promise ignores abort. Late callbacks are
 * fenced off; the original scanner still owns resource cleanup after abort. */
export async function guardScan(options:{
  signal:AbortSignal;
  run:(signal:AbortSignal,publish:(state:ScannerState)=>void,ready:()=>void)=>Promise<void>;
  update:(state:ScannerState)=>void;
  sharing:()=>boolean;
  cancelResources:()=>void;
  /** Actual injected operation settlement, independent of the watchdog's
   * bounded return. This is not a guarantee of OS/native resource reclamation. */
  onRunSettled?:()=>void;
  limits?:typeof scanLimits;
  intervalMs?:number;
}) {
  const controller=new AbortController(),clock=new ScanProgressClock(performance.now());
  let active=true,ready=false,latest:ScannerState|undefined,warned=false;
  let rejectStop!:(error:unknown)=>void;
  const stopped=new Promise<never>((_,reject)=>{rejectStop=reject});
  const interrupt=(error:unknown,kind:NonNullable<ScannerState['interrupted']>)=>{
    if(!active)return;
    active=false;
    controller.abort(error);
    try{options.cancelResources();}catch{/* Keep UI cancellation independent of teardown. */}
    if(latest)options.update({...latest,cards:latest.cards.map(c=>({...c,review:[...c.review]})),
      interrupted:kind,status:'스캔 중지',autoStopped:false,processingWarning:undefined});
    rejectStop(error);
  };
  const abort=()=>interrupt(options.signal.reason??new DOMException('스캔 중지','AbortError'),'cancelled');
  options.signal.addEventListener('abort',abort,{once:true});
  const timer=setInterval(()=>{
    if(!active)return;
    const now=performance.now();
    const idleSharing=ready&&latest?.workPhase==='capture'&&!latest.queued&&options.sharing();
    const reason=clock.check(now,ready,!!idleSharing,options.limits);
    if(reason){
      const label=reason==='cleanup'?'임시 기록 정리가 지연되어 종료했습니다.':reason==='initialization'?'스캔 준비 시간이 초과됐습니다.':'처리 진척이 없어 스캔을 중단했습니다.';
      interrupt(new ScanStalledError(`${label} 읽은 카드는 유지되며, 스캔은 미완료 상태입니다.`),'stalled');return;
    }
    if(latest&&ready&&!idleSharing&&clock.delayed(now)&&!warned){warned=true;options.update({...latest,processingWarning:'처리가 지연되고 있어요. 진척이 없으면 자동으로 중단합니다.'});}
  },options.intervalMs??1000);
  try {
    if(options.signal.aborted)abort();
    const operation=(active?Promise.resolve().then(()=>{
      controller.signal.throwIfAborted();
      return options.run(controller.signal,state=>{
        if(!active)return;
        latest=state;clock.observe(state,performance.now());
        warned=ready&&clock.delayed(performance.now());
        options.update({...state,processingWarning:warned?'처리가 지연되고 있어요. 진척이 없으면 자동으로 중단합니다.':undefined});
      },()=>{ready=true;clock.ready(performance.now());});
    }):stopped).finally(()=>{try{void Promise.resolve(options.onRunSettled?.()).catch(()=>{});}catch{/* Optional lifecycle observer cannot change the scan outcome. */}});
    await Promise.race([operation,stopped]);
  } catch(error){
    if(active)interrupt(error,'failed');
    throw error;
  } finally {
    active=false;clearInterval(timer);options.signal.removeEventListener('abort',abort);
  }
}
