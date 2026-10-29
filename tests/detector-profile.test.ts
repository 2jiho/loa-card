import test from 'node:test';
import assert from 'node:assert/strict';
import {recordDetectorStage,detectorProfile,addDetectorProfile,type DetectorProfile} from '../src/features/card-scanner/detector-profile';
test('detector work keeps global search, tracking, refinement and growth separate',()=>{
 const p:DetectorProfile={};
 recordDetectorStage(p,{stage:'coarse',tracked:false,cached:false,elapsedMs:20});
 recordDetectorStage(p,{stage:'coarse',tracked:true,cached:true,elapsedMs:2});
 recordDetectorStage(p,{stage:'refinement-work',cached:false,elapsedMs:8});
 recordDetectorStage(p,{stage:'growth',cached:true,elapsedMs:1});
 recordDetectorStage(p,{stage:'refined',elapsedMs:999});
 assert.deepEqual(p,{global:{calls:1,cached:0,elapsedMs:20},tracked:{calls:1,cached:1,elapsedMs:2},
  refinement:{calls:1,cached:0,elapsedMs:8},growth:{calls:1,cached:1,elapsedMs:1}});
 const combined=addDetectorProfile(p,p)!;assert.equal(combined.global?.elapsedMs,40);assert.equal(p.global?.elapsedMs,20);
});
test('missing and malformed measurements do not turn into zero work',()=>{
 for(const value of [null,{},[],{global:{calls:0,cached:0,elapsedMs:1}},{global:{calls:1,cached:2,elapsedMs:1}},
  {global:{calls:1,cached:0,elapsedMs:NaN}},{unknown:{calls:1,cached:0,elapsedMs:1}}])assert.equal(detectorProfile(value),undefined);
 assert.equal(addDetectorProfile(undefined,undefined),undefined);
});
