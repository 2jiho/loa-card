import test from 'node:test';
import assert from 'node:assert/strict';
import {assertNormalPairedCropRun,parsePairedCropTargets} from '../dev/paired-crop-config';
import type {NormalPairedCropRunContext} from '../dev/paired-crop-config';
test('paired diagnostics are explicit, bounded, one based frames and zero based slots',()=>{
  assert.deepEqual(parsePairedCropTargets(null),[]);
  assert.deepEqual(parsePairedCropTargets('97:32,119:20'),[{processingFrame:97,slot:32},{processingFrame:119,slot:20}]);
  for(const input of ['', '0:0','1:40','1:0,1:00','1:0,2:0,3:0,4:0,5:0','1:0x','1.2:0','1:0,'.repeat(100)])assert.throws(()=>parsePairedCropTargets(input));
});

test('four ordered targets keep processing-frame identity and reject normalized duplicates',()=>{
  assert.deepEqual(parsePairedCropTargets('1:0,999999:39,12:3,12:4'),[
    {processingFrame:1,slot:0},{processingFrame:999999,slot:39},{processingFrame:12,slot:3},{processingFrame:12,slot:4},
  ]);
  for(const input of ['1000000:0','000001:0,1:0','1:01,1:1','1:0,2:0,3:0,4:0,5:0'])assert.throws(()=>parsePairedCropTargets(input));
});

const normal=():NormalPairedCropRunContext=>({mode:'offline',images:false,inputCount:1,recording:false,captureOnly:false,
  preparedSource:false,nativeAcquisition:false,rgbaRecovery:false,fractionalPortrait:false,fpsRequested:false,
  grayNameFallback:false,localCropPixels:false,nameRawResultPolicy:'resample',warmNameReaders:false});

test('normal paired diagnostics accept exactly the ordinary single-video offline reader',()=>{
  assert.doesNotThrow(()=>assertNormalPairedCropRun(normal()));
});

test('normal paired diagnostics reject input and recording outside the ordinary reader contract',()=>{
  const invalid:Partial<NormalPairedCropRunContext>[]=[
    {mode:'live'},{images:true},{inputCount:0},{inputCount:2},{recording:true},{captureOnly:true},
  ];
  for(const difference of invalid)assert.throws(()=>assertNormalPairedCropRun({...normal(),...difference}));
});

test('every other input or recognition experiment is independently rejected for normal pairs',()=>{
  const flags=['preparedSource','nativeAcquisition','rgbaRecovery','fractionalPortrait','fpsRequested','grayNameFallback',
    'localCropPixels','warmNameReaders'] as const;
  for(const flag of flags)assert.throws(()=>assertNormalPairedCropRun({...normal(),[flag]:true}),undefined,flag);
  assert.throws(()=>assertNormalPairedCropRun({...normal(),nameRawResultPolicy:'continue'}));
});

test('missing or malformed actual run facts are rejected rather than defaulted',()=>{
  for(const difference of [{inputCount:NaN},{inputCount:1.5},{mode:'unknown'},{nameRawResultPolicy:undefined},
    {fpsRequested:undefined},{recording:0},{grayNameFallback:'false'}]){
    assert.throws(()=>assertNormalPairedCropRun({...normal(),...difference} as NormalPairedCropRunContext));
  }
});
