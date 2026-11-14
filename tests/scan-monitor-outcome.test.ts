import test from 'node:test';
import assert from 'node:assert/strict';
import {scanHasInputWarnings,scanMonitorInputFacts,scanMonitorOutcome,scanMonitorRecentCounts} from '../src/features/card-scanner/session/scan-monitor-outcome';
import {csvInventoryState} from '../src/inventory-csv';

test('recent visible cells never count unknown or empty slots as queued work',()=>{
 const cells=Array.from({length:40},(_,i)=>({status:i<18?'read' as const:'unknown' as const}));
 const grid={recentFrame:{frame:436,cells}};
 assert.deepEqual(scanMonitorRecentCounts(grid),{captured:40,read:18,unknown:22,waiting:0,reading:0,review:0,empty:0});
 assert.equal(scanMonitorRecentCounts(undefined),null);
 assert.equal(scanMonitorRecentCounts({}),null);
});

test('recent counts follow exact waiting, active, completed and rejected transitions',()=>{
 const statuses=['unknown','waiting','reading','read','review','empty'] as const;
 for(const status of statuses){
  const counts=scanMonitorRecentCounts({recentFrame:{frame:1,cells:[{status}]}})!;
  assert.equal(counts[status],1);
  assert.equal(Object.entries(counts).filter(([key])=>key!=='captured').reduce((sum,[,value])=>sum+value,0),1);
 }
});

const ended={busy:false,sharing:false};
const complete={currentRunRead:385,expected:385,unresolvedCount:0,droppedFrames:0,hasInput:true,queued:0,activeReadings:0};

test('a header conflict keeps an otherwise fully read inventory in review',()=>{
 const conflict={...complete,headerConflict:true};
 assert.equal(scanHasInputWarnings(conflict),true);
 const outcome=scanMonitorOutcome(conflict,ended);
 assert.equal(outcome.kind,'review');
 assert.match(outcome.message,/보관함 수량을 확실히 읽지 못했어요/);
 assert.match(outcome.detail,/보관함 수량을 확실히 읽지 못함/);
 const projected=scanMonitorInputFacts(conflict);
 assert.equal(projected.headerConflict,true);
 assert.equal(scanMonitorOutcome({...conflict,headerConflict:false},ended).kind,'complete');
});

test('one missing card keeps an ended scan in review with its map and a re-show request',()=>{
 const outcome=scanMonitorOutcome({...complete,currentRunRead:384},ended);
 assert.equal(outcome.kind,'review');assert.equal(outcome.header,'다시 볼 곳 있음');assert.equal(outcome.missingCount,1);
 assert.equal(outcome.showGrid,true);assert.match(outcome.detail,/이름 못 읽음 1종/);assert.match(outcome.message,/다시 스캔/);
});

test('live monitor separates uncollected names from cards that need review',()=>{
 const outcome=scanMonitorOutcome({...complete,expected:384,currentRunRead:357,currentRunNames:361,review:5},ended);
 assert.equal(outcome.kind,'review');assert.equal(outcome.missingCount,23);
 assert.match(outcome.detail,/이름 못 읽음 23종/);assert.match(outcome.detail,/값 못 읽음 5종/);
 assert.doesNotMatch(outcome.detail,/27종/);
});

test('equal card counts cannot hide unresolved inputs or call a full scan complete',()=>{
  const outcome=scanMonitorOutcome({...complete,unresolvedCount:14},ended);
  assert.equal(outcome.kind,'review');assert.equal(outcome.header,'알아보지 못한 화면');assert.equal(outcome.unresolvedCount,14);assert.equal(outcome.missingCount,0);
  assert.equal(outcome.showGrid,true);assert.match(outcome.detail,/화면 14개/);assert.doesNotMatch(outcome.detail,/14종/);
  assert.match(outcome.message,/카드 수는 맞지만 알아보지 못한 화면/);
});

test('equal counts and no unidentified crops still show unresolved changed-field proof',()=>{
 const state={...complete,unresolvedFieldChanges:2};
 const outcome=scanMonitorOutcome(state,ended);
 assert.equal(outcome.kind,'review');assert.equal(outcome.missingCount,0);assert.equal(outcome.unresolvedCount,0);
 assert.equal(outcome.unresolvedFieldChanges,2);assert.match(outcome.detail,/다시 볼 화면 있음/);
 assert.equal(scanMonitorOutcome({...state,hasInput:false},ended).kind,'review','restored unresolved proof is not hidden by an idle input clock');
 assert.equal(scanMonitorOutcome({...state,unresolvedFieldChanges:0},ended).kind,'complete');
 assert.equal(scanMonitorOutcome({...state,unresolvedFieldChanges:NaN},ended).kind,'review');
 assert.match(scanMonitorOutcome({...state,unresolvedFieldChanges:NaN},ended).detail,/다시 볼 화면 수를 모름/);
});

test('known zero unresolved input labels reading complete without claiming scan verification',()=>{
 const outcome=scanMonitorOutcome(complete,ended);
 assert.equal(outcome.kind,'complete');assert.equal(outcome.message,'모든 카드를 읽었어요');assert.equal(outcome.showGrid,true);
 assert.doesNotMatch(outcome.message,/스캔 완료|검증/);
 assert.equal(scanMonitorOutcome({...complete,queued:1},ended).kind,'review');
 assert.equal(scanMonitorOutcome({...complete,activeReadings:1},ended).kind,'review');
});

test('interruption remains visible even before any card or frame was collected',()=>{
 const outcome=scanMonitorOutcome({currentRunRead:0,expected:null,hasInput:false,unresolvedCount:0,interrupted:'cancelled'},ended);
 assert.equal(outcome.kind,'interrupted');assert.equal(outcome.header,'멈춤');assert.equal(outcome.showGrid,true);
 assert.match(outcome.detail,/다시 스캔/);assert.doesNotMatch(outcome.message,/공유를 시작/);
 assert.equal(scanMonitorOutcome({...complete,interrupted:'failed'},ended).kind,'interrupted');
});

