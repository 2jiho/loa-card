import {readFile,stat} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {basename} from 'node:path';
import {pathToFileURL} from 'node:url';
import {compareScanResults} from './scan-case-results.mjs';

const hash=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const stable=value=>JSON.stringify(value,(_key,item)=>object(item)
  ?Object.fromEntries(Object.keys(item).sort().map(key=>[key,item[key]])):item);
const same=(a,b)=>stable(a)===stable(b);
function requireCondition(condition,message){if(!condition)throw Error(message);}

/** Compare two explicit offline rereads of the same saved pixels. This checks
 * report provenance and settings; reports are observations, not attestations
 * of human truth, original input completeness, or live performance. */
export function compareStoredReplays(baseline,fractional){
 function inspect(report,mode){
  requireCondition(object(report)&&object(report.validation)&&object(report.replayEvidence)&&object(report.runtimeConfiguration),'Missing replay report');
  const v=report.validation,e=report.replayEvidence,c=e.comparison,r=report.runtimeConfiguration;
  requireCondition(v.mode==='recorded-input-reinterpretation'&&v.scheduling==='recorded-input-sequential-reinterpretation'&&
   v.completed===true&&v.outcome==='completed'&&v.error===null&&!v.captureOnly,'Expected completed sequential recognition replay');
  requireCondition(v.integrity==='original-blob-sha256-verified-before-run','Missing verified original input');
  requireCondition(v.sourceChanged===false&&hash(v.sourceStart?.sourceDigest)&&v.sourceStart.sourceDigest===v.sourceEnd?.sourceDigest,'Missing or changing source digest');
  requireCondition(Array.isArray(v.input)&&v.input.length===1&&v.input.every((input,i)=>object(input)&&input.index===i&&
   hash(input.sha256)&&Number.isSafeInteger(input.bytes)&&input.bytes>0&&typeof input.type==='string'),'Invalid ordered input');
  requireCondition(e.kind==='stored-exact-pixels'&&Number.isSafeInteger(e.verifiedFrames)&&e.verifiedFrames>0&&
   typeof e.partial==='boolean'&&typeof e.configurationRecorded==='boolean','Missing exact pixel verification');
  requireCondition(e.seedCount===0&&v.startedWithCards===0,'Expected empty initial inventory');
  requireCondition(object(c)&&c.scope==='stored-input-counterfactual-recognition'&&c.requested===mode&&
   same(c.applied,{fractionalPortrait:mode==='fractional',grayNameFallback:false})&&
   object(c.appliedNameConfiguration)&&c.appliedNameConfiguration.version===1&&
   c.appliedNameConfiguration.rawResultPolicy==='resample'&&!c.appliedNameConfiguration.contrastNameFallback&&
   Object.keys(c.appliedNameConfiguration).every(key=>['version','rawResultPolicy','contrastNameFallback'].includes(key)),
   'Invalid comparison configuration');
  requireCondition(e.configurationRecorded?object(c.recordedNameConfiguration):c.recordedNameConfiguration===null,'Missing recorded configuration status');
  requireCondition(c.recordedDevRecognition===null||object(c.recordedDevRecognition)&&c.recordedDevRecognition.version===1&&
   c.recordedDevRecognition.fractionalPortrait===false&&c.recordedDevRecognition.grayNameFallback===false,
   'Invalid recorded development options');
  requireCondition(!e.configurationRecorded||same(c.recordedNameConfiguration,c.appliedNameConfiguration),'Recorded name configuration conflict');
  requireCondition(same(e.configuration,c.appliedNameConfiguration)&&same(e.devRecognition?.applied,c.applied)&&
   same(e.devRecognition?.recorded,c.recordedDevRecognition)&&e.devRecognition?.scope==='recognition-retries-only','Replay settings conflict');
  requireCondition(r.portraitRegistration===(mode==='baseline'?'integer-cell-v1':'full-retry-near-quarter-v1')&&
   same(r.nameConfiguration,c.appliedNameConfiguration),'Runtime settings conflict');
  requireCondition(typeof v.browser==='string'&&v.browser.length>0&&Number.isSafeInteger(v.hardwareConcurrency)&&v.hardwareConcurrency>0,'Missing browser context');
  const runtimeFields=['source','rowMode','captureOnly','liveScreen','continuousRecording','lanePlan','hardwareConcurrency','build',
   'recordingControl','recordingMode','unknownSourcePolicy','nativeAcquisition','rgbaRecovery','preparedSource','restoredHandoff',
   'preparedCropProof','localCropPixels','visualOverflow','nameRawResultPolicy','nameConfiguration','preparedSourceMode',
   'grayFirstLineFallback','portraitRegistration','liveInputSelection','sourceStore','recordingCodecPolicy','recordingBudgetBytes',
   'restoredHandoffRequested','preparedCropProofRequested','latestPixelGateRequested','completionDrainRequested',
   'obstructionFenceRequested','frameObstructionProbeRequested','frameObstructionHashRequested','countSourceProbeRequested',
   'hiddenUnknownProbeRequested','playbackSourcePresentation'];
  requireCondition(runtimeFields.every(key=>Object.hasOwn(r,key)&&r[key]!==undefined),'Missing replay runtime context');
  requireCondition(object(r.lanePlan)&&Number.isSafeInteger(r.lanePlan.fast)&&r.lanePlan.fast>0&&
   Number.isSafeInteger(r.lanePlan.readers)&&r.lanePlan.readers>0&&r.hardwareConcurrency===v.hardwareConcurrency&&
   object(r.liveInputSelection)&&['pendingFrames','maxRetainedBytes','hint','minIntervalMs','offerFloorMs']
    .every(key=>Object.hasOwn(r.liveInputSelection,key)&&r.liveInputSelection[key]!==undefined)&&
   object(r.sourceStore)&&typeof r.sourceStore.kind==='string'&&r.sourceStore.kind.length>0,
   'Invalid replay runtime context');
  requireCondition(['captureOnly','liveScreen','continuousRecording','nativeAcquisition','rgbaRecovery','preparedSource',
   'restoredHandoff','preparedCropProof','localCropPixels','visualOverflow','restoredHandoffRequested','preparedCropProofRequested',
   'latestPixelGateRequested','completionDrainRequested','obstructionFenceRequested','frameObstructionProbeRequested',
   'frameObstructionHashRequested','countSourceProbeRequested','hiddenUnknownProbeRequested'].every(key=>typeof r[key]==='boolean')&&
   ['source','rowMode','build','recordingControl','recordingMode','unknownSourcePolicy','nameRawResultPolicy','grayFirstLineFallback',
    'playbackSourcePresentation'].every(key=>typeof r[key]==='string'&&r[key].length>0)&&
   Number.isSafeInteger(r.recordingBudgetBytes)&&r.recordingBudgetBytes>0,'Invalid replay runtime context');
  const {portraitRegistration: _variant,...runtime}=r;
  const validationOptions={captureOnly:v.captureOnly,latestPixelGateRequested:v.latestPixelGateRequested,
   restoredHandoffRequested:v.restoredHandoffRequested,preparedCropProofRequested:v.preparedCropProofRequested,
   completionDrainRequested:v.completionDrainRequested,obstructionFenceRequested:v.obstructionFenceRequested,
   frameObstructionProbeRequested:v.frameObstructionProbeRequested,frameObstructionHashRequested:v.frameObstructionHashRequested,
   countSourceProbeRequested:v.countSourceProbeRequested,inputProvider:v.inputProvider,pairedCropTargets:v.pairedCropTargets,
   nameOptions:v.nameOptions,rowMode:v.rowMode,screenOptions:v.screenOptions,recordingEnabled:v.recordingEnabled,
   inputOrder:v.inputOrder,inputClock:v.inputClock,browser:v.browser,hardwareConcurrency:v.hardwareConcurrency};
  requireCondition(Object.values(validationOptions).every(value=>value!==undefined),'Missing replay execution configuration');
  requireCondition(['captureOnly','latestPixelGateRequested','restoredHandoffRequested','preparedCropProofRequested',
   'completionDrainRequested','obstructionFenceRequested','frameObstructionProbeRequested','frameObstructionHashRequested',
   'countSourceProbeRequested','recordingEnabled'].every(key=>typeof v[key]==='boolean')&&
   object(v.nameOptions)&&same(v.nameOptions.configuration,c.appliedNameConfiguration)&&Array.isArray(v.pairedCropTargets)&&
   typeof v.rowMode==='string'&&typeof v.inputOrder==='string'&&typeof v.inputClock==='string','Invalid replay execution configuration');
  return {source:v.sourceStart.sourceDigest,input:v.input.map(({index,bytes,sha256,type})=>({index,bytes,sha256,type})),
   caseId:v.caseId,frames:e.verifiedFrames,partial:e.partial,configurationRecorded:e.configurationRecorded,
   recordedName:c.recordedNameConfiguration,recordedDev:c.recordedDevRecognition,appliedName:c.appliedNameConfiguration,
   runtime,validationOptions,result:report};
 }
 const a=inspect(baseline,'baseline'),b=inspect(fractional,'fractional');
 requireCondition(a.source===b.source,'Replay source digest differs');
 requireCondition(same(a.input,b.input)&&hash(a.caseId)&&a.caseId===b.caseId,'Replay input differs');
 requireCondition(a.frames===b.frames&&a.partial===b.partial,'Verified replay coverage differs');
 requireCondition(a.configurationRecorded===b.configurationRecorded&&same(a.recordedName,b.recordedName)&&same(a.recordedDev,b.recordedDev)&&
  same(a.appliedName,b.appliedName),'Recorded or applied replay settings differ');
 requireCondition(same(a.runtime,b.runtime)&&same(a.validationOptions,b.validationOptions),'Replay execution configuration differs');
 return {version:1,scope:'stored-input-counterfactual-recognition',matchedDeclaredRequirements:true,
  executionSettingsCompleteness:'unknown',replayRuns:{baseline:'completed',fractional:'completed'},
  input:a.input,caseId:a.caseId,sourceDigest:a.source,
  inputCoverage:{storedRecord:a.partial?'partial':'not-declared-partial',originalCapture:'unknown',
   verifiedFrames:a.frames,comparedFrameIdentities:'unknown'},
  originalNameConfiguration:a.configurationRecorded?'recorded':'unknown',
  originalDevelopmentOptions:a.recordedDev===null?'unknown':'recorded',
  resultComparison:compareScanResults(a.result,b.result),
  limitations:'Checks recorded report provenance and settings, not human correctness, model bytes, original capture completeness, exact execution scheduling, or real-time performance. Frame counts alone do not prove which frames were read.'};
}

async function loadReport(path){
 requireCondition((await stat(path)).size<=64*1024*1024,'Report exceeds 64 MiB');
 const bytes=await readFile(path);requireCondition(bytes.length<=64*1024*1024,'Report exceeds 64 MiB');
 const digest=createHash('sha256').update(bytes).digest('hex'),name=basename(path),match=/^run-([a-f0-9]{64})\.json$/.exec(name);
 if(match)requireCondition(match[1]===digest,'Content-addressed report hash mismatch');
 return {report:JSON.parse(bytes),sha256:digest};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 if(process.argv.length!==4)throw Error('Usage: node scripts/compare-stored-replays.mjs <baseline.json> <fractional.json>');
 const [a,b]=await Promise.all(process.argv.slice(2).map(loadReport));
 console.log(JSON.stringify({reports:[a.sha256,b.sha256],...compareStoredReplays(a.report,b.report)},null,2));
}
