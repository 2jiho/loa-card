import test from 'node:test';
import assert from 'node:assert/strict';
import {ScanGrid,gridReady,isLockedInventorySlot} from '../src/features/card-scanner/scan-grid';

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