test('unknown totals and unknown unresolved evidence never manufacture reading completion',()=>{
 const unknownTotal=scanMonitorOutcome({...complete,expected:null},ended);
 assert.equal(unknownTotal.kind,'review');assert.equal(unknownTotal.missingCount,null);assert.match(unknownTotal.message,/보관함 수량/);
 const {unresolvedCount:_,...withoutProof}=complete;assert.equal(scanMonitorOutcome(withoutProof,ended).kind,'review');
 assert.equal(scanMonitorOutcome({...complete,currentRunRead:386},ended).kind,'review');
 assert.equal(scanMonitorOutcome({...complete,currentRunRead:NaN},ended).kind,'review');
});

test('idle state does not turn restored inventory counts into current-input proof',()=>{
 assert.equal(scanMonitorOutcome(null,ended).kind,'idle');
 const outcome=scanMonitorOutcome({...complete,hasInput:false},ended);
 assert.equal(outcome.kind,'idle');assert.equal(outcome.showGrid,false);assert.equal(outcome.header,'대기');
 assert.match(outcome.message,/화면 공유를 시작/);
});

test('resumed sharing and active readers override an old ended or interrupted display',()=>{
 for(const state of [{...complete,currentRunRead:384},{...complete,unresolvedCount:14},{...complete,interrupted:'stalled'}]){
  const sharing=scanMonitorOutcome(state,{busy:true,sharing:true});assert.equal(sharing.kind,'active');assert.equal(sharing.header,'공유 중');
  const reading=scanMonitorOutcome(state,{busy:true,sharing:false});assert.equal(reading.kind,'active');assert.equal(reading.header,'읽는 중');
 }
 assert.equal(scanMonitorOutcome(complete,{busy:false,sharing:true}).kind,'active');
});

test('raw scanner facts count observations while projecting only a boolean input flag',()=>{
 const unidentified=[{image:'private-image-a'},{image:'private-image-b'}];
 assert.deepEqual(scanMonitorInputFacts({sampled:1,unidentified}),{hasInput:true,unresolvedCount:2});
 assert.deepEqual(scanMonitorInputFacts({sampled:99,unidentified}),{hasInput:true,unresolvedCount:2});
 assert.equal(scanMonitorOutcome({...complete,sampled:12,unidentified},ended).kind,'review');
 assert.equal(scanMonitorInputFacts({unresolvedCount:0,unidentified}).unresolvedCount,2,'raw evidence defeats a stale projected count');
 assert.equal(scanMonitorInputFacts({currentRunRead:5}).hasInput,true);
 assert.equal(scanMonitorInputFacts({sampled:0,currentRunRead:5}).hasInput,false,'an explicit raw input clock protects restored inventory');
});

test('ledger-only unresolved inputs are not erased by an empty diagnostic list or double counted',()=>{
 const raw={...complete,sampled:42,unidentified:[],unresolvedObservations:3};
 assert.equal(scanMonitorInputFacts(raw).unresolvedCount,3);
 const outcome=scanMonitorOutcome(raw,ended);
 assert.equal(outcome.kind,'review');assert.match(outcome.detail,/알아보지 못한 화면 3개/);
 assert.equal(scanHasInputWarnings(raw),true);
 assert.equal(scanMonitorInputFacts({...raw,unidentified:[{},{}],unresolvedObservations:3}).unresolvedCount,3);
 assert.equal(scanMonitorInputFacts({...raw,unidentified:[{},{},{},{}],unresolvedObservations:3}).unresolvedCount,4);
 const resolved={...raw,unresolvedObservations:0};
 assert.equal(scanMonitorOutcome(resolved,ended).kind,'complete');assert.equal(scanHasInputWarnings(resolved),false);
});

test('missing or invalid aggregate and dropped-frame evidence cannot produce completion',()=>{
 for(const unresolvedObservations of [undefined,NaN,-1,Infinity]){
  const state={...complete,sampled:1,unidentified:[],unresolvedObservations};
  assert.equal(scanMonitorOutcome(state,ended).kind,'review');assert.equal(scanHasInputWarnings(state),true);
 }
 for(const droppedFrames of [undefined,NaN,-1,Infinity,1]){
  const state={...complete,droppedFrames};
  assert.equal(scanMonitorOutcome(state,ended).kind,'review');assert.equal(scanHasInputWarnings(state),true);
 }
 assert.match(scanMonitorOutcome({...complete,droppedFrames:1},ended).message,/처음부터 다시 스캔/);
 assert.equal(scanHasInputWarnings(null),false);
});

test('CSV import remains idle and a legacy restored scan stays neutral when its input proof is absent',()=>{
 const csv=csvInventoryState([],'');
 assert.equal(scanHasInputWarnings(csv),false);
 assert.equal(scanMonitorOutcome(csv,ended).kind,'idle');
 const legacy={...csv,status:'복원',sampled:1,expected:1,currentRunRead:1};
 const outcome=scanMonitorOutcome(legacy,ended);
 assert.equal(outcome.kind,'review');assert.equal(outcome.header,'확인 불가');
 assert.doesNotMatch(outcome.message,/알아보지 못한.*남/);
 assert.equal(scanHasInputWarnings(legacy),true,'missing evidence must not produce a green completion check');
 const {droppedFrames:_,...older}=legacy;
 assert.equal(scanMonitorOutcome(older,ended).header,'확인 불가');
 assert.equal(scanHasInputWarnings(older),true,'missing drop evidence is not a verified scan');
});
