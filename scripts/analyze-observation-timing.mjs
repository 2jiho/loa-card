import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {parseRunStateTrace} from '../dev/run-state-trace.ts';
import {ScanGrid} from '../src/features/card-scanner/scan-grid.ts';
import {applyScanGridCommand} from '../src/features/card-scanner/scan-grid-command.ts';

const stats=values=>{
  values.sort((a,b)=>a-b);
  return {count:values.length,p50:values[Math.floor(values.length*.5)]??null,
    p95:values[Math.floor(values.length*.95)]??null,max:values.at(-1)??null};
};

/** Offline diagnostics. Reconstruct live facts through the same grid reducer. */
export function analyzeObservationTiming(trace) {
  const queued=new Map(),active=new Map(),seen=new Set(),readObservations=new Set();
  const firstWait=[],retryWait=[],duration=[],intervals=[],firstWaitIntervals=[];
  let time=0,previousTime=-1,previousSeq=-1,gridFacts=0,directFacts=0;
  let startsWithoutQueue=0,finishesWithoutStart=0;
  const accept=fact=>{
    const key=JSON.stringify([fact.source.sessionId,fact.source.observationId]);
    const attempt=JSON.stringify([key,fact.attemptId]);
    if(fact.kind==='queued') {
      if(queued.has(key))throw Error('Duplicate queued observation');
      queued.set(key,time);
    } else if(fact.kind==='read-started') {
      if(seen.has(attempt))throw Error('Duplicate read attempt');
      if(queued.has(key)) {
        (readObservations.has(key)?retryWait:firstWait).push((time-queued.get(key))*1000);
        if(!readObservations.has(key))firstWaitIntervals.push([queued.get(key)*1000,time*1000]);
      }
      else startsWithoutQueue++;
      seen.add(attempt);readObservations.add(key);active.set(attempt,time);
    } else if(fact.kind==='read-finished') {
      if(active.has(attempt)) {
        intervals.push([active.get(attempt)*1000,time*1000]);
        duration.push((time-active.get(attempt))*1000);active.delete(attempt);
      } else finishesWithoutStart++;
    }
  };
  const grid=new ScanGrid(fact=>{gridFacts++;accept(fact);});
  if(trace.events.length>1_000_000)throw Error('Analysis event limit exceeded');
  for(const event of trace.events) {
    if(!Number.isSafeInteger(event.seq)||event.seq<=previousSeq||!Number.isFinite(event.time)||event.time<0)
      throw Error('Expected ordered trace events');
    previousSeq=event.seq;
    // Input lineage uses capture time; it may arrive after execution events.
    if(event.type!=='grid-command'&&event.type!=='observation-fact')continue;
    if(event.time<previousTime)throw Error('Expected monotonic execution times');
    previousTime=time=event.time;
    if(event.type==='grid-command')applyScanGridCommand(grid,event.value);
    else if(event.type==='observation-fact'){directFacts++;accept(event.value);}
  }
  intervals.sort((a,b)=>a[0]-b[0]);
  let occupiedMs=0,end=null;const gaps=[];
  for(const [start,finish] of intervals) {
    if(end!==null&&start>end)gaps.push([end,start]);
    occupiedMs+=Math.max(0,finish-Math.max(start,end??start));
    end=Math.max(end??finish,finish);
  }
  const spanMs=intervals.length?end-intervals[0][0]:null;
  // Task overlap measures scheduler occupancy, not CPU utilization. Aggregate
  // simultaneous boundaries before advancing so touching tasks do not overlap.
  const boundaries=new Map();
  for(const [start,finish] of intervals) {
    boundaries.set(start,(boundaries.get(start)??0)+1);
    boundaries.set(finish,(boundaries.get(finish)??0)-1);
  }
  const concurrencyMs={};let concurrency=0,lastBoundary=null;
  for(const [at,change] of [...boundaries].sort((a,b)=>a[0]-b[0])) {
    if(lastBoundary!==null&&at>lastBoundary)
      concurrencyMs[concurrency]=(concurrencyMs[concurrency]??0)+at-lastBoundary;
    concurrency+=change;lastBoundary=at;
  }
  // Only completed first-start intervals prove waiting here. Retry queues and
  // never-started observations are deliberately not inferred from final state.
  const waitingUnion=[];
  for(const [start,finish] of firstWaitIntervals.sort((a,b)=>a[0]-b[0])) {
    const last=waitingUnion.at(-1);
    if(last&&start<=last[1])last[1]=Math.max(last[1],finish);
    else waitingUnion.push([start,finish]);
  }
  let gapWithFirstReadWaitingMs=0,w=0;
  for(const [start,finish] of gaps) {
    while(w<waitingUnion.length&&waitingUnion[w][1]<=start)w++;
    for(let i=w;i<waitingUnion.length&&waitingUnion[i][0]<finish;i++)
      gapWithFirstReadWaitingMs+=Math.max(0,Math.min(finish,waitingUnion[i][1])-Math.max(start,waitingUnion[i][0]));
  }
  return {version:1,status:!duration.length?'unmeasured':!trace.complete||trace.dropped||startsWithoutQueue||active.size?'partial':'measured',
    traceComplete:trace.complete,traceDropped:trace.dropped,gridFacts,directFacts,
    firstReadWaitMs:stats(firstWait),retryFromInitialQueueMs:stats(retryWait),readTaskMs:stats(duration),
    matchedTaskActivity:intervals.length?{spanMs,occupiedMs,gapMs:spanMs-occupiedMs,
      summedTaskMs:duration.reduce((sum,value)=>sum+value,0)}:null,
    matchedTaskConcurrency:intervals.length?{durationMsByActiveTasks:concurrencyMs,
      scope:'Overlapping completed recorded read tasks only; scheduling and callbacks included. Not worker CPU utilization or configured reader capacity.'}:null,
    readGapEvidence:intervals.length?{gapWithFirstReadWaitingMs,
      otherGapMs:spanMs-occupiedMs-gapWithFirstReadWaitingMs,
      scope:'Union of matched first-queue-to-start waits overlapping gaps between recorded reads. Other gaps may include retries, acquisition or decoding; neither category proves CPU idle.'}:null,
    startsWithoutQueue,finishesWithoutStart,unfinishedAttempts:active.size,
    scope:'Recorded command/fact times through the common grid reducer. Read task includes scheduling and callbacks, not only worker CPU. Retry wait starts at initial queue. Finishes without a start can be state corrections, not failed reads. Not UI receipt latency or input accuracy.'};
}

export async function analyzeObservationReport(path) {
  const bytes=await readFile(path),report=JSON.parse(bytes);
  const trace=await parseRunStateTrace(new Blob([JSON.stringify(report.execution)]),new AbortController().signal);
  return {reportSha256:createHash('sha256').update(bytes).digest('hex'),analysis:analyzeObservationTiming(trace)};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href) {
  if(process.argv.length!==3)throw Error('Usage: node --import tsx scripts/analyze-observation-timing.mjs <private-run-report.json>');
  console.log(JSON.stringify(await analyzeObservationReport(process.argv[2]),null,2));
}
