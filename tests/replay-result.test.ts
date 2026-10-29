import test from 'node:test';
import assert from 'node:assert/strict';
import {compareReplayResult} from '../dev/replay-result';
const baseline={expected:1,read:1,experience:0,unidentified:0,cards:[{id:'a',name:'A',awakening:0,extraCopies:0,review:[] as string[]}]};
test('replay comparison separates equality from completion and partial inputs',()=>{
 assert.equal(compareReplayResult(baseline,baseline,true,false).status,'match');
 const interrupted=compareReplayResult(baseline,baseline,false,true);
 assert.equal(interrupted.status,'incomplete');assert.equal(interrupted.matches,true);assert.equal(interrupted.partialInput,true);
 assert.equal(compareReplayResult(null,baseline,true,false).status,'baseline-unavailable');
});
test('replay comparison catches null versus zero, missing cards and total-only changes',()=>{
 const altered={...baseline,cards:[{...baseline.cards[0],extraCopies:null}]};
 assert.equal(compareReplayResult(baseline,altered,true,false).status,'different');
 assert.deepEqual(compareReplayResult(baseline,{...baseline,cards:[]},true,false).fields?.missing,['A']);
 const totals=compareReplayResult(baseline,{...baseline,experience:null},true,false);
 assert.equal(totals.status,'different');assert.equal(totals.totals?.experience,false);
});
