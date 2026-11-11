import {test} from 'node:test';
import assert from 'node:assert/strict';
import {LatestAcquisitionGate} from '../src/features/card-scanner/acquisition/latest-acquisition-gate';

test('a newer skipped or saturated acquisition blocks completion until a later successful frame',()=>{
 const gate=new LatestAcquisitionGate();
 assert.equal(gate.settled,false);
 gate.begin(1);gate.finish(1,true);assert.equal(gate.settled,true);
 gate.begin(2);assert.equal(gate.settled,false);
 gate.finish(2,false);assert.equal(gate.settled,false);
 gate.begin(3);gate.finish(3,true);assert.equal(gate.settled,true);
});

test('a delayed older completion cannot certify the newer pending or rejected frame',()=>{
 const gate=new LatestAcquisitionGate();
 gate.begin(1);gate.begin(2);gate.finish(1,true);
 assert.equal(gate.settled,false);
 gate.finish(2,false);gate.finish(1,true);
 assert.equal(gate.settled,false);
 assert.throws(()=>gate.begin(2),TypeError);
});
