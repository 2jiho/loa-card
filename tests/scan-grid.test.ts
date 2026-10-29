import test from 'node:test';
import assert from 'node:assert/strict';
import {ScanGrid,gridReady,isLockedInventorySlot} from '../src/features/card-scanner/scan-grid';
import {reduceObservationExecution,observationExecutionSnapshot,hashObservationExecution} from '../src/features/card-scanner/observation-execution';
import type {ObservationFact,ObservationSource,ObservationExecutionState} from '../src/features/card-scanner/observation-execution';

test('scroll permission requires every slot to be retained or explicitly empty',()=>{
 const grid=new ScanGrid();grid.begin(true);
 for(let i=0;i<39;i++)grid.group(i,i,i+1,true);
 assert.equal(gridReady(grid.snapshot()),false);
 grid.cell(39,'empty');assert.equal(gridReady(grid.snapshot()),true);
 grid.stage(1,'dropped');assert.equal(gridReady(grid.snapshot()),false);
 grid.finish(1,'read');assert.equal(gridReady(grid.snapshot()),true);
 grid.begin(false);assert.equal(gridReady(grid.snapshot()),false);
});
test('moving duplicate slots follow their group while late old reads cannot confirm newer input',()=>{
 const grid=new ScanGrid();grid.begin(true);grid.group(0,9,1,true,5);
 grid.finish(1,'read');grid.begin(true);grid.group(10,9,2,false,5);
 assert.equal(grid.snapshot().cells[10].status,'read');
 grid.group(10,9,3,true,5);grid.finish(1,'read');
 assert.equal(grid.snapshot().cells[10].status,'waiting');
 grid.finish(3,'review');assert.equal(grid.snapshot().cells[10].status,'review');
 grid.reset();grid.begin(true);grid.group(0,9,4,false);
 assert.equal(grid.snapshot().cells[0].status,'unknown');
});
test('rejected overlay does not borrow a previous slot result and snapshots are detached',()=>{
 const grid=new ScanGrid();grid.begin(true);grid.group(0,1,1,true);grid.finish(1,'read');
 grid.begin(true);grid.cell(0,'review','툴팁 가림');grid.finish(1,'read');
 const result=grid.snapshot();assert.equal(result.cells[0].status,'review');
 result.cells[0].status='read';assert.equal(grid.snapshot().cells[0].status,'review');
});
test('inventory retains offscreen slots and latest async results, but resets on range changes',()=>{
 const grid=new ScanGrid();grid.geometry(55);grid.begin(true);grid.group(0,1,1,true,1);
 grid.begin(true);grid.group(0,2,2,true,52);grid.finish(1,'read');
 assert.equal(grid.snapshot().inventory?.[0].status,'read');
 assert.equal(grid.snapshot().inventory?.[510].status,'waiting');
 grid.cell(1,'review','moving'); // Unknown location cannot corrupt a guessed global slot.
 assert.equal(grid.snapshot().inventory?.[511],undefined);
 grid.group(0,2,3,true,52);grid.finish(2,'read');
 assert.equal(grid.snapshot().inventory?.[510].status,'waiting');
 grid.geometry(40);assert.equal(grid.snapshot().inventory?.length,0);
 grid.reset();assert.equal(grid.snapshot().totalRows,undefined);
});
test('locked slots derive from opened capacity, never from the registered count',()=>{
 assert.equal(isLockedInventorySlot(393,450,393),false);
 assert.equal(isLockedInventorySlot(449,450,393),false);
 assert.equal(isLockedInventorySlot(450,450,393),true);
 assert.equal(isLockedInventorySlot(549,450,393),true);
 assert.equal(isLockedInventorySlot(450,null,393),false);
 assert.equal(isLockedInventorySlot(450,390,393),false);
 assert.equal(isLockedInventorySlot(549,550,393),false);
});
test('a revised position cannot paint the same observation group in two places',()=>{
 const grid=new ScanGrid();grid.begin(true);grid.group(0,1,1,true,10);grid.finish(1,'read');
 grid.begin(true);grid.group(0,1,2,false,11);
 const result=grid.snapshot();
 assert.equal(result.inventory?.[90].status,'unknown');
 assert.equal(result.inventory?.[100].status,'read');
});
test('transient unknown or rejected crops retain registered history while current-frame quality stays honest',()=>{
 const grid=new ScanGrid();grid.begin(true);grid.group(0,1,1,true,1);grid.finish(1,'read');
 grid.begin(true);grid.cell(0,'unknown',undefined,1);
 assert.equal(grid.snapshot().inventory?.[0].status,'read');
 grid.cell(0,'review','tooltip',1);
 assert.equal(grid.snapshot().inventory?.[0].status,'read');
 assert.equal(grid.snapshot().cells[0].status,'review');
 grid.group(0,2,2,true,1);
 assert.equal(grid.snapshot().inventory?.[0].status,'waiting');
});
test('delayed frame placement fills history without overwriting newer evidence or the current viewport',()=>{
 const grid=new ScanGrid();grid.begin(true);grid.group(0,1,1,true);grid.record(1);
 grid.begin(true);grid.group(0,2,2,true);grid.record(2);grid.register(2,1);grid.finish(2,'read');
 grid.register(1,1);grid.finish(1,'review');
 assert.equal(grid.snapshot().inventory?.[0].status,'read');
 assert.equal(grid.snapshot().cells[0].status,'read');
 grid.begin(true);grid.group(0,3,3,true);grid.record(3);
 grid.begin(true);grid.group(0,4,4,true);grid.record(4);
 grid.register(3,5);grid.finish(3,'read');
 assert.equal(grid.snapshot().inventory?.[40].status,'read');
 assert.equal(grid.snapshot().cells[0].row,undefined);
});

