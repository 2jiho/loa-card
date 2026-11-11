import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createRetryLedger,reduceRetryLedger} from '../src/features/card-scanner/session/retry-receipt-state';
import type {RetryEvent,RetryLedger,RetryReceipt} from '../src/features/card-scanner/session/retry-receipt-state';

const original:RetryReceipt={session:'s',pixel:'p',input:'i1',sourceFrame:'f1',capturedAt:1,origin:'live',stable:true};
const next:RetryReceipt={...original,input:'i2',sourceFrame:'f2',capturedAt:2};
const start=(receipt=original):RetryEvent=>({type:'original-started',receipt});
const finish=(receipt=original):RetryEvent=>({type:'original-finished',pixel:receipt.pixel,input:receipt.input,sourceFrame:receipt.sourceFrame,outcome:'timeout'});
const enqueue=(receipt=next,id='r'):RetryEvent=>({type:'queue-accepted',receipt,id});
const apply=(state:RetryLedger,...events:RetryEvent[])=>events.reduce((s,e)=>{
 const result=reduceRetryLedger(s,e);assert.equal(result.accepted,true,`${e.type}: ${result.reason}`);return result.state;
},state);

test('one later stable physical live input after a completed timeout, with deterministic replay',()=>{
 const events:RetryEvent[]=[start(),finish(),enqueue(),{type:'retry-started',pixel:'p',id:'r',generation:1},
  {type:'retry-finished',pixel:'p',id:'r',generation:1}];
 const a=apply(createRetryLedger('s'),...events),b=apply(createRetryLedger('s'),...JSON.parse(JSON.stringify(events)));
 assert.deepEqual(b,a);
 assert.equal(reduceRetryLedger(a,enqueue({...next,input:'i3',sourceFrame:'f3',capturedAt:3},'again')).accepted,false);
 assert.equal(a.entries.p.retry?.state,'spent');
});

test('same physical frame or input, synthetic, replay, unstable, and non-later frames fail closed',()=>{
 const state=apply(createRetryLedger('s'),start(),finish());
 for(const receipt of [original,{...next,input:'i1'},{...next,sourceFrame:'f1'},
  {...next,capturedAt:1},{...next,capturedAt:NaN},{...next,stable:false},
  {...next,origin:'replay' as const},{...next,origin:'synthetic' as const},{...next,session:'other'}]) {
  const result=reduceRetryLedger(state,enqueue(receipt));
  assert.equal(result.accepted,false,JSON.stringify(receipt));assert.strictEqual(result.state,state);
 }
});

test('reject before original completion, non-timeout and mismatched completion',()=>{
 let state=apply(createRetryLedger('s'),start());
 assert.equal(reduceRetryLedger(state,enqueue()).accepted,false);
 assert.equal(reduceRetryLedger(state,{type:'original-finished',pixel:'p',input:'i1',sourceFrame:'wrong',outcome:'timeout'}).accepted,false);
 state=apply(state,{type:'original-finished',pixel:'p',input:'i1',sourceFrame:'f1',outcome:'other'});
 assert.equal(reduceRetryLedger(state,enqueue()).accepted,false);
});

test('queue refusal and pre-start cancellation do not consume the token; post-start cancellation does',()=>{
 let state=apply(createRetryLedger('s'),start(),finish());
 const refused=reduceRetryLedger(state,{type:'queue-rejected',receipt:next,id:'r'});
 assert.equal(refused.accepted,false);assert.strictEqual(refused.state,state);
 state=apply(state,enqueue(),{type:'retry-cancelled',pixel:'p',id:'r',generation:1},enqueue(next,'r2'),
  {type:'retry-started',pixel:'p',id:'r2',generation:2},{type:'retry-cancelled',pixel:'p',id:'r2',generation:2});
 assert.equal(state.entries.p.retry?.state,'spent');
 assert.equal(reduceRetryLedger(state,enqueue(next,'r3')).accepted,false);
});

