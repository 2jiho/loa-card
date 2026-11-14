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
    return `받아 둔 화면 다시 보는 중 ${Math.floor(Math.max(0,Math.min(100,recoveryPercent)))}%`;
  // The persistent alert below the scanner already explains this condition.
  if(hasScanInputLoss(gate,droppedFrames))return '';
  if(phase==='capture'&&liveObstruction)return LIVE_OBSTRUCTION_MESSAGE;
  if(phase==='capture'&&processing&&gate===stableGuidance&&(gate==='latest-observations'||gate==='occluded'))
    return '아직 못 읽은 화면을 다시 보고 있어요.';
  // Latest-observation debt can include work still being processed. It is not
  // by itself proof that another capture is already needed.
  if(gate==='latest-observations' && gate===stableGuidance)
    return '최근 화면을 확인하고 있어요. 오래 걸리면 카드 목록을 다시 넘겨 주세요.';
  if(gate && gate===stableGuidance && actionableGate(gate))return autoCompletionMessage(gate);
  if(lagGuidance)return '카드 목록이 따라올 때까지 잠시 스크롤을 멈춰 주세요.';
  if(gate==='input' && inputWaitGuidance)return typeof queued==='number'&&Number.isSafeInteger(queued)&&queued>0
    ?'읽을 화면이 밀려 있어요. 스크롤을 잠시 멈춰 주세요.':'화면을 잠시 멈춰 주세요.';
  if(remaining===0)return gate && !actionableGate(gate) ? autoCompletionMessage(gate)
    : '카드는 다 읽었어요. 마지막 확인이 끝나면 스캔이 끝나요.';
  return phase==='reading' ? (estimate ? `남은 시간 약 ${formatScanTime(estimate.low)}~${formatScanTime(estimate.high)} (마지막 확인 제외)` : '남은 시간을 계산하는 중이에요.') : '';
}
