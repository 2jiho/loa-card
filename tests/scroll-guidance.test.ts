import {test} from 'node:test';
import assert from 'node:assert/strict';
import {scrollGuidance} from '../src/features/card-scanner/scroll-guidance';
const state={gaps:1,busy:true,expected:387,collected:333};
test('scroll holes during live capture and recovery are informational, not a rescan request',()=>{
 assert.equal(scrollGuidance(state),'collecting');
 assert.equal(scrollGuidance({...state,expected:null}),'collecting');
});
test('only a completed pass with a known shortage asks for another screen',()=>{
 assert.equal(scrollGuidance({...state,busy:false}),'rescan');
 assert.equal(scrollGuidance({...state,busy:false,expected:null}),null);
 assert.equal(scrollGuidance({...state,busy:false,expected:0}),null);
 assert.equal(scrollGuidance({...state,busy:false,gaps:0}),null);
});
test('current-run coverage hides old scrollbar estimates even if their gaps remain',()=>{
 for(const busy of [true,false]){
  assert.equal(scrollGuidance({...state,busy,collected:387}),null);
  assert.equal(scrollGuidance({...state,busy,autoStopped:true}),null);
  assert.equal(scrollGuidance({...state,busy,recoverySkipped:true}),null);
 }
});
