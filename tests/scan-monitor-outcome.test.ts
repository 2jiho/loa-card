import test from 'node:test';
import assert from 'node:assert/strict';
import {scanMonitorInputFacts,scanMonitorOutcome,scanMonitorRecentCounts} from '../src/features/card-scanner/scan-monitor-outcome';

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
const complete={currentRunRead:385,expected:385,unresolvedCount:0,hasInput:true,queued:0,activeReadings:0};

test('one missing card keeps an ended scan in review with its map and a re-show request',()=>{
 const outcome=scanMonitorOutcome({...complete,currentRunRead:384},ended);
 assert.equal(outcome.kind,'review');assert.equal(outcome.header,'확인 필요');assert.equal(outcome.missingCount,1);
 assert.equal(outcome.showGrid,true);assert.match(outcome.detail,/1종 부족/);assert.match(outcome.message,/다시 보여/);
});

test('equal card counts cannot hide unresolved inputs or call a full scan complete',()=>{
 const outcome=scanMonitorOutcome({...complete,unresolvedCount:14},ended);
 assert.equal(outcome.kind,'review');assert.equal(outcome.unresolvedCount,14);assert.equal(outcome.missingCount,0);
 assert.equal(outcome.showGrid,true);assert.match(outcome.detail,/입력 14건/);assert.doesNotMatch(outcome.detail,/14종/);
 assert.doesNotMatch(outcome.message,/완료/);
});

test('equal counts and no unidentified crops still show unresolved changed-field proof',()=>{
 const state={...complete,unresolvedFieldChanges:2};
 const outcome=scanMonitorOutcome(state,ended);
 assert.equal(outcome.kind,'review');assert.equal(outcome.missingCount,0);assert.equal(outcome.unresolvedCount,0);
 assert.equal(outcome.unresolvedFieldChanges,2);assert.match(outcome.detail,/최신 필드 확인 2건/);
 assert.equal(scanMonitorOutcome({...state,hasInput:false},ended).kind,'review','restored unresolved proof is not hidden by an idle input clock');
 assert.equal(scanMonitorOutcome({...state,unresolvedFieldChanges:0},ended).kind,'complete');
 assert.equal(scanMonitorOutcome({...state,unresolvedFieldChanges:NaN},ended).kind,'review');
 assert.match(scanMonitorOutcome({...state,unresolvedFieldChanges:NaN},ended).detail,/최신 필드 상태 확인 필요/);
});

test('known zero unresolved input labels reading complete without claiming scan verification',()=>{
 const outcome=scanMonitorOutcome(complete,ended);
 assert.equal(outcome.kind,'complete');assert.equal(outcome.message,'카드 판독 완료');assert.equal(outcome.showGrid,true);
 assert.doesNotMatch(outcome.message,/스캔 완료|검증/);
 assert.equal(scanMonitorOutcome({...complete,queued:1},ended).kind,'review');
 assert.equal(scanMonitorOutcome({...complete,activeReadings:1},ended).kind,'review');
});

test('interruption remains visible even before any card or frame was collected',()=>{
 const outcome=scanMonitorOutcome({currentRunRead:0,expected:null,hasInput:false,unresolvedCount:0,interrupted:'cancelled'},ended);
 assert.equal(outcome.kind,'interrupted');assert.equal(outcome.header,'중단');assert.equal(outcome.showGrid,true);
 assert.match(outcome.detail,/다시 공유/);assert.doesNotMatch(outcome.message,/공유를 시작/);
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
  const reading=scanMonitorOutcome(state,{busy:true,sharing:false});assert.equal(reading.kind,'active');assert.equal(reading.header,'처리 중');
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