test('final verified identities resolve old review observations without painting unknown slots',()=>{
 const grid=new ScanGrid();grid.begin(true);grid.group(0,1,1,true,1);grid.identify(1,'a');grid.finish(1,'review');
 grid.group(1,2,2,true,1);grid.identify(2,'b');grid.finish(2,'review');
 grid.confirm(['a']);
 assert.equal(grid.snapshot().inventory?.[0].status,'read');
 assert.equal(grid.snapshot().inventory?.[1].status,'review');
 assert.equal(grid.snapshot().cells[2].status,'unknown');
 grid.group(0,1,3,true,1);
 assert.equal(grid.snapshot().inventory?.[0].status,'waiting');
 grid.reset();assert.equal(grid.snapshot().inventory?.length,0);
});

test('final validation preserves an independently identified position through an unidentified crop',()=>{
 const grid=new ScanGrid();grid.begin(true);grid.group(0,1,1,true,3);grid.identify(1,'a');grid.finish(1,'read');
 grid.begin(true);grid.group(0,2,2,true,3);grid.finish(2,'review');
 assert.equal(grid.snapshot().inventory?.[20].status,'review');
 grid.confirm(['a']);assert.equal(grid.snapshot().inventory?.[20].status,'read');
 grid.identify(2,'b');assert.equal(grid.snapshot().inventory?.[20].status,'review');
 grid.cell(0,'empty',undefined,3);assert.equal(grid.snapshot().inventory?.[20].status,'empty');
});

test('order restoration requires the exact complete confirmed identity set',()=>{
 const grid=new ScanGrid();grid.confirm(['a','b']);
 grid.restoreOrder(['a','c']);assert.equal(grid.snapshot().inventory?.length,0);
 grid.restoreOrder(['a']);assert.equal(grid.snapshot().inventory?.length,0);
 grid.restoreOrder(['a','a']);assert.equal(grid.snapshot().inventory?.length,0);
 grid.restoreOrder(['b','a']);
 assert.deepEqual(grid.snapshot().inventory?.map(c=>c.status),['read','read']);
 assert.match(grid.snapshot().inventory![0].reason!,/이름순/);
});

