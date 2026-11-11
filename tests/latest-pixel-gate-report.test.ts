import {test} from 'node:test';
import assert from 'node:assert/strict';
import {parseLatestPixelGate,parsePreparedCropProofRequest,parseRestoredHandoff,parseScannerExperiment,readLatestPixelGateRequested} from '../dev/latest-pixel-gate-report';

test('최신 입력 게이트 옵션은 명확한 0 또는 1만 허용한다',()=>{
 assert.equal(parseLatestPixelGate(''),false);assert.equal(parseLatestPixelGate('?latestPixelGate=0'),false);
 assert.equal(parseLatestPixelGate('?latestPixelGate=1'),true);
 for(const input of ['?latestPixelGate','?latestPixelGate=2','?latestPixelGate=1&latestPixelGate=0'])
  assert.throws(()=>parseLatestPixelGate(input));
});
test('가림 펜스 실험도 단일 명시값만 허용하고 기본은 꺼진 상태다',()=>{
 assert.equal(parseScannerExperiment('','obstructionFence'),false);
 assert.equal(parseScannerExperiment('?obstructionFence=0','obstructionFence'),false);
 assert.equal(parseScannerExperiment('?obstructionFence=1','obstructionFence'),true);
 assert.throws(()=>parseScannerExperiment('?obstructionFence=1&obstructionFence=1','obstructionFence'));
 assert.throws(()=>parseScannerExperiment('?obstructionFence=yes','obstructionFence'));
});
test('복원 이전 실험은 명시적 요청과 공통 입력을 모두 요구한다',()=>{
 assert.equal(parseRestoredHandoff('',false),false);
 assert.equal(parseRestoredHandoff('?restoredHandoff=0',false),false);
 assert.equal(parseRestoredHandoff('?restoredHandoff=1',true),true);
 assert.throws(()=>parseRestoredHandoff('?restoredHandoff=1',false),/prepared=1/);
 for(const input of ['?restoredHandoff','?restoredHandoff=2','?restoredHandoff=1&restoredHandoff=1'])
  assert.throws(()=>parseRestoredHandoff(input,true));
});
test('크롭 픽셀 비교는 공통 입력과 명시 요청이 모두 필요하다',()=>{
 assert.equal(parsePreparedCropProofRequest('',false),false);
 assert.equal(parsePreparedCropProofRequest('?preparedCropProof=0',false),false);
 assert.equal(parsePreparedCropProofRequest('?preparedCropProof=1',true),true);
 assert.throws(()=>parsePreparedCropProofRequest('?preparedCropProof=1',false),/prepared=1/);
 for(const input of ['?preparedCropProof','?preparedCropProof=2','?preparedCropProof=1&preparedCropProof=1'])
  assert.throws(()=>parsePreparedCropProofRequest(input,true));
});
test('명시된 요청만 읽고 구 보고서와 비정상 값은 알 수 없음으로 유지한다',()=>{
 assert.equal(readLatestPixelGateRequested({validation:{latestPixelGateRequested:true}}),true);
 assert.equal(readLatestPixelGateRequested({validation:{latestPixelGateRequested:false}}),false);
 assert.equal(readLatestPixelGateRequested({validation:{}}),null);
 assert.equal(readLatestPixelGateRequested({validation:{latestPixelGateRequested:'false'}}),null);
 assert.equal(readLatestPixelGateRequested(null),null);
});
