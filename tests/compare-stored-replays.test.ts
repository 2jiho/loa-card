import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {promisify} from 'node:util';
import {compareStoredReplays} from '../scripts/compare-stored-replays.mjs';

function report(mode:'baseline'|'fractional'){
 const name={version:1,rawResultPolicy:'resample'},applied={fractionalPortrait:mode==='fractional',grayNameFallback:false};
 return {validation:{caseId:'a'.repeat(64),mode:'recorded-input-reinterpretation',scheduling:'recorded-input-sequential-reinterpretation',
  completed:true,outcome:'completed',error:null,captureOnly:false,integrity:'original-blob-sha256-verified-before-run',
  input:[{index:0,bytes:100,sha256:'b'.repeat(64),type:'application/octet-stream'}],
  sourceChanged:false,sourceStart:{sourceDigest:'c'.repeat(64)},sourceEnd:{sourceDigest:'c'.repeat(64)},startedWithCards:0,
  latestPixelGateRequested:false,restoredHandoffRequested:false,preparedCropProofRequested:false,completionDrainRequested:false,
  obstructionFenceRequested:false,frameObstructionProbeRequested:false,frameObstructionHashRequested:false,countSourceProbeRequested:false,
  inputProvider:null,pairedCropTargets:[],nameOptions:{configuration:name},rowMode:'all',screenOptions:null,recordingEnabled:false,
  inputOrder:'manifest',inputClock:'recorded',browser:'browser',hardwareConcurrency:4},
  replayEvidence:{kind:'stored-exact-pixels',seedCount:0,verifiedFrames:2,partial:false,configurationRecorded:false,configuration:name,
   devRecognition:{recorded:null,applied,scope:'recognition-retries-only'},comparison:{requested:mode,
    scope:'stored-input-counterfactual-recognition',recordedNameConfiguration:null,recordedDevRecognition:null,appliedNameConfiguration:name,applied}},
  runtimeConfiguration:{source:'screen',rowMode:'all',captureOnly:false,liveScreen:false,continuousRecording:false,lanePlan:{fast:2,readers:4},
   hardwareConcurrency:4,build:'local',recordingControl:'default',recordingMode:'diagnostic',unknownSourcePolicy:'group-v1',nativeAcquisition:false,
   rgbaRecovery:false,preparedSource:false,restoredHandoff:false,preparedCropProof:false,localCropPixels:false,visualOverflow:false,
   nameRawResultPolicy:'resample',nameConfiguration:name,preparedSourceMode:null,grayFirstLineFallback:'disabled',
   portraitRegistration:mode==='baseline'?'integer-cell-v1':'full-retry-near-quarter-v1',
   liveInputSelection:{pendingFrames:2,maxRetainedBytes:100,hint:'same-frozen-scrollbar',minIntervalMs:null,offerFloorMs:null},
   sourceStore:{kind:'none'},recordingCodecPolicy:null,recordingBudgetBytes:100,restoredHandoffRequested:false,preparedCropProofRequested:false,
   latestPixelGateRequested:false,completionDrainRequested:false,obstructionFenceRequested:false,frameObstructionProbeRequested:false,
   frameObstructionHashRequested:false,countSourceProbeRequested:false,hiddenUnknownProbeRequested:false,playbackSourcePresentation:'detached'},
  result:{expected:1,read:1,unidentified:0,experience:null,cards:[{id:'1',name:'카드',awakening:0,extraCopies:0,review:[]}]}};
}

test('matching stored rereads expose unknown original settings and only report value comparison',()=>{
 const a=report('baseline'),b=report('fractional');b.result.cards[0].extraCopies=1;
 const result=compareStoredReplays(a,b);
 assert.equal(result.matchedDeclaredRequirements,true);assert.equal(result.originalNameConfiguration,'unknown');
 assert.equal(result.executionSettingsCompleteness,'unknown');assert.equal(result.inputCoverage.originalCapture,'unknown');
 assert.equal(result.inputCoverage.storedRecord,'not-declared-partial');assert.equal(result.replayRuns.baseline,'completed');
 assert.equal(result.originalDevelopmentOptions,'unknown');assert.equal(result.resultComparison.exactSame,false);
 assert.match(result.limitations,/not human correctness/);
});

