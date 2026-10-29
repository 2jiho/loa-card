/** Temporal overlap only. Never identifies missing pixels or a causal bottleneck. */
export function analyzeCallbackStalls(trace, performance) {
  const work=performance?.mainThreadWork,origin=performance?.clockOrigin?.runStartedAtMs;
  const scope='Same-playback callback intervals on the run page clock; long-task overlap is not causal attribution, CPU time or pixel-loss proof.';
  const unavailable=reason=>({status:'unmeasured',reason,scope,gaps:[]});
  if(!Number.isFinite(origin)||origin<0)return unavailable('missing-run-clock');
  if(work?.status!=='measured'||work.clock!=='page-performance-now')return unavailable('missing-long-task-observation');
  if(!Array.isArray(work.samples)||!Number.isSafeInteger(work.omitted)||work.omitted<0||
    work.samples.some(s=>!Number.isFinite(s.startTime)||s.startTime<0||!Number.isFinite(s.duration)||s.duration<50))
    return unavailable('invalid-long-task-observation');
  // Union intervals so duplicate/overlapping samples cannot inflate the overlap.
  const intervals=[];
  for(const s of [...work.samples].sort((a,b)=>a.startTime-b.startTime)) {
    const last=intervals.at(-1),end=s.startTime+s.duration;
    if(last&&s.startTime<=last[1])last[1]=Math.max(last[1],end);
    else intervals.push([s.startTime,end]);
  }
  const previous=new Map(),gaps=[];
  let measuredIntervals=0,invalidIntervals=0;
  for(const e of trace.events) {
    if(e.type!=='source-playback')continue;
    const v=e.value;
    if(v.type!=='frame'){previous.delete(v.playbackId);continue;}
    const before=previous.get(v.playbackId);previous.set(v.playbackId,e);
    if(!before)continue;
    // Source-playback event time is recorded relative to runStartedAtMs.
    // observedAtMs is relative to a different (playback) origin; never add it here.
    const start=origin+before.time*1000,end=origin+e.time*1000;
    const mediaGap=v.mediaTime-before.value.mediaTime;
    if(!Number.isFinite(start)||!Number.isFinite(end)||end<start||!Number.isFinite(mediaGap)||mediaGap<0){invalidIntervals++;continue;}
    measuredIntervals++;
    gaps.push({playbackId:v.playbackId,fromSeq:before.seq,toSeq:e.seq,mediaStart:before.value.mediaTime,
      mediaEnd:v.mediaTime,mediaGapSeconds:mediaGap,callbackGapMs:end-start,
      longTaskOverlapMs:intervals.reduce((sum,[a,b])=>sum+Math.max(0,Math.min(end,b)-Math.max(start,a)),0)});
    gaps.sort((a,b)=>b.mediaGapSeconds-a.mediaGapSeconds||b.callbackGapMs-a.callbackGapMs);
    if(gaps.length>20)gaps.pop();
  }
  return {status:!measuredIntervals?'unmeasured':!trace.complete||trace.dropped||work.omitted||invalidIntervals?'partial':'measured',
    measuredIntervals,invalidIntervals,omittedLongTasks:work.omitted,reportedGapLimit:20,scope,gaps};
}
