import test from 'node:test';
import assert from 'node:assert/strict';
import {createScanMonitorStore,projectScanMonitorState} from '../src/features/card-scanner/scan-monitor-store';
import {ScanGrid} from '../src/features/card-scanner/scan-grid';
import {scanMonitorOutcome} from '../src/features/card-scanner/scan-monitor-outcome';
import type {ScanMonitorState} from '../src/features/card-scanner/scan-monitor-store';

test('monitor updates synchronously before any batched result view and retains only display data',()=>{
 const store=createScanMonitorStore(),grid=new ScanGrid();let calls=0;
 const unsubscribe=store.subscribe(()=>calls++);
 grid.liveViewport(1);
 const next={grid:grid.snapshot(),currentRunRead:20,expected:393,capacity:450,cards:['pixels'],unidentified:[{image:'private crops',time:1,pending:false}]};
 store.publish(next);assert.equal(calls,1);
 assert.equal(store.getSnapshot()!.grid!.liveTop,1);
 assert.equal('cards' in store.getSnapshot()!,false);
 store.publish(next);assert.equal(calls,1,'unchanged snapshots need no render');
 assert.equal(grid.liveViewport(19),true);
 store.publish({...next,grid:grid.snapshot()});
 assert.equal(store.getSnapshot()!.grid!.liveTop,19);
 assert.equal(calls,2);assert.equal(grid.liveViewport(19),false);
 assert.equal(grid.liveViewport(undefined),true);
 store.publish({...next,grid:grid.snapshot()});assert.equal(store.getSnapshot()!.grid!.liveTop,undefined);
 store.clear();assert.equal(store.getSnapshot(),null);
 unsubscribe();store.publish(next);assert.equal(calls,4);
});

function snapshot():ScanMonitorState {
 return {currentRunRead:1,expected:394,capacity:450,interrupted:undefined,queued:39,activeReadings:0,unresolvedCount:0,hasInput:true,grid:{located:true,totalRows:55,estimatedTop:1,liveTop:1,liveTracking:true,
  cells:Array.from({length:40},(_,i)=>({status:i===0?'read':'waiting',row:Math.floor(i/10)+1})),
  inventory:Array.from({length:550},(_,i)=>({status:i===0?'read':'unknown',row:Math.floor(i/10)+1})),
  recent:{captured:40,read:1,waiting:39,review:0},
  recentFrame:{frame:1,cells:Array.from({length:40},(_,i)=>({status:i===0?'read':'waiting'}))}}};
}

test('equivalent cloned grid values preserve snapshots without extra notifications',()=>{
 const store=createScanMonitorStore();let calls=0;store.subscribe(()=>calls++);
 const input=snapshot();store.publish(input);
 const first=store.getSnapshot();
 for(let i=0;i<100;i++)store.publish(structuredClone(input));
 assert.equal(calls,1);assert.equal(store.getSnapshot(),first);
 assert.equal(store.getSnapshot()!.grid!.inventory,first!.grid!.inventory);
});

test('a newer unresolved field revokes green immediately and shares only unchanged cells',()=>{
 const store=createScanMonitorStore();let calls=0;store.subscribe(()=>calls++);
 const input=snapshot(),original=structuredClone(input);store.publish(input);
 const previous=store.getSnapshot()!,changed=structuredClone(input);
 changed.currentRunRead=0;
 changed.grid!.inventory![0]={status:'review',row:1,reason:'최신 각성·장수 확인'};
 changed.grid!.cells[0]={status:'review',row:1,reason:'최신 각성·장수 확인'};
 changed.grid!.recent={captured:40,read:0,waiting:39,review:1};
 store.publish(changed);
 const current=store.getSnapshot()!;
 assert.equal(calls,2);assert.equal(current.currentRunRead,0);
 assert.equal(current.grid!.inventory![0].status,'review');
 assert.equal(current.grid!.recent!.review,1);
 assert.notEqual(current.grid!.inventory,previous.grid!.inventory);
 assert.notEqual(current.grid!.inventory![0],previous.grid!.inventory![0]);
 for(let i=1;i<550;i++)assert.equal(current.grid!.inventory![i],previous.grid!.inventory![i]);
 assert.deepEqual(input,original,'sharing cannot mutate an older snapshot');
 store.publish(structuredClone(changed));assert.equal(calls,2);
});