test('sort reset retains duplicate reading status but discards all old positions and pending frames',()=>{
 const grid=new ScanGrid();grid.geometry(55);grid.begin(true);
 grid.group(0,7,1,true);grid.identify(7,'a');grid.record(1);grid.register(1,1);grid.finish(1,'read');
 grid.begin(true);grid.group(0,8,2,true);grid.record(2);
 grid.resetPositions();
 assert.equal(grid.snapshot().inventory?.length,0);
 grid.register(2,10);assert.equal(grid.snapshot().inventory?.length,0);
 grid.begin(true);grid.group(0,7,3,false);grid.record(3);grid.register(3,20);
 assert.equal(grid.snapshot().inventory?.[190].status,'read');
 assert.equal(grid.snapshot().inventory?.[0].status,'unknown');
 // A pending job may finish after sorting, but only at its newly observed slot.
 grid.group(1,8,4,false,20);grid.finish(2,'review');
 assert.equal(grid.snapshot().inventory?.[191].status,'review');
 // A new observation still supersedes an old completed job.
 grid.group(0,7,5,true,20);grid.finish(1,'read');
 assert.equal(grid.snapshot().inventory?.[190].status,'waiting');
 grid.finish(5,'read');assert.equal(grid.snapshot().inventory?.[190].status,'read');
});

test('long scans retain visible, mapped and pending-frame results during cache eviction',()=>{
 const grid=new ScanGrid();grid.begin(true);grid.group(0,1,1,true,1);grid.finish(1,'read');
 grid.begin(true);grid.group(0,2,2,true);grid.record(1);
 for(let n=3;n<=6000;n++){grid.begin(true);grid.group(0,n,n,true);grid.finish(n,'read');}
 assert.equal(grid.snapshot().inventory?.[0].status,'read');
 grid.finish(2,'review');grid.register(1,4);
 assert.equal(grid.snapshot().inventory?.[30].status,'review');
 grid.begin(true);grid.group(0,1,6001,false,1);
 assert.equal(grid.snapshot().cells[0].status,'read');
 grid.group(0,1,6002,true,1);grid.finish(1,'read');
 assert.equal(grid.snapshot().cells[0].status,'waiting');
 grid.finish(6002,'review');assert.equal(grid.snapshot().cells[0].status,'review');
});

test('duplicate frames cannot evict the trace of a still pending read',()=>{
 const grid=new ScanGrid();grid.begin(true);grid.group(0,1,1,true,1);
 for(let trace=2;trace<=5000;trace++){grid.begin(true);grid.group(0,1,trace,false,1);}
 grid.finish(1,'read');assert.equal(grid.snapshot().cells[0].status,'read');
 grid.finish(5000,'review');assert.equal(grid.snapshot().cells[0].status,'read');
});

test('viewport hints do not paint inventory, mark crops ready or survive a missing layout',()=>{
 const grid=new ScanGrid();grid.begin(true);grid.viewport(21);
 assert.equal(grid.snapshot().estimatedTop,21);
 assert.equal(grid.snapshot().inventory?.length,0);
 assert.equal(gridReady(grid.snapshot()),false);
 grid.begin(false);assert.equal(grid.snapshot().estimatedTop,undefined);
 grid.viewport(53);assert.equal(grid.snapshot().estimatedTop,undefined);
 grid.viewport(1);grid.resetPositions();assert.equal(grid.snapshot().estimatedTop,undefined);
});

test('independent live viewport survives a delayed acquisition without moving registered slots',()=>{
 const grid=new ScanGrid();grid.begin(true);grid.group(0,1,1,true);grid.record(1);grid.register(1,1);
 grid.liveViewport(20);
 grid.begin(true);grid.group(0,1,2,false);grid.record(2);grid.register(2,1);
 assert.equal(grid.snapshot().liveTop,20);
 assert.equal(grid.snapshot().cells[0].row,1);
 assert.equal(grid.snapshot().inventory?.[0].row,1);
 grid.liveViewport(undefined);assert.equal(grid.snapshot().liveTracking,true);
 grid.resetPositions();assert.equal(grid.snapshot().liveTracking,false);
});

