import {createElement} from 'react';
import type {InventoryEvidenceReplay,InventoryReplaySummary} from '../reproduction/inventory-evidence-replay';

/** Hash equality describes only saved state, not recognition accuracy or the
 * authenticity of the policy declaration. Incomplete archives cannot attest
 * to whole-execution equality even if a prefix has a matching checkpoint. */
export function InventoryReplayNotice({inventory,policy,recordingComplete}:{inventory:InventoryReplaySummary;
  policy:ReturnType<InventoryEvidenceReplay['policy']>;recordingComplete:boolean|null}) {
  if(!inventory.supported||policy.status==='no-seed')return createElement('p',{className:'muted'},recordingComplete===true
    ?'카드 근거 재생 미지원 · 기록에 목록 시작 상태가 없습니다.'
    :'카드 근거 재생 미확인 · 목록 시작 상태를 확인할 수 없습니다.');
  const matches=recordingComplete===true?inventory.matchesCapturedState:null;
  const hash=matches===true?'저장된 상태 해시 일치':matches===false?'저장된 상태 해시 불일치':'저장된 상태 해시 일치 여부 미확인';
  const policyNotice=policy.status==='declared'
    ? `카드 합의 규칙 기록됨 (${policy.declared}) · 전체 상태 규칙 미기록 · 실행 코드 미인증`
    : '당시 병합 규칙 미기록';
  return createElement('p',{className:matches===false?'notice':'muted'},
    `카드 근거 재생 · ${inventory.cards.toLocaleString()}종 · ${hash} · ${policyNotice}`);
}