test('reason, spatial, recent and header-only changes cannot be suppressed',()=>{
 const changes:((state:ScanMonitorState)=>void)[]=[
  state=>{state.grid!.inventory![0].reason='위치 근거 변경';},
  state=>{state.grid!.inventory![0].row=2;},
  state=>{state.grid!.cells[0].status='review';},
  state=>{state.grid!.located=false;},state=>{state.grid!.totalRows=54;},
  state=>{state.grid!.estimatedTop=2;},state=>{state.grid!.liveTop=2;},
  state=>{state.grid!.liveTracking=false;},state=>{state.grid!.recent!.captured=30;},
  state=>{state.grid!.recent!.waiting=30;},state=>{state.grid!.recent!.reading=1;},state=>{state.grid!.recent=undefined;},
  state=>{state.grid!.recentFrame!.frame=2;},state=>{state.grid!.recentFrame!.cells[1].status='reading';},
  state=>{state.grid!.recentFrame!.cells[1].reason='가림';},state=>{state.grid!.recentFrame=undefined;},
  state=>{state.grid!.inventory!.pop();},state=>{state.grid!.inventory=undefined;},
  state=>{state.currentRunRead=2;},state=>{state.expected=393;},state=>{state.capacity=550;},
  state=>{state.queued=38;},state=>{state.activeReadings=1;},
  state=>{state.unresolvedCount=14;},state=>{state.unresolvedFieldChanges=2;},state=>{state.hasInput=false;},
  state=>{state.interrupted='stalled';},state=>{state.grid=undefined;},
 ];
 for(const change of changes){
  const store=createScanMonitorStore();let calls=0;store.subscribe(()=>calls++);
  const input=snapshot();store.publish(input);
  const next=structuredClone(input);change(next);store.publish(next);
  assert.equal(calls,2);assert.deepEqual(store.getSnapshot(),next);
 }
});

test('viewport-only and count-only updates keep all card marker references',()=>{
 const store=createScanMonitorStore(),first=snapshot();store.publish(first);
 const previous=store.getSnapshot()!;
 const moved=structuredClone(first);moved.grid!.liveTop=37;store.publish(moved);
 const viewport=store.getSnapshot()!;
 assert.equal(viewport.grid!.inventory,previous.grid!.inventory);
 assert.equal(viewport.grid!.cells,previous.grid!.cells);
 assert.equal(viewport.grid!.recent,previous.grid!.recent);
 assert.equal(viewport.grid!.recentFrame,previous.grid!.recentFrame);
 const counted=structuredClone(moved);counted.currentRunRead=2;store.publish(counted);
 assert.equal(store.getSnapshot()!.grid,viewport.grid);
 store.clear();assert.equal(store.getSnapshot(),null);
 store.publish(structuredClone(first));assert.deepEqual(store.getSnapshot(),first);
});

test('reading starts publish immediately without claiming another completed card',()=>{
 const store=createScanMonitorStore(),initial=snapshot();let calls=0;store.subscribe(()=>calls++);
 store.publish(initial);
 const before=store.getSnapshot()!,started=structuredClone(initial);
 started.queued=38;started.activeReadings=1;
 started.grid!.recent={captured:40,read:1,waiting:38,reading:1,review:0};
 started.grid!.cells[1]={status:'reading',row:1};
 started.grid!.inventory![1]={status:'reading',row:1};
 store.publish(started);
 const reading=store.getSnapshot()!;
 assert.equal(calls,2);assert.equal(reading.currentRunRead,1);
 assert.equal(reading.activeReadings,1);assert.equal(reading.grid!.recent!.reading,1);
 assert.equal(reading.grid!.inventory![1].status,'reading');
 assert.equal(reading.grid!.inventory![2],before.grid!.inventory![2]);
 const finished=structuredClone(started);
 finished.activeReadings=0;finished.currentRunRead=2;
 finished.grid!.recent={captured:40,read:2,waiting:38,reading:0,review:0};
 finished.grid!.cells[1]={status:'read',row:1};
 finished.grid!.inventory![1]={status:'read',row:1};
 store.publish(finished);
 assert.equal(calls,3);assert.equal(store.getSnapshot()!.currentRunRead,2);
 assert.equal(store.getSnapshot()!.grid!.inventory![1].status,'read');
});

test('background readers notify even outside the recent view and absent counts behave as zero',()=>{
 const store=createScanMonitorStore(),legacy=snapshot();let calls=0;store.subscribe(()=>calls++);
 delete legacy.queued;delete legacy.activeReadings;
 store.publish(legacy);
 const first=store.getSnapshot()!,zero=structuredClone(legacy);
 zero.queued=0;zero.activeReadings=0;zero.grid!.recent!.reading=0;
 store.publish(zero);assert.equal(calls,1);assert.equal(store.getSnapshot(),first);
 store.publish({...zero,queued:4,activeReadings:2});
 assert.equal(calls,2);assert.equal(store.getSnapshot()!.activeReadings,2);
 assert.equal(store.getSnapshot()!.grid,first.grid,'a background reader does not repaint the recent view');
 assert.equal(store.getSnapshot()!.currentRunRead,first.currentRunRead);
 store.publish({...zero,queued:4,activeReadings:0});
 assert.equal(calls,3);assert.equal(store.getSnapshot()!.activeReadings,0);
});

