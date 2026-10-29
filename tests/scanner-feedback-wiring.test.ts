import test from 'node:test';
import assert from 'node:assert/strict';
import {ScanGrid} from '../src/features/card-scanner/scan-grid';
import {createScanMonitorStore} from '../src/features/card-scanner/scan-monitor-store';
import {createScannerFeedback} from '../src/features/card-scanner/scanner-feedback';
import type {ScannerFeedback,FeedbackReadContext} from '../src/features/card-scanner/scanner-feedback';
import type {ObservationFact,ObservationSource} from '../src/features/card-scanner/observation-execution';

const source:ObservationSource={sessionId:'actual-test-session',frameId:7,observationId:'11',captureOrder:51,captureTime:2.4,phase:'input',slot:0};

test('accepted crop and actual grid task transitions bind the store canonical snapshot without changing its JSON',()=>{
  let now=0,notifications=0;
  const probe=createScannerFeedback({now:()=>now});
  const facts:ObservationFact[]=[];
  const grid=new ScanGrid(fact=>{facts.push(fact);probe.observation(fact);},(snapshot,entries,previous)=>probe.grid(snapshot,entries,previous));
  const store=createScanMonitorStore();store.subscribe(()=>notifications++);store.setFeedback(probe);
  assert.equal(notifications,0);
  grid.begin(true);grid.group(0,1,11,true,undefined,source);
  // ObservationWork's queued fact precedes real queue acceptance. It is not a timing origin.
  assert.equal(facts[0].kind,'queued');
  now=1;probe.queued(source,37);grid.record(37);
  const publish=()=>store.publish({grid:grid.snapshot(),currentRunRead:0,expected:40,capacity:550,interrupted:undefined});
  publish();const waiting=store.getSnapshot()!;
  const waitingJson=JSON.stringify(waiting),queued=probe.bindings(waiting);
  assert.equal(queued.length,1);assert.equal(queued[0].target.status,'waiting');
  assert.deepEqual(queued[0].join.source,source);assert.equal(queued[0].join.processingFrame,37);assert.equal(queued[0].join.attemptId,0);
  now=201;assert.equal(probe.acknowledge(waiting,queued[0]),true);probe.commitDone(waiting);
  assert.equal(JSON.stringify(waiting),waitingJson);assert.equal(notifications,1);
  now=210;const old=grid.start(11);publish();const reading=store.getSnapshot()!;
  const started=probe.bindings(reading);assert.equal(started.length,1);assert.equal(started[0].target.status,'reading');assert.equal(started[0].join.attemptId,1);
  now=220;const latest=grid.start(11);grid.finish(11,'read',old);publish();
  assert.equal(store.getSnapshot(),reading,'a rejected stale completion cannot invent a display transition');
  now=230;grid.finish(11,'read',latest);publish();const completed=store.getSnapshot()!;
  const ended=probe.bindings(completed);assert.equal(ended.length,1);assert.equal(ended[0].target.status,'read');assert.equal(ended[0].join.attemptId,2);
  assert.equal(probe.acknowledge(reading,started[0]),false,'replaced canonical publication cannot be credited late');
  now=240;
  assert.equal(probe.acknowledge(completed,ended[0]),true);probe.commitDone(completed);
  assert.equal(notifications,3);store.clear();assert.equal(store.getFeedback(),undefined);
});

test('viewport sidecars preserve shared cell arrays and only bind the actual accepted preview top',()=>{
  let now=0;const probe=createScannerFeedback({now:()=>now});
  const grid=new ScanGrid(undefined,(snapshot,entries,previous)=>probe.grid(snapshot,entries,previous));
  const store=createScanMonitorStore();store.setFeedback(probe);
  grid.begin(true);const first=grid.snapshot();
  now=10;probe.viewport(18,now);grid.liveViewport(18);
  const next=grid.viewportSnapshot(first);assert.equal(next.cells,first.cells);assert.equal(next.inventory,first.inventory);
  store.publish({grid:next,currentRunRead:0,expected:40,capacity:550,interrupted:undefined});
  const snapshot=store.getSnapshot()!,bindings=probe.bindings(snapshot);
  assert.equal(bindings.length,1);assert.equal(bindings[0].surface,'live-scrollbar');assert.equal(bindings[0].top,18);
  assert.equal(bindings[0].join.source,null);assert.equal(bindings[0].join.processingFrame,null);
  now=30;assert.equal(probe.acknowledge(snapshot,bindings[0]),true);probe.commitDone(snapshot);
});