test('late events cannot start a replacement even if the queue reuses its id',()=>{
 let state=apply(createRetryLedger('s'),start(),finish(),enqueue(),
  {type:'retry-cancelled',pixel:'p',id:'r',generation:1},enqueue());
 const stale=reduceRetryLedger(state,{type:'retry-started',pixel:'p',id:'r',generation:1});
 assert.equal(stale.accepted,false);assert.strictEqual(stale.state,state);
 state=apply(state,{type:'retry-started',pixel:'p',id:'r',generation:2});
 assert.equal(state.entries.p.retry?.state,'active');
});

test('concurrency is bounded and duplicate or stale lifecycle events do not change state',()=>{
 const second={...original,pixel:'p2',input:'x1',sourceFrame:'y1'},secondNext={...second,input:'x2',sourceFrame:'y2',capturedAt:2};
 let state=apply(createRetryLedger('s',10,1),start(),finish(),start(second),finish(second),enqueue());
 for(const event of [enqueue(next,'duplicate'),enqueue(secondNext,'r2'),{type:'retry-started' as const,pixel:'p',id:'wrong',generation:1}]) {
  const result=reduceRetryLedger(state,event);assert.equal(result.accepted,false);assert.strictEqual(result.state,state);
 }
 state=apply(state,{type:'retry-started',pixel:'p',id:'r',generation:1},{type:'retry-finished',pixel:'p',id:'r',generation:1},enqueue(secondNext,'r2'));
 assert.equal(state.entries.p2.retry?.state,'queued');
});

test('capacity rejects unknown pixels instead of evicting a consumed token',()=>{
 let state=apply(createRetryLedger('s',1),start(),finish(),enqueue(),
  {type:'retry-started',pixel:'p',id:'r',generation:1},{type:'retry-finished',pixel:'p',id:'r',generation:1});
 const result=reduceRetryLedger(state,start({...original,pixel:'p2'}));
 assert.equal(result.reason,'capacity');assert.strictEqual(result.state,state);
 state=JSON.parse(JSON.stringify(state));
 assert.equal(reduceRetryLedger(state,enqueue({...next,input:'i3',sourceFrame:'f3',capturedAt:3})).accepted,false);
});

test('untrusted replay event data is schema checked and getters never execute',()=>{
 const state=apply(createRetryLedger('s'),start(),finish());
 let getterCalled=false;
 const getter={type:'queue-accepted',id:'r',get receipt(){getterCalled=true;throw Error('no');}};
 const nested={...next,get input():string{getterCalled=true;throw Error('no');}};
 const proxy=new Proxy({}, {ownKeys(){throw Error('no');}});
 const inherited=Object.create({type:'queue-accepted'});
 const polluted=JSON.parse('{"type":"retry-started","pixel":"__proto__","id":"r","generation":1}');
 const inputs:unknown[]=[null,[],{},inherited,proxy,getter,{type:'queue-accepted',id:'r',receipt:nested},
  {type:'mystery',pixel:'p',id:'r',generation:1},
  {type:'original-finished',pixel:'p',input:'i1',sourceFrame:'f1',outcome:'surprise'},
  {type:'original-finished',pixel:'p',input:'i1',sourceFrame:'f1'},
  {...enqueue(),extra:true},{...enqueue(),id:'x'.repeat(257)},polluted,
  enqueue({...next,capturedAt:-1}),enqueue({...next,capturedAt:Infinity}),
  enqueue({...next,capturedAt:Number.MAX_SAFE_INTEGER+1}),enqueue({...next,input:'constructor'}),
  {type:'retry-started',pixel:'p',id:'r',generation:NaN},
  {type:'retry-started',pixel:'p',id:'r',generation:0}];
 for(const input of inputs) {
  const result=reduceRetryLedger(state,input);
  assert.equal(result.accepted,false);assert.equal(result.reason,'invalid-event');assert.strictEqual(result.state,state);
 }
 assert.equal(getterCalled,false);
 const nullPrototype=Object.assign(Object.create(null),enqueue());
 assert.equal(reduceRetryLedger(state,nullPrototype).accepted,true);
});

test('session, memory and concurrency bounds are enforced',()=>{
 for(const [session,capacity,concurrency] of [['s',2049,1],['s',1,33],['x'.repeat(257),1,1],['__proto__',1,1]] as const)
  assert.throws(()=>createRetryLedger(session,capacity,concurrency));
 assert.equal(createRetryLedger('s',2048,32).capacity,2048);
});
