import test from 'node:test';
import assert from 'node:assert/strict';
import {beginFinalCardVerification,previewFinalizationStatus} from '../src/features/card-scanner/ui/preview-finalization-status';
import type {ScanWorkPhase} from '../src/features/card-scanner/ui/read-progress';

test('preview finalization is announced only while its own work remains',()=>{
  const base={busy:true,sharing:false,engineReady:true,stopped:false,error:null,status:'카드 이미지 정리 중',phase:'reading' as ScanWorkPhase};
  assert.deepEqual(previewFinalizationStatus(base),{
    title:'카드 이미지 정리 중',description:'인식한 카드의 이미지를 정리하고 있습니다.',
  });
  for(const change of [{busy:false},{sharing:true},{engineReady:false},{stopped:true},
    {error:'입력 오류'},{status:'카드 판독 중'},{status:undefined},
    {phase:'verifying' as ScanWorkPhase},{phase:'cleanup' as ScanWorkPhase},
    {phase:'recovery' as ScanWorkPhase},{phase:'capture' as ScanWorkPhase}]) {
    assert.equal(previewFinalizationStatus({...base,...change}),null);
  }
});

test('completing the preview flush publishes the verification stage and clears its old status',()=>{
  const state:{status:string;workPhase?:ScanWorkPhase}={status:'카드 이미지 정리 중',workPhase:'reading'};
  beginFinalCardVerification(state);
  assert.deepEqual(state,{status:'판독 결과 검증 중',workPhase:'verifying'});
  assert.equal(previewFinalizationStatus({busy:true,sharing:false,engineReady:true,stopped:false,
    error:null,status:state.status,phase:state.workPhase!}),null);
});