test('optional snapshot callbacks and broken timing consumers cannot change grid/store notifications',()=>{
  const ordinary=new ScanGrid(),instrumented=new ScanGrid(undefined,()=>{throw Error('diagnostic failure');});
  for(const grid of [ordinary,instrumented]){grid.begin(true);grid.group(0,1,11,true,undefined,source);grid.record(37);}
  assert.deepEqual(instrumented.snapshot(),ordinary.snapshot());
  const store=createScanMonitorStore();let notifications=0;store.subscribe(()=>notifications++);
  store.setFeedback({publish(){throw Error('publish');},cancel(){throw Error('cancel');}} as unknown as ScannerFeedback);
  const input={grid:ordinary.snapshot(),currentRunRead:0,expected:40,capacity:550,interrupted:undefined};
  store.publish(input);store.publish(structuredClone(input));assert.equal(notifications,1);
  store.clear();assert.equal(notifications,2);assert.equal(store.getSnapshot(),null);
});

test('the same captured work can be displayed in a later frame and different slot without changing its source',()=>{
  let now=10;const probe=createScannerFeedback({now:()=>now});
  const grid=new ScanGrid(fact=>probe.observation(fact),(snapshot,entries,previous)=>probe.grid(snapshot,entries,previous));
  const store=createScanMonitorStore();store.setFeedback(probe);
  grid.begin(true);grid.group(0,1,11,true,undefined,source);probe.queued(source,37);grid.record(37);
  grid.begin(true);grid.group(20,1,11,false);grid.record(41);
  now=20;const lease=grid.start(11);
  store.publish({grid:grid.snapshot(),currentRunRead:0,expected:40,capacity:550,interrupted:undefined});
  const snapshot=store.getSnapshot()!,bindings=probe.bindings(snapshot);
  assert.equal(bindings.length,1);
  const binding=bindings[0];
  assert.equal(binding.slot,20);assert.equal(binding.displayFrame,41);
  assert.equal(binding.join.processingFrame,37);assert.equal(binding.join.source?.slot,0);
  assert.deepEqual(binding.join.source,source);assert.equal(binding.join.attemptId,1);
  assert.equal(binding.join.atMs,20);
  now=30;
  assert.equal(probe.acknowledge(snapshot,{...binding}),false,'a copied witness has no canonical publication ownership');
  assert.equal(probe.acknowledge({...snapshot},binding),false);
  assert.equal(probe.acknowledge(snapshot,binding),true);probe.commitDone(snapshot);
  now=40;grid.finish(11,'read',lease);
  store.publish({grid:grid.snapshot(),currentRunRead:1,expected:40,capacity:550,interrupted:undefined});
  const ended=probe.bindings(store.getSnapshot()!);
  assert.equal(ended.length,1);assert.equal(ended[0].join.kind,'read-task-end');
  assert.equal(ended[0].displayFrame,41);assert.equal(ended[0].slot,20);
  assert.equal(ended[0].join.processingFrame,37);assert.equal(ended[0].join.source?.slot,0);
});