test('recent frame-only changes notify immediately without repainting the absolute map',()=>{
 const store=createScanMonitorStore(),initial=snapshot();let calls=0;store.subscribe(()=>calls++);
 store.publish(initial);const before=store.getSnapshot()!,started=structuredClone(initial);
 started.grid!.recentFrame!.cells[1].status='reading';store.publish(started);
 const reading=store.getSnapshot()!;
 assert.equal(calls,2);assert.equal(reading.currentRunRead,before.currentRunRead);
 assert.equal(reading.grid!.inventory,before.grid!.inventory);assert.equal(reading.grid!.cells,before.grid!.cells);
 assert.notEqual(reading.grid!.recentFrame,before.grid!.recentFrame);
 assert.notEqual(reading.grid!.recentFrame!.cells[1],before.grid!.recentFrame!.cells[1]);
 assert.equal(reading.grid!.recentFrame!.cells[0],before.grid!.recentFrame!.cells[0]);
 assert.equal(before.grid!.recentFrame!.cells[1].status,'waiting');
 store.publish(structuredClone(started));assert.equal(calls,2);
 const replaced=structuredClone(started);replaced.grid!.recentFrame!.frame=2;store.publish(replaced);
 assert.equal(calls,3);assert.equal(store.getSnapshot()!.grid!.recentFrame!.frame,2);
 assert.equal(store.getSnapshot()!.grid!.recentFrame!.cells,reading.grid!.recentFrame!.cells,'a new receipt still shares unchanged markers');
 const cleared=structuredClone(replaced);delete cleared.grid!.recentFrame;store.publish(cleared);
 assert.equal(calls,4);assert.equal(store.getSnapshot()!.grid!.recentFrame,undefined);
 store.publish(structuredClone(cleared));assert.equal(calls,4);
 store.publish(replaced);assert.equal(calls,5);
 assert.deepEqual(store.getSnapshot()!.grid!.recentFrame,replaced.grid!.recentFrame);
});

test('raw state projects unresolved counts and input presence without retaining diagnostic images or sampled counters',()=>{
 const store=createScanMonitorStore();let calls=0;store.subscribe(()=>calls++);
 const raw={...snapshot(),sampled:1,unidentified:[{image:'private crop one',time:1,pending:false}],cards:['private inventory']};
 delete raw.hasInput;delete raw.unresolvedCount;
 store.publish(raw);const first=store.getSnapshot()!;
 assert.equal(first.unresolvedCount,1);assert.equal(first.hasInput,true);
 for(const key of ['sampled','unidentified','cards'])assert.equal(key in first,false);
 assert.doesNotMatch(JSON.stringify(first),/private crop|private inventory/);
 store.publish({...raw,sampled:100,unidentified:[{image:'different private crop',time:2,pending:true}]});
 assert.equal(calls,1,'same input-present boolean and unresolved count cannot cause per-frame rerenders');assert.equal(store.getSnapshot(),first);
 store.publish({...raw,unidentified:[...raw.unidentified,{image:'another private crop',time:3,pending:false}]});
 assert.equal(calls,2);assert.equal(store.getSnapshot()!.unresolvedCount,2);assert.equal(first.unresolvedCount,1);
 const projected=projectScanMonitorState({...raw,sampled:0,unidentified:[],currentRunRead:0});
 assert.equal(projected.hasInput,false);assert.equal(projected.unresolvedCount,0);
 store.publish(projected);assert.equal(calls,3);assert.equal(store.getSnapshot()!.hasInput,false);
});

test('changed-field-only feedback publishes immediately and survives image-free projection',()=>{
 const store=createScanMonitorStore();let calls=0;store.subscribe(()=>calls++);
 const ready={...snapshot(),currentRunRead:394,queued:0,unidentified:[],unresolvedFieldChanges:0};
 store.publish(ready);const original=store.getSnapshot();
 store.publish({...ready,unresolvedFieldChanges:1});
 const current=store.getSnapshot()!;
 assert.equal(calls,2);assert.equal(current.unresolvedFieldChanges,1);assert.equal(current.grid,original!.grid);
 assert.equal('unidentified' in current,false);
 assert.equal(scanMonitorOutcome(current,{busy:false,sharing:false}).kind,'review');
 store.publish({...ready,unresolvedFieldChanges:1});assert.equal(calls,2);
 store.publish(ready);assert.equal(calls,3);
 assert.equal(scanMonitorOutcome(store.getSnapshot(),{busy:false,sharing:false}).kind,'complete');
 const malformed=projectScanMonitorState({...ready,unresolvedFieldChanges:Infinity});
 assert.equal(malformed.unresolvedFieldChanges,undefined);assert.equal(malformed.unresolvedFieldChangesUnavailable,true);
 store.publish(malformed);assert.equal(scanMonitorOutcome(store.getSnapshot(),{busy:false,sharing:false}).kind,'review');
});
