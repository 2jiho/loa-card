import {test} from 'node:test';
import assert from 'node:assert/strict';
import {entryParts} from '../src/features/card-scanner/reproduction/exact-recording-codec';
import {auditDeliveredInputs} from '../src/features/card-scanner/session/delivered-input-coverage';

const signal=()=>new AbortController().signal;
const archive=(values:readonly {type:string;value:unknown}[])=>new Blob(values.flatMap((value,index)=>
 entryParts({kind:'event',seq:index+1,time:index,type:value.type,value:value.value})));
const arrival=(id:number)=>({version:1,inputId:id,captureTime:id,observedAtMs:id,delivery:'video-poll'});
const consider=(id:number,expected?:string)=>({kind:'consider',stamp:{inputId:id,captureTime:id,observedAtMs:id},
 gates:{capturing:true,checkingCompletion:false},...(expected===undefined?{}:{expected})});

test('missing arrival and selection facts remain unknown even for a declared complete stream',async()=>{
 const result=await auditDeliveredInputs(archive([{type:'other',value:null}]),signal(),undefined);
 assert.equal(result.status,'unknown');assert.equal(result.recorded.arrivals,0);
 assert.equal(result.callbackPixelBinding,'unproven');assert.equal(result.sourceDeliveryCompleteness,'unproven');
});

test('recorded skips and replacement show risk without claiming missing pixels in old schemas',async()=>{
 const file=archive([
  {type:'input-arrival',value:arrival(1)},
  {type:'input-admission',value:consider(1,'cadence')},
  {type:'input-arrival',value:arrival(3)},
  {type:'input-admission',value:consider(3)},
  {type:'input-backup-reservation',value:{version:1,inputId:3,captureTime:3,store:'capture-originals',reservationId:12}},
  {type:'input-decision',value:{version:2,seq:1,atMs:3,kind:'replaced',oldInputId:1,newInputId:3}},
 ]);
 const result=await auditDeliveredInputs(file,signal(),undefined);
 assert.equal(result.status,'unproven');assert.equal(result.recorded.skipped.cadence,1);
 assert.equal(result.recorded.consideredWithoutRecordedDecision,1);assert.equal(result.recorded.arrivalIdGaps,1);
 assert.equal(result.recorded.replacements,1);assert.equal(result.recorded.nonNullBackupReservations,1);
 assert.equal(result.callbackPixelBinding,'unproven','a reserved backup is not a source-bound replay');
});

test('versioned acquisition skip is partial; malformed optional diagnostics are counted',async()=>{
 const file=archive([{type:'input-arrival',value:arrival(1)},
  {type:'input-link',value:{inputId:1}},{type:'input-recording-error',value:{}}]);
 const result=await auditDeliveredInputs(file,signal(),'partial');
 assert.equal(result.status,'partial');assert.equal(result.recorded.malformed,1);
 assert.equal(result.recorded.links,0);assert.equal(result.recorded.recorderErrors,1);
});

test('an empty valid decision history does not prove all physical or callback frames',async()=>{
 const result=await auditDeliveredInputs(archive([{type:'input-arrival',value:arrival(1)},
  {type:'input-admission',value:consider(1,'freeze')}]),signal(),'unknown');
 assert.equal(result.status,'unproven');assert.equal(result.recorded.skipped.cadence,0);
 assert.equal(result.sourceDeliveryCompleteness,'unproven');assert.equal(result.callbackPixelBinding,'unproven');
});

test('comparison-only and lost recovery facts are not counted as replay pixel links',async()=>{
 const file=archive([
  {type:'input-arrival',value:arrival(1)},
  {type:'input-admission',value:consider(1,'verification')},
  {type:'input-recovery',value:{version:1,seq:1,kind:'released',inputId:1,failed:false,reason:'compared'}},
  {type:'input-recovery',value:{version:1,seq:2,kind:'lost',inputId:2,reason:'overflow'}},
  {type:'input-backup-reservation',value:{version:1,inputId:1,captureTime:1,store:'capture-originals',reservationId:null}},
 ]);
 const result=await auditDeliveredInputs(file,signal(),undefined);
 assert.equal(result.status,'unproven');assert.equal(result.recorded.recoveryComparedWithoutReplayLink,1);
 assert.equal(result.recorded.recoveryLost,1);assert.equal(result.recorded.links,0);
 assert.equal(result.recorded.backupReservations,1);assert.equal(result.recorded.nonNullBackupReservations,0);
});
