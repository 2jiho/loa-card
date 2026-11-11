import {test} from 'node:test';
import assert from 'node:assert/strict';
import {obstructionEventAdmitted} from '../src/features/card-scanner/session/obstruction-recording-receipt';
import type {ExactEventQueueStats} from '../src/features/card-scanner/reproduction/exact-recording';

const stats=(acceptedEvents:number,firstFailure:ExactEventQueueStats['firstFailure']=null):ExactEventQueueStats=>({
 version:1,acceptedEvents,postedBatches:0,acknowledgedBatches:0,pendingEvents:acceptedEvents,pendingBytes:0,
 peakPendingBytes:0,inFlightBatches:0,peakInFlightBatches:0,firstFailure,
});
const failure:NonNullable<ExactEventQueueStats['firstFailure']>={reason:'worker-write',seq:1,eventType:'x',estimatedBytes:1,
 pendingEvents:0,pendingBytes:0,inFlightBatches:0,observedAtMs:1,error:'failed'};
test('exact-only records acknowledge queue admission without asserting durable storage',()=>{
 const base={attempted:true,exactRequested:true,traceRequested:false,before:stats(2)};
 assert.equal(obstructionEventAdmitted({...base,after:stats(3)}),true);
 assert.equal(obstructionEventAdmitted({...base,after:stats(2)}),false,'missing event');
 assert.equal(obstructionEventAdmitted({...base,after:stats(4)}),false,'unrelated events do not prove this event');
 assert.equal(obstructionEventAdmitted({...base,after:stats(3,failure)}),false);
 assert.equal(obstructionEventAdmitted({...base,before:stats(2,failure),after:stats(3)}),false);
 assert.equal(obstructionEventAdmitted({...base,attempted:false,after:stats(3)}),false);
});
test('when both sinks are enabled each must acknowledge the same event',()=>{
 const both={attempted:true,exactRequested:true,traceRequested:true,before:stats(1),after:stats(2)};
 assert.equal(obstructionEventAdmitted({...both,traceAck:true}),true);
 assert.equal(obstructionEventAdmitted({...both,traceAck:false}),false);
 assert.equal(obstructionEventAdmitted({...both,traceAck:true,after:stats(1)}),false);
 assert.equal(obstructionEventAdmitted({attempted:true,exactRequested:false,traceRequested:true,traceAck:true}),true);
 assert.equal(obstructionEventAdmitted({attempted:true,exactRequested:false,traceRequested:false}),false);
});