test('live identity placements fill immediately, revoke stale results and clear on sorting',()=>{
 const grid=new ScanGrid();grid.begin(true);grid.group(0,1,1,true,3);grid.identify(1,'a');grid.finish(1,'read');
 const positions=[{id:'a',slot:30},{id:'b',slot:31}];
 grid.placeLive(positions,new Map([['a','read'],['b','waiting']]));
 assert.equal(grid.snapshot().inventory?.[20].status,'unknown','old marker is not duplicated');
 assert.equal(grid.snapshot().inventory?.[30].status,'read');
 assert.equal(grid.snapshot().inventory?.[31].status,'waiting');
 grid.placeLive(positions,new Map([['a','review'],['b','read']]));
 assert.equal(grid.snapshot().inventory?.[30].status,'review','latest fields can revoke green');
 assert.equal(grid.snapshot().inventory?.[31].status,'read');
 grid.resetPositions();assert.equal(grid.snapshot().inventory?.length,0);
});

test('live display rejects collisions and yields to final verified placements',()=>{
 const grid=new ScanGrid();grid.placeLive([{id:'a',slot:0},{id:'b',slot:0}],new Map([['a','read'],['b','read']]));
 assert.equal(grid.snapshot().inventory?.length,0);
 grid.placeLive([{id:'a',slot:20}],new Map([['a','waiting']]));
 grid.confirm(['a']);grid.restorePositions([{id:'a',slot:0}]);
 assert.deepEqual(grid.snapshot().inventory?.map(c=>c.status),['read']);
});

test('late missing layout cannot erase a fresh independently guarded viewport',()=>{
 const grid=new ScanGrid();grid.begin(true);grid.liveViewport(28);
 grid.begin(false);
 assert.equal(grid.snapshot().liveTop,28);
 assert.equal(gridReady(grid.snapshot()),false,'a viewport hint cannot confirm card acquisition');
 grid.liveViewport(undefined);
 assert.equal(grid.snapshot().liveTop,undefined,'a current guard mismatch still hides immediately');
});

test('fast viewport updates reuse published cells without delaying newly read card status',()=>{
 const grid=new ScanGrid();grid.begin(true);grid.group(0,1,1,true,1);
 const before=grid.snapshot();
 for(let top=1;top<=52;top++){
  grid.liveViewport(top);const next=grid.viewportSnapshot(before);
  assert.equal(next.liveTop,top);assert.equal(next.inventory,before.inventory);assert.equal(next.cells,before.cells);
 }
 grid.finish(1,'read');
 const read=grid.snapshot();assert.equal(read.inventory?.[0].status,'read');
 assert.equal(grid.viewportSnapshot(read).inventory,read.inventory);
 grid.resetPositions();assert.equal(grid.snapshot().liveTop,undefined);
});

test('recent captured fields update without spatial anchors and exclude rejected and empty slots',()=>{
 const grid=new ScanGrid();grid.begin(true);
 grid.group(0,1,1,true);grid.group(1,2,2,true);
 grid.cell(2,'review','가림');grid.cell(3,'empty');grid.record(1);
 assert.deepEqual(grid.snapshot().recent,{captured:2,read:0,waiting:2,reading:0,review:0});
 grid.finish(1,'read');grid.finish(2,'review');
 assert.deepEqual(grid.snapshot().recent,{captured:2,read:1,waiting:0,reading:0,review:1});
 assert.equal(grid.snapshot().inventory!.length,0,'a summary must not invent absolute positions');
 grid.begin(false);
 assert.equal(grid.snapshot().recent!.read,1,'a new in-flight capture does not blink away the last complete receipt');
 grid.begin(true);grid.group(0,1,3,true);grid.record(2);
 assert.deepEqual(grid.snapshot().recent,{captured:1,read:0,waiting:1,reading:0,review:0},'new field evidence revokes the old green status');
 grid.finish(1,'read');assert.equal(grid.snapshot().recent!.read,0);
 grid.finish(3,'read');assert.equal(grid.snapshot().recent!.read,1);
 grid.resetPositions();assert.equal(grid.snapshot().recent!.captured,0);
});

test('queued crops become reading only when a reader starts and remain safe to scroll',()=>{
 const grid=new ScanGrid();grid.begin(true);
 for(let i=0;i<40;i++)grid.group(i,i,i+1,true,1+Math.floor(i/10));
 grid.record(1);
 assert.equal(grid.snapshot().recent!.waiting,40);
 const attempt=grid.start(1);
 assert.equal(grid.snapshot().cells[0].status,'reading');
 assert.equal(grid.snapshot().inventory![0].status,'reading');
 assert.deepEqual(grid.snapshot().recent,{captured:40,waiting:39,reading:1,read:0,review:0});
 assert.equal(gridReady(grid.snapshot()),true,'accepted input can scroll while OCR continues');
 grid.finish(1,'read',attempt);
 assert.equal(grid.snapshot().recent!.read,1);
 assert.equal(grid.snapshot().recent!.reading,0);
});