test('rejects different input, changed or missing source, bad frame coverage and nonempty seed',()=>{
 const mutations:((v:ReturnType<typeof report>)=>void)[]=[
  v=>{v.validation.input[0].sha256='d'.repeat(64)},v=>{v.validation.input[0].bytes++},
  v=>{v.validation.input[0].index=1},v=>{v.validation.caseId='d'.repeat(64)},
  v=>{v.validation.sourceChanged=true},v=>{v.validation.sourceStart.sourceDigest='d'.repeat(64)},
  v=>{v.validation.sourceStart.sourceDigest='';v.validation.sourceEnd.sourceDigest=''},
  v=>{v.replayEvidence.verifiedFrames=0},v=>{v.replayEvidence.verifiedFrames++},
  v=>{v.replayEvidence.partial=true},v=>{v.replayEvidence.seedCount=1},v=>{v.validation.startedWithCards=1},
  v=>{v.validation.integrity='not-checked-by-runner'},v=>{v.validation.completed=false},
  v=>{v.validation.outcome='cancelled'},v=>{v.validation.captureOnly=true},
 ];
 for(const mutate of mutations){const a=report('baseline'),b=report('fractional');mutate(b);assert.throws(()=>compareStoredReplays(a,b));}
});

test('rejects unrecorded or contradictory applied settings and non-experiment context changes',()=>{
 const mutations:((v:ReturnType<typeof report>)=>void)[]=[
  v=>{v.replayEvidence.comparison.requested='baseline'},
  v=>{v.replayEvidence.comparison.applied.fractionalPortrait=false},
  v=>{v.replayEvidence.devRecognition.scope='other'},
  v=>{v.replayEvidence.configurationRecorded=true},
  v=>{v.replayEvidence.comparison.recordedDevRecognition={version:1,fractionalPortrait:true,grayNameFallback:false} as never},
  v=>{v.runtimeConfiguration.portraitRegistration='integer-cell-v1'},
  v=>{v.runtimeConfiguration.lanePlan.readers=2},v=>{v.validation.hardwareConcurrency=8},
  v=>{v.validation.obstructionFenceRequested=true},v=>{v.validation.browser='other'},
  v=>{delete (v.validation as {inputClock?:string}).inputClock},
 ];
 for(const mutate of mutations){const a=report('baseline'),b=report('fractional');mutate(b);assert.throws(()=>compareStoredReplays(a,b));}
});

test('partial recording is distinct from two completed replay runs',()=>{
 const a=report('baseline'),b=report('fractional');a.replayEvidence.partial=true;b.replayEvidence.partial=true;
 const result=compareStoredReplays(a,b);
 assert.equal(result.inputCoverage.storedRecord,'partial');assert.equal(result.inputCoverage.originalCapture,'unknown');
 assert.deepEqual(result.replayRuns,{baseline:'completed',fractional:'completed'});
});

test('missing runtime fields in both reports cannot pass as matching context',()=>{
 const a=report('baseline'),b=report('fractional');
 delete (a.runtimeConfiguration as {lanePlan?:unknown}).lanePlan;delete (b.runtimeConfiguration as {lanePlan?:unknown}).lanePlan;
 assert.throws(()=>compareStoredReplays(a,b),/Missing replay runtime context/);
});

test('recorded settings must be present and agree with the applied settings',()=>{
 const a=report('baseline'),b=report('fractional');
 for(const v of [a,b]){v.replayEvidence.configurationRecorded=true;v.replayEvidence.comparison.recordedNameConfiguration={version:1,rawResultPolicy:'resample'} as never;}
 assert.equal(compareStoredReplays(a,b).originalNameConfiguration,'recorded');
 b.replayEvidence.comparison.recordedNameConfiguration={version:1,rawResultPolicy:'continue'} as never;
 assert.throws(()=>compareStoredReplays(a,b),/configuration conflict/);
});

test('CLI checks content-addressed report names before comparison',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'loacard-replay-pair-'));
 try{
  const a=join(dir,`run-${'a'.repeat(64)}.json`),b=join(dir,'fractional.json');
  await writeFile(a,JSON.stringify(report('baseline')));await writeFile(b,JSON.stringify(report('fractional')));
  await assert.rejects(promisify(execFile)(process.execPath,[resolve('scripts/compare-stored-replays.mjs'),a,b]),
   error=>{assert.match((error as Error).message,/Content-addressed report hash mismatch/);return true;});
 }finally{await rm(dir,{recursive:true,force:true});}
});
