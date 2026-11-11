import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createFrameObstructionDiagnostics} from '../dev/frame-obstruction-diagnostics';
import type {FrameObstructionProbeEvent} from '../src/features/card-scanner/acquisition/acquisition-client';

const submitted:FrameObstructionProbeEvent={kind:'submitted',id:1,time:0.5,roi:{x:10,y:20,width:100,height:100},readbackMs:2,readbackBytes:40000};
test('retains delivered diagnostics as detached data and explicitly bounds omission',()=>{
 let now=0;const recorder=createFrameObstructionDiagnostics({maxEvents:1,now:()=>now++});
 assert.equal(recorder.record(submitted),true);
 assert.equal(recorder.record({kind:'skipped',id:2,time:0.6,reason:'busy'}),false);
 const snapshot=recorder.snapshot();assert.equal(snapshot.attempted,2);assert.equal(snapshot.recorded,1);assert.equal(snapshot.omitted,1);
 assert.equal(snapshot.retainedEveryDeliveredCallback,false);assert.equal(snapshot.captureMs,2);
 assert.notEqual(snapshot.events[0],submitted);recorder.close();assert.equal(recorder.record(submitted),false);
 assert.equal(recorder.snapshot().attempted,2);
});
test('rejects oversized or invalid events without claiming a clean negative',()=>{
 const recorder=createFrameObstructionDiagnostics({maxBytes:8});
 assert.equal(recorder.record(submitted),false);assert.equal(recorder.snapshot().omitted,1);
 const other=createFrameObstructionDiagnostics();assert.equal(other.record({kind:'skipped',id:0,time:1,reason:'busy'}),false);
 assert.equal(other.snapshot().retainedEveryDeliveredCallback,false);
});
