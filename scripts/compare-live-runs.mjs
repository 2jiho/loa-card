import {readFile,stat} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {parseScanResult,compareScanResults} from './scan-case-results.mjs';

const hash=/^[a-f0-9]{64}$/;
const measured=value=>typeof value==='number'&&Number.isFinite(value)&&value>=0?value:null;
const interval=(end,start)=>measured(end)!==null&&measured(start)!==null&&end>=start?end-start:null;
const sampleCount=value=>Number.isSafeInteger(value)&&value>=0?value:null;
function feedbackMeasurements(receipts) {
  return Object.fromEntries(['viewport','crop-queued','read-task-start','read-task-end'].map(kind=>{
    const stage=receipts?.byKind?.[kind],samples=sampleCount(stage?.samples);
    return [kind,{status:samples===null?'missing':samples===0?'unmeasured':'partial',samples,
      offered:sampleCount(stage?.offeredValidFacts),receipts:sampleCount(stage?.receipts),
      factToReceiptP95Ms:samples!==null&&samples>0?measured(stage?.factToReceipt?.p95Ms):null,
      publicationToReceiptP95Ms:samples!==null&&samples>0?measured(stage?.publicationToReceipt?.p95Ms):null}];
  }));
}
const stable=value=>JSON.stringify(value,(_key,item)=>item&&typeof item==='object'&&!Array.isArray(item)
  ?Object.fromEntries(Object.keys(item).sort().map(key=>[key,item[key]])):item);
function experimentRequest(report,key) {
  const sources=[report.validation,report.validation?.screenOptions,report.runtimeConfiguration].filter(value=>value&&typeof value==='object');
  const entries=sources.filter(source=>Object.hasOwn(source,key)).map(source=>source[key]);
  if(!entries.length)return {value:null,status:'unknown'};
  if(entries.some(value=>typeof value!=='boolean'))return {value:null,status:'invalid'};
  if(entries.some(value=>value!==entries[0]))return {value:null,status:'conflict'};
  return {value:entries[0],status:'recorded'};
}
function latestGateEvidence(performance) {
  const value=performance?.completionPixelGate;
  if(value===undefined||value===null)return {status:'unknown',referenceSamples:null,currentSamples:null,matches:null,mismatches:null,unavailable:null};
  if(!value||typeof value!=='object'||Array.isArray(value))return {status:'invalid',referenceSamples:null,currentSamples:null,matches:null,mismatches:null,unavailable:null};
  const counts=Object.fromEntries(['referenceSamples','currentSamples','matches','mismatches','unavailable'].map(key=>[key,sampleCount(value[key])]));
  if(Object.values(counts).some(count=>count===null))return {status:'invalid',...counts};
  return {status:'instrumentation-observed',...counts};
}
function inputKind(validation) {
  if(validation.scheduling==='paced-native-video-screen-loop'&&validation.input.length===1&&
     typeof validation.input[0].type==='string'&&validation.input[0].type.startsWith('video/'))return 'video-capture-stream';
  return null;
}
function cropRecordingRequest(report) {
  if(!Object.hasOwn(report,'cropEvidence'))return null;
  if(report.cropEvidence===null)return false;
  return typeof report.cropEvidence?.requested==='boolean'?report.cropEvidence.requested:null;
}

