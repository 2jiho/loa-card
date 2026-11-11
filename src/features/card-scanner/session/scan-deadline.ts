/** Client-side scan deadline and input-stall state. The progress deadline starts
 * at the first accepted card input and restarts on every accepted input/read
 * progress. It never marks the scan complete. Callers must stop the share and
 * show failure guidance when the idle or hard limit is exceeded. These helpers
 * are pure and need no server. */
export type ScanDeadlineState='waiting'|'running'|'warning'|'exceeded';
export type ScanDeadlineReason='idle'|'hard';
export interface ScanDeadline {
  readonly state:ScanDeadlineState;
  readonly elapsedMs:number;
  readonly idleMs:number;
  readonly remainingMs:number;
  readonly hardRemainingMs:number;
  readonly limitMs:number;
  readonly hardLimitMs:number;
  readonly warningAtMs:number;
  readonly reason?:ScanDeadlineReason;
}
export function scanDeadline(input:{
  firstInputAtMs:number|null|undefined;lastProgressAtMs?:number|null;nowMs:number;limitMs?:number;hardLimitMs?:number;warningRatio?:number;
}):ScanDeadline {
  // A person scanning by hand can pause to inspect or reposition the window.
  // Keep the long hard cap for genuinely stuck sessions, but do not treat a
  // 30-second pause as a failed scan: the deployed version did not stop there.
  const limitMs=input.limitMs??120_000,hardLimitMs=input.hardLimitMs??300_000,warningRatio=input.warningRatio??.8;
  if(!Number.isFinite(limitMs)||limitMs<=0||!Number.isFinite(hardLimitMs)||hardLimitMs<limitMs||!Number.isFinite(warningRatio)||warningRatio<=0||warningRatio>=1)
    throw new RangeError('Invalid scan deadline');
  const warningAtMs=limitMs*warningRatio,first=input.firstInputAtMs;
  if(typeof first!=='number'||!Number.isFinite(first)||!Number.isFinite(input.nowMs)||input.nowMs<first)
    return Object.freeze({state:'waiting',elapsedMs:0,idleMs:0,remainingMs:limitMs,hardRemainingMs:hardLimitMs,limitMs,hardLimitMs,warningAtMs});
  const lastProgress=typeof input.lastProgressAtMs==='number'&&Number.isFinite(input.lastProgressAtMs)&&input.lastProgressAtMs>=first?
    Math.min(input.lastProgressAtMs,input.nowMs):first;
  const elapsedMs=input.nowMs-first,idleMs=input.nowMs-lastProgress;
  const hardExceeded=elapsedMs>=hardLimitMs,idleExceeded=idleMs>=limitMs;
  const state:ScanDeadlineState=hardExceeded||idleExceeded?'exceeded':idleMs>=warningAtMs?'warning':'running';
  return Object.freeze({
    state,elapsedMs,idleMs,remainingMs:Math.max(0,limitMs-idleMs),hardRemainingMs:Math.max(0,hardLimitMs-elapsedMs),
    limitMs,hardLimitMs,warningAtMs,...(state==='exceeded'?{reason:hardExceeded?'hard' as const:'idle' as const}:{}),
  });
}
/** User-facing message for the current deadline state. */
export function scanDeadlineMessage(deadline:ScanDeadline):string {
  const idleSeconds=Math.max(1,Math.floor(deadline.idleMs/1000));
  if(deadline.state==='waiting')return '카드 입력을 기다리는 중입니다.';
  if(deadline.state==='running')return `스캔 중 · 진행 대기 ${Math.ceil(deadline.remainingMs/1000)}초`;
  if(deadline.state==='warning')return `스캔 진행이 ${idleSeconds}초째 없습니다. 카드를 다시 보여 주세요.`;
  return '스캔 시간 초과 · 카드 입력을 확인하고 새 스캔을 시작해 주세요.';
}
/** One UI line combining the progress deadline and the input-stall state. Timeout
 * wins over stall because the scan is already stopped in that state. */
export function scanStatusMessage(input:{deadline:ScanDeadline;inputState:ScanInputState;idleMs:number;timedOut:boolean}):string {
  if(input.timedOut)return '스캔 시간 초과 · 카드 입력을 확인하고 새 스캔을 시작해 주세요.';
  if(input.inputState==='stalled')return `입력이 ${Math.max(1,Math.round(input.idleMs/1000))}초째 멈췄습니다. 카드를 다시 보여 주세요.`;
  return scanDeadlineMessage(input.deadline);
}
export type ScanInputState='waiting'|'receiving'|'stalled';
/** Distinguishes "no card input yet" from "input arrived recently" and
 * "input stopped" so the UI never shows a stalled scan as still progressing. */
export function scanInputState(input:{lastInputAtMs:number|null|undefined;nowMs:number;stallMs?:number}):{
  readonly state:ScanInputState;readonly idleMs:number;
} {
  const stallMs=input.stallMs??5000;
  if(!Number.isFinite(stallMs)||stallMs<=0)throw new RangeError('Invalid scan stall window');
  const last=input.lastInputAtMs;
  if(typeof last!=='number'||!Number.isFinite(last)||!Number.isFinite(input.nowMs)||input.nowMs<last)
    return Object.freeze({state:'waiting',idleMs:0});
  const idleMs=input.nowMs-last;
  return Object.freeze({state:idleMs>=stallMs?'stalled':'receiving',idleMs});
}
