import {test} from 'node:test';
import assert from 'node:assert/strict';
import {analyzeFrameObstructionProbe} from '../scripts/analyze-frame-obstruction-probe.mjs';

function report(events:any[],omitted=0){const digest='a'.repeat(64);return {validation:{frameObstructionProbeRequested:true,completed:true,sourceChanged:false,
 sourceStart:{sourceDigest:digest},sourceEnd:{sourceDigest:digest},input:[{sha256:'b'.repeat(64)}],integrity:'not-checked-by-runner'},
 performance:{inputPipeline:{offered:20,processed:10,replaced:10,capacityDropped:0}},execution:{complete:true,dropped:0},
 frameObstructionEvidence:{events,attempted:events.length+omitted,recorded:events.length,omitted,retainedEveryDeliveredCallback:omitted===0}};}
test('reports submitted, skipped, unsupported and truncated without implying negative coverage',()=>{
 const value=report([{kind:'submitted',id:1,time:1,readbackMs:3},{kind:'result',id:1,time:1,computeMs:5,result:{supported:true,truncated:true,candidates:[]}},
  {kind:'skipped',id:2,time:2,reason:'busy'},{kind:'submitted',id:3,time:3,readbackMs:1},
  {kind:'result',id:3,time:3,computeMs:7,result:{supported:false,truncated:false,candidates:[]}}]);
 const result=analyzeFrameObstructionProbe(value);assert.equal(result.status,'partial');
 assert.equal(result.callbacks.truncated,1);assert.equal(result.callbacks.unsupported,1);assert.equal(result.callbacks.skips.busy,1);
 assert.equal(result.callbacks.candidates,0);assert.equal(result.inputPipeline.replaced,10);assert.equal(result.latency.compute.samples,2);
 assert.match(result.scope,/No decoded-frame identity/);
});
test('missing callbacks, dropped record, and changing source stay partial',()=>{
 const pending=report([{kind:'submitted',id:1,time:1,readbackMs:1}]);
 assert.equal(analyzeFrameObstructionProbe(pending).callbacks.pendingObserved,1);assert.equal(analyzeFrameObstructionProbe(pending).status,'partial');
 const omitted=report([],1);assert.equal(analyzeFrameObstructionProbe(omitted).status,'partial');
 const changed=report([]);changed.validation.sourceChanged=true;assert.equal(analyzeFrameObstructionProbe(changed).status,'partial');
 assert.equal(analyzeFrameObstructionProbe({validation:{},performance:{}}).status,'unavailable');
});
test('ROI hash is content evidence only and missing or failed hashes stay partial',()=>{
 const value=report([{kind:'submitted',id:1,time:1,readbackMs:1},{kind:'result',id:1,time:1,computeMs:1,result:{supported:true,truncated:false,candidates:[]},
  roiHash:{status:'ok',algorithm:'sha256',hex:'b'.repeat(64),hashMs:2,scope:'roi-rgba-content-only',captureTimeVerified:false,physicalSourceVerified:false}}]);
 Object.assign(value.validation,{frameObstructionHashRequested:true});
 value.performance.frameObstructionProbe={submitted:1,results:1,skipped:0} as any;
 const result=analyzeFrameObstructionProbe(value);assert.equal(result.roiHash.ok,1);assert.equal(result.roiHash.latency.samples,1);assert.match(result.roiHash.scope,/no source PTS/);
 delete (value.frameObstructionEvidence.events[1] as any).roiHash;
 assert.equal(analyzeFrameObstructionProbe(value).status,'partial');
 assert.equal(analyzeFrameObstructionProbe(value).roiHash.missing,1);
});
