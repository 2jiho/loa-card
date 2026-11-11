import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createRetryRecorder,replayRetryRecords} from '../src/features/card-scanner/reproduction/retry-receipt-replay';
import type {RetryRecord} from '../src/features/card-scanner/reproduction/retry-receipt-replay';
import type {RetryEvent,RetryReceipt} from '../src/features/card-scanner/session/retry-receipt-state';

const first:RetryReceipt={session:'s',pixel:'p',input:'i1',sourceFrame:'f1',capturedAt:1,origin:'live',stable:true};
const later:RetryReceipt={...first,input:'i2',sourceFrame:'f2',capturedAt:2};
const events:RetryEvent[]=[{type:'original-started',receipt:first},
  {type:'original-finished',pixel:'p',input:'i1',sourceFrame:'f1',outcome:'timeout'},
  {type:'queue-rejected',id:'r',receipt:later},{type:'queue-accepted',id:'r',receipt:later},
  {type:'retry-cancelled',pixel:'p',id:'r',generation:1},{type:'queue-accepted',id:'r2',receipt:later},
  {type:'retry-started',pixel:'p',id:'r2',generation:2},{type:'retry-finished',pixel:'p',id:'r2',generation:2}];
async function fixture() {
  const items:RetryRecord[]=[];
  const recorder=await createRetryRecorder('s',10,1,async item=>{items.push(structuredClone(item));});
  for(const event of events)await recorder.append(event);
  return {items,checkpoint:recorder.close()};
}
test('replay preserves rejected queue, cancellation and spent token decisions',async()=>{
  const {items,checkpoint}=await fixture(),result=await replayRetryRecords(items,checkpoint);
  assert.equal(result.ok,true);
  if(result.ok)assert.equal(result.state.entries.p.retry?.state,'spent');
  assert.equal(result.physicalSourceVerified,false);
  assert.equal(result.scannerIntegrated,false);
  assert.equal(items[2].reason,'queue-rejected');
  assert.equal(items[4].reason,'cancelled-before-start');
});
test('detect missing, duplicated, reordered and altered events or checkpoint',async()=>{
  const {items,checkpoint}=await fixture();
  for(const input of [items.slice(0,-1),[items[0],...items], [items[1],items[0],...items.slice(2)],
    [...items.slice(0,2),{...items[2],reason:'other'},...items.slice(3)],
    [...items.slice(0,1),{...items[1],event:{...items[1].event,input:'different'}},...items.slice(2)]])
    assert.equal((await replayRetryRecords(input,checkpoint)).ok,false);
  assert.equal((await replayRetryRecords(items,{...checkpoint,hash:'0'.repeat(64)})).ok,false);
  assert.equal((await replayRetryRecords(items,{...checkpoint,sealed:false})).ok,false);
});
test('caller frame IDs never establish physical uniqueness, even for a complete log',async()=>{
  const {items,checkpoint}=await fixture();
  const replay=await replayRetryRecords(items,checkpoint);
  assert.equal(replay.ok,true);assert.equal(replay.physicalSourceVerified,false);
});
test('duplicate input, reused frame and synthetic or replay sources are rejected in replay',async()=>{
  const items:RetryRecord[]=[];
  const recorder=await createRetryRecorder('s',10,1,async item=>{items.push(structuredClone(item));});
  await recorder.append(events[0]);await recorder.append(events[1]);
  for(const receipt of [{...later,input:'i1'},{...later,sourceFrame:'f1'},
    {...later,origin:'replay' as const},{...later,origin:'synthetic' as const}])
    assert.equal((await recorder.append({type:'queue-accepted',id:'r',receipt})).accepted,false);
  assert.equal((await replayRetryRecords(items,recorder.close())).ok,true);
});
test('failed persistence and malformed events cannot produce a sealed checkpoint',async()=>{
  const recorder=await createRetryRecorder('s',10,1,async()=>{throw Error('disk');});
  await assert.rejects(recorder.append(events[0]));
  assert.equal(recorder.close().sealed,false);
  const invalid=await createRetryRecorder('s',10,1,async()=>{});
  let called=false;
  const item={type:'original-started',get receipt(){called=true;return first;}};
  await assert.rejects(invalid.append(item));assert.equal(called,false);
  assert.equal(invalid.close().sealed,false);
});

test('malformed checkpoints and record accessors are refused without executing getters',async()=>{
  const {items,checkpoint}=await fixture();
  let called=false;
  const badRecord={seq:1,event:items[0].event,accepted:true,get reason(){called=true;return 'registered';}};
  const badCheckpoint={...checkpoint,get hash(){called=true;return '0'.repeat(64);}};
  assert.equal((await replayRetryRecords([badRecord,...items.slice(1)],checkpoint)).ok,false);
  assert.equal((await replayRetryRecords(items,badCheckpoint)).ok,false);
  assert.equal((await replayRetryRecords(items,{...checkpoint,extra:true})).ok,false);
  assert.equal(called,false);
});

test('a sink cannot mutate a record and leave a falsely sealed log',async()=>{
  const recorder=await createRetryRecorder('s',10,1,async item=>{
    (item.event as {type:string}).type='changed';
  });
  await assert.rejects(recorder.append(events[0]));
  assert.equal(recorder.close().sealed,false);
});

test('a write in flight cannot be skipped by concurrent append or close',async()=>{
  let release!:()=>void;
  const barrier=new Promise<void>(resolve=>{release=resolve;});
  const recorder=await createRetryRecorder('s',10,1,async()=>barrier);
  const write=recorder.append(events[0]);
  await assert.rejects(recorder.append(events[1]));
  assert.throws(()=>recorder.close(),/busy/);
  release();await write;
  assert.equal(recorder.close().count,1);
  await assert.rejects(recorder.append(events[1]));
});

test('checkpoint seed, transition decisions and full event content are covered',async()=>{
  const {items,checkpoint}=await fixture();
  assert.equal((await replayRetryRecords(items,{...checkpoint,capacity:11})).ok,false);
  assert.equal((await replayRetryRecords(items,{...checkpoint,count:checkpoint.count-1})).ok,false);
  const changed=structuredClone(items);
  const event=changed[0].event;
  assert.equal(event.type,'original-started');
  if(event.type==='original-started')event.receipt.stable=false;
  assert.equal((await replayRetryRecords(changed,checkpoint)).ok,false);
});
