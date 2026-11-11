import {useLayoutEffect, useRef, useSyncExternalStore} from 'react';
import type {ScanMonitorState, ScanMonitorStore} from '../features/card-scanner/ui/scan-monitor-store';
import type {MonitorLatencyProbe} from '../shared/monitor-latency';

/** Dev-only preview presentation timing. The boundary is store publication to
 * React layout commit, not capture, OCR, paint, or total user latency. */
export function DevPreviewLatency({store,probe}:{store:ScanMonitorStore;probe:{current:MonitorLatencyProbe<ScanMonitorState>|null}}) {
  const snapshot=useSyncExternalStore(store.subscribe,store.getSnapshot);
  const output=useRef<HTMLParagraphElement>(null),lastSent=useRef(0);
  useLayoutEffect(()=>{
    const current=probe.current;
    if(!current)return;
    current.commit(snapshot);
    const stats=current.stats();
    const ms=(value:number|null)=>value===null?'—':`${value.toFixed(1)}ms`;
    if(output.current)output.current.textContent=`미리보기 지연(store→commit) p50 ${ms(stats.p50Ms)} · p95 ${ms(stats.p95Ms)} · max ${ms(stats.maxMs)} · n=${stats.sampleCount}`;
    const now=performance.now();
    if(now-lastSent.current>2000){
      lastSent.current=now;
      void fetch('/__corpus/preview-latency',{method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({...stats,page:location.pathname,at:new Date().toISOString()})}).catch(()=>{});
    }
  },[snapshot,probe]);
  return <p ref={output} className="note" role="status" />;
}
