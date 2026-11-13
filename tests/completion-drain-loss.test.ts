import {test} from 'node:test';
import assert from 'node:assert/strict';
import {boundedDrainInputLoss,drainLossFinal,unresolvedWithDrainLoss} from '../src/features/card-scanner/session/completion-drain-loss';
import {drainClockObservationFailure} from '../src/features/card-scanner/session/completion-drain-clock';


test('refreshing card or progress counts preserves independent input-loss debt',()=>{
 const loss={reason:'clock-gap',replaySupported:false} as const;
 assert.equal(unresolvedWithDrainLoss(0,0,loss),1);
 assert.equal(unresolvedWithDrainLoss(2,3,loss),6);
 assert.equal(unresolvedWithDrainLoss(0,0,undefined),0);
});
test('legacy, malformed and getter-backed loss claims do not become replay evidence',()=>{
 assert.equal(boundedDrainInputLoss(undefined),undefined);
 assert.equal(boundedDrainInputLoss({reason:'unknown',replaySupported:false}),undefined);
 assert.equal(boundedDrainInputLoss({reason:'clock-gap',replaySupported:true}),undefined);
 let read=false;assert.equal(boundedDrainInputLoss({get reason(){read=true;return 'clock-gap';},replaySupported:false}),undefined);
 assert.equal(read,false);
 assert.deepEqual(drainLossFinal({unresolved:2,status:'대기'},undefined),{unresolved:2,status:'대기'});
});
test('clock diagnostics distinguish known failures without claiming physical-frame completeness',()=>{
 const good={kind:'callback',sequence:2,mediaTime:2,presentedFrames:3,mediaRelation:'advance',presentedRelation:'advance',missedFrames:0,captureEligible:true} as const;
 assert.equal(drainClockObservationFailure(good),null);
 assert.equal(drainClockObservationFailure({...good,missedFrames:1}),'clock-gap');
 assert.equal(drainClockObservationFailure({...good,mediaRelation:'duplicate'}),'clock-duplicate');
 assert.equal(drainClockObservationFailure({...good,presentedRelation:'regression'}),'clock-regression');
 assert.equal(drainClockObservationFailure({...good,sequence:null}),'clock-invalid');
});