test('overlapping attempts sharing a trace cannot finish a newer active retry',()=>{
 const grid=new ScanGrid();grid.begin(true);grid.group(0,1,1,true,1);grid.record(1);
 const first=grid.start(1);grid.stage(1,'deferred');
 assert.equal(grid.snapshot().cells[0].status,'waiting');
 const retry=grid.start(1);
 grid.finish(1,'waiting',first);
 assert.equal(grid.snapshot().cells[0].status,'reading');
 grid.finish(1,'read',retry);grid.finish(1,'review',first);
 assert.equal(grid.snapshot().cells[0].status,'read');
 grid.group(0,1,2,true,1);
 assert.equal(grid.start(1),undefined);
 grid.finish(1,'read',retry);
 assert.equal(grid.snapshot().cells[0].status,'waiting');
 const next=grid.start(2);grid.stage(2,'dropped');grid.finish(2,'read',next);
 assert.equal(grid.snapshot().cells[0].status,'review','abandoned work cannot leave a reading marker');
});

test('live placement exposes active field retries without hiding confirmed reads',()=>{
 const grid=new ScanGrid();grid.begin(true);grid.group(0,1,1,true,1);grid.identify(1,'a');
 grid.placeLive([{id:'a',slot:10}],new Map([['a','review']]));
 const retry=grid.start(1);
 assert.equal(grid.snapshot().inventory![10].status,'reading','field-status overlay must not hide actual work');
 grid.placeLive([{id:'a',slot:10}],new Map([['a','read']]));
 assert.equal(grid.snapshot().inventory![10].status,'read','an already-proven latest card stays complete');
 grid.finish(1,'review',retry);
 grid.placeLive([{id:'a',slot:10}],new Map([['a','review']]));
 assert.equal(grid.snapshot().inventory![10].status,'review');
});

test('live grid lifecycle facts replay into identical states without OCR or position inference',async()=>{
 const facts:ObservationFact[]=[],replayed=new Map<string,ObservationExecutionState>();
 const grid=new ScanGrid(fact=>facts.push(fact));grid.begin(true);
 const origin:ObservationSource={sessionId:'scan-1',frameId:12,observationId:'31',captureOrder:480,
  captureTime:1.25,phase:'input',slot:4};
 const compare=()=>{
  while(replayedCount<facts.length){const fact=facts[replayedCount++];
   replayed.set(fact.source.observationId,reduceObservationExecution(replayed.get(fact.source.observationId),fact));}
  assert.deepEqual(observationExecutionSnapshot(replayed.values()),grid.executionSnapshot());
 };
 let replayedCount=0;
 grid.group(4,7,31,true,undefined,origin);compare();
 grid.group(5,8,32,true,undefined,{...origin,observationId:'32',slot:5,captureOrder:481});compare();
 grid.record(12);
 const first=grid.start(31);compare();assert.equal(grid.snapshot().recent!.reading,1);
 grid.stage(31,'deferred');compare();assert.equal(grid.snapshot().recent!.waiting,2);
 grid.finish(31,'read',first);compare();assert.equal(grid.snapshot().recent!.read,0);
 const retry=grid.start(31);compare();
 grid.finish(31,'read',retry);compare();
 grid.finish(32,'review');compare();
 grid.finish(32,'read');compare();
 assert.equal(grid.snapshot().recent!.read,2);
 assert.equal(grid.snapshot().inventory!.length,0,'read facts cannot manufacture row anchors');
 assert.equal(await hashObservationExecution(grid.executionSnapshot()),
  await hashObservationExecution(observationExecutionSnapshot(replayed.values())));
 const reverse=new Map<string,ObservationExecutionState>();
 for(const fact of [...facts].reverse())reverse.set(fact.source.observationId,
  reduceObservationExecution(reverse.get(fact.source.observationId),fact));
 assert.deepEqual(observationExecutionSnapshot(reverse.values()),grid.executionSnapshot());
});

