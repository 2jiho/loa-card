import {test} from 'node:test';
import assert from 'node:assert/strict';
import {observeInputWait,scanReadDetail} from '../src/features/card-scanner/ui/scan-read-detail';
import {createScanMonitorStore} from '../src/features/card-scanner/ui/scan-monitor-store';
import {ScanGrid} from '../src/features/card-scanner/session/scan-grid';

test('an established rescan or header instruction remains visible while cards are still pending',()=>{
  const base={phase:'capture' as const,remaining:15,estimate:null};
  assert.match(scanReadDetail({...base,gate:'latest-observations',stableGuidance:'latest-observations'}),/오래 걸리면/);
  assert.match(scanReadDetail({...base,gate:'occluded',stableGuidance:'occluded'}),/가려진/);
  assert.match(scanReadDetail({...base,gate:'header-unavailable',stableGuidance:'header-unavailable'}),/성장 탭/);
});

test('a stale, transient or disabled diagnostic does not show an actionable instruction',()=>{
  const base={phase:'capture' as const,remaining:15,estimate:null};
  assert.equal(scanReadDetail({...base,gate:'occluded'}),'');
  assert.equal(scanReadDetail({...base,gate:'inventory',stableGuidance:'occluded'}),'');
  assert.equal(scanReadDetail({...base,stableGuidance:'occluded'}),'');
  assert.equal(scanReadDetail({...base,gate:'latest-observations',stableGuidance:'occluded'}),'');
});

test('a stable unresolved gate waits for ongoing reads before requesting another capture',()=>{
  const base={phase:'capture' as const,remaining:1,estimate:null,processing:true};
  for(const gate of ['latest-observations','occluded'] as const){
    const detail=scanReadDetail({...base,gate,stableGuidance:gate});
    assert.match(detail,/다시 보고 있어요/);assert.doesNotMatch(detail,/(보여|넘겨) 주세요/);
    assert.match(scanReadDetail({...base,gate,stableGuidance:gate,processing:false}),/(보여|넘겨) 주세요/);
  }
  assert.equal(scanReadDetail({...base,gate:'input-dropped',stableGuidance:'occluded'}),'');
});

test('recovery and remaining-time details stay distinct from live capture diagnostics',()=>{
  const diagnostic={gate:'occluded' as const,stableGuidance:'occluded' as const,remaining:10,estimate:null};
  assert.match(scanReadDetail({...diagnostic,phase:'recovery',recoveryPercent:25}),/받아 둔 화면 다시 보는 중 25%/);
  assert.match(scanReadDetail({phase:'reading',remaining:10,estimate:{low:10,high:20}}),/남은 시간 약 10초~20초/);
  assert.match(scanReadDetail({phase:'capture',remaining:0,estimate:null,gate:'input'}),/마저 읽고/);
});

test('a sustained input gate offers a neutral instruction while other gates and recovery stay distinct',()=>{
  const base={phase:'capture' as const,remaining:15,estimate:null};
  assert.equal(scanReadDetail({...base,gate:'input',inputWaitGuidance:true}),'화면을 잠시 멈춰 주세요.');
  assert.equal(scanReadDetail({...base,gate:'input',inputWaitGuidance:true,queued:3}),'읽을 화면이 밀려 있어요. 스크롤을 잠시 멈춰 주세요.');
  for(const queued of [0,-1,NaN,Infinity])assert.equal(scanReadDetail({...base,gate:'input',inputWaitGuidance:true,queued}),'화면을 잠시 멈춰 주세요.');
  assert.equal(scanReadDetail({...base,gate:'input'}),'');
  assert.equal(scanReadDetail({...base,gate:'inventory',inputWaitGuidance:true}),'');
  assert.match(scanReadDetail({...base,phase:'recovery',recoveryPercent:25,gate:'input',inputWaitGuidance:true}),/받아 둔 화면 다시 보는 중 25%/);
});

test('a dropped-input gate leaves its restart guidance to the persistent alert',()=>{
 const base={phase:'capture' as const,remaining:0,estimate:null,gate:'input-dropped' as const};
 assert.equal(scanReadDetail(base),'');
 assert.equal(scanReadDetail({...base,lagGuidance:true,inputWaitGuidance:true}),'');
});

test('lag and input-wait guidance share one slot and actionable evidence has priority',()=>{
  const base={phase:'capture' as const,remaining:15,estimate:null};
  assert.equal(scanReadDetail({...base,gate:'input',inputWaitGuidance:true,lagGuidance:true}),
    '카드 목록이 따라올 때까지 잠시 스크롤을 멈춰 주세요.');
  assert.match(scanReadDetail({...base,gate:'occluded',stableGuidance:'occluded',lagGuidance:true}),/가려진/);
  assert.match(scanReadDetail({...base,phase:'recovery',recoveryPercent:25,lagGuidance:true}),/받아 둔 화면 다시 보는 중 25%/);
});

test('input advice waits 1.75 seconds, cleans up and fences a late callback after A to B to A',()=>{
  let count=0,cancelled=0;
  const callbacks:Array<()=>void>=[],delays:number[]=[];
  const schedule=(callback:()=>void,delay:number)=>{callbacks.push(callback);delays.push(delay);return ()=>{cancelled++;};};
  const first=observeInputWait('input',()=>{count++;},schedule);
  assert.deepEqual(delays,[1750]);assert.equal(count,0);
  first();
  const other=observeInputWait('inventory',()=>{count++;},schedule);
  other();assert.equal(callbacks.length,1);
  observeInputWait('input',()=>{count++;},schedule);
  assert.deepEqual(delays,[1750,1750]);
  callbacks[0]();assert.equal(count,0,'a callback queued before cancellation is fenced');
  callbacks[1]();callbacks[1]();assert.equal(count,1,'the current observation can fire only once');
  assert.equal(cancelled,1);
});

test('the monitor preserves a distinct diagnostic object for batched input to other to input transitions',()=>{
  const store=createScanMonitorStore(),grid=new ScanGrid();
  store.publish({grid:grid.snapshot(),currentRunRead:1,expected:2,capacity:450,interrupted:undefined});
  const common={expected:2,identities:2,names:2,fields:2,unresolved:0,inputPending:true,headerAvailable:true,
    headerAttempts:0,headerMismatches:0,headerErrors:0};
  store.publishAutoCompletion({...common,gate:'input'});
  const first=store.getSnapshot()!.autoCompletionDiagnostic;
  store.publishAutoCompletion({...common,gate:'inventory'});
  store.publishAutoCompletion({...common,gate:'input'});
  const last=store.getSnapshot()!.autoCompletionDiagnostic;
  assert.equal(first?.gate,'input');assert.equal(last?.gate,'input');assert.notEqual(first,last);
  store.publish({grid:grid.snapshot(),currentRunRead:1,expected:2,capacity:450,interrupted:undefined});
  assert.equal(store.getSnapshot()!.autoCompletionDiagnostic,last,'unrelated feedback does not reset the timer');
});
