import test from 'node:test';
import assert from 'node:assert/strict';
import {createScanMonitorStore} from '../src/features/card-scanner/scan-monitor-store';
import {ScanGrid} from '../src/features/card-scanner/scan-grid';

test('monitor updates synchronously before any batched result view and retains only display data',()=>{
 const store=createScanMonitorStore(),grid=new ScanGrid();let calls=0;
 const unsubscribe=store.subscribe(()=>calls++);
 grid.liveViewport(1);
 const next={grid:grid.snapshot(),currentRunRead:20,expected:393,capacity:450,cards:['pixels'],unidentified:['private crops']};
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