test('callbacks retain original capture metadata and never publish ignored old completions',()=>{
 const facts:ObservationFact[]=[];const grid=new ScanGrid(fact=>facts.push(fact));grid.begin(true);
 const origin={sessionId:'capture',frameId:27,observationId:'10',captureOrder:400,
  captureTime:3.5,phase:'input' as const,slot:0};
 grid.group(0,1,10,true,1,origin);
 origin.frameId=99;origin.captureTime=99;
 const attempt=grid.start(10);grid.finish(10,'read',attempt);
 const count=facts.length;
 grid.finish(10,'review',attempt);
 grid.group(10,1,11,false,1);
 assert.equal(facts.length,count,'neither duplicate crops nor expired leases are new lifecycle facts');
 for(const fact of facts){assert.equal(fact.source.frameId,27);assert.equal(fact.source.captureTime,3.5);}
 grid.group(10,1,12,true,1,{...origin,observationId:'12',slot:10,phase:'input'});
 const freshCount=facts.length;
 grid.finish(10,'read');assert.equal(grid.start(10),undefined);
 assert.equal(facts.length,freshCount,'replaced observation jobs cannot publish current completion');
 assert.equal(grid.snapshot().cells[10].status,'waiting');
});

test('a replaced group keeps only the old running lease until its own completion without painting the newer crop',()=>{
 const facts:ObservationFact[]=[];const grid=new ScanGrid(fact=>facts.push(fact));grid.begin(true);
 grid.group(0,1,1,true);const old=grid.start(1);
 grid.group(0,1,2,true);const next=grid.start(2);
 const before=grid.snapshot();assert.equal(before.cells[0].status,'reading');
 grid.finish(1,'read',old);
 assert.equal(facts.at(-1)?.source.observationId,'1');assert.equal(facts.at(-1)?.kind,'read-finished');
 assert.deepEqual(grid.snapshot(),before,'an older lease ends its work, not the new cell');
 const count=facts.length;grid.finish(1,'review',old);grid.finish(1,'read');assert.equal(facts.length,count);
 grid.finish(2,'review',next);assert.equal(grid.snapshot().cells[0].status,'review');
 assert.equal(facts.at(-1)?.source.observationId,'2');
});

test('pruning display-only groups cannot orphan a running work lease',()=>{
 const facts:ObservationFact[]=[];const grid=new ScanGrid(fact=>facts.push(fact));grid.begin(true);
 grid.group(0,1,1,true);const old=grid.start(1);
 for(let trace=2;trace<2100;trace++)grid.group(0,trace,trace,true);
 assert.equal(grid.start(1),undefined,'old display group was pruned');
 grid.finish(1,'read',old);
 assert.equal(facts.at(-1)?.source.observationId,'1');assert.equal(facts.at(-1)?.kind,'read-finished');
 assert.equal(grid.snapshot().cells[0].status,'waiting');
});

test('reentrant start and finish callbacks cannot replace or delete a newer retry lease',()=>{
 let nested:number|undefined,reenterStart=true,reenterFinish=true;
 const grid=new ScanGrid(fact=>{
   if(fact.kind==='read-started'&&reenterStart){reenterStart=false;nested=grid.start(1);}
   else if(fact.kind==='read-finished'&&reenterFinish){reenterFinish=false;nested=grid.start(1);}
 });grid.begin(true);grid.group(0,1,1,true);
 const outer=grid.start(1);assert.notEqual(outer,nested);
 grid.finish(1,'read',outer);assert.equal(grid.snapshot().cells[0].status,'reading');
 grid.finish(1,'read',nested);assert.equal(grid.snapshot().cells[0].status,'reading','finish callback started the next retry');
 grid.finish(1,'review',nested);assert.equal(grid.snapshot().cells[0].status,'review');
});

