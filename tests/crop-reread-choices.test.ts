import {test} from 'node:test';
import assert from 'node:assert/strict';
import {cropRereadChoices} from '../dev/crop-reread-core';
import {createRecognitionCropJournal,replayRecognitionCropJournal} from '../dev/recognition-crop-journal';
import type {CropEvent,CropCheckpoint,CropJournalSeed} from '../dev/recognition-crop-journal';
import type {RecognitionInputMeta,RecognitionInputOutcome} from '../src/features/card-scanner/recognition/recognition-input-observer';

const seed:CropJournalSeed={version:2,captureBoundary:'recognition-input-v2',sessionId:null,build:'test',catalog:'test',
  nameConfiguration:{version:1,rawResultPolicy:'resample'},modelSignature:null,
  recognitionOptions:{fractionalPortrait:false,grayNameFallback:false}};
function meta(id:number):RecognitionInputMeta{return {diagnosticReadId:id,processingFrame:id,slot:id-1,group:id,trace:id,pixelKey:`pixel${id}`,
  source:{sessionId:'session',frameId:id,observationId:`o${id}`,captureOrder:id,captureTime:id/10,phase:'input',slot:id-1},
  stage:'short',stable:true,borderAlignment:1,sourceBox:{x:0,y:0,width:1,height:1},sourceWidth:10,sourceHeight:10,cropWidth:1,cropHeight:1};}
const canvas={width:1,height:1,getContext:()=>({getImageData:()=>({data:new Uint8ClampedArray([1,2,3,255])})})} as unknown as HTMLCanvasElement;
const identified={id:'card',name:'카드'};
function result(value:Partial<RecognitionInputOutcome>):RecognitionInputOutcome{
  return {admitted:true,identifyExecuted:true,timedOut:false,error:null,status:'read',identified:null,acceptedIdentity:null,...value} as RecognitionInputOutcome;
}

test('verified input-time journal lists rereadable observations and prioritizes unresolved without losing source metadata',async()=>{
  const pixels=new Map<string,Uint8Array>(),events:CropEvent[]=[];let checkpoint:CropCheckpoint|null=null;
  const sink={begin:async()=>{},get:async(key:string)=>pixels.get(key),put:async(key:string,bytes:Uint8Array)=>{pixels.set(key,bytes);},
    append:async(event:CropEvent)=>{events.push(event);},seal:async(value:CropCheckpoint)=>{checkpoint=value;}};
  const journal=createRecognitionCropJournal(seed,sink);
  for(const [id,outcome] of [[1,result({identified,acceptedIdentity:identified})],[2,result({})],[3,result({identifyExecuted:false})]] as const){
    const inspection=journal.observer.begin(meta(id))!;inspection.captureInput!(canvas);inspection.finish(outcome);
  }
  await journal.finish();
  const crops:{readId:number;meta:RecognitionInputMeta}[]=[];
  const verified=await replayRecognitionCropJournal(seed,events,checkpoint,async(key)=>pixels.get(key),
    (event,value)=>{crops.push({readId:event.readId,meta:value});},new AbortController().signal);
  const list=cropRereadChoices(crops,events,1);
  assert.equal(verified.complete,true);assert.equal(list.total,2);assert.equal(list.omitted,1);
  assert.deepEqual(list.choices.map(x=>[x.readId,x.needsReview,x.slot,x.captureTime]),[[2,true,1,0.2]]);
  assert.deepEqual(crops.map(x=>x.readId),[1,2,3]);
});

test('missing finish and unadmitted calls are not offered, and invalid display bounds fail closed',()=>{
  const crops=[{readId:1,meta:meta(1)},{readId:2,meta:meta(2)}];
  const events:CropEvent[]=[{seq:1,kind:'finish',readId:1,outcome:{admitted:false,identifyExecuted:false,timedOut:false,error:null,status:'',identified:null,acceptedIdentity:null}}];
  assert.deepEqual(cropRereadChoices(crops,events).choices,[]);
  assert.throws(()=>cropRereadChoices(crops,events,0),/limit/);
});
