import {test} from 'node:test';
import assert from 'node:assert/strict';
import {scanMonitorMessage} from '../src/features/card-scanner/ui/scan-monitor-message';
import {projectScanMonitorState} from '../src/features/card-scanner/ui/scan-monitor-store';
import {scanMonitorOutcome} from '../src/features/card-scanner/session/scan-monitor-outcome';
import type {AutoCompletionGate} from '../src/features/card-scanner/session/auto-completion-diagnostics';

const baseline=()=>({outcome:{kind:'active',message:'화면 공유 중'},sharing:true,inputLoss:false,obstructed:false,
 located:true,viewportReady:true,gate:'inventory' as AutoCompletionGate,expected:393,completed:40,queued:0,reading:0});

test('a ready viewport requests a different section without claiming scroll direction',()=>{
 const result=scanMonitorMessage(baseline());
 assert.deepEqual(result,{message:'다른 구간을 보여 주세요',ready:true});
 assert.doesNotMatch(result.message,/아래|위/);
});
test('a ready viewport cannot hide missing field or identity proof',()=>{
 const state=baseline();
 assert.deepEqual(scanMonitorMessage({...state,completed:393,gate:'fields'}),{message:'각성과 장수 확인이 필요해요',ready:false});
 assert.deepEqual(scanMonitorMessage({...state,completed:393,gate:'fields',reading:1}),{message:'각성과 장수를 확인하고 있어요',ready:false});
 assert.deepEqual(scanMonitorMessage({...state,completed:393,gate:'latest-observations'}),{message:'확인할 카드를 다시 보여 주세요',ready:false});
 assert.deepEqual(scanMonitorMessage({...state,completed:393,gate:'latest-observations',queued:1}),{message:'미확인 화면의 판독 상태를 확인하고 있어요',ready:false});
 assert.deepEqual(scanMonitorMessage({...state,completed:393,gate:'latest-observations',queued:undefined}),{message:'미확인 화면의 판독 상태를 확인하고 있어요',ready:false});
 assert.deepEqual(scanMonitorMessage({...state,completed:393,gate:'names'}),{message:'카드 이름을 다시 확인해 주세요',ready:false});
 assert.deepEqual(scanMonitorMessage({...state,completed:393,gate:'names',queued:1}),{message:'카드 이름을 확인하고 있어요',ready:false});
 assert.deepEqual(scanMonitorMessage({...state,completed:393}),{message:'카드 정보를 확인하고 있어요',ready:false});
});
test('acquisition, final verification and unavailable header get distinct messages',()=>{
 const state=baseline();
 assert.equal(scanMonitorMessage({...state,gate:'input'}).message,'수집한 화면을 정리하고 있어요');
 assert.equal(scanMonitorMessage({...state,gate:'header-reading'}).message,'보관함 수량을 확인하고 있어요');
 assert.equal(scanMonitorMessage({...state,gate:'header-unavailable'}).message,'보관함 수량을 보여 주세요');
 assert.equal(scanMonitorMessage({...state,gate:'header-mismatch'}).message,'보관함 수량·용량이 달라요 · 계속 다르면 다시 스캔해 주세요');
 assert.equal(scanMonitorMessage({...state,gate:'occluded'}).message,'가림을 없애고 다시 보여 주세요');
 assert.equal(scanMonitorMessage({...state,gate:'occluded',reading:1}).message,'판독 상태 확인 중 · 커서를 카드 밖으로 옮겨 주세요');
});
test('input loss and obstruction take precedence over ready viewport and completion gate',()=>{
 const state=baseline();
 assert.equal(scanMonitorMessage({...state,inputLoss:true,obstructed:true,gate:'fields'}).message,'화면 누락 · 공유 종료 후 다시 스캔해 주세요');
 assert.equal(scanMonitorMessage({...state,obstructed:true,gate:'fields'}).message,'커서를 카드 밖으로 옮겨 주세요');
 assert.equal(scanMonitorMessage({...state,inputLoss:true,sharing:false}).message,'화면 누락 · 처음부터 다시 스캔해 주세요');
});
test('matching counts cannot hide independently unresolved input or latest-field evidence when the gate is missing or stale',()=>{
 const state={...baseline(),gate:undefined,completed:393};
 assert.deepEqual(scanMonitorMessage({...state,unresolvedCount:14}),{message:'확인할 화면 입력이 남아 있어요',ready:false});
 assert.deepEqual(scanMonitorMessage({...state,unresolvedFieldChanges:2}),{message:'최신 카드 상태 확인이 필요해요',ready:false});
 assert.deepEqual(scanMonitorMessage({...state,unresolvedCountUnavailable:true}),{message:'미식별 입력 상태를 확인해 주세요',ready:false});
 assert.deepEqual(scanMonitorMessage({...state,unresolvedFieldChangesUnavailable:true}),{message:'최신 카드 상태를 확인해 주세요',ready:false});
 assert.equal(scanMonitorMessage({...state,gate:'hold',unresolvedCount:1}).message,'확인할 화면 입력이 남아 있어요');
 assert.equal(scanMonitorMessage({...state,gate:'fields',unresolvedCountUnavailable:true}).message,'각성과 장수 확인이 필요해요');
 assert.equal(scanMonitorMessage({...state,gate:'fields',unresolvedFieldChanges:1}).message,'각성과 장수 확인이 필요해요');
 assert.equal(scanMonitorMessage({...state,gate:'occluded',unresolvedFieldChanges:1}).message,'가림을 없애고 다시 보여 주세요');
 assert.equal(scanMonitorMessage({...state,gate:'names',unresolvedFieldChangesUnavailable:true}).message,'카드 이름을 다시 확인해 주세요');
 assert.equal(scanMonitorMessage({...state,unresolvedCount:0,unresolvedFieldChanges:0}).message,'카드 정보를 확인하고 있어요');
});
test('the image-free live projection preserves a real unresolved observation count without a diagnostic gate',()=>{
 const projected=projectScanMonitorState({grid:undefined,currentRunRead:385,expected:385,capacity:450,queued:0,activeReadings:0,
  sampled:1,unidentified:Array.from({length:14},()=>({image:'',time:0,pending:false})),unresolvedObservations:14,droppedFrames:0,unresolvedFieldChanges:0});
 const outcome=scanMonitorOutcome(projected,{busy:true,sharing:true});
 assert.equal(projected.unresolvedCount,14);
 assert.deepEqual(scanMonitorMessage({...baseline(),outcome,gate:projected.autoCompletionDiagnostic?.gate,
  expected:projected.expected,completed:projected.currentRunRead??0,unresolvedCount:projected.unresolvedCount,
  unresolvedCountUnavailable:projected.unresolvedCountUnavailable,unresolvedFieldChanges:projected.unresolvedFieldChanges,
  unresolvedFieldChangesUnavailable:projected.unresolvedFieldChangesUnavailable}),{message:'확인할 화면 입력이 남아 있어요',ready:false});
});
test('while other cards are missing, a partial unresolved count does not imply which direction to scroll',()=>{
 const state=baseline();
 assert.deepEqual(scanMonitorMessage({...state,unresolvedCount:14}),{message:'다른 구간을 보여 주세요',ready:true});
});
test('unlocated and unfinished viewport do not assert position or readiness',()=>{
 const state=baseline();
 assert.deepEqual(scanMonitorMessage({...state,located:false}),{message:'카드 성장 탭을 보여 주세요',ready:false});
 assert.deepEqual(scanMonitorMessage({...state,viewportReady:false}),{message:'잠깐 멈춰 주세요',ready:false});
});
test('terminal outcomes and processing after share end are retained',()=>{
 const state=baseline();
 assert.deepEqual(scanMonitorMessage({...state,sharing:false}),{message:'남은 카드를 읽고 있어요',ready:false});
 assert.deepEqual(scanMonitorMessage({...state,sharing:false,outcome:{kind:'complete',message:'카드 판독 완료'}}),{message:'카드 판독 완료',ready:true});
 assert.deepEqual(scanMonitorMessage({...state,sharing:false,outcome:{kind:'review',message:'확인할 구간을 다시 보여 주세요'}}),{message:'확인할 구간을 다시 보여 주세요',ready:false});
});
