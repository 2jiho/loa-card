import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {compareRejectedReplays,loadRejectedReplayReport} from '../scripts/compare-rejected-replays.mjs';

const hash=(s:string)=>s.repeat(64);
function report(variant:'baseline'|'reduced',options:{source?:'legacy'|'current';uses?:any[]}={}) {
 const reduced=variant==='reduced',name={version:1,rawResultPolicy:'resample'};
 const rr={variant,source:options.source==='current'?'stored-scanner-input':'stored-screen-capture',
  ...(options.source==='current'?{originalCaptureSource:'unknown',replaySemantics:'screen'}:{}),acquisition:'worker',
  inputPhase:reduced?'omit-repeated-rejected-raster':'full-raster',recoveryPhase:'full-raster',workerInputPixelAttestation:'not-verified',seedPolicy:'empty-required'};
 const runtimeConfiguration={source:'screen',rowMode:'all',captureOnly:false,liveScreen:false,continuousRecording:false,
  lanePlan:{fast:2,readers:4},hardwareConcurrency:24,build:'local',recordingControl:'default',recordingMode:'diagnostic',
  rejectedTransportRequested:reduced,rejectedReplayRequested:variant,unknownSourcePolicy:'group-v1',nativeAcquisition:false,
  rgbaRecovery:false,preparedSource:false,restoredHandoff:false,preparedCropProof:false,localCropPixels:false,visualOverflow:false,
  nameRawResultPolicy:'resample',nameConfiguration:name,preparedSourceMode:null,grayFirstLineFallback:'disabled',portraitRegistration:'integer-cell-v1',
  liveInputSelection:{pendingFrames:2},sourceStore:{kind:'none'},recordingCodecPolicy:null,recordingBudgetBytes:1,
  restoredHandoffRequested:false,preparedCropProofRequested:false,latestPixelGateRequested:false,completionDrainRequested:false,
  obstructionFenceRequested:false,advisoryFenceRequested:false,moveReuseProfileRequested:false,frameObstructionProbeRequested:false,
  frameObstructionHashRequested:false,countSourceProbeRequested:false,hiddenUnknownProbeRequested:false,playbackSourcePresentation:'detached'};
 const validation={caseId:hash('a'),mode:'recorded-input-reinterpretation',input:[{index:0,name:'x',type:'application/octet-stream',bytes:10,sha256:hash('b')}],
  captureOnly:false,latestPixelGateRequested:false,restoredHandoffRequested:false,preparedCropProofRequested:false,
  rejectedTransportRequested:reduced,rejectedReplay:rr,completionDrainRequested:false,obstructionFenceRequested:false,freshnessVersion:1,
  advisoryFenceRequested:false,moveReuseProfileRequested:false,frameObstructionProbeRequested:false,frameObstructionHashRequested:false,
  countSourceProbeRequested:false,inputProvider:null,pairedCropTargets:[],nameOptions:{prepared:false,configuration:name},rowMode:'all',
  scheduling:'recorded-screen-input-sequential-worker-reinterpretation',hardwareConcurrency:24,screenOptions:null,recordingEnabled:false,
  ui:'production-monitor-panel',stateRecording:'state',obstructionStateReplay:'not-requested',inputOrder:'manifest',timeUnknown:false,
  inputClock:'recorded-capture-time; sequential reinterpretation',browser:'browser',build:'local',serverStartSignature:'signature',
  completed:true,outcome:'completed',error:null,startedWithCards:0,integrity:'original-blob-sha256-verified-before-run',sourceChanged:false,
  sourceStart:{sourceDigest:hash('c')},sourceEnd:{sourceDigest:hash('c')}};
 const runId=variant==='baseline'?'a'.repeat(36):'b'.repeat(36);
 const values=options.uses??[{processingFrame:1,acquisitionFrameId:1,sourceFrameId:2,captureTime:0.2,phase:'input',phaseInferred:false,pixelHash:hash('d')}];
 const execution={version:1,complete:true,dropped:0,events:values.map((value,i)=>({seq:i+1,time:i,type:'replay-source-use',value:{version:1,runId,...value}}))};
 return {validation,runtimeConfiguration,replayEvidence:{kind:'stored-exact-pixels',seedCount:0,partial:false,configurationRecorded:false,
  configuration:name,devRecognition:{recorded:null,applied:{fractionalPortrait:false,grayNameFallback:false},scope:'recognition-retries-only'},
  verifiedFrames:1,comparison:null,sourceUseTrace:{runId}},execution,
  result:{expected:1,read:1,unidentified:0,experience:null,cards:[{id:'1',name:'가',awakening:0,extraCopies:0,review:[]}]}};
}
test('matching ordered metadata and results does not assert physical pixels or truth',async()=>{
 const result=await compareRejectedReplays(report('baseline'),report('reduced'));
 assert.equal(result.contextComparison,'matched-declared-context');assert.equal(result.sourceUseComparison,'matched-recorded-metadata');
 assert.equal(result.sourceUse.status,'matched-recorded-metadata');assert.equal(result.sourceUse.uses,1);
 assert.equal(result.resultComparison.exactSame,true);assert.equal(result.workerInputPixels,'not-verified');
 assert.equal(result.originalCaptureSource,'unknown');assert.equal(result.sourceLabels.baseline,'legacy-unverified-screen-label');
 const current=await compareRejectedReplays(report('baseline',{source:'current'}),report('reduced',{source:'current'}));
 assert.equal(current.sourceLabels.baseline,'stored-input-origin-unknown');
});
test('disallows different inputs, unknown environment, seed, wrong variants and changed execution',async()=>{
 const edits:((v:any)=>void)[]=[v=>v.validation.input[0].sha256=hash('e'),v=>v.validation.sourceChanged=true,
  v=>v.validation.sourceEnd.sourceDigest=hash('e'),v=>v.validation.sourceStart.sourceDigest='',v=>v.replayEvidence.seedCount=1,
  v=>v.validation.startedWithCards=1,v=>v.replayEvidence.verifiedFrames=0,v=>v.validation.integrity='unknown',
  v=>v.validation.outcome='cancelled',v=>v.validation.rejectedReplay.inputPhase='full-raster',
  v=>v.runtimeConfiguration.lanePlan.readers=9,v=>v.validation.browser='different',v=>v.validation.freshnessVersion=2,
  v=>v.runtimeConfiguration.rejectedTransportRequested=false,v=>v.validation.recordingEnabled=true,
  v=>v.runtimeConfiguration.visualOverflow=true,v=>delete v.runtimeConfiguration.lanePlan,
  v=>v.validation.rejectedReplay.workerInputPixelAttestation='verified'];
 for(const mutate of edits){const b=report('reduced');mutate(b);await assert.rejects(compareRejectedReplays(report('baseline'),b));}
});
test('use identity, timing, phase and pixel differences are not accepted',async()=>{
 for(const patch of [{captureTime:0.3},{phase:'recovery'},{pixelHash:hash('e')},{sourceFrameId:3},{acquisitionFrameId:2}]){
  const a=report('baseline'),b=report('reduced');Object.assign(b.execution.events[0].value,patch);
  await assert.rejects(compareRejectedReplays(a,b),/source-use order/);
 }
});
test('missing and partial trace stays unsupported rather than same',async()=>{
 const a=report('baseline'),b=report('reduced');(b as any).execution=null;
 const missing=await compareRejectedReplays(a,b);assert.equal(missing.contextComparison,'matched-declared-context');
 assert.equal(missing.sourceUseComparison,'unsupported');assert.equal(missing.sourceUse.status,'unsupported');
 assert.equal(Object.hasOwn(missing,'matchedDeclaredRequirements'),false);
 b.execution={version:1,complete:false,dropped:1,events:[]};
 assert.equal((await compareRejectedReplays(a,b)).sourceUse.status,'unsupported');
 b.execution={version:1,complete:true,dropped:0,events:[]};
 assert.equal((await compareRejectedReplays(a,b)).sourceUse.status,'unsupported');
});
test('content addressed report file names are verified',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'replay-compare-'));
 try{const path=join(dir,`run-${hash('a')}.json`);await writeFile(path,JSON.stringify(report('baseline')));await assert.rejects(loadRejectedReplayReport(path),/hash mismatch/);}
 finally{await rm(dir,{recursive:true,force:true});}
});

