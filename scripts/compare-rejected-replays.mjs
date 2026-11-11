import {readFile,stat} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {basename} from 'node:path';
import {pathToFileURL} from 'node:url';
import {parseRunStateTrace} from '../dev/run-state-trace.ts';
import {compareScanResults} from './scan-case-results.mjs';

const isHash=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const object=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const stable=v=>JSON.stringify(v,(_k,x)=>object(x)?Object.fromEntries(Object.keys(x).sort().map(k=>[k,x[k]])):x);
const same=(a,b)=>stable(a)===stable(b);
const requireCondition=(x,why)=>{if(!x)throw Error(why);};
const requireKeys=(o,keys,label)=>requireCondition(object(o)&&keys.every(k=>Object.hasOwn(o,k)&&o[k]!==undefined),`Missing ${label}`);
const runtimeKeys=['source','rowMode','captureOnly','liveScreen','continuousRecording','lanePlan','hardwareConcurrency','build',
 'recordingControl','recordingMode','rejectedTransportRequested','rejectedReplayRequested','unknownSourcePolicy','nativeAcquisition',
 'rgbaRecovery','preparedSource','restoredHandoff','preparedCropProof','localCropPixels','visualOverflow','nameRawResultPolicy',
 'nameConfiguration','preparedSourceMode','grayFirstLineFallback','portraitRegistration','liveInputSelection','sourceStore',
 'recordingCodecPolicy','recordingBudgetBytes','restoredHandoffRequested','preparedCropProofRequested','latestPixelGateRequested',
 'completionDrainRequested','obstructionFenceRequested','advisoryFenceRequested','moveReuseProfileRequested',
 'frameObstructionProbeRequested','frameObstructionHashRequested','countSourceProbeRequested','hiddenUnknownProbeRequested','playbackSourcePresentation'];
const validationKeys=['captureOnly','latestPixelGateRequested','restoredHandoffRequested','preparedCropProofRequested',
 'rejectedTransportRequested','rejectedReplay','completionDrainRequested','obstructionFenceRequested','freshnessVersion',
 'advisoryFenceRequested','moveReuseProfileRequested','frameObstructionProbeRequested','frameObstructionHashRequested',
 'countSourceProbeRequested','inputProvider','pairedCropTargets','nameOptions','rowMode','scheduling','hardwareConcurrency',
 'screenOptions','recordingEnabled','ui','stateRecording','obstructionStateReplay','inputOrder','timeUnknown','inputClock','browser','build','serverStartSignature'];
