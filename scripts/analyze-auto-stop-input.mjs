import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {parseRunStateTrace} from '../dev/run-state-trace.ts';
import {createLiveInputAdmission,applyLiveInputAdmissionFact} from '../src/features/card-scanner/capture/live-input-admission.ts';
import {parseInventoryHeaderFact} from '../src/features/card-scanner/session/scroll-capture-diagnostic.ts';
import {parseInputFrameLink} from '../src/features/card-scanner/reproduction/live-input-decision-replay.ts';

/** Diagnostic facts only. A skipped callback contains no pixels and the read
 * fact is emitted after OCR; it is not the time OCR began or a stop event. */
export function analyzeAutoStopInput(trace) {
  if(!trace||!Array.isArray(trace.events)||trace.events.length>1_000_000)throw Error('Invalid or oversized trace');
  const admission=createLiveInputAdmission(),skips=[],freezes=new Map(),links=new Map();
  let seq=0,admissionFacts=0,headerReads=0,unlinkedHeaders=0,truncatedSkips=0,skipHead=0;
  let exposedHeaders=0,totalVerificationSkips=0;
  const checks=[];
  const orderedSkip=index=>skips[(skipHead+index)%skips.length];
  const countAfter=id=>{
    let low=0,high=skips.length;
    while(low<high){const mid=(low+high)>>>1;if(orderedSkip(mid)<=id)low=mid+1;else high=mid;}
    return skips.length-low;
  };
  for(const event of trace.events){
    if(!Number.isSafeInteger(event.seq)||event.seq<=seq)throw Error('Expected ordered trace events');
    seq=event.seq;
    if(event.type==='input-admission'){
      admissionFacts++;
      const result=applyLiveInputAdmissionFact(admission,event.value);
      if(event.value.kind==='frozen'&&event.value.succeeded){
        freezes.set(event.value.stamp.inputId,event.value.stamp.captureTime);
        if(freezes.size>20000)freezes.delete(freezes.keys().next().value);
      }
      if(result?.kind==='skip'&&result.reason==='verification'){
        totalVerificationSkips++;
        if(skips.length<50000)skips.push(result.stamp.inputId);
        else {skips[skipHead]=result.stamp.inputId;skipHead=(skipHead+1)%skips.length;truncatedSkips++;}
      }
    }else if(event.type==='input-link'){
      const link=parseInputFrameLink(event.value);
      if(links.has(link.inputId))throw Error('Duplicate input link');
      links.set(link.inputId,link);
      if(links.size>20000)links.delete(links.keys().next().value);
    }else if(event.type==='inventory-header-read'){
      const fact=parseInventoryHeaderFact(event.value);
      if(fact.purpose!=='auto-completion')continue;
      headerReads++;
      const id=fact.source.phase==='input'?fact.source.inputId:null;
      const link=id===null?undefined:links.get(id);
      const linked=!!link&&link.phase==='input'&&link.frameId===fact.source.acquisitionFrameId&&
        link.captureTime===fact.source.captureTime&&freezes.get(id)===fact.source.captureTime;
      const historyPartial=!linked||truncatedSkips>0&&id<orderedSkip(0);
      if(!linked)unlinkedHeaders++;
      // Strictly later callback identities observed before the read completed.
      // Repeated attempts may refer to the same skip; do not sum them as unique.
      const newer=id===null?null:countAfter(id);
      if(newer)exposedHeaders++;
      if(checks.length>=256)checks.shift();
      checks.push({factId:fact.factId,headerInputId:id,inputLinkMatches:linked,newerVerificationSkips:newer,
        historyPartial,interpretation:newer?'unobserved-input-possible':historyPartial?'unknown':'no-recorded-verification-skip'});
    }
  }
  const complete=trace.complete===true&&trace.dropped===0&&!admission.snapshot().pending;
  return {version:1,status:!admissionFacts||!headerReads?'unmeasured':!complete||unlinkedHeaders||truncatedSkips||headerReads>256?'partial':'measured',
    traceComplete:trace.complete===true,traceDropped:trace.dropped,admissionFacts,headerReads,unlinkedHeaders,
    totalVerificationSkips,exposedHeaders,truncatedSkips,checksTruncated:Math.max(0,headerReads-256),checks,
    scope:'Ordered recorded admission decisions and successful auto-completion header read facts only. A skipped callback has no saved pixels; it may show the same or a changed image. This does not prove a share stopped, a card changed, physical input uniqueness, replay accuracy, or real-time performance. Missing/failed reads are not recorded header facts. A clean result does not prove safety.'};
}

export async function analyzeAutoStopInputReport(path) {
  const bytes=await readFile(path),report=JSON.parse(bytes);
  const trace=await parseRunStateTrace(new Blob([JSON.stringify(report.execution)]),new AbortController().signal);
  return {reportSha256:createHash('sha256').update(bytes).digest('hex'),analysis:analyzeAutoStopInput(trace)};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  if(process.argv.length!==3)throw Error('Usage: node --import tsx scripts/analyze-auto-stop-input.mjs <private-run-report.json>');
  console.log(JSON.stringify(await analyzeAutoStopInputReport(process.argv[2]),null,2));
}
