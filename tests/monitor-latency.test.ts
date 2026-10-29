import test from 'node:test';
import assert from 'node:assert/strict';
import {createMonitorLatencyProbe} from '../dev/monitor-latency';
import {createScanMonitorStore} from '../src/features/card-scanner/scan-monitor-store';
import type {ScanMonitorState} from '../src/features/card-scanner/scan-monitor-store';

test('measures notified canonical snapshots only, without duplicate commits',()=>{
  let time=10;
  const probe=createMonitorLatencyProbe(()=>time),snapshot={};
  assert.equal(probe.commit(null),false);
  assert.equal(probe.commit(snapshot),false,'initial render is not a store notification');
  assert.equal(probe.notify(null),false);
  assert.equal(probe.notify(snapshot),true);
  time=12;assert.equal(probe.notify(snapshot),false);
  time=14;assert.equal(probe.commit(snapshot),true);
  time=16;assert.equal(probe.commit(snapshot),false);
  assert.deepEqual(probe.stats(),{
    boundary:'store-notification-to-react-layout-commit',notified:1,committed:1,
    skippedCoalesced:0,pending:0,rejectedClock:0,sampleCount:1,sampleLimit:2048,p50Ms:4,p95Ms:4,maxMs:4,
  });
});

test('counts skipped snapshots when React commits a newer notification',()=>{
  let time=0;
  const probe=createMonitorLatencyProbe(()=>time),a={},b={},c={},d={};
  probe.notify(a);time=1;probe.notify(b);time=2;probe.notify(c);
  assert.equal(probe.stats().pending,3);
  time=5;probe.commit(c);
  assert.equal(probe.commit(a),false,'a late old commit cannot move the sequence backwards');
  assert.equal(probe.commit(b),false);
  time=6;probe.notify(d);
  assert.equal(probe.stats().notified,4);assert.equal(probe.stats().committed,1);
  assert.equal(probe.stats().skippedCoalesced,2);assert.equal(probe.stats().pending,1);
  time=7;probe.commit(d);
  assert.equal(probe.stats().pending,0);assert.equal(probe.stats().committed,2);
});

test('a notification does not declare earlier snapshots skipped before a commit',()=>{
  let time=1;
  const probe=createMonitorLatencyProbe(()=>time),a={},b={};
  probe.notify(a);time=2;probe.notify(b);
  time=3;probe.commit(a);time=4;probe.commit(b);
  assert.equal(probe.stats().committed,2);assert.equal(probe.stats().skippedCoalesced,0);
  assert.equal(probe.stats().pending,0);assert.equal(probe.stats().p50Ms,2);
});

test('rejects invalid or backwards clock measurements without inventing coalescing',()=>{
  let time=10;
  const probe=createMonitorLatencyProbe(()=>time);
  for(const invalid of [NaN,Infinity,-1,9]){
    const snapshot={};time=10;probe.notify(snapshot);
    time=invalid;probe.commit(snapshot);
  }
  time=NaN;const invalidStart={};probe.notify(invalidStart);
  time=11;probe.commit(invalidStart);
  assert.equal(probe.stats().notified,5);assert.equal(probe.stats().committed,5);
  assert.equal(probe.stats().rejectedClock,5);assert.equal(probe.stats().sampleCount,0);
  assert.equal(probe.stats().skippedCoalesced,0);assert.equal(probe.stats().pending,0);
  const valid={};time=12;probe.notify(valid);probe.commit(valid);
  assert.equal(probe.stats().sampleCount,1);assert.equal(probe.stats().p50Ms,0);
});

test('reset clears counters and invalidates marks from a previous session',()=>{
  let time=5;
  const probe=createMonitorLatencyProbe(()=>time),old={};probe.notify(old);
  const before=probe.stats();assert.equal(Object.isFrozen(before),true);
  probe.reset();time=1;
  assert.equal(probe.commit(old),false);
  assert.equal(probe.stats().notified,0);assert.equal(probe.stats().pending,0);
  assert.equal(probe.stats().p50Ms,null);assert.equal(probe.stats().p95Ms,null);assert.equal(probe.stats().maxMs,null);
  probe.notify(old);time=2;probe.commit(old);
  assert.equal(probe.stats().p50Ms,1);assert.equal(probe.stats().rejectedClock,0);
  assert.equal(before.pending,1,'previous summaries remain detached');
});

test('retains a bounded rolling sample window while counts cover the whole run',()=>{
  let time=0;
  const probe=createMonitorLatencyProbe(()=>time,3);
  for(const duration of [100,20,2,3,4]){
    const snapshot={};probe.notify(snapshot);time+=duration;probe.commit(snapshot);time++;
  }
  assert.equal(probe.stats().notified,5);assert.equal(probe.stats().committed,5);
  assert.equal(probe.stats().sampleLimit,3);assert.equal(probe.stats().sampleCount,3);
  assert.equal(probe.stats().p50Ms,3);assert.equal(probe.stats().p95Ms,4);assert.equal(probe.stats().maxMs,4);
  for(const limit of [0,-1,1.5,2049,Infinity,NaN])assert.throws(()=>createMonitorLatencyProbe(()=>0,limit),RangeError);
});

test('canonical store notifications are timestamped before the React listener and clear resets them',()=>{
  let time=0;
  const probe=createMonitorLatencyProbe<ScanMonitorState>(()=>time),store=createScanMonitorStore();
  let listeners=0;
  const subscribe=(listener:()=>void)=>store.subscribe(()=>{probe.notify(store.getSnapshot());listener();});
  const unsubscribe=subscribe(()=>{
    listeners++;
    const state=store.getSnapshot();
    if(state!==null)assert.equal(probe.stats().pending,1);
    time+=2;probe.commit(state);
  });
  const snapshot:ScanMonitorState={currentRunRead:1,expected:394,capacity:450};
  store.publish(snapshot);store.publish({...snapshot});
  assert.equal(listeners,1);assert.equal(probe.stats().p50Ms,2);
  store.publish({...snapshot,currentRunRead:2});
  assert.equal(listeners,2);assert.equal(probe.stats().committed,2);
  store.clear();probe.reset();
  assert.equal(probe.stats().notified,0);assert.equal(probe.stats().pending,0);
  unsubscribe();store.publish(snapshot);assert.equal(probe.stats().notified,0);
});