function inspect(report,variant){
 requireKeys(report,['validation','runtimeConfiguration','replayEvidence','result'],'replay report');
 const v=report.validation,r=report.runtimeConfiguration,e=report.replayEvidence;
 requireKeys(v,validationKeys,'validation context');requireKeys(r,runtimeKeys,'runtime context');
 requireKeys(e,['kind','seedCount','partial','configurationRecorded','configuration','devRecognition','verifiedFrames','comparison','sourceUseTrace'],'replay evidence');
 requireCondition(v.mode==='recorded-input-reinterpretation'&&v.scheduling==='recorded-screen-input-sequential-worker-reinterpretation'&&
  v.completed===true&&v.outcome==='completed'&&v.error===null&&!v.captureOnly,'Expected completed sequential Worker replay');
 requireCondition(v.integrity==='original-blob-sha256-verified-before-run'&&isHash(v.caseId),'Unverified input');
 requireCondition(v.sourceChanged===false&&isHash(v.sourceStart?.sourceDigest)&&v.sourceStart.sourceDigest===v.sourceEnd?.sourceDigest,'Missing or changing source digest');
 requireCondition(Array.isArray(v.input)&&v.input.length===1&&v.input.every((x,i)=>object(x)&&x.index===i&&isHash(x.sha256)&&Number.isSafeInteger(x.bytes)&&x.bytes>0&&typeof x.type==='string'&&x.type.length>0),'Invalid ordered input');
 requireCondition(e.kind==='stored-exact-pixels'&&Number.isSafeInteger(e.verifiedFrames)&&e.verifiedFrames>0&&typeof e.partial==='boolean'&&typeof e.configurationRecorded==='boolean'&&e.seedCount===0&&v.startedWithCards===0,'Missing exact pixel verification or empty seed');
 requireCondition(object(e.configuration)&&object(e.devRecognition)&&same(e.configuration,v.nameOptions?.configuration)&&same(e.configuration,r.nameConfiguration)&&e.comparison===null,'Conflicting recognition configuration');
 requireCondition(typeof v.browser==='string'&&v.browser.length>0&&Number.isSafeInteger(v.hardwareConcurrency)&&v.hardwareConcurrency>0&&v.hardwareConcurrency===r.hardwareConcurrency&&object(r.lanePlan)&&Number.isSafeInteger(r.lanePlan.fast)&&r.lanePlan.fast>0&&Number.isSafeInteger(r.lanePlan.readers)&&r.lanePlan.readers>0,'Invalid browser or lane context');
 const rr=v.rejectedReplay;
 requireKeys(rr,['variant','source','acquisition','inputPhase','recoveryPhase','workerInputPixelAttestation','seedPolicy'],'transport replay configuration');
 requireCondition(rr.variant===variant&&rr.acquisition==='worker'&&rr.inputPhase===(variant==='baseline'?'full-raster':'omit-repeated-rejected-raster')&&rr.recoveryPhase==='full-raster'&&rr.workerInputPixelAttestation==='not-verified'&&rr.seedPolicy==='empty-required','Invalid transport replay configuration');
 const legacy=rr.source==='stored-screen-capture';
 requireCondition(legacy||(rr.source==='stored-scanner-input'&&rr.originalCaptureSource==='unknown'&&rr.replaySemantics==='screen'),'Unrecognized stored input source');
 requireCondition(r.rejectedReplayRequested===variant&&r.rejectedTransportRequested===(variant==='reduced')&&v.rejectedTransportRequested===(variant==='reduced'),'Contradictory variant');
 const prohibited=['latestPixelGateRequested','restoredHandoffRequested','preparedCropProofRequested','completionDrainRequested',
  'obstructionFenceRequested','advisoryFenceRequested','moveReuseProfileRequested','frameObstructionProbeRequested','frameObstructionHashRequested','countSourceProbeRequested','recordingEnabled'];
 const runtimeProhibited=['nativeAcquisition','rgbaRecovery','preparedSource','restoredHandoff','preparedCropProof','localCropPixels',
  'visualOverflow','restoredHandoffRequested','preparedCropProofRequested','latestPixelGateRequested','completionDrainRequested',
  'obstructionFenceRequested','advisoryFenceRequested','moveReuseProfileRequested','frameObstructionProbeRequested',
  'frameObstructionHashRequested','countSourceProbeRequested','hiddenUnknownProbeRequested'];
 requireCondition(prohibited.every(k=>v[k]===false)&&runtimeProhibited.every(k=>r[k]===false)&&
  v.inputProvider===null&&v.screenOptions===null&&Array.isArray(v.pairedCropTargets)&&v.pairedCropTargets.length===0&&
  v.rowMode==='all'&&r.source==='screen'&&r.rowMode==='all'&&r.liveScreen===false&&r.captureOnly===false&&
  r.continuousRecording===false&&r.recordingMode==='diagnostic'&&r.sourceStore?.kind==='none'&&
  v.nameOptions?.prepared===false&&same(v.nameOptions.configuration,r.nameConfiguration),'Unsupported mixed experiment');
 const {rejectedTransportRequested:_transport,rejectedReplayRequested:_variant,...runtime}=r;
 const options=Object.fromEntries(validationKeys.filter(k=>!['rejectedTransportRequested','rejectedReplay'].includes(k)).map(k=>[k,v[k]]));
 return {report,source:v.sourceStart.sourceDigest,input:v.input.map(({index,sha256,bytes,type})=>({index,sha256,bytes,type})),caseId:v.caseId,
  frames:e.verifiedFrames,partial:e.partial,configurationRecorded:e.configurationRecorded,configuration:e.configuration,devRecognition:e.devRecognition,
  runtime,options,legacySourceLabel:legacy,runId:e.sourceUseTrace?.runId};
}
async function sourceUses(candidate){
 const x=candidate.report.execution;
 if(!object(x)||x.complete!==true||x.dropped!==0)return {status:'unsupported',reason:'missing-or-incomplete-execution-trace'};
 let trace;
 try{trace=await parseRunStateTrace(new Blob([JSON.stringify(x)]),AbortSignal.timeout(120_000));}
 catch{return {status:'unsupported',reason:'invalid-or-unreadable-execution-trace'};}
 if(!trace.complete||trace.dropped!==0)return {status:'unsupported',reason:'partial-execution-trace'};
 const uses=trace.events.filter(e=>e.type==='replay-source-use').map(e=>e.value);
 if(!uses.length)return {status:'unsupported',reason:'missing-replay-source-use-events'};
 requireCondition(typeof candidate.runId==='string'&&uses.every((u,i)=>u.runId===candidate.runId&&u.processingFrame===i+1),'Invalid replay source-use provenance');
 if(uses.some(u=>!Number.isSafeInteger(u.sourceFrameId)||u.sourceFrameId<1||
  !Number.isFinite(u.captureTime)||u.captureTime<0||!['input','recovery'].includes(u.phase)||u.phaseInferred!==false||!isHash(u.pixelHash)))
  return {status:'unsupported',reason:'missing-or-inferred-source-metadata'};
 return {status:'available',uses:uses.map(({processingFrame,acquisitionFrameId,sourceFrameId,captureTime,phase,phaseInferred,pixelHash})=>({processingFrame,acquisitionFrameId,sourceFrameId,captureTime,phase,phaseInferred,pixelHash}))};
}
/** Reports assert their settings and source metadata; they do not attest Worker pixels or ground truth. */
export async function compareRejectedReplays(baseline,reduced){
 const a=inspect(baseline,'baseline'),b=inspect(reduced,'reduced');
 requireCondition(a.source===b.source,'Replay source digest differs');
 requireCondition(same(a.input,b.input)&&a.caseId===b.caseId,'Replay input differs');
 requireCondition(a.frames===b.frames&&a.partial===b.partial,'Verified stored frame coverage differs');
 requireCondition(a.configurationRecorded===b.configurationRecorded&&same(a.configuration,b.configuration)&&same(a.devRecognition,b.devRecognition),'Recognition configuration differs');
 requireCondition(same(a.runtime,b.runtime)&&same(a.options,b.options),'Replay runtime or validation context differs');
 const [left,right]=await Promise.all([sourceUses(a),sourceUses(b)]);
 let sourceUse;
 if(left.status==='available'&&right.status==='available'){
  requireCondition(same(left.uses,right.uses),'Replay source-use order, time, phase or pixel hash differs');
  const phases={input:0,recovery:0};let inferredPhases=0;
  for(const use of left.uses){phases[use.phase]++;if(use.phaseInferred)inferredPhases++;}
  sourceUse={status:'matched-recorded-metadata',uses:left.uses.length,phases,inferredPhases,scope:'stored-replay-source-metadata-only'};
 }else sourceUse={status:'unsupported',baseline:left.status==='unsupported'?left.reason:'available',reduced:right.status==='unsupported'?right.reason:'available'};
 return {version:1,scope:'stored-input-rejected-transport-comparison',contextComparison:'matched-declared-context',
  sourceUseComparison:sourceUse.status==='matched-recorded-metadata'?'matched-recorded-metadata':'unsupported',
  caseId:a.caseId,input:a.input,sourceDigest:a.source,storedRecord:a.partial?'partial-or-unknown':'declared-complete',
  verifiedStoredPhysicalFrames:a.frames,sourceUse,originalCaptureSource:'unknown',
  sourceLabels:{baseline:a.legacySourceLabel?'legacy-unverified-screen-label':'stored-input-origin-unknown',reduced:b.legacySourceLabel?'legacy-unverified-screen-label':'stored-input-origin-unknown'},
  workerInputPixels:'not-verified',readerPixels:'not-verified',originalCaptureCoverage:'unknown',humanGroundTruth:'not-verified',livePerformance:'not-measured',
  resultComparison:compareScanResults(a.report,b.report),
  limitations:'Report and decoded source-use metadata comparison only; source-use equality does not prove Worker or OCR pixels, original capture coverage, human correctness, or real-time performance.'};
}
export async function loadRejectedReplayReport(path){
 requireCondition((await stat(path)).size<=64*1024*1024,'Report exceeds 64 MiB');const bytes=await readFile(path);
 requireCondition(bytes.length<=64*1024*1024,'Report exceeds 64 MiB');
 const sha256=createHash('sha256').update(bytes).digest('hex'),name=basename(path);
 if(name.startsWith('run-'))requireCondition(name===`run-${sha256}.json`,'Content-addressed report hash mismatch');
 return {report:JSON.parse(bytes.toString('utf8')),sha256};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 try{
  if(process.argv.length!==4)throw Error('Usage: node --import tsx scripts/compare-rejected-replays.mjs <baseline.json> <reduced.json>');
  const [a,b]=await Promise.all(process.argv.slice(2).map(loadRejectedReplayReport));
  const comparison=await compareRejectedReplays(a.report,b.report);
  console.log(JSON.stringify({reports:[a.sha256,b.sha256],...comparison},null,2));
  // Result differences take precedence over missing source-use evidence.
  process.exitCode=!comparison.resultComparison.exactSame?2:comparison.sourceUseComparison!=='matched-recorded-metadata'?3:0;
 }catch(error){console.error(`Comparison failed: ${error instanceof Error?error.message:String(error)}`);process.exitCode=1;}
}
