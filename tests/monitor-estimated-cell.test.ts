import test from 'node:test';
import assert from 'node:assert/strict';
import {ScanGrid} from '../src/features/card-scanner/session/scan-grid';
import {estimatedMonitorCell,projectMonitorCell} from '../src/features/card-scanner/ui/monitor-estimated-cell';
import {createScanMonitorStore} from '../src/features/card-scanner/ui/scan-monitor-store';
import {applyScanGridCommand,recordScanGrid,hashScanGridReplay,scanGridReplaySnapshot} from '../src/features/card-scanner/session/scan-grid-command';

test('middle capture projects actual work to only its frozen hinted location',()=>{
 const grid=new ScanGrid();grid.geometry(55);grid.begin(true);grid.viewport(26);grid.liveViewport(26);
 grid.group(0,101,201,true);grid.record(1);
 let snapshot=grid.snapshot();assert.equal(snapshot.recentFrame!.capturedTop,26);
 assert.equal(estimatedMonitorCell(snapshot,250,450,394)?.status,'waiting');
 assert.equal(snapshot.inventory!.length,0,'projection must not register a location');
 const token=grid.start(201);snapshot=grid.snapshot();
 assert.equal(estimatedMonitorCell(snapshot,250,450,394)?.status,'reading');
 grid.finish(201,'read',token);snapshot=grid.snapshot();
 assert.equal(estimatedMonitorCell(snapshot,250,450,394)?.status,'read');
 assert.equal(estimatedMonitorCell(snapshot,240,450,394),undefined);
 assert.equal(snapshot.inventory!.length,0);
 // One change to a new viewport invalidates, even on return to the old row.
 grid.liveViewport(27);let moved=grid.viewportSnapshot(snapshot);
 assert.equal(moved.recentFrame!.capturedTop,undefined);
 assert.equal(estimatedMonitorCell(moved,250,450,394),undefined);
 grid.liveViewport(26);moved=grid.viewportSnapshot(moved);
 assert.equal(estimatedMonitorCell(moved,250,450,394),undefined);
});

test('missing and contradictory hints, locked slots, and authoritative positions never become guesses',()=>{
 const grid=new ScanGrid();grid.begin(true);grid.viewport(51);grid.group(0,1,1,true);grid.record(1);
 grid.liveViewport(51);
 assert.equal(estimatedMonitorCell(grid.snapshot(),500,550,394),undefined,'a hint captured without live tracking cannot be promoted later');
 grid.begin(true);grid.liveViewport(51);grid.group(0,1,1,false);grid.record(1);
 assert.equal(estimatedMonitorCell(grid.snapshot(),500,450,394),undefined);
 grid.begin(true);grid.viewport(51);grid.group(0,1,1,false);grid.record(2);
 assert.equal(estimatedMonitorCell(grid.snapshot(),500,450,394),undefined,'locked slot wins');
 assert.equal(estimatedMonitorCell(grid.snapshot(),500,550,394)?.status,'waiting');
 grid.register(2,51);
 const positioned=projectMonitorCell(grid.snapshot(),500,550,394,true);
 assert.equal(positioned.cell.status,'waiting','positioned status remains the main cell');
 assert.equal(positioned.estimate?.status,'waiting','current estimated work remains visible separately');
 const lease=grid.start(1);const reading=projectMonitorCell(grid.snapshot(),500,550,394,true);
 assert.equal(reading.cell.status,'reading');assert.equal(reading.estimate?.status,'reading');
 grid.finish(1,'read',lease);
 grid.begin(true);grid.viewport(10);grid.group(0,2,2,true);grid.record(3);
 assert.equal(grid.snapshot().recentFrame!.capturedTop,undefined,'capture does not inherit a conflicting live viewport');
});

test('store publishes hint changes and old v1 hashes intentionally exclude the new display hint',async()=>{
 const grid=new ScanGrid(),store=createScanMonitorStore();let notified=0;store.subscribe(()=>notified++);
 grid.begin(true);grid.viewport(20);grid.liveViewport(20);grid.group(0,1,1,true);grid.record(1);
 const snapshot=grid.snapshot(),input={grid:snapshot,currentRunRead:0,expected:394,capacity:450,interrupted:undefined};
 store.publish(input);assert.equal(notified,1);
 grid.liveViewport(21);store.publish({...input,grid:grid.viewportSnapshot(snapshot)});
 assert.equal(notified,2);assert.equal(store.getSnapshot()!.grid!.recentFrame!.capturedTop,undefined);
 const replay=scanGridReplaySnapshot(grid);
 const hintOnly=structuredClone(replay);hintOnly.grid.recentFrame!.capturedTop=20;
 assert.equal(await hashScanGridReplay(replay),await hashScanGridReplay(hintOnly));
});


test('command replay reproduces the projected position and real work state without OCR',()=>{
 const commands:unknown[]=[],source=new ScanGrid(), replay=new ScanGrid();
 const live=recordScanGrid(source,command=>{commands.push(command);applyScanGridCommand(replay,JSON.parse(JSON.stringify(command)));});
 live.begin(true);live.viewport(24);live.liveViewport(24);live.group(4,11,12,true);live.record(1);
 assert.equal(estimatedMonitorCell(live.snapshot(),234,450,394)?.status,'waiting');
 assert.equal(estimatedMonitorCell(replay.snapshot(),234,450,394)?.status,'waiting');
 const lease=live.start(12);assert.equal(estimatedMonitorCell(replay.snapshot(),234,450,394)?.status,'reading');
 live.finish(12,'read',lease);assert.equal(estimatedMonitorCell(replay.snapshot(),234,450,394)?.status,'read');
 live.liveViewport(25);assert.equal(estimatedMonitorCell(replay.snapshot(),234,450,394),undefined);
 live.liveViewport(24);assert.equal(estimatedMonitorCell(replay.snapshot(),234,450,394),undefined);
 assert.ok(commands.length>0);
});


test('anchored completed marker and newly reading estimate are both represented',()=>{
 const grid=new ScanGrid();grid.begin(true);grid.liveViewport(20);grid.viewport(20);
 grid.group(0,1,1,true,20);const first=grid.start(1);grid.finish(1,'read',first);
 grid.group(0,2,2,true);grid.record(1);grid.start(2);
 const projection=projectMonitorCell(grid.snapshot(),190,450,394,true);
 assert.equal(projection.cell.status,'read');
 assert.equal(projection.estimate?.status,'reading');
 assert.equal(projection.estimatedPrimary,false);
});