test('an evicted queued origin is recovered only at the actual accepted work start, without resurrecting queued time',()=>{
  let now=1,context:FeedbackReadContext|undefined;
  const probe=createScannerFeedback({now:()=>now});
  const grid=new ScanGrid(fact=>probe.observation(fact,context),(snapshot,entries,previous)=>probe.grid(snapshot,entries,previous));
  const store=createScanMonitorStore();store.setFeedback(probe);
  grid.begin(true);grid.group(0,1,11,true,undefined,source);probe.queued(source,37);grid.record(37);
  for(let i=0;i<300;i++){
    now++;probe.queued({...source,observationId:'pressure-'+i,captureOrder:1000+i},100+i);
  }
  assert.ok(probe.stats().adapter.counters.associationEvictions>0);
  now=500;context={source,processingFrame:37};
  let lease:number|undefined;
  try{lease=grid.start(11);}finally{context=undefined;}
  store.publish({grid:grid.snapshot(),currentRunRead:0,expected:40,capacity:550,interrupted:undefined});
  const reading=store.getSnapshot()!,started=probe.bindings(reading);
  assert.equal(started.length,1);assert.equal(started[0].join.kind,'read-task-start');
  assert.equal(started[0].join.atMs,500);assert.equal(started[0].join.processingFrame,37);
  now=510;assert.equal(probe.acknowledge(reading,started[0]),true);probe.commitDone(reading);
  for(let i=0;i<300;i++)probe.queued({...source,observationId:'more-'+i,captureOrder:2000+i},500+i);
  now=600;grid.finish(11,'read',lease);
  store.publish({grid:grid.snapshot(),currentRunRead:1,expected:40,capacity:550,interrupted:undefined});
  const completed=store.getSnapshot()!,ended=probe.bindings(completed);
  assert.equal(ended.length,1);assert.equal(ended[0].join.kind,'read-task-end');
  assert.equal(ended[0].join.atMs,600);assert.equal(ended[0].join.attemptId,1);
  now=610;assert.equal(probe.acknowledge(completed,ended[0]),true);probe.commitDone(completed);
  assert.equal(probe.stats().byKind['read-task-start'].receipts,1);
  assert.equal(probe.stats().byKind['read-task-end'].receipts,1);
  assert.ok(probe.stats().adapter.metadataBytes<=probe.stats().adapter.limits.metadataBytes);
});

test('a synchronous read context cannot authorize another source or an unleased correction',()=>{
  let now=1,context:FeedbackReadContext|undefined;
  const probe=createScannerFeedback({now:()=>now});
  const grid=new ScanGrid(fact=>probe.observation(fact,context),(snapshot,entries,previous)=>probe.grid(snapshot,entries,previous));
  const other={...source,observationId:'12',slot:1};
  grid.begin(true);grid.group(1,2,12,true,undefined,other);grid.record(37);
  context={source,processingFrame:37};
  try{grid.start(12);}finally{context=undefined;}
  now=2;grid.finish(12,'read');
  const store=createScanMonitorStore();store.setFeedback(probe);
  store.publish({grid:grid.snapshot(),currentRunRead:0,expected:40,capacity:550,interrupted:undefined});
  assert.equal(probe.bindings(store.getSnapshot()!).length,0);
  assert.equal(probe.stats().byKind['read-task-start'].offeredValidFacts,0);
  assert.equal(probe.stats().byKind['read-task-end'].offeredValidFacts,0);
});

test('superseded running work emits its own end fact without completing the replacement display',()=>{
  let now=1;const probe=createScannerFeedback({now:()=>now});
  const grid=new ScanGrid(fact=>probe.observation(fact),(snapshot,entries,previous)=>probe.grid(snapshot,entries,previous));
  grid.begin(true);grid.group(0,1,11,true,undefined,source);probe.queued(source,37);grid.record(37);
  now=2;const old=grid.start(11);
  const replacement={...source,observationId:'12',frameId:8,captureOrder:52};
  grid.group(0,1,12,true,undefined,replacement);probe.queued(replacement,38);grid.record(38);
  assert.equal(probe.stats().adapter.activeSources,1);
  now=3;grid.finish(11,'read',old);
  assert.equal(probe.stats().adapter.activeSources,0);
  assert.equal(probe.stats().byKind['read-task-end'].offeredValidFacts,1);
  const store=createScanMonitorStore();store.setFeedback(probe);
  store.publish({grid:grid.snapshot(),currentRunRead:0,expected:40,capacity:550,interrupted:undefined});
  const snapshot=store.getSnapshot()!;
  assert.equal(snapshot.grid?.recentFrame?.cells[0].status,'waiting');
  assert.ok(probe.bindings(snapshot).every(binding=>binding.join.source?.observationId!=='11'));
  assert.equal(probe.stats().adapter.counters.projectionSourceAbsent,1);
});
