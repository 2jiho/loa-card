import {InputDecisionReplay} from '../src/features/card-scanner/live-input-decision-replay.ts';

const distribution=values=>{
  const sorted=[...values].sort((a,b)=>a-b);
  return {samples:sorted.length,p50Ms:sorted.length?sorted[Math.ceil(sorted.length*.5)-1]:null,
    p95Ms:sorted.length?sorted[Math.ceil(sorted.length*.95)-1]:null,maxMs:sorted.length?sorted.at(-1):null};
};

/** Offline analysis: no new sampling or allocations on the live capture path. */
export function analyzeInputResources(trace) {
  const replay=new InputDecisionReplay(new AbortController().signal),owned=new Map(),wait=[],consume=[];
  let sequence=0,events=0,peakBytes=0,peakFrames=0,releaseFailures=0,unknownBytes=false;
  let budget=null;
  for(const event of trace.events){
    if(!Number.isSafeInteger(event.seq)||event.seq<=sequence)throw Error('Expected ordered validated events');
    sequence=event.seq;
    if(event.type!=='input-decision')continue;
    const v=event.value;
    // Reuse the ownership/order validator; malformed lifecycles are not metrics.
    replay.pipeline(v);events++;
    if(v.kind==='offered'){
      unknownBytes ||= v.version!==2;
      budget=v.version===2?v.maxRetainedBytes:null;
      owned.set(v.inputId,{bytes:v.estimatedBytes??0,offered:v.atMs,started:null});
    }else if(v.kind==='started'){
      const input=owned.get(v.inputId);input.started=v.atMs;wait.push(v.atMs-input.offered);
    }else if(v.kind==='finished')consume.push(v.atMs-owned.get(v.inputId).started);
    else if(v.kind==='released'){
      if(v.failed)releaseFailures++;
      owned.delete(v.inputId);
    }
    peakBytes=Math.max(peakBytes,[...owned.values()].reduce((sum,input)=>sum+input.bytes,0));
    peakFrames=Math.max(peakFrames,owned.size);
  }
  const measured=events>0;
  return {status:!measured?'unmeasured':!trace.complete||trace.dropped||owned.size||releaseFailures?'partial':'measured',
    decisions:events,queueWait:distribution(wait),acquisition:distribution(consume),
    rasterEstimate:{scope:'Active, pending and transient incoming frame estimates only; not JS heap, GPU, OCR, crops or total process memory.',
      retainedBudgetBytes:budget,peakOwnedFrames:measured?peakFrames:null,
      peakOwnedBytes:measured&&!unknownBytes?peakBytes:null,
      unreleasedFrames:measured?owned.size:null,
      endingOwnedBytes:measured&&!unknownBytes&&!releaseFailures?[...owned.values()].reduce((sum,input)=>sum+input.bytes,0):null,
      releaseFailures,includesIncomingTransient:true},
    interpretation:'Observed decision-clock intervals, not capture-to-display latency. Peaks include incoming frames before replacement/capacity cleanup and may exceed the retained budget. Truncated traces are lower bounds; failed release makes remaining physical memory unknown.'};
}
