import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {parseRunStateTrace} from '../dev/run-state-trace.ts';

const sourceKey=value=>JSON.stringify([value.sessionId,value.observationId]);

/** Diagnostics only. Neither shared groups nor final identities authorize a reader skip. */
export function analyzeRecognitionTail(trace,namesReadyMs) {
  if(!Number.isFinite(namesReadyMs)||namesReadyMs<0)throw Error('A measured namesReadyMs is required');
  const acquisitions=new Map(),groups=new Map(),identities=new Map(),seenGroups=new Map(),seenObservations=new Set();
  const tailGroups=new Map(),byCard=new Map(),revisionGroups=new Map();
  const result={version:1,traceComplete:trace.complete,traceDropped:trace.dropped,namesReadyMs,
    recognitionEvents:0,tailEvents:0,missingAcquisition:0,missingGroup:0,firstGroupRead:0,repeatedGroupRead:0,
    sameObservationRetry:0,sameFieldRevision:0,changedFieldRevision:0,missingFieldRevision:0,
    identityPaths:{},groupsWithoutIdentity:0,groupsWithConflictingIdentity:0};
  let previousSeq=-1;
  for(const event of trace.events) {
    if(!Number.isSafeInteger(event.seq)||event.seq<=previousSeq||!Number.isFinite(event.time)||event.time<0)
      throw Error('Expected ordered, validated trace events');
    previousSeq=event.seq;
    const v=event.value;
    if(event.type==='acquisition-capture')acquisitions.set(sourceKey(v),v);
    if(event.type==='grid-command'&&v.method==='group') {
      const [,group,,accepted,,source]=v.args;
      if(source&&accepted)groups.set(sourceKey(source),group);
    }
    if(event.type==='grid-command'&&v.method==='identify') {
      const [group,id]=v.args,ids=identities.get(group)??new Set();ids.add(id);identities.set(group,ids);
    }
    if(event.type!=='recognition-capture')continue;
    result.recognitionEvents++;
    const key=sourceKey(v.source),group=groups.get(key),old=group===undefined?undefined:seenGroups.get(group);
    const acquisition=v.acquisition?acquisitions.get(sourceKey(v.acquisition)):undefined;
    if(event.time*1000>=namesReadyMs) {
      result.tailEvents++;result.identityPaths[v.identityPath]=(result.identityPaths[v.identityPath]??0)+1;
      if(!acquisition)result.missingAcquisition++;
      if(seenObservations.has(key))result.sameObservationRetry++;
      if(group===undefined)result.missingGroup++;
      else {
        tailGroups.set(group,(tailGroups.get(group)??0)+1);
        if(acquisition?.fieldRevision) {
          // Revision tokens are acquisition-session local scheduling evidence.
          // Equal text from another session must never appear reusable.
          const revision=JSON.stringify([acquisition.sessionId,acquisition.fieldRevision]);
          const members=revisionGroups.get(revision)??new Set();
          members.add(group);revisionGroups.set(revision,members);
        }
        if(!old)result.firstGroupRead++;
        else {
          result.repeatedGroupRead++;
          if(!acquisition?.fieldRevision||!old.fieldRevision)result.missingFieldRevision++;
          else if(acquisition.fieldRevision===old.fieldRevision)result.sameFieldRevision++;
          else result.changedFieldRevision++;
        }
      }
    }
    seenObservations.add(key);
    if(group!==undefined)seenGroups.set(group,{fieldRevision:acquisition?.fieldRevision});
  }
  for(const [group,reads] of tailGroups) {
    const ids=identities.get(group);
    if(!ids?.size){result.groupsWithoutIdentity++;continue;}
    if(ids.size!==1){result.groupsWithConflictingIdentity++;continue;}
    const id=[...ids][0],row=byCard.get(id)??{id,groups:0,reads:0};row.groups++;row.reads+=reads;byCard.set(id,row);
  }
  const sharedRevisions=[...revisionGroups.values()].filter(members=>members.size>1);
  const measured=result.recognitionEvents>0;
  return {...result,status:!measured?'unmeasured':!trace.complete||trace.dropped||result.missingGroup||result.missingAcquisition?'partial':'measured',
    tailGroupCount:measured?tailGroups.size:null,identifiedTailCards:measured?byCard.size:null,
    crossGroupFieldRevisions:measured?{count:sharedRevisions.length,
      groups:[...new Set(sharedRevisions.flatMap(members=>[...members]))].length,
      scope:'Session-scoped field revision tokens shared across tail groups. Diagnostic scheduling evidence only, not identity, confirmed values or permission to skip reads.'}:null,
    fragmentedCards:measured?[...byCard.values()].filter(row=>row.groups>1).sort((a,b)=>b.groups-a.groups||a.id.localeCompare(b.id)):null,
    scope:'Identity-selection events, not inference timings or successful field reads. Final card IDs classify groups retrospectively; they are not available as early skip evidence. Missing events are not zero work.'};
}

export async function analyzeRunReport(path) {
  const bytes=await readFile(path),report=JSON.parse(bytes);
  const trace=await parseRunStateTrace(new Blob([JSON.stringify(report.execution)]),new AbortController().signal);
  return {reportSha256:createHash('sha256').update(bytes).digest('hex'),source:report.source??null,
    analysis:analyzeRecognitionTail(trace,report.performance?.finishTiming?.namesReadyMs)};
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href) {
  if(process.argv.length!==3)throw Error('Usage: node --import tsx scripts/analyze-recognition-tail.mjs <private-run-report.json>');
  console.log(JSON.stringify(await analyzeRunReport(process.argv[2]),null,2));
}
