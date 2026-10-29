const MAX_SAMPLES=2048;

export type MonitorLatencyStats=Readonly<{
  boundary:'store-notification-to-react-layout-commit';
  notified:number;
  committed:number;
  skippedCoalesced:number;
  pending:number;
  rejectedClock:number;
  sampleCount:number;
  sampleLimit:number;
  p50Ms:number|null;
  p95Ms:number|null;
  maxMs:number|null;
}>;

/** Dev-only presentation timing. Counts cover non-null canonical snapshots;
 * latency statistics cover the latest bounded commit samples, not capture,
 * browser paint, OCR, or total user-perceived latency. Snapshot keys are weak. */
export function createMonitorLatencyProbe<T extends object>(
  now:()=>number=()=>performance.now(),sampleLimit=MAX_SAMPLES,
) {
  if(!Number.isInteger(sampleLimit)||sampleLimit<1||sampleLimit>MAX_SAMPLES)
    throw new RangeError(`sampleLimit must be between 1 and ${MAX_SAMPLES}`);
  let marks=new WeakMap<T,{sequence:number;time:number|null}>();
  const samples=new Float64Array(sampleLimit);
  let notified=0,committed=0,skippedCoalesced=0,lastCommitted=0,rejectedClock=0;
  let sampleCount=0,sampleNext=0,lastClock:number|undefined;
  const clock=()=>{
    const time=now();
    if(!Number.isFinite(time)||time<0||lastClock!==undefined&&time<lastClock){
      rejectedClock++;return null;
    }
    lastClock=time;return time;
  };
  return {
    notify(snapshot:T|null):boolean {
      if(snapshot===null||marks.has(snapshot))return false;
      marks.set(snapshot,{sequence:++notified,time:clock()});return true;
    },
    commit(snapshot:T|null):boolean {
      if(snapshot===null)return false;
      const mark=marks.get(snapshot);
      if(!mark||mark.sequence<=lastCommitted)return false;
      const time=clock();
      skippedCoalesced+=mark.sequence-lastCommitted-1;
      lastCommitted=mark.sequence;committed++;
      // Invalid clock readings invalidate timing only, not actual notifications
      // and commits; they must not be misreported as React coalescing.
      if(mark.time!==null&&time!==null){
        samples[sampleNext]=time-mark.time;
        sampleNext=(sampleNext+1)%sampleLimit;
        sampleCount=Math.min(sampleCount+1,sampleLimit);
      }
      return true;
    },
    reset():void {
      marks=new WeakMap();samples.fill(0);
      notified=committed=skippedCoalesced=lastCommitted=rejectedClock=sampleCount=sampleNext=0;
      lastClock=undefined;
    },
    stats():MonitorLatencyStats {
      const sorted=Array.from(samples.subarray(0,sampleCount)).sort((a,b)=>a-b);
      const percentile=(fraction:number)=>sampleCount?sorted[Math.ceil(sampleCount*fraction)-1]:null;
      return Object.freeze({
        boundary:'store-notification-to-react-layout-commit',
        notified,committed,skippedCoalesced,pending:notified-committed-skippedCoalesced,rejectedClock,
        sampleCount,sampleLimit,p50Ms:percentile(.5),p95Ms:percentile(.95),maxMs:sampleCount?sorted[sampleCount-1]:null,
      });
    },
  };
}

export type MonitorLatencyProbe<T extends object>=ReturnType<typeof createMonitorLatencyProbe<T>>;