test('unclosed replay reads have an explicit cap independent of display-cache pruning',()=>{
 const grid=new ScanGrid();grid.begin(true);
 let first:number|undefined;
 for(let trace=1;trace<=2048;trace++){
   grid.group(0,trace,trace,true);const lease=grid.start(trace);if(trace===1)first=lease;
 }
 grid.group(0,2049,2049,true);
 assert.throws(()=>grid.start(2049),/active read limit/);
 grid.finish(1,'read',first);assert.doesNotThrow(()=>grid.start(2049));
 grid.reset();grid.begin(true);grid.group(0,1,1,true);assert.doesNotThrow(()=>grid.start(1));
});

test('a throwing finish observer cannot retain a completed lease or finish it twice',()=>{
 let throws=true;const facts:ObservationFact[]=[];
 const grid=new ScanGrid(fact=>{facts.push(fact);if(fact.kind==='read-finished'&&throws){throws=false;throw Error('observer');}});
 grid.begin(true);grid.group(0,1,1,true);const lease=grid.start(1);
 assert.throws(()=>grid.finish(1,'read',lease),/observer/);assert.equal(grid.snapshot().cells[0].status,'read');
 const count=facts.length;grid.finish(1,'review',lease);assert.equal(facts.length,count);
});

test('untokened corrections use explicit new attempts while stage completion invalidates active leases',()=>{
 const facts:ObservationFact[]=[];const grid=new ScanGrid(fact=>facts.push(fact));grid.begin(true);
 grid.group(0,1,1,true,1);
 assert.deepEqual(facts[0].source,{sessionId:'grid',frameId:1,observationId:'1',captureOrder:1,captureTime:0,phase:'input',slot:0});
 grid.finish(1,'review');grid.finish(1,'read');
 assert.deepEqual(facts.map(fact=>fact.attemptId),[0,0,1]);
 const attempt=grid.start(1);grid.stage(1,'dropped');
 const count=facts.length;
 grid.finish(1,'read',attempt);assert.equal(facts.length,count);
 assert.equal(grid.snapshot().cells[0].status,'review');
 const state=grid.executionSnapshot().observations[0];
 assert.equal(state.attemptId,2);assert.equal(state.phase,'finished');
 assert.equal(state.status,'review');
});

test('bad source is rejected before existing confirmed grid state changes',()=>{
 const facts:ObservationFact[]=[];const grid=new ScanGrid(fact=>facts.push(fact));grid.begin(true);
 grid.group(0,1,1,true,1);grid.identify(1,'a');grid.finish(1,'review');grid.confirm(['a']);
 const previous=grid.snapshot(),count=facts.length;
 const origin={sessionId:'test',frameId:2,observationId:'2',captureOrder:2,captureTime:0,phase:'input' as const,slot:1};
 assert.throws(()=>grid.group(0,1,2,true,1,origin),/does not match/);
 assert.deepEqual(grid.snapshot(),previous);assert.equal(facts.length,count);
 assert.throws(()=>grid.group(0,1,2,true,1,{...origin,slot:0,captureTime:NaN}),/capture time/);
 assert.deepEqual(grid.snapshot(),previous);assert.equal(facts.length,count);
});

test('recent frame keeps all forty captured slots and receives late reads without row anchors',()=>{
 const grid=new ScanGrid();grid.begin(true);grid.viewport(35);
 grid.group(0,1,1,true);grid.cell(1,'empty');grid.cell(2,'review','툴팁 가림');
 grid.group(39,2,2,true);grid.record(7);
 const before=grid.snapshot(),receipt=before.recentFrame!;
 assert.equal(receipt.frame,7);assert.equal(receipt.cells.length,40);
 assert.deepEqual(receipt.cells.map(cell=>cell.status),[
  'waiting','empty','review',...Array.from({length:36},()=> 'unknown'),'waiting',
 ]);
 assert.equal(receipt.cells[2].reason,'툴팁 가림');
 assert.ok(receipt.cells.every(cell=>cell.row===undefined));
 assert.equal(before.inventory!.length,0);
 const attempt=grid.start(1);
 assert.equal(grid.snapshot().recentFrame!.cells[0].status,'reading');
 grid.finish(1,'read',attempt);grid.finish(2,'review');
 const finished=grid.snapshot();
 assert.equal(finished.recentFrame!.cells[0].status,'read');
 assert.equal(finished.recentFrame!.cells[39].status,'review');
 assert.equal(finished.recentFrame!.cells[1].status,'empty');
 assert.equal(finished.inventory!.length,0,'local completion cannot manufacture absolute positions');
 assert.equal(receipt.cells[0].status,'waiting','previous snapshots stay detached');
 finished.recentFrame!.cells[0].status='review';
 assert.equal(grid.snapshot().recentFrame!.cells[0].status,'read');
 grid.cell(1,'review','later acquisition mutation');
 assert.equal(grid.snapshot().recentFrame!.cells[1].status,'empty','record owns the captured slot copy');
});

