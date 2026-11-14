interface WatchdogState {
  workPhase?: 'capture' | 'reading' | 'recovery' | 'verifying' | 'cleanup';
  ledger?: {stages?: Partial<Record<string, number>>};
  sampled: number;
  stable: number;
  workDone?: number;
  recoveryFrames?: number;
  currentRunRead?: number;
  queued?: number;
  activeReadings?: number;
  cards: readonly {review: string[]}[];
  interrupted?: 'stalled' | 'cancelled' | 'failed';
  status?: string;
  autoStopped?: boolean;
  processingWarning?: string;
}

export class ScanStalledError extends Error {
  constructor(message:string){super(message);this.name='ScanStalledError';}
}
export const scanLimits={stall:15_000,cleanup:15_000,initialization:180_000,warning:7_000,recoveryWarning:30_000};

/** Progress is completed work, not status text, a spinner or a shrinking queue. */
export class ScanProgressClock {
  private high:number[]=[];
  private last:number;
  private phase:WatchdogState['workPhase'];
  private cleanupAt:number|undefined;
  private recoveryAt:number|undefined;
  private started:number;
  constructor(started:number){this.started=started;this.last=started;}
  ready(now:number){this.last=now;}
  observe(state:WatchdogState,now:number){
    if(state.workPhase!==this.phase){this.phase=state.workPhase;this.last=now;
      this.recoveryAt=state.workPhase==='recovery'?now:undefined;}
    if(state.workPhase==='cleanup')this.cleanupAt??=now;
    const stages=state.ledger?.stages;
    const values=[state.sampled,state.stable,state.recoveryFrames??0,state.currentRunRead??0,state.workDone??0,
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
  /** Elapsed recovery is advisory only: slow progress is not a stalled scan. */
  warning(now:number,limits=scanLimits):string|undefined {
    if(this.phase!=='cleanup'&&now-this.last>=limits.warning)
      return '처리가 지연되고 있어요. 진척이 없으면 자동으로 중단합니다.';
    if(this.recoveryAt!==undefined&&now-this.recoveryAt>=limits.recoveryWarning)
      return '저장된 화면을 확인하는 데 시간이 걸리고 있어요. 기다리거나 스캔을 중지할 수 있습니다.';
  }
}

/** Bounds the caller even if a browser promise ignores abort. Late callbacks are
 * fenced off; the original scanner still owns resource cleanup after abort. */
export async function guardScan<T extends WatchdogState>(options:{
  signal:AbortSignal;
  run:(signal:AbortSignal,publish:(state:T)=>void,ready:()=>void)=>Promise<void>;
  update:(state:T)=>void;
  sharing:()=>boolean;
  cancelResources:()=>void;
  /** Actual injected operation settlement, independent of the watchdog's
   * bounded return. This is not a guarantee of OS/native resource reclamation. */
  onRunSettled?:()=>void;
  limits?:typeof scanLimits;
  intervalMs?:number;
}) {
  const controller=new AbortController(),clock=new ScanProgressClock(performance.now());
  let active=true,ready=false,latest:T|undefined,lastWarning:string|undefined;
  let rejectStop!:(error:unknown)=>void;
  const stopped=new Promise<never>((_,reject)=>{rejectStop=reject});
  const interrupt=(error:unknown,kind:NonNullable<WatchdogState['interrupted']>)=>{
    if(!active)return;
    active=false;
    controller.abort(error);
    try{options.cancelResources();}catch{/* Keep UI cancellation independent of teardown. */}
    if(latest)options.update({...latest,cards:latest.cards.map(c=>({...c,review:[...c.review]})),
      interrupted:kind,status:'스캔 중지',autoStopped:false,processingWarning:undefined} as T);
    rejectStop(error);
  };
  const abort=()=>interrupt(options.signal.reason??new DOMException('스캔 중지','AbortError'),'cancelled');
  options.signal.addEventListener('abort',abort,{once:true});
  const timer=setInterval(()=>{
    if(!active)return;
    const now=performance.now();
    // While a person is sharing, a drained queue means the scanner is waiting
    // for more card input, not that processing hung. This includes the reading
    // phase (for example, after a batch finishes but the user is still moving
    // the inventory). Recovery/cleanup keep their own bounded deadlines.
    const waitingForInput=latest?.workPhase==='capture'||latest?.workPhase==='reading';
    const idleSharing=ready&&waitingForInput&&!latest?.queued&&!(latest?.activeReadings??0)&&options.sharing();
    const reason=clock.check(now,ready,!!idleSharing,options.limits);
    if(reason){
      const label=reason==='cleanup'?'인식 엔진 또는 임시 기록 정리가 지연되어 종료했습니다.':reason==='initialization'?'스캔 준비 시간이 초과됐습니다.':'처리 진척이 없어 스캔을 중단했습니다.';
      interrupt(new ScanStalledError(`${label} 읽은 카드는 유지되며, 스캔은 미완료 상태입니다.`),'stalled');return;
    }
    if(latest&&ready&&!idleSharing){
      const warning=clock.warning(now,options.limits);
      if(warning!==lastWarning){lastWarning=warning;options.update({...latest,processingWarning:warning} as T);}
    }
  },options.intervalMs??1000);
  try {
    if(options.signal.aborted)abort();
    const operation=(active?Promise.resolve().then(()=>{
      controller.signal.throwIfAborted();
      return options.run(controller.signal,state=>{
        if(!active)return;
        latest=state;clock.observe(state,performance.now());
        lastWarning=ready?clock.warning(performance.now(),options.limits):undefined;
        options.update({...state,processingWarning:lastWarning});
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
