import {test} from 'node:test';
import assert from 'node:assert/strict';
import {parseRejectedTransport,validateRejectedTransportInput,parseRejectedReplay,validateRejectedReplayInput,rejectedReplayEvidence} from '../dev/rejected-transport-options';

test('rejected transport experiment is explicit and cannot silently combine query options',()=>{
 assert.equal(parseRejectedTransport(''),false);assert.equal(parseRejectedTransport('?rejectedTransport=1'),true);
 assert.equal(parseRejectedTransport('?rejectedTransport=0'),false);
 for(const query of ['?rejectedTransport=1&rejectedTransport=1','?rejectedTransport=2','?rejectedTransport=1&fps=8'])
  assert.throws(()=>parseRejectedTransport(query));
});
test('rejected transport is restricted to one live-video case without pixel recording',()=>{
 const valid={enabled:true,images:false,replay:false,mode:'live',captureOnly:false,cropRecording:false,recording:false,batch:false,
  caseId:'a'.repeat(64),mediaTypes:['video/mp4']};
 assert.doesNotThrow(()=>validateRejectedTransportInput(valid));
 for(const patch of [{images:true},{replay:true},{mode:'offline'},{captureOnly:true},{cropRecording:true},{recording:true},
  {batch:true},{caseId:null},{mediaTypes:[]},{mediaTypes:['image/png']},{mediaTypes:['video/mp4','video/mp4']},{recordingMode:'detailed'}])
   assert.throws(()=>validateRejectedTransportInput({...valid,...patch}));
 assert.doesNotThrow(()=>validateRejectedTransportInput({...valid,enabled:false,recording:true}));
});

test('stored-input variants are explicit and cannot mix other experiments',()=>{
 assert.equal(parseRejectedReplay(''),undefined);
 assert.equal(parseRejectedReplay('?rejectedReplay=baseline'),'baseline');
 assert.equal(parseRejectedReplay('?rejectedReplay=reduced'),'reduced');
 for(const query of ['?rejectedReplay=','?rejectedReplay=x','?rejectedReplay=baseline&rejectedReplay=reduced',
  '?rejectedReplay=reduced&rejectedTransport=1','?rejectedReplay=baseline&gray=1'])
  assert.throws(()=>parseRejectedReplay(query));
});
test('stored-input worker comparisons require screen replay semantics, exact pixels, an empty seed and no extra recording',()=>{
 const valid={variant:'baseline' as const,exact:true,source:'screen',seedCount:0,mode:'offline',captureOnly:false,
  cropRecording:false,recording:false,batch:false,caseId:'a'.repeat(64)};
 assert.doesNotThrow(()=>validateRejectedReplayInput(valid));
 assert.doesNotThrow(()=>validateRejectedReplayInput({...valid,variant:'reduced'}));
 for(const patch of [{exact:false},{source:'video'},{source:undefined},{seedCount:1},{mode:'live'},
  {captureOnly:true},{cropRecording:true},{recording:true},{batch:true},{caseId:null},{recordingMode:'detailed'}])
   assert.throws(()=>validateRejectedReplayInput({...valid,...patch}));
 assert.doesNotThrow(()=>validateRejectedReplayInput({...valid,variant:undefined,exact:false}));
});

test('replay semantics do not assert the original capture source',()=>{
 for(const variant of ['baseline','reduced'] as const){
  const evidence=rejectedReplayEvidence(variant);
  assert.equal(evidence.source,'stored-scanner-input');assert.equal(evidence.originalCaptureSource,'unknown');
  assert.equal(evidence.replaySemantics,'screen');assert.equal(evidence.workerInputPixelAttestation,'not-verified');
 }
});