test('middle start, large jumps and reverse scrolling never relocate a recent capture from liveTop',()=>{
 const grid=new ScanGrid();grid.geometry(55);grid.begin(true);grid.viewport(35);
 grid.group(0,1,1,true);grid.record(1);const first=grid.snapshot();
 for(const top of [43,52,35]){
  grid.liveViewport(top);const moved=grid.viewportSnapshot(first);
  assert.equal(moved.liveTop,top);assert.equal(moved.recentFrame,first.recentFrame);
  assert.equal(moved.recentFrame!.frame,1);assert.equal(moved.inventory!.length,0);
 }
 grid.begin(true);assert.equal(grid.snapshot().recentFrame,undefined);
 grid.viewport(43);grid.group(10,2,2,true);grid.record(2);
 grid.finish(1,'read');
 assert.equal(grid.snapshot().recentFrame!.frame,2);
 assert.equal(grid.snapshot().recentFrame!.cells[0].status,'unknown');
 assert.equal(grid.snapshot().recentFrame!.cells[10].status,'waiting');
 grid.begin(true);grid.viewport(35);grid.group(0,1,3,false);grid.record(3);
 const reverse=grid.snapshot();
 assert.equal(reverse.recentFrame!.frame,3);
 assert.equal(reverse.recentFrame!.cells[0].status,'read','duplicate input may reuse its actual prior read');
 assert.ok(reverse.recentFrame!.cells.every(cell=>cell.row===undefined));
 assert.equal(reverse.inventory!.length,0);
 grid.register(1,35);
 assert.equal(grid.snapshot().recentFrame!.cells[0].row,undefined,'late registration does not relabel the recent capture');
});

test('new acquisition and reused groups cannot mix an old recent frame with newer work',()=>{
 const grid=new ScanGrid();grid.begin(true);grid.group(4,1,1,true);grid.record(1);
 const oldAttempt=grid.start(1);
 grid.begin(true);grid.group(9,1,2,true);
 assert.equal(grid.snapshot().recentFrame,undefined,'a receipt is published only after record');
 grid.finish(1,'read',oldAttempt);grid.record(2);
 let current=grid.snapshot().recentFrame!;
 assert.equal(current.cells[4].status,'unknown');assert.equal(current.cells[9].status,'waiting');
 const currentAttempt=grid.start(2);grid.finish(1,'review');
 assert.equal(grid.snapshot().recentFrame!.cells[9].status,'reading');
 grid.finish(2,'read',currentAttempt);current=grid.snapshot().recentFrame!;
 assert.equal(current.cells[9].status,'read');
 grid.begin(false);assert.equal(grid.snapshot().recentFrame,undefined,'failed acquisition clears a previous receipt too');
});

test('sort and session reset discard recent placement while duplicate read evidence remains separate',()=>{
 const grid=new ScanGrid();grid.begin(true);grid.group(0,1,1,true);grid.record(1);grid.finish(1,'read');
 grid.resetPositions();grid.register(1,35);
 assert.equal(grid.snapshot().recentFrame,undefined);assert.equal(grid.snapshot().inventory!.length,0);
 grid.begin(true);grid.group(30,1,2,false);grid.record(2);
 assert.equal(grid.snapshot().recentFrame!.cells[30].status,'read');
 assert.equal(grid.snapshot().recentFrame!.cells[0].status,'unknown');
 grid.reset();assert.equal(grid.snapshot().recentFrame,undefined);
 grid.begin(true);grid.group(30,1,3,false);grid.record(3);
 assert.equal(grid.snapshot().recentFrame!.cells[30].status,'unknown','reset cannot reuse a previous session read');
});
