import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {parseRunStateTrace} from '../dev/run-state-trace.ts';
import {analyzeCallbackStalls} from './analyze-callback-stalls.mjs';
import {analyzeInputResources} from './analyze-input-resources.mjs';
import {analyzeInputAdmission} from './analyze-input-admission.mjs';

/** Separate clock domains. Callback gaps are observations, never pixel-loss proof. */
export function analyzeInputDelivery(trace) {
  const playback=new Map(),phases=new Map(),locations=new Map(),decisions={},deferrals={};
  let previousSeq=-1;
  for(const event of trace.events) {
    if(!Number.isSafeInteger(event.seq)||event.seq<=previousSeq)throw Error('Expected ordered validated events');
    previousSeq=event.seq;
    const v=event.value;
    if(event.type==='source-playback') {
      const row=playback.get(v.playbackId)??{playbackId:v.playbackId,callbacks:0,maxMediaGapSeconds:null,
        maxCallbackGapMs:null,mediaRegressions:0,callbackRegressions:0,firstMediaTime:null,lastMediaTime:null,endReason:null};
      if(v.type==='frame') {
        if(row.previous) {
          const media=v.mediaTime-row.previous.mediaTime,wall=v.observedAtMs-row.previous.observedAtMs;
          if(media<0)row.mediaRegressions++;else row.maxMediaGapSeconds=Math.max(row.maxMediaGapSeconds??0,media);
          if(wall<0)row.callbackRegressions++;else row.maxCallbackGapMs=Math.max(row.maxCallbackGapMs??0,wall);
        }
        row.firstMediaTime??=v.mediaTime;row.lastMediaTime=v.mediaTime;row.callbacks++;row.previous=v;
      } else if(v.type==='end')row.endReason=v.reason;
      playback.set(v.playbackId,row);
    }
    if(event.type==='input-decision')decisions[v.kind]=(decisions[v.kind]??0)+1;
    if(event.type==='backup-capacity-deferral')deferrals[v.reason]=(deferrals[v.reason]??0)+1;
    if(event.type==='scroll-capture') {
      const s=v.source,key=JSON.stringify([s.sessionId,s.phase]);
      const group=locations.get(key)??{sessionId:s.sessionId,phase:s.phase,frames:new Map()};
      const row=group.frames.get(s.processingFrame)??{processingFrame:s.processingFrame,located:new Set()};
      // Every other scroll state requires a detected layout; it does not imply
      // readable cards or a usable scrollbar. Do not infer positions here.
      row.located.add(v.state!=='not-located');group.frames.set(s.processingFrame,row);locations.set(key,group);
    }
    if(event.type==='acquisition-capture') {
      const row=phases.get(v.phase)??{phase:v.phase,observations:0,frames:new Set(),firstCaptureTime:null,lastCaptureTime:null};
      row.observations++;row.frames.add(JSON.stringify([v.sessionId,v.acquisitionFrameId]));
      row.firstCaptureTime=Math.min(row.firstCaptureTime??Infinity,v.captureTime);
      row.lastCaptureTime=Math.max(row.lastCaptureTime??-Infinity,v.captureTime);phases.set(v.phase,row);
    }
  }
  return {version:1,traceComplete:trace.complete,traceDropped:trace.dropped,
    status:!playback.size&&!phases.size&&!locations.size?'unmeasured':!trace.complete||trace.dropped?'partial':'measured',
    playback:[...playback.values()].map(({previous,...row})=>{void previous;return row;}),
    acquisition:[...phases.values()].map(({frames,...row})=>({...row,framesWithObservations:frames.size})),
    locations:[...locations.values()].map(({frames,...group})=>{
      const rows=[...frames.values()].sort((a,b)=>a.processingFrame-b.processingFrame);
      const first=rows.find(r=>r.located.size===1&&r.located.has(true));
      const misses=rows.filter(r=>r.located.size===1&&r.located.has(false));
      return {...group,observedFrames:rows.length,conflictingFrames:rows.filter(r=>r.located.size!==1).length,
        firstLocatedProcessingFrame:first?.processingFrame??null,notLocatedFrames:misses.length,
        notLocatedBeforeFirst:first?misses.filter(r=>r.processingFrame<first.processingFrame).length:null,
        notLocatedAfterFirst:first?misses.filter(r=>r.processingFrame>first.processingFrame).length:null};
    }),
    decisions,deferrals,
    scope:'Observed source callbacks and acquisition receipts only. Source media time, callback clock and capture time are separate. No timestamp-based frame joins, decoded-frame coverage, pixel equality or causal attribution. Frames without acquisition observations are not counted; missing facts are not zero work.'};
}

export async function analyzeInputDeliveryReport(path) {
  const bytes=await readFile(path),report=JSON.parse(bytes);
  const trace=await parseRunStateTrace(new Blob([JSON.stringify(report.execution)]),new AbortController().signal);
  return {reportSha256:createHash('sha256').update(bytes).digest('hex'),...analyzeInputDelivery(trace),
    callbackStalls:analyzeCallbackStalls(trace,report.performance),inputResources:analyzeInputResources(trace),
    inputAdmission:analyzeInputAdmission(trace)};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href) {
  try {
    if(process.argv.length!==3)throw Error('Usage: node --import tsx scripts/analyze-input-delivery.mjs <run.json>');
    console.log(JSON.stringify(await analyzeInputDeliveryReport(process.argv[2]),null,2));
  } catch(error) {console.error(error.message);process.exitCode=1;}
}
