import {autoCompletionMessage} from '../session/auto-completion-diagnostics';
import type {AutoCompletionGate} from '../session/auto-completion-diagnostics';
import {formatScanTime} from './read-progress';
import type {readingEstimate,ScanWorkPhase} from './read-progress';
import {LIVE_OBSTRUCTION_MESSAGE} from '../session/live-obstruction-hint';

export const actionableGate = (gate:AutoCompletionGate|undefined) =>
  gate === 'latest-observations' || gate === 'occluded' || gate === 'header-unavailable';

/** The scanner's persistent input-loss warning takes priority over hints. */
export const hasScanInputLoss=(gate:AutoCompletionGate|undefined,droppedFrames:number|undefined)=>
  gate==='input-dropped'||(typeof droppedFrames==='number'&&Number.isFinite(droppedFrames)&&droppedFrames>0);

/** Advisory only: the input gate can remain busy while the capture pipeline
 * settles. A single skipped callback does not establish a missed card. The
 * cancel closure also fences a callback already queued by the host scheduler. */
export function observeInputWait(gate:AutoCompletionGate|undefined,notify:()=>void,
  schedule:(callback:()=>void,delayMs:number)=>()=>void):()=>void {
  if(gate!=='input')return ()=>{};
  let active=true;
  const cancel=schedule(()=>{if(active){active=false;notify();}},1750);
  return ()=>{active=false;cancel();};
}

/** Only show an actionable gate while it is the current diagnostic. */
export function scanReadDetail(input:{phase:ScanWorkPhase;recoveryPercent?:number;remaining:number|null;
  gate?:AutoCompletionGate;droppedFrames?:number;stableGuidance?:AutoCompletionGate;inputWaitGuidance?:boolean;lagGuidance?:boolean;liveObstruction?:boolean;processing?:boolean;queued?:number;estimate:ReturnType<typeof readingEstimate>}) {
  const {phase,recoveryPercent,remaining,gate,droppedFrames,stableGuidance,inputWaitGuidance,lagGuidance,liveObstruction,processing,queued,estimate}=input;
  if(phase==='recovery' && recoveryPercent !== undefined)
    return `기록 검사 ${Math.floor(Math.max(0,Math.min(100,recoveryPercent)))}% · 카드 판독률과 별개`;
  // The persistent alert below the scanner already explains this condition.
  if(hasScanInputLoss(gate,droppedFrames))return '';
  if(phase==='capture'&&liveObstruction)return LIVE_OBSTRUCTION_MESSAGE;
  if(phase==='capture'&&processing&&gate===stableGuidance&&(gate==='latest-observations'||gate==='occluded'))
    return '미확인된 화면의 판독 상태를 확인하고 있어요. 처리 후에도 남으면 다시 확인해 주세요.';
  // Latest-observation debt can include work still being processed. It is not
  // by itself proof that another capture is already needed.
  if(gate==='latest-observations' && gate===stableGuidance)
    return '최신 관측을 확인하고 있어요. 계속 확인되지 않으면 카드 목록을 다시 보여 주세요.';
  if(gate && gate===stableGuidance && actionableGate(gate))return autoCompletionMessage(gate);
  if(lagGuidance)return '카드 목록이 따라올 때까지 잠시 스크롤을 멈춰 주세요.';
  if(gate==='input' && inputWaitGuidance)return typeof queued==='number'&&Number.isSafeInteger(queued)&&queued>0
    ?'판독 대기 중이에요. 화면을 잠시 멈춰 주세요.':'화면을 잠시 멈춰 주세요.';
  if(remaining===0)return gate && !actionableGate(gate) ? autoCompletionMessage(gate)
    : '카드 판독은 끝났어요. 검증·정리가 끝나면 스캔이 완료됩니다.';
  return phase==='reading' ? (estimate ? `남은 판독 약 ${formatScanTime(estimate.low)}–${formatScanTime(estimate.high)} (추가 검증 제외)` : '남은 시간을 계산 중이에요.') : '';
}
