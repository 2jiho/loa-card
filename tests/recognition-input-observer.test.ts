import test from 'node:test';
import assert from 'node:assert/strict';
import {beginRecognitionInspection,observeNameLabel,type RecognitionInputMeta,type RecognitionInputOutcome} from '../src/features/card-scanner/recognition-input-observer';
const meta:RecognitionInputMeta={diagnosticReadId:1,processingFrame:97,slot:32,
  source:{sessionId:'test',frameId:98,observationId:'3113',captureOrder:4,captureTime:3.2,phase:'input',slot:32},
  group:4,trace:3113,pixelKey:'exact',stage:'short',stable:true,borderAlignment:1,
  sourceBox:{x:1,y:2,width:140,height:210},sourceWidth:2560,sourceHeight:1440,cropWidth:140,cropHeight:210};
test('optional evidence cannot reject reads even if the observer fails',()=>{
  assert.equal(beginRecognitionInspection(undefined,meta),undefined);
  assert.equal(beginRecognitionInspection({begin(){throw Error('diagnostic init');}},meta),undefined);
  const inspection=beginRecognitionInspection({begin(){return {
    captureCard(){throw Error('readback');},captureLabel(){throw Error('retention');},finish(){throw Error('serialization');},
  };}},meta)!;
  assert.doesNotThrow(()=>inspection.captureCard({} as HTMLCanvasElement));
  const pixels={width:128,height:36,data:new Uint8ClampedArray(128*36*4)};
  const recipe={region:'initial-name-label' as const,sourceBox:{x:6,y:14,width:128,height:36},targetWidth:128 as const,targetHeight:36 as const,offsetY:0,quick:true,allowRaw:true,bypassCache:false};
  assert.doesNotThrow(()=>observeNameLabel(inspection.captureLabel,pixels,recipe));
  assert.doesNotThrow(()=>inspection.finish({} as RecognitionInputOutcome));
});
