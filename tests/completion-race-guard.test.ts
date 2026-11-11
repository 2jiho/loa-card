import {test} from 'node:test';
import assert from 'node:assert/strict';
import {CompletionRaceGuard,type CompletionSample} from '../src/features/card-scanner/session/completion-race-guard';

const sample=(...values:number[]):CompletionSample=>({geometry:'window:1;growth:0,0,1,1;grid:0,1,2,1',pixels:Uint8Array.from(values)});

test('a changed card or lost Growth tab while header OCR runs blocks the old result',()=>{
 for(const pixels of [sample(1,3,0),sample(0,2,0)]) {
  const guard=new CompletionRaceGuard(1,sample(1,2,0));
  guard.arrival(2);
  assert.equal(guard.measure(2,pixels),false);
  guard.finishHeader(true);
  assert.equal(guard.canCommit(true,true),false);
 }
});

test('repeated delivered stationary pixels allow completion without waiting for silence',()=>{
 const guard=new CompletionRaceGuard(1,sample(1,2,0));
 guard.arrival(2);assert.equal(guard.measure(2,sample(1,2,0)),true);
 guard.finishHeader(true);
 for(let id=3;id<100;id++) {
  guard.arrival(id);
  assert.equal(guard.canCommit(true,true),false,'an arrival without its pixels is not verified');
  assert.equal(guard.measure(id,sample(1,2,0)),true);
  assert.equal(guard.canCommit(true,true),true);
 }
});

test('animation outside a caller-selected relevant sample is not automatically a change',()=>{
 // This tests the barrier contract, not whether production selects all needed
 // pixels. Background is deliberately absent from the caller's sample.
 const relevant=(frame:{tab:number;header:number;field:number;background:number})=>sample(frame.tab,frame.header,frame.field);
 const guard=new CompletionRaceGuard(1,relevant({tab:1,header:2,field:3,background:0}));
 guard.arrival(2);
 assert.equal(guard.measure(2,relevant({tab:1,header:2,field:3,background:255})),true);
 guard.finishHeader(true);assert.equal(guard.canCommit(true,true),true);
 guard.arrival(3);assert.equal(guard.measure(3,relevant({tab:1,header:2,field:4,background:17})),false);
 assert.equal(guard.canCommit(true,true),false);
});

test('unmeasured arrival, stale measurement, changed geometry and failed proofs never commit',()=>{
 const guard=new CompletionRaceGuard(1,sample(1));guard.finishHeader(true);
 guard.arrival(2);guard.arrival(3);
 assert.equal(guard.measure(2,sample(1)),true);
 assert.equal(guard.canCommit(true,true),false,'newer frame not measured');
 assert.equal(guard.measure(3,{geometry:'different',pixels:Uint8Array.of(1)}),false);
 assert.equal(guard.canCommit(true,true),false);
 const failed=new CompletionRaceGuard(1,sample(1));failed.finishHeader(false);
 assert.equal(failed.canCommit(true,true),false);
 const pending=new CompletionRaceGuard(1,sample(1));pending.finishHeader(true);
 assert.equal(pending.canCommit(false,true),false);
 assert.equal(pending.canCommit(true,false),false);
 pending.close();assert.equal(pending.canCommit(true,true),false);
});

test('a later matching image cannot conceal a skipped intermediate input',()=>{
 const guard=new CompletionRaceGuard(1,sample(1));guard.finishHeader(true);
 guard.arrival(2);guard.arrival(3);
 assert.equal(guard.measure(3,sample(1)),false);
 assert.equal(guard.canCommit(true,true),false);
});

test('shared mutable pixels cannot be used as a completion receipt',()=>{
 const pixels=new Uint8Array(new SharedArrayBuffer(2));
 assert.throws(()=>new CompletionRaceGuard(1,{geometry:'x',pixels}),TypeError);
 const guard=new CompletionRaceGuard(1,sample(0,0));guard.arrival(2);
 assert.equal(guard.measure(2,{geometry:'window:1;growth:0,0,1,1;grid:0,1,2,1',pixels}),false);
 guard.finishHeader(true);assert.equal(guard.canCommit(true,true),false);
});

test('the baseline is privately copied and a change cannot be erased by a later match',()=>{
 const original=sample(1,2),guard=new CompletionRaceGuard(1,original);
 original.pixels[0]=8;guard.arrival(2);
 assert.equal(guard.measure(2,sample(8,2)),false);
 guard.arrival(3);assert.equal(guard.measure(3,sample(1,2)),false);
 guard.finishHeader(true);assert.equal(guard.canCommit(true,true),false);
});