test('missing or inferred source evidence never claims matched input metadata',async()=>{
 const mutations:((v:any)=>void)[]=[
  v=>{v.sourceFrameId=null},v=>{delete v.sourceFrameId},v=>{delete v.captureTime},v=>{v.captureTime=null},
  v=>{delete v.phase},v=>{v.phaseInferred=true},v=>{delete v.phaseInferred},
  v=>{delete v.pixelHash},v=>{v.pixelHash=null},
 ];
 for(const mutate of mutations){const b=report('reduced');mutate(b.execution.events[0].value);
  const compared=await compareRejectedReplays(report('baseline'),b);
  assert.equal(compared.contextComparison,'matched-declared-context');assert.equal(compared.sourceUseComparison,'unsupported');
  assert.equal(compared.sourceUse.status,'unsupported');assert.equal(Object.hasOwn(compared,'matchedDeclaredRequirements'),false);
 }
});

test('CLI exit codes distinguish match, result mismatch, unsupported source trace and invalid validation',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'replay-cli-'));
 try{
  const a=report('baseline'),b=report('reduced'),aPath=join(dir,'a.json'),bPath=join(dir,'b.json');
  await writeFile(aPath,JSON.stringify(a));
  const run=async(value:unknown)=>{await writeFile(bPath,JSON.stringify(value));return spawnSync(process.execPath,
   ['--import','tsx',resolve('scripts/compare-rejected-replays.mjs'),aPath,bPath],{encoding:'utf8',maxBuffer:1024*1024});};
  let got=await run(b);assert.equal(got.status,0,got.stderr);assert.equal(JSON.parse(got.stdout).sourceUseComparison,'matched-recorded-metadata');
  const mismatch=structuredClone(b);mismatch.result.cards[0].extraCopies=1;
  got=await run(mismatch);assert.equal(got.status,2,got.stderr);assert.equal(JSON.parse(got.stdout).resultComparison.exactSame,false);
  const unsupported=structuredClone(b);(unsupported as any).execution=null;
  got=await run(unsupported);assert.equal(got.status,3,got.stderr);assert.equal(JSON.parse(got.stdout).sourceUseComparison,'unsupported');
  const both=structuredClone(mismatch);(both as any).execution=null;got=await run(both);assert.equal(got.status,2,got.stderr);
  const invalid=structuredClone(b);invalid.validation.input[0].sha256=hash('e');
  got=await run(invalid);assert.equal(got.status,1);assert.match(got.stderr,/Replay input differs/);
 }finally{await rm(dir,{recursive:true,force:true});}
});
