import {test} from 'node:test';
import assert from 'node:assert/strict';
import {scannerFeedbackState} from '../src/features/card-scanner/ui/scanner-feedback-state';
import {createScanMonitorStore} from '../src/features/card-scanner/ui/scan-monitor-store';
import {scanMonitorOutcome} from '../src/features/card-scanner/session/scan-monitor-outcome';
import {ScanGrid} from '../src/features/card-scanner/session/scan-grid';

test('actual scanner progress snapshot retains and clears header conflict alongside other completion facts',()=>{
  const grid=new ScanGrid().snapshot(),store=createScanMonitorStore(),ended={busy:false,sharing:false};
  let state={expected:1,capacity:450,interrupted:undefined,unresolvedFieldChanges:0,
    queued:0,activeReadings:0,droppedFrames:0,sampled:1,headerConflict:false};
  let notices=0;store.subscribe(()=>notices++);
  const immediate=()=>scannerFeedbackState(state,grid,1,0);
  const full=()=>({...state,grid,currentRunRead:1,unresolvedObservations:0,unidentified:[]});

  store.publish(full());
  assert.equal(scanMonitorOutcome(store.getSnapshot(),ended).kind,'complete');
  state={...state,headerConflict:true};
  store.publish(immediate());
  assert.equal(store.getSnapshot()!.headerConflict,true);
  assert.equal(scanMonitorOutcome(store.getSnapshot(),ended).kind,'review');
  store.publish(full());
  store.publish(immediate());
  assert.equal(store.getSnapshot()!.headerConflict,true,'subsequent real progress snapshots must not erase conflict');
  assert.equal(scanMonitorOutcome(store.getSnapshot(),ended).kind,'review');
  state={...state,headerConflict:false};
  store.publish(immediate());
  assert.notEqual(store.getSnapshot()!.headerConflict,true);
  assert.equal(scanMonitorOutcome(store.getSnapshot(),ended).kind,'complete');
  store.publish(full());store.publish(immediate());
  assert.equal(scanMonitorOutcome(store.getSnapshot(),ended).kind,'complete');
  assert.equal(notices,3,'unchanged full and progress snapshots should not cause a redundant redraw');
});