/** Compare observations, never infer accuracy or causality from one faster run. */
export function compareLiveRuns(before,after) {
  function inspect(report) {
    const v=report.validation,p=report.performance;
    if(!v||v.mode!=='live'||v.completed!==true||!p)throw Error('Expected a completed live run');
    if(v.sourceChanged!==false||!hash.test(v.sourceStart?.sourceDigest)||v.sourceStart.sourceDigest!==v.sourceEnd?.sourceDigest)
      throw Error('Missing or changing runtime source');
    if(!Array.isArray(v.input)||!v.input.length||v.input.some((input,i)=>input.index!==i||!hash.test(input.sha256)||!Number.isSafeInteger(input.bytes)||input.bytes<1))
      throw Error('Missing ordered input hashes');
    if(v.startedWithCards!==0||v.captureOnly!==false)throw Error('Requires empty-list recognition runs');
    const result=parseScanResult(report);
    const pipeline=p.inputPipeline??{},stages=p.live?.stages??{};
    const gate=experimentRequest(report,'latestPixelGateRequested'),gateEvidence=latestGateEvidence(p);
    const fastAssist=experimentRequest(report,'fastOcrAssistRequested');
    const obstruction=experimentRequest(report,'obstructionFenceRequested');
    const rejectedTransport=experimentRequest(report,'rejectedTransportRequested');
    return {source:v.sourceStart.sourceDigest,result,
      context:{input:v.input.map(({index,bytes,sha256})=>({index,bytes,sha256})),
        runtime:report.runtimeConfiguration??null,recording:v.recordingEnabled??null,
        browser:v.browser??null,hardwareConcurrency:v.hardwareConcurrency??null,
        visibility:v.visibility?.everHidden??null,latestPixelGateRequested:gate.value,
        fastOcrAssistRequested:fastAssist.value,
        inputKind:inputKind(v),cropRecordingRequested:cropRecordingRequest(report),obstructionFenceRequested:obstruction.value,
        rejectedTransportRequested:rejectedTransport.value,
        freshnessVersion:v.freshnessVersion===1||v.freshnessVersion===2?v.freshnessVersion:null},
      latestPixelGate:{requestStatus:gate.status,requested:gate.value,evidence:gateEvidence,
        consistency:gate.value===false&&gateEvidence.status==='instrumentation-observed'?'conflict':'unproven',
        interpretation:'Instrumentation presence is not a match, actual automatic stop, or proof of all prior exposures.'},
      fastOcrAssist:{requestStatus:fastAssist.status,requested:fastAssist.value,
        evidence:p.fastOcrAssist??null,
        consistency:fastAssist.value===false&&p.fastOcrAssist!=null?'conflict':'unproven',
        interpretation:'Dispatch counters do not prove input coverage, correctness, or a speedup.'},
      obstructionFence:{requestStatus:obstruction.status,requested:obstruction.value,
        evidence:p.obstructionExperiment??null,stateReplay:v.obstructionStateReplay??null},
      rejectedTransport:{requestStatus:rejectedTransport.status,requested:rejectedTransport.value},
      measurements:{elapsedMs:measured(p.elapsedMs),
        feedback:feedbackMeasurements(p.feedbackReceipts),
        inputFinishedMs:measured(p.liveTiming?.inputFinishedMs),
        afterInputFinishedMs:interval(p.elapsedMs,p.liveTiming?.inputFinishedMs),
        // Both stamps belong to scanner time. Never subtract these from the
        // run clock or trust a persisted withinTarget boolean as completion.
        afterLastIdentifiedCardMs:interval(p.finishTiming?.finishedMs,p.finishTiming?.lastCardInputMs),
        afterLastIdentifiedToAutoStopMs:interval(p.finishTiming?.autoStoppedMs,p.finishTiming?.lastCardInputMs),
        afterAutoStopMs:interval(p.finishTiming?.finishedMs,p.finishTiming?.autoStoppedMs),
        recoveryFrames:measured(p.recovery?.frames),
        recoveryAcquisitionMs:measured(p.recovery?.acquisitionMs),
        recoveryReadMs:measured(p.recovery?.readMs),
        offered:measured(pipeline.offered),processed:measured(pipeline.processed),
        replaced:measured(pipeline.replaced),capacityDropped:measured(pipeline.capacityDropped),
        workerMs:measured(stages.workerMs),detectMs:measured(stages.detectMs),cropMs:measured(stages.cropMs)},
      completeInventory:result.expected!==null&&result.read===result.expected&&result.cards.length===result.expected&&
        result.unidentified===0&&result.cards.every(card=>card.awakening!==null&&card.extraCopies!==null&&!card.review.length)&&
        report.diagnosticSummary?.unresolvedFieldChanges===0};
  }
  const a=inspect(before),b=inspect(after);
  const differences=Object.keys(a.context).filter(key=>stable(a.context[key])!==stable(b.context[key]));
  const missingContext=Object.keys(a.context).filter(key=>a.context[key]===null||b.context[key]===null);
  return {version:1,sameSource:a.source===b.source,contextDifferences:differences,missingContext,
    resultComparison:compareScanResults(a.result,b.result),
    lastCardTimingScope:'Last identified card capture to scanner finish; does not prove the last valid exposure of unseen cards or UI paint. Complete inventory must be checked independently.',
    before:{source:a.source,completeInventory:a.completeInventory,inputKind:a.context.inputKind,
      freshnessVersion:a.context.freshnessVersion,cropRecordingRequested:a.context.cropRecordingRequested,latestPixelGate:a.latestPixelGate,fastOcrAssist:a.fastOcrAssist,obstructionFence:a.obstructionFence,rejectedTransport:a.rejectedTransport,...a.measurements},
    after:{source:b.source,completeInventory:b.completeInventory,inputKind:b.context.inputKind,
      freshnessVersion:b.context.freshnessVersion,cropRecordingRequested:b.context.cropRecordingRequested,latestPixelGate:b.latestPixelGate,fastOcrAssist:b.fastOcrAssist,obstructionFence:b.obstructionFence,rejectedTransport:b.rejectedTransport,...b.measurements},
    interpretation:'Observed runs only. Matching configuration is not equal delivered pixels, system load, CPU time, or proof of accuracy. Incomplete results must not be ranked as faster completion. After-input time is run return minus media input end, not last valid card exposure or UI paint; recovery task durations can overlap and must not be summed as elapsed time. Feedback receipts cover only matched visible targets, not paint or all transitions; zero samples are unmeasured, not zero latency.'};
}

async function readReport(path) {
  if((await stat(path)).size>64*1024*1024)throw Error('Run report exceeds 64 MiB');
  const bytes=await readFile(path);
  if(bytes.length>64*1024*1024)throw Error('Run report exceeds 64 MiB');
  return {report:JSON.parse(bytes),sha256:createHash('sha256').update(bytes).digest('hex')};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href) {
  if(process.argv.length!==4)throw Error('Usage: node scripts/compare-live-runs.mjs <before.json> <after.json>');
  const [a,b]=await Promise.all(process.argv.slice(2).map(readReport));
  console.log(JSON.stringify({reports:[a.sha256,b.sha256],...compareLiveRuns(a.report,b.report)},null,2));
}
