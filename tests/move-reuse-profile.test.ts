import {test} from 'node:test';
import assert from 'node:assert/strict';
import {parseMoveReuseProfile,validateMoveReuseProfileInput} from '../dev/move-reuse-profile';
import {acquisitionProfile,addAcquisitionProfile} from '../src/features/card-scanner/acquisition/acquisition-profile';
const valid={enabled:true,images:false,replay:false,mode:'live',captureOnly:false,cropRecording:false,recording:false,batch:false,caseId:'case',mediaTypes:['video/mp4']};
test('move profile accepts only isolated registered 1x video input',()=>{
 assert.equal(parseMoveReuseProfile(''),false);assert.equal(parseMoveReuseProfile('?moveReuseProfile=1'),true);
 for(const q of ['?moveReuseProfile=1&other=1','?moveReuseProfile=1&moveReuseProfile=0','?moveReuseProfile=x'])assert.throws(()=>parseMoveReuseProfile(q));
 assert.doesNotThrow(()=>validateMoveReuseProfileInput(valid));
 for(const changed of [{images:true},{replay:true},{mode:'offline'},{captureOnly:true},{recording:true},{cropRecording:true},{batch:true},{caseId:null},{mediaTypes:[]},{mediaTypes:['video/mp4','video/mp4']}])assert.throws(()=>validateMoveReuseProfileInput({...valid,...changed}));
});
test('move profile aggregates actual measured samples without inventing zero for missing data',()=>{
 const frame={exact:2,moved:0,inspected:38,probeMs:1,shifted:1,moveCompared:2,moveMatched:0};
 const a=addAcquisitionProfile(undefined,frame)!;assert.equal(a.moveMeasurement,undefined);assert.equal(a.moveMeasurementSamples,undefined);
 const m={lookups:2,eligible:1,bytesCompared:32,elapsedMs:.5};const b=addAcquisitionProfile(a,{...frame,moveMeasurement:m})!;
 assert.deepEqual(b.moveMeasurement,m);assert.equal(b.moveMeasurementSamples,1);assert.equal(b.samples,2);
 const c=addAcquisitionProfile(b,frame)!;assert.deepEqual(c.moveMeasurement,m);assert.equal(c.moveMeasurementSamples,1);assert.equal(c.samples,3);
 assert.equal(acquisitionProfile({...frame,moveMeasurement:{...m,eligible:3}}),undefined);
 assert.equal(acquisitionProfile({...frame,moveMeasurement:{...m,elapsedMs:NaN}}),undefined);
});
