import {compareReplayResult} from './replay-result';
import {observeMainThreadWork} from './main-thread-work';
import {recordContinuous} from '../src/features/card-scanner/continuous-capture';
import type {ReproductionResult} from '../src/features/card-scanner/scan-reproduction';
import {loadReplayOriginal} from './replay-original';
import {reproductionInput} from '../src/features/card-scanner/reproduction-input';
import {openReproduction} from '../src/features/card-scanner/scan-reproduction';
import { runScanner } from '../src/features/card-scanner/scanner';
import type { ScannerState } from '../src/features/card-scanner/scanner';
import { createScanDiagnosticSummary,reproductionResult } from '../src/features/card-scanner/scan-reproduction';
import type { SourceSnapshot } from './source-snapshot';
import {RunStateTrace,replayRunStateTrace} from './run-state-trace';
import {prepareLiveVideoInput,type LiveVideoInput} from './live-video-input';
import type {ScanMonitorState} from '../src/features/card-scanner/scan-monitor-store';
import {createMonitorPreview} from './scan-monitor-preview';
import {archiveCorpusRun,type ArchivedRun} from './run-archive-client';
import {runScannerBatch,type ScannerBatchJob,type ScannerBatchRunSummary} from './scanner-batch';
import {beginReproduction,createReproductionBundle} from '../src/features/card-scanner/scan-reproduction';
import type {ReproductionFile} from '../src/features/card-scanner/scan-reproduction';
import type {ExactRecorder} from '../src/features/card-scanner/exact-recording';
import {executionSummary} from '../src/features/card-scanner/exact-recording-codec';
import {createExactRecording} from '../src/features/card-scanner/exact-recording';
import {RGBA_WINDOW_POLICY} from '../src/features/card-scanner/rgba-window-policy';
import {createReproductionSessionStore} from '../src/features/card-scanner/reproduction-session-store';
import {recordingBudget} from './recording-budget';
import {prepareScanner,type PreparedScanner} from '../src/features/card-scanner/scanner-preparation';
import {parseScannerNameConfiguration} from '../src/features/card-scanner/scanner-name-configuration';
import {loadVideoInput,VideoInputLoadTimeoutError,VIDEO_INPUT_LOAD_TIMEOUT_MS} from './video-input-loader';
import {createRunVisibilityObserver,type RunVisibilitySummary} from './run-visibility';
import type {createComparisonFrames} from './native-yuv-frames';
import {loadComparisonOriginal} from './comparison-original';
import {createRunCallbackScope} from './run-callback-scope';
import {assertNormalPairedCropRun,parsePairedCropTargets} from './paired-crop-config';
import {createScannerFeedback} from '../src/features/card-scanner/scanner-feedback';
import type {createPairedCropCollector} from './paired-crop-collector';

interface InputDescription { name: string; bytes: number; type: string; sha256?: string; index: number }
interface VideoInputPreparation {
  version:1;kind:'ordinary-video-load';clock:'page-performance-now';limitMs:number;
  startedAtMs:number;settledAtMs:number|null;elapsedMs:number|null;
  outcome:'pending'|'ready'|'cancelled'|'timeout'|'failed';
}
interface CorpusCase {
  id: string; name: string; kind: 'video' | 'images' | 'replay'; inputs: (InputDescription & { url: string })[];
}
const form = document.querySelector('form')!;
const filesInput = document.querySelector<HTMLInputElement>('#files')!;
const corpusSelect = document.querySelector<HTMLSelectElement>('#corpus')!;
const corpusStatus = document.querySelector<HTMLParagraphElement>('#corpus-status')!;
const refresh = document.querySelector<HTMLButtonElement>('#refresh-corpus')!;
const captureOnly = document.querySelector<HTMLInputElement>('#capture-only')!;
const sessionRecording=document.querySelector<HTMLInputElement>('#session-recording')!;
const devRecordingBudget=recordingBudget(new URLSearchParams(location.search).get('recordingBudgetMiB'));
const devSessionStore=createReproductionSessionStore({dbName:devRecordingBudget.database,limits:{maxBytes:devRecordingBudget.bytes}});
let sessionEvidence:unknown=null;
let persistedSessionFile:ReproductionFile|undefined;
const saveSession=document.querySelector<HTMLButtonElement>('#save-session')!;
const sessionMessage=document.querySelector<HTMLParagraphElement>('#session-message')!;
const mode = document.querySelector<HTMLSelectElement>('#mode')!;
const start = document.querySelector<HTMLButtonElement>('#start')!;
const stop = document.querySelector<HTMLButtonElement>('#stop')!;
const save = document.querySelector<HTMLButtonElement>('#save')!;
const replayState = document.querySelector<HTMLButtonElement>('#replay-state')!;
const replayMessage = document.querySelector<HTMLParagraphElement>('#replay-message')!;
const replayComparisonMessage=document.querySelector<HTMLPreElement>('#replay-comparison')!;
let replayBaseline:ReproductionResult|null=null;
let replayComparison:ReturnType<typeof compareReplayResult>|null=null;
const archiveMessage=document.querySelector<HTMLParagraphElement>('#archive-message')!;
const retryArchive=document.querySelector<HTMLButtonElement>('#retry-archive')!;
const video = document.querySelector('video')!;
const batchVariant=document.querySelector<HTMLSelectElement>('#batch-variant')!;
const batchCases=document.querySelector<HTMLSelectElement>('#batch-cases')!;
const batchStart=document.querySelector<HTMLButtonElement>('#batch-start')!;
const batchSave=document.querySelector<HTMLButtonElement>('#batch-save')!;
const batchStatus=document.querySelector<HTMLElement>('#batch-status')!;
const batchResult=document.querySelector<HTMLElement>('#batch-result')!;
const cleanupStatus=document.querySelector<HTMLElement>('#cleanup-status')!;
const message = document.querySelector<HTMLParagraphElement>('#message')!;
const result = document.querySelector<HTMLPreElement>('#result')!;
const monitor = document.querySelector<HTMLPreElement>('#monitor')!;
const page = new AbortController();
// An explicit dev-only experiment. Keep the production canvas path unchanged
// until native acquisition passes pixel/field and paced regression checks.
const nativeAcquisition=new URLSearchParams(location.search).get('native')==='1';
const visiblePlaybackSource=new URLSearchParams(location.search).get('sourcePresentation')==='visible';
const playbackOnly=new URLSearchParams(location.search).get('playbackOnly')==='1';
const transportRecording=new URLSearchParams(location.search).get('transportRecording')==='1';
const requestedContinuousRecording=new URLSearchParams(location.search).get('continuousRecording');
if(requestedContinuousRecording!==null&&!['disabled','fail-start'].includes(requestedContinuousRecording))throw Error('알 수 없는 연속 기록 대조 옵션');
const continuousRecording=requestedContinuousRecording as 'disabled'|'fail-start'|undefined|null;
const requestedRecordingMode=new URLSearchParams(location.search).getAll('recording');
if(requestedRecordingMode.length>1||requestedRecordingMode.some(value=>value!=='diagnostic'&&value!=='detailed'))throw Error('recording=diagnostic 또는 detailed를 사용하세요.');
const recordingMode=requestedRecordingMode[0] as 'diagnostic'|'detailed'|undefined;
const preparedSource=new URLSearchParams(location.search).get('prepared')==='1';
const preparedAttestation=new URLSearchParams(location.search).get('attest')==='1';
const requestedCodecPolicy=new URLSearchParams(location.search).get('codecPolicy');
if(requestedCodecPolicy!==null&&requestedCodecPolicy!==RGBA_WINDOW_POLICY)throw Error('지원하지 않는 기록 codecPolicy입니다.');
const recordingCodecPolicy=requestedCodecPolicy??undefined;
if(preparedAttestation&&!preparedSource)throw Error('변환 증명 실험에는 prepared=1이 필요합니다.');
const requestedPreparation=new URLSearchParams(location.search).get('preparation');
if(requestedPreparation!==null&&requestedPreparation!=='auto'&&requestedPreparation!=='canvas')throw Error('준비 방식은 preparation=auto 또는 canvas만 지원합니다.');
const preparedSourceMode=requestedPreparation??'auto';
// Window recording accepts RGBA, not native/compact frames. Explicit canvas
// preparation shares those exact pixels with acquisition and emits raster
// receipts, allowing end-to-end proof without enabling native conversion.
if(recordingCodecPolicy&&preparedSource&&(preparedSourceMode!=='canvas'||preparedAttestation))
  throw Error('RGBA window 공통 입력은 preparation=canvas로만 검사하세요.');
if(requestedPreparation!==null&&!preparedSource)throw Error('준비 방식 선택에는 prepared=1이 필요합니다.');
if(preparedSourceMode==='canvas'&&preparedAttestation)throw Error('Canvas 준비 비교와 native 변환 증명은 따로 실행하세요.');
// Deterministic-pixel recovery experiment; never enables the production path.
const rgbaRecovery=new URLSearchParams(location.search).get('rgba')==='1';
const fractionalPortrait=new URLSearchParams(location.search).get('fractional')==='1';
const grayNameFallback=new URLSearchParams(location.search).get('gray')==='1';
const localCropPixels=new URLSearchParams(location.search).get('localpixels')==='1';
const requestedNamePolicy=new URLSearchParams(location.search).get('names');
if(requestedNamePolicy!==null&&requestedNamePolicy!=='continue'&&requestedNamePolicy!=='resample')throw Error('이름 판독 비교는 names=continue 또는 resample만 지원합니다.');
const nameRawResultPolicy=requestedNamePolicy??'resample';
const contrastOption=new URLSearchParams(location.search).getAll('contrast');
if(contrastOption.length>1||contrastOption.some(value=>value!=='1'&&value!=='0'))throw Error('대비 이름 보완은 contrast=1 또는 0만 지원합니다.');
const contrastNameFallback=contrastOption[0]==='1';
const nameConfiguration=parseScannerNameConfiguration({version:1,rawResultPolicy:nameRawResultPolicy,
  ...(contrastNameFallback?{contrastNameFallback:true}:{})});
const warmNameReaders=new URLSearchParams(location.search).get('warm')==='1';
const requestedFps=new URLSearchParams(location.search).get('fps');
const inputFps=requestedFps===null?undefined:Number(requestedFps);
if(inputFps!==undefined&&![4,6,8].includes(inputFps))throw Error('입력 빈도 실험은 fps=4,6,8만 지원합니다.');
const minInputIntervalMs=inputFps===undefined?undefined:1000/inputFps;
const floorOptions=new URLSearchParams(location.search).getAll('offerFloor');
if(floorOptions.length>1||floorOptions.some(value=>!['0','16','33'].includes(value)))throw Error('입력 간격 비교는 offerFloor=0,16,33만 지원합니다.');
const inputOfferFloorMs=floorOptions.length?Number(floorOptions[0]):undefined;
const requestedProvider=new URLSearchParams(location.search).get('provider');
if(requestedProvider!==null&&requestedProvider!=='canvas-control'&&requestedProvider!=='native-yuv')throw Error('입력 비교는 provider=canvas-control 또는 native-yuv만 지원합니다.');
const inputProvider=requestedProvider;
const pairedTargets=parsePairedCropTargets(new URLSearchParams(location.search).get('pairs'));
if(preparedSource&&(nativeAcquisition||inputProvider||rgbaRecovery||fractionalPortrait||inputFps!==undefined||inputOfferFloorMs!==undefined||grayNameFallback))throw Error('공통 입력 실험은 다른 실험 옵션과 함께 실행하지 않습니다.');
if(inputProvider&&(nativeAcquisition||rgbaRecovery||fractionalPortrait||inputFps!==undefined))throw Error('입력 비교는 다른 실험 옵션과 함께 실행하지 않습니다.');
if(grayNameFallback&&(nativeAcquisition||rgbaRecovery||fractionalPortrait||inputFps!==undefined))throw Error('회색 이름 보완 비교는 다른 입력 실험과 함께 실행하지 않습니다.');
if(localCropPixels&&(preparedSource||inputProvider||nativeAcquisition||rgbaRecovery||fractionalPortrait||inputFps!==undefined||inputOfferFloorMs!==undefined||grayNameFallback))throw Error('로컬 카드 픽셀 전달 실험은 다른 입력 실험과 함께 실행하지 않습니다.');
if(nameRawResultPolicy==='continue'&&(preparedSource||inputProvider||nativeAcquisition||rgbaRecovery||fractionalPortrait||inputFps!==undefined||inputOfferFloorMs!==undefined||grayNameFallback||localCropPixels))throw Error('이름 OCR 연속 판독은 다른 입력 실험과 함께 실행하지 않습니다.');
if(warmNameReaders&&(preparedSource||inputProvider||nativeAcquisition||rgbaRecovery||fractionalPortrait||inputFps!==undefined||inputOfferFloorMs!==undefined||grayNameFallback||localCropPixels))throw Error('예열 판독 설정 검사는 기본 입력에서 단독 실행하세요.');
const providerNotice=document.querySelector<HTMLElement>('#input-experiment')!;
if(contrastNameFallback&&(preparedSource||inputProvider||nativeAcquisition||rgbaRecovery||fractionalPortrait||inputFps!==undefined||inputOfferFloorMs!==undefined||grayNameFallback||localCropPixels||nameRawResultPolicy==='continue'))throw Error('대비 이름 보완은 기본 입력에서 단독 비교하세요.');
if(inputProvider){providerNotice.hidden=false;providerNotice.textContent=`입력 비교 · ${inputProvider} · 획득 Worker와 직렬 판독 · 실제 공유 처리량과 별도 검사${grayNameFallback?' · 실패한 이름 정밀 재시도에 회색 보완':''}${pairedTargets.length?' · 선택한 관측의 카드·이름 영역 보존':''}`;}
if(pairedTargets.length&&!inputProvider){providerNotice.hidden=false;providerNotice.textContent='선택 관측 진단 · 기본 단일 영상·전체 프레임 순차 판독·세션 저장 끔 · 카드·이름 영역 보존';}
if(preparedSource){providerNotice.hidden=false;providerNotice.textContent=`공통 입력 실험 · 준비 ${preparedSourceMode} · 영상 1배속 + 자동 세션 저장 필요 · 원본 준비·획득·저장 해시 연결 · 기본 스캐너와 별도 검증`;}
if(localCropPixels){providerNotice.hidden=false;providerNotice.textContent='카드 픽셀 전달 실험 · 영상 1배속 · 정수·불투명 카드만 직접 전달 · 기본 스캐너와 별도 검증';}
if(nameRawResultPolicy==='continue'){providerNotice.hidden=false;providerNotice.textContent='이름 OCR 연속 판독 실험 · 기본 영상·이미지 입력 · 같은 판독 안의 원본 이름 결과만 재사용 · 기본 스캐너와 별도 검증';}
let comparison:ReturnType<typeof createComparisonFrames>|undefined;
let providerOriginal:{sha256:string;bytes:number}|undefined;
let providerPreparation:{readers:number;visualWorkers:number;acquisitionReady:boolean}|undefined;
let pairedCropEvidence:unknown=null;
let sourcePlaybackOrigin:unknown=null;
let controller: AbortController | undefined;
let batchController:AbortController|undefined,batchDownloadUrl:string|undefined,batchInitialized=false;
let pendingInternal:object|null=null;
let archivedRun:ArchivedRun|null=null,runGrayNameFallback=grayNameFallback,runFractionalPortrait=fractionalPortrait;
let runNameConfiguration=nameConfiguration;
const monitorPreview=createMonitorPreview(document.querySelector<HTMLElement>('#monitor-preview')!,()=>controller?.abort());
let latest: ScannerState | undefined;
let inputDescription: InputDescription[] = [];
let runCaseId: string | null = null;
let ended = false;
let runCaptureOnly = false;
let runImages = false;
let replayEvidence:{kind:string;seedCount:number;partial:boolean;configurationRecorded:boolean;configuration:typeof nameConfiguration;verifiedFrames:number}|null=null;
let startedAt: string | null = null;
let finishedAt: string | null = null;
let elapsedMs = 0;
let inputPreparation:VideoInputPreparation|null=null;
let mainThreadWork:ReturnType<ReturnType<typeof observeMainThreadWork>['stop']>|null=null;
let transportEncoding:{bytes:number|null;peakPendingBytes:number;finishMs:number;warnings:string[]}|null=null;
let outcome: 'completed' | 'cancelled' | 'failed' | 'interrupted' | 'source-changed' | 'source-unverified' = 'failed';
let sourceStart: SourceSnapshot | null = null;
let sourceEnd: SourceSnapshot | null = null;
let sourceChanged: boolean | null = null;
let sourceInvalidated = false;
let stateTrace = new RunStateTrace();
let capturedGridHash:string|null = null;
let capturedInventoryHash:string|null=null,capturedInputHash:string|null=null,capturedUnknownHash:string|null=null,capturedFreshnessHash:string|null=null;
let runMode:'offline'|'live'='offline';
let liveTiming:{readyMs:number|null;inputFinishedMs:number|null;inputSeconds:number;durationSeconds:number;naturalEnd:boolean}|null=null;
let feedbackDeliveries=0;
let feedbackSummary:ReturnType<typeof monitorSummary>|null=null;
let runVisibility:RunVisibilitySummary|null=null;
let runClockOrigin:{clock:'page-performance-now';runStartedAtMs:number;scannerTraceOriginMs:number|null;runReturnedAtMs:number|null}|null=null;
let runtimeConfiguration:unknown=null,completionCheck:unknown=null;
let reportBlob:Blob|undefined;
let runError:string|null=null;
const currentState = (): ScannerState | undefined => latest;


function monitorSummary(state:ScanMonitorState) {
  const grid=state.grid;
  return {read:state.currentRunRead,expected:state.expected,queued:state.queued,reading:state.activeReadings,
    unresolvedFieldChanges:state.unresolvedFieldChanges??0,
    positioned:grid?.located,liveTop:grid?.liveTop,estimatedTop:grid?.estimatedTop,recent:grid?.recent,
    inventory:grid?.inventory?.reduce<Record<string,number>>((counts,cell)=>{
      counts[cell.status]=(counts[cell.status]??0)+1;return counts;
    },{})};
}
function summary(state: ScannerState) {
  return {
    status: state.status, captureWarning:state.captureWarning??null, percent: state.percent, sampled: state.sampled,
    expected: state.expected, identified: state.cards.length,
    currentRunRead: state.currentRunRead ?? 0,currentRunNames:state.currentRunNames, finishTiming: state.finishTiming,
    unresolvedFieldChanges:state.unresolvedFieldChanges??0,
    autoStopped:state.autoStopped,recoverySkipped:state.recoverySkipped,
    recoveryReuse:state.recoveryReuse,retryWork:state.retryWork,
    review: state.cards.filter(card => card.review.length).length,
    unreadable: state.unreadable, queued: state.queued, activeReadings: state.activeReadings,
    growthPoints: state.growthPoints, unidentified: state.unidentified.filter(item => !item.pending).length,
    acquisition: state.captureDiagnostics && {
      acquired: state.captureDiagnostics.acquired, rejected: state.captureDiagnostics.rejected,
      duplicates: state.captureDiagnostics.duplicates, improved: state.captureDiagnostics.improved,
      reasons: Object.fromEntries(Object.entries(state.captureDiagnostics.reasons).slice(0, 50)),
    },
  };
}
function update(state: ScannerState) {
  latest = state; message.textContent = state.status;
  monitorPreview.publish(state);
  result.textContent = JSON.stringify(summary(state), null, 2);
}

async function loadCorpus() {
  refresh.disabled = true;
  const selected = corpusSelect.value;
  try {
    const response = await fetch('/__corpus', { signal: page.signal });
    if (!response.ok) throw new Error('입력 코퍼스를 읽을 수 없습니다. npm run corpus -- verify로 확인하세요.');
    const index: { cases: { id: string; name: string; kind: CorpusCase['kind']; inputs: number }[] } = await response.json();
    const choices = index.cases.filter(item => ['video','images','replay'].includes(item.kind));
    const selectedBatch=new Set([...batchCases.selectedOptions].map(option=>option.value));
    batchCases.replaceChildren();
    for(const item of choices.filter(item=>item.kind!=='replay')){
      const option=new Option(`${item.name} · ${item.kind==='video'?'영상':`사진 ${item.inputs}개`}`,item.id);
      option.selected=!batchInitialized||selectedBatch.has(item.id);batchCases.add(option);
    }
    batchInitialized=true;
    corpusSelect.replaceChildren(new Option('직접 파일 선택', ''));
    for (const item of choices) corpusSelect.add(new Option(`${item.name} · ${item.kind === 'video' ? '영상' : item.kind==='replay'?'저장된 입력':`사진 ${item.inputs}개`}`, item.id));
    if (choices.some(item => item.id === selected)) corpusSelect.value = selected;
    corpusStatus.textContent = `${choices.length}개 사례 · 등록한 순서로 읽습니다. .loareplay는 저장된 픽셀을 다시 판독합니다.`;
  } catch (error) {
    if (!page.signal.aborted) corpusStatus.textContent = String(error);
  } finally { busy(!!controller); }
}
function busy(value: boolean) {
  const locked=value||!!batchController;
  const scanLocked=locked||pendingInternal!==null;
  start.disabled = filesInput.disabled = corpusSelect.disabled = captureOnly.disabled = sessionRecording.disabled = mode.disabled = refresh.disabled = scanLocked;
  batchVariant.disabled=scanLocked;batchCases.disabled=scanLocked;batchStart.disabled=scanLocked||batchCases.options.length===0;batchSave.disabled=locked||!batchDownloadUrl;
  cleanupStatus.hidden=locked||pendingInternal===null;
  cleanupStatus.textContent=cleanupStatus.hidden?'':'이전 판독기 정리 중입니다. 정리가 끝나면 새 검사를 시작할 수 있습니다. 오래 지속되면 이 페이지를 새로고침해 주세요.';
  saveSession.disabled=locked||!persistedSessionFile;
  stop.disabled = !locked; save.disabled = locked || (!latest&&!reportBlob);
  replayState.disabled = locked || !latest;
  retryArchive.disabled=locked||!reportBlob||!runCaseId;
}
async function sourceSnapshot(signal: AbortSignal): Promise<SourceSnapshot> {
  const response = await fetch('/__corpus/environment', { cache: 'no-store', signal: AbortSignal.any([signal, AbortSignal.timeout(10000)]) });
  if (!response.ok) throw new Error('실행 소스를 확인하지 못했습니다. 코드 변경이 끝난 뒤 다시 검사하세요.');
  return response.json();
}
interface SingleRunOptions {caseId:string;mode:'offline'|'live';gray:boolean;fractional:boolean;contrast:boolean;signal:AbortSignal}
async function runSelectedCase(options?:SingleRunOptions):Promise<ScannerBatchRunSummary|null> {
  if(controller||pendingInternal)return null;
  const selectedId = options?.caseId??corpusSelect.value;
  // Direct inputs retain FileList order too; no implicit filename sorting.
  const files = options?[]:[...filesInput.files ?? []];
  const fileReplay=files.length===1&&files[0].name.toLowerCase().endsWith('.loareplay');
  const fileImages = files.length > 0 && files.every(file => file.type.startsWith('image/'));
  if (!selectedId && !fileReplay && !fileImages && !(files.length === 1 && files[0].type.startsWith('video/'))) {
    message.textContent = '코퍼스 사례 또는 영상·이미지·.loareplay를 선택하세요.'; return null;
  }
  controller = new AbortController(); const runController=controller;
  const signal=AbortSignal.any([runController.signal,page.signal,...(options?[options.signal]:[])]);
  const runRecording=options?false:sessionRecording.checked;
  runFractionalPortrait=options?.fractional??fractionalPortrait;
  runGrayNameFallback=options?.gray??grayNameFallback;archivedRun=null;
  runNameConfiguration=options?parseScannerNameConfiguration({version:1,rawResultPolicy:'resample',contrastNameFallback:options.contrast}):nameConfiguration;
  const callbacks=createRunCallbackScope(()=>controller===runController);
  let liveInput:LiveVideoInput|undefined,liveFailure:unknown;
  let preparedComparison:PreparedScanner|undefined;
  let preparedTransferred=false;
  let runComparison:ReturnType<typeof createComparisonFrames>|undefined;
  let pairedCollector:ReturnType<typeof createPairedCropCollector>|undefined;
  let mainThreadObserver:ReturnType<typeof observeMainThreadWork>|undefined;
  let sessionRun:ReturnType<typeof beginReproduction>|undefined,devExact:ExactRecorder|undefined;
  const objectUrls: string[] = [];
  let clockStarted = performance.now(); startedAt = new Date().toISOString();
  runClockOrigin={clock:'page-performance-now',runStartedAtMs:clockStarted,scannerTraceOriginMs:null,runReturnedAtMs:null};
  replayEvidence=null;replayBaseline=null;replayComparison=null;replayComparisonMessage.textContent='';
  latest = undefined; ended = false; elapsedMs = 0; inputPreparation=null; finishedAt = null; outcome = 'failed'; inputDescription = [];
  comparison=undefined;providerOriginal=undefined;providerPreparation=undefined;
  pairedCropEvidence=null;
  mainThreadWork=null;
  transportEncoding=null;
  sourcePlaybackOrigin=null;
  persistedSessionFile=undefined;sessionEvidence=null;sessionMessage.textContent='';
  reportBlob=undefined;runError=null;archiveMessage.textContent='';retryArchive.hidden=true;
  sourceStart = sourceEnd = null; sourceChanged = null; sourceInvalidated = false;
  stateTrace.dispose();
  stateTrace = new RunStateTrace();capturedGridHash=null;capturedInventoryHash=null;capturedInputHash=null;capturedUnknownHash=null;capturedFreshnessHash=null;replayMessage.textContent='';
  const runTrace=stateTrace;
  runtimeConfiguration=completionCheck=null;
  runMode=options?.mode??(mode.value==='live'?'live':'offline');liveTiming=null;feedbackDeliveries=0;feedbackSummary=null;monitor.textContent='';
  monitorPreview.clear();monitorPreview.setStatus({busy:true,sharing:false});
  const feedbackProbe=createScannerFeedback({now:()=>performance.now(),signal});
  monitorPreview.setFeedback(feedbackProbe);
  const visibilityObserver=createRunVisibilityObserver(document);
  runVisibility=visibilityObserver.snapshot();
  runCaseId = selectedId || null; runCaptureOnly = options?false:captureOnly.checked; runImages = false;
  busy(true); result.textContent = ''; message.textContent = '입력을 준비하고 있습니다.';
  try {
    sourceStart = await sourceSnapshot(signal);
    // Keep source hashing overhead outside the scanner/preparation measurement.
    clockStarted = performance.now(); startedAt = new Date().toISOString();
    runClockOrigin.runStartedAtMs=clockStarted;
    let urls: string[], images: boolean, replayFile:ReproductionFile|undefined;
    if (selectedId) {
      const response = await fetch(`/__corpus/cases/${selectedId}`, { signal });
      if (!response.ok) throw new Error('코퍼스 입력이 없거나 유효하지 않습니다. npm run corpus -- verify로 확인하세요.');
      const item: CorpusCase = await response.json();
      if(item.kind==='replay'){
        if(item.inputs.length!==1)throw Error('재현 사례는 파일 하나여야 합니다.');
        const blob=await loadReplayOriginal(item.inputs[0].url,item.inputs[0].bytes,signal);
        replayFile=await openReproduction(blob,signal);
      }
      images = item.kind === 'images'; urls = item.inputs.map(input => input.url);
      inputDescription = item.inputs.map(({ index, name, bytes, type, sha256 }) => ({ index, name, bytes, type, sha256 }));
    } else {
      urls = files.map(file => { const url = URL.createObjectURL(file); objectUrls.push(url); return url; });
      images = fileImages;
      if(fileReplay)replayFile=await openReproduction(files[0],signal);
      inputDescription = files.map((file, index) => ({ index, name: file.name, bytes: file.size, type: file.type }));
    }
    runImages = images;
    if(continuousRecording&&(playbackOnly||runMode!=='live'||images||replayFile||runRecording||inputProvider||preparedSource||nativeAcquisition||rgbaRecovery||recordingCodecPolicy||options))
      throw Error('연속 기록 대조는 단일 영상 1배속·세션 저장 끔·입력 실험 끔에서 실행하세요.');
    if(transportRecording&&!playbackOnly)throw Error('인코딩 대조는 playbackOnly=1에서만 실행하세요.');
    if(playbackOnly&&(runMode!=='live'||images||replayFile||runCaptureOnly||runRecording||inputProvider||
      preparedSource||nativeAcquisition||rgbaRecovery||localCropPixels||warmNameReaders||pairedTargets.length||options||
      runFractionalPortrait||inputFps!==undefined||runGrayNameFallback||requestedNamePolicy!==null||recordingCodecPolicy))
      throw Error('재생 전달 대조는 단일 영상·1배속·획득만 검사 끔·세션 저장 끔·입력 실험 끔으로 실행하세요.');
    if(replayFile&&(runMode!=='offline'||runCaptureOnly||runRecording||preparedSource||nativeAcquisition||inputProvider||rgbaRecovery||runFractionalPortrait||inputFps!==undefined||runGrayNameFallback||localCropPixels||warmNameReaders||requestedNamePolicy!==null||pairedTargets.length||recordingCodecPolicy))
      throw Error('저장된 입력은 실험 옵션 없이 전체 프레임 순차·판독 모드·세션 저장 끔으로 실행하세요.');
    const replayInput=replayFile?reproductionInput(replayFile,signal,count=>{if(replayEvidence)replayEvidence.verifiedFrames=count;}):undefined;
    if(replayFile)replayBaseline=replayFile.metadata.result;
    if(replayInput)replayEvidence={kind:replayFile!.exact?'stored-exact-pixels':'decoded-recorded-video',seedCount:replayInput.seed.length,
      partial:replayInput.options.replay.truncated,configurationRecorded:replayInput.configurationRecorded,configuration:replayInput.options.nameConfiguration,verifiedFrames:0};
    if(pairedTargets.length&&!inputProvider)assertNormalPairedCropRun({
      mode:runMode,images,inputCount:urls.length,recording:runRecording,captureOnly:runCaptureOnly,
      preparedSource,nativeAcquisition,rgbaRecovery,fractionalPortrait:runFractionalPortrait,fpsRequested:inputFps!==undefined,
      grayNameFallback:runGrayNameFallback,localCropPixels,nameRawResultPolicy,warmNameReaders,
    });
    if(images&&runMode==='live')throw Error('사진은 전체 프레임 순차 검사로 실행하세요.');
    if(localCropPixels&&runMode!=='live')throw Error('로컬 카드 픽셀 전달 실험은 영상 1배속에서 실행하세요.');
    if(inputProvider){
      if(images||runMode!=='offline'||urls.length!==1||runRecording)throw Error('입력 비교는 단일 영상·전체 프레임 직렬 검사·세션 저장 끔으로 실행하세요.');
      if(pairedTargets.length&&runCaptureOnly)throw Error('pairs 비교는 실제 카드 판독 모드에서 실행하세요.');
      message.textContent='입력 비교 원본의 길이와 SHA-256을 확인하고 있습니다.';
      const {blob,verified}=await loadComparisonOriginal(urls[0],inputDescription[0],signal);providerOriginal=verified;
      if(!inputDescription[0].sha256)inputDescription[0].sha256=providerOriginal!.sha256;
      const {createComparisonFrames}=await import('./native-yuv-frames');signal.throwIfAborted();
      runComparison=comparison=createComparisonFrames(blob,inputProvider,signal);
      clockStarted=performance.now();startedAt=new Date().toISOString();
      runClockOrigin.runStartedAtMs=clockStarted;
      preparedComparison=await prepareScanner(callbacks.wrap(value=>{message.textContent=value;}),signal,replayInput?.options.nameConfiguration??runNameConfiguration);
      providerPreparation={readers:preparedComparison.readers.length,visualWorkers:preparedComparison.visuals.filter(Boolean).length,acquisitionReady:preparedComparison.acquisition?.supportsNative===true};
      if(!providerPreparation.acquisitionReady)throw Error('입력 비교에는 실제 획득 Worker·VideoFrame 지원이 필요합니다.');
    }
    if(preparedSource&&(!runRecording||runMode!=='live'||runCaptureOnly))throw Error('공통 입력 실험은 영상 1배속·판독 모드와 자동 세션 저장을 함께 사용하세요.');
    if(recordingCodecPolicy&&(!runRecording||runMode!=='live'||runCaptureOnly))throw Error('RGBA window 검사는 영상 1배속·판독 모드와 자동 세션 저장이 필요합니다.');
    if(warmNameReaders){
      if(runCaptureOnly)throw Error('예열 판독 설정 검사는 실제 카드 판독 모드에서 실행하세요.');
      preparedComparison=await prepareScanner(callbacks.wrap(value=>{message.textContent=value;}),signal,replayInput?.options.nameConfiguration??runNameConfiguration);
    }
    if(runRecording){
      if(runMode!=='live'||runCaptureOnly)throw Error('자동 세션 저장 검사는 영상 1배속·판독 모드에서 실행하세요.');
      devExact=await createExactRecording(recordingCodecPolicy?{codecPolicy:recordingCodecPolicy}:preparedSource?{storageVersion:1,...(preparedAttestation?{preparedNativeAttestation:true}:{})}:{});
      sessionRun=beginReproduction([],{browser:navigator.userAgent,catalog:'dev-corpus',build:import.meta.env.VITE_BUILD_REVISION??'local'},
        {record:true,exact:devExact,store:devSessionStore,nameConfiguration:runNameConfiguration});
    }
    if(runMode==='live') {
      liveTiming={readyMs:null,inputFinishedMs:null,inputSeconds:0,durationSeconds:0,naturalEnd:false};
      liveInput=await prepareLiveVideoInput(urls[0],video,signal,{
        ...(visiblePlaybackSource?{sourceContainer:document.querySelector<HTMLElement>('#playback-source')!}:{}),
        onPlayback:callbacks.wrap(fact=>{
          if(fact.type==='start')sourcePlaybackOrigin={playbackId:fact.playbackId,caseId:runCaseId,input:{...inputDescription[0]},
            source:'original source HTMLVideoElement before captureStream',integrity:'input description only; not source-byte verification',
            boundary:'Callback counters are not original decoded ordinals and are not joined to target frames by timestamps.'};
          runTrace.record('source-playback',fact,(performance.now()-clockStarted)/1000);
        }),
        onPlaybackError:callbacks.wrap(error=>{runTrace.record('media-recording-error',{error:String(error)},(performance.now()-clockStarted)/1000);}),
      });
      void liveInput.completion.then(callbacks.wrap(()=>{
        if(liveTiming)liveTiming.inputFinishedMs=performance.now()-clockStarted;
        monitorPreview.setStatus({busy:true,sharing:false});
      }),callbacks.wrap(error=>{
        if(signal.aborted)return;
        liveFailure=error;runController.abort(error);
      }));
    } else if (!images&&!inputProvider&&!replayInput) {
      message.textContent='영상 데이터를 준비하고 있습니다.';
      inputPreparation={version:1,kind:'ordinary-video-load',clock:'page-performance-now',limitMs:VIDEO_INPUT_LOAD_TIMEOUT_MS,
        startedAtMs:performance.now(),settledAtMs:null,elapsedMs:null,outcome:'pending'};
      try{await loadVideoInput(video,urls[0],signal);inputPreparation.outcome='ready';}
      catch(error){inputPreparation.outcome=signal.aborted?'cancelled':error instanceof VideoInputLoadTimeoutError?'timeout':'failed';throw error;}
      finally{inputPreparation.settledAtMs=performance.now();inputPreparation.elapsedMs=inputPreparation.settledAtMs-inputPreparation.startedAtMs;}
    }
    signal.throwIfAborted();
    if(pairedTargets.length){
      const {createPairedCropCollector}=await import('./paired-crop-collector');
      signal.throwIfAborted();pairedCollector=createPairedCropCollector(pairedTargets);
    }
    preparedTransferred=true;
    const internalToken={};if(!playbackOnly)pendingInternal=internalToken;
    mainThreadObserver=observeMainThreadWork();
    if(playbackOnly){
      runtimeConfiguration={playbackOnly:true,transportRecording,playbackSourcePresentation:visiblePlaybackSource?'visible':'detached'};
      message.textContent=transportRecording?'재생·인코딩 대조 중 · 검출·판독 미실행':'재생 전달 대조 중 · 검출·판독·연속 인코딩 미실행';
      const warnings:string[]=[];
      const recorder=transportRecording?recordContinuous(new MediaStream((video.srcObject as MediaStream).getVideoTracks()),message=>warnings.push(message)):undefined;
      if(liveTiming)liveTiming.readyMs=performance.now()-clockStarted;
      const timeout=setTimeout(()=>runController.abort(Error('재생 전달 대조 시간 초과')),
        Math.min(2_000_000_000,Math.ceil(liveInput!.durationSeconds*1000)+15_000));
      try{await liveInput!.start();await liveInput!.completion;}finally{
        clearTimeout(timeout);
        if(recorder){
          const finishStarted=performance.now(),recording=await recorder.finish();
          transportEncoding={bytes:recording?.blob.size??null,peakPendingBytes:recorder.peakBufferedBytes,
            finishMs:performance.now()-finishStarted,warnings};
          await recording?.dispose?.();
        }
      }
    }else await runScanner(video, runMode==='live'||replayInput?'screen':'video', signal, callbacks.wrap(update), replayInput?.seed??[], callbacks.wrap(()=>{
      if(liveTiming)liveTiming.readyMs=performance.now()-clockStarted;
      monitorPreview.setStatus({busy:true,sharing:runMode==='live'});
      if(liveInput)void liveInput.start().catch(error=>{if(!signal.aborted){liveFailure=error;runController.abort(error);}});
    }), 'all', images?urls:undefined, runCaptureOnly, {
      ...sessionRun?.options,
      feedbackProbe,
      onInternalSettled:()=>{
        if(pendingInternal!==internalToken)return;
        pendingInternal=null;
        if(!page.signal.aborted&&!controller&&!batchController)busy(false);
      },
      ...(pairedCollector?{recognitionObserver:pairedCollector}:{}),
      nameConfiguration:replayInput?.options.nameConfiguration??runNameConfiguration,comparisonInput:!!inputProvider,continuousRecording:continuousRecording??undefined,
      recordingMode:recordingMode??sessionRun?.options.recordingMode,
      preparedSource,preparedSourceMode,nativeAcquisition,rgbaRecovery,fractionalPortrait:runFractionalPortrait,minInputIntervalMs,inputOfferFloorMs,grayNameFallback:runGrayNameFallback,localCropPixels,nameRawResultPolicy:replayInput?.options.nameConfiguration.rawResultPolicy??nameRawResultPolicy,
      trace:callbacks.wrap((type:string,value:unknown,time:number)=>{
        if(type==='scanner-clock'&&runClockOrigin&&value&&typeof value==='object'){
          const anchor=value as {version?:unknown;clock?:unknown;phase?:unknown;originMs?:unknown};
          if(anchor.version===1&&anchor.clock==='page-performance-now'&&anchor.phase==='input-and-recognition'
            &&typeof anchor.originMs==='number'&&Number.isFinite(anchor.originMs)&&anchor.originMs>=0)
            runClockOrigin.scannerTraceOriginMs=anchor.originMs;
        }
        if(type==='frame'&&runComparison)runComparison.noteConsumed(value);
        if(type==='configuration'||type==='completion-check') {
          try {
            const encoded=JSON.stringify(value);
            if(encoded.length<=8192) {
              const detached:unknown=JSON.parse(encoded);
              if(type==='configuration')runtimeConfiguration={
                ...(detached&&typeof detached==='object'&&!Array.isArray(detached)?detached:{configuration:detached}),
                recordingCodecPolicy:recordingCodecPolicy??null,
                recordingBudgetBytes:devRecordingBudget.bytes,
                playbackSourcePresentation:visiblePlaybackSource?'visible':'detached',
              };else completionCheck=detached;
            }
          }catch{/* Optional bounded metadata never blocks input. */}
        }
        // Grid commands already reproduce ordinary observation work. Keep
        // separate facts only for recovery, which must not move current cells.
        const inGrid=type==='observation-fact'&&value&&typeof value==='object'
          &&'source' in value&&value.source&&typeof value.source==='object'
          &&'phase' in value.source&&value.source.phase==='input';
        if(!inGrid)runTrace.record(type,value,time);
        if(['grid-checkpoint','inventory-checkpoint','input-checkpoint','unknown-checkpoint','freshness-checkpoint'].includes(type)&&value&&typeof value==='object') {
          const checkpoint=value as {complete?:boolean;hash?:unknown};
          const hash=checkpoint.complete&&typeof checkpoint.hash==='string'&&/^[a-f0-9]{64}$/.test(checkpoint.hash)
            ?checkpoint.hash:null;
          if(type==='grid-checkpoint')capturedGridHash=hash;
          else if(type==='inventory-checkpoint')capturedInventoryHash=hash;
          else if(type==='input-checkpoint')capturedInputHash=hash;
          else if(type==='unknown-checkpoint')capturedUnknownHash=hash;
          else capturedFreshnessHash=hash;
        }
      }),
      ...replayInput?.options,
      ...(comparison?{
        replay:{kind:'loacard-capture',version:1,createdAt:startedAt!,source:'video',rowMode:'all',captureOnly:runCaptureOnly,seed:[],frames:[],truncated:false},
        replayInputs:comparison.frames,
      }:{}),
    },preparedComparison,runMode==='live'?callbacks.wrap((state:ScanMonitorState)=>{
      feedbackDeliveries++;feedbackSummary=monitorSummary(state);
      monitorPreview.publish(state);
      monitor.textContent=JSON.stringify(feedbackSummary,null,2);
    }):undefined);
    if(liveFailure)throw liveFailure;
    const state = currentState(); ended = !signal.aborted && !state?.interrupted; outcome = ended ? 'completed' : 'interrupted';
    message.textContent = !ended ? `중단된 부분 결과 · ${state?.status ?? '검사 중단'}` : '실행 전후 소스를 확인하고 있습니다.';
  } catch (error) {
    outcome = signal.aborted&&!liveFailure ? 'cancelled' : 'failed';
    runError=String(liveFailure??error).slice(0,2000);
    message.textContent = liveFailure?String(liveFailure):signal.aborted ? '검사를 중지했습니다. 저장 시 부분 결과로 표시합니다.' : String(error);
  } finally {
    mainThreadWork=mainThreadObserver?.stop()??null;
    // Close this owned source while its diagnostic callback scope still
    // accepts the terminal playback fact. No scanner/native reader is freed.
    liveInput?.dispose();
    callbacks.close();
    // Once handed off, the scanner owns detector/reader disposal even when its
    // watchdog returns early. Freeing those native resources here can race it.
    const cleanup=await Promise.allSettled([runComparison?.dispose(),preparedTransferred?undefined:preparedComparison?.dispose()]);
    const cleanupErrors=cleanup.filter(item=>item.status==='rejected').map(item=>String(item.reason).slice(0,500));
    if(cleanupErrors.length){ended=false;outcome='failed';runError=[runError,...cleanupErrors].filter(Boolean).join(' · ').slice(0,2000);}
    const measuredEnd=performance.now();
    elapsedMs = measuredEnd - clockStarted; finishedAt = new Date().toISOString();
    if(runClockOrigin)runClockOrigin.runReturnedAtMs=measuredEnd;
    if(pairedCollector){
      // Stop accepting late scanner callbacks before awaiting any PNG work.
      // This retention is diagnostic and excluded from scan timing above.
      message.textContent='선택한 카드와 이름 영역의 진단 이미지를 저장하고 있습니다.';
      try{pairedCropEvidence=await pairedCollector.finish();}
      catch(error){pairedCropEvidence={error:String(error).slice(0,1000)};}
      finally{try{await pairedCollector.dispose();}catch(error){
        pairedCropEvidence={evidence:pairedCropEvidence,cleanupError:String(error).slice(0,1000)};
      }}
    }
    if(sessionRun){
      const savingStarted=performance.now();sessionMessage.textContent='세션 청크 저장을 마무리하고 있습니다.';
      const timings:{finishMs:number|null;indexReadMs:number|null;detailsReadMs:number|null;executionSummaryMs:number|null}=
        {finishMs:null,indexReadMs:null,detailsReadMs:null,executionSummaryMs:null};
      try {
        let stageStarted=performance.now();
        persistedSessionFile=await sessionRun.finish(currentState(),ended);
        timings.finishMs=performance.now()-stageStarted;
        const sessionId=sessionRun.id;
        stageStarted=performance.now();
        const index=(await devSessionStore.listSessions()).find(item=>item.id===sessionId);
        timings.indexReadMs=performance.now()-stageStarted;
        stageStarted=performance.now();
        const details=await devSessionStore.getSessionDetails(sessionId);
        timings.detailsReadMs=performance.now()-stageStarted;
        stageStarted=performance.now();
        const restored=persistedSessionFile?.exact?await executionSummary(persistedSessionFile.exact,
          AbortSignal.any([page.signal,AbortSignal.timeout(120000)]),persistedSessionFile.metadata.exact):null;
        if(persistedSessionFile?.exact)timings.executionSummaryMs=performance.now()-stageStarted;
        sessionEvidence={id:sessionRun.id,index,journal:sessionRun.journalStats(),metadata:persistedSessionFile?.metadata,producedExact:devExact?.finishedStats,
          exactFinalization:details?.exactFinalization,
          execution:restored,timings,finishTiming:sessionRun.finalizationTiming(),finalizationMs:performance.now()-savingStarted};
        sessionMessage.textContent=`세션 ${index?.status??'미확인'} · ${(index?.bytes??0).toLocaleString()}바이트 · `+
          `카드 근거 ${restored?.inventory.matchesCapturedState===true?'일치':'미확인'} · 입력 선택 ${restored?.input.matchesCapturedState===true?'일치':'미확인'} · `+
          `미식별 상태 ${restored?.unknownLifecycle.matchesCapturedState===true?'일치':'미확인'} · `+
          `최신 필드 상태 ${restored?.freshness.matchesCapturedState===true?'일치':'미확인'}`;
      }catch(error){sessionEvidence={error:String(error),timings,finishTiming:sessionRun.finalizationTiming(),finalizationMs:performance.now()-savingStarted};sessionMessage.textContent=String(error);}
    }else await devExact?.dispose();
    runVisibility=visibilityObserver.dispose();
    if(liveInput&&liveTiming) {
      liveTiming.inputSeconds=liveInput.inputSeconds;liveTiming.durationSeconds=liveInput.durationSeconds;
      liveTiming.naturalEnd=liveInput.ended;liveInput.dispose();
    }
    video.pause(); video.removeAttribute('src'); video.load();
    objectUrls.forEach(url => URL.revokeObjectURL(url));
    // The run's abort signal may already be cancelled. Verify the end source
    // independently so partial results still carry useful provenance.
    try { sourceEnd = await sourceSnapshot(page.signal); }
    catch { /* A failed snapshot remains unknown, never a verified baseline. */ }
    sourceChanged = sourceInvalidated || (sourceStart && sourceEnd ? sourceStart.sourceDigest !== sourceEnd.sourceDigest : null);
    if (sourceChanged) {
      ended = false; outcome = 'source-changed';
      message.textContent = '검사 중 코드가 변경됐습니다. 이 결과는 비교 기준으로 사용하지 말고 다시 검사하세요.';
    } else if (ended && sourceChanged === null) {
      ended = false; outcome = 'source-unverified';
      message.textContent = '실행 소스를 확인하지 못했습니다. 비교 기준으로 사용하려면 다시 검사하세요.';
    } else if (ended) {
      const state = currentState();
      message.textContent = playbackOnly ? '재생 전달 대조 완료 · 카드 인식·획득 성능 검증 아님' : runCaptureOnly ? `획득 검사 완료 · ${state?.captureDiagnostics?.acquired ?? 0}크롭 · OCR 미실행`
        : `입력 처리 완료 · ${state?.cards.length ?? 0}종 (정확도 확인과 별개)`;
    }
    monitorPreview.setStatus({busy:false,sharing:false});
    // Readers and source verification have already settled. Archive separately
    // from capture/recognition timing, including useful partial and failed runs.
    const archiveController=new AbortController();controller=archiveController;
    if(replayEvidence){
      replayComparison=compareReplayResult(replayBaseline,latest?reproductionResult(latest):null,ended,replayEvidence.partial);
      replayComparisonMessage.textContent=JSON.stringify(replayComparison,null,2);
    }
    await archiveRun(AbortSignal.any([page.signal,archiveController.signal]));
    controller = undefined; busy(false);
  }
  if(!options)return null;
  if(!sourceStart||!sourceEnd)throw Error('일괄 비교의 실행 소스가 확인되지 않았습니다. 현재 개별 보고서를 보관하세요.');
  const observed=latest?reproductionResult(latest):{expected:null,read:0,unidentified:0,cards:[]};
  const fields=observed.cards.map(({id,name,awakening,extraCopies})=>({id,name,awakening,extraCopies})).sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0);
  const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(fields)));
  const cardFieldsHash=[...new Uint8Array(digest)].map(byte=>byte.toString(16).padStart(2,'0')).join('');
  // archiveRun fills this validated response asynchronously after the reset.
  const archive=archivedRun as ArchivedRun|null;
  return {completed:ended,outcome,expected:observed.expected,read:observed.read,review:observed.cards.filter(card=>card.review.length>0).length,
    unknown:observed.unidentified,cardFieldsHash,sourceStart:sourceStart.sourceDigest,sourceEnd:sourceEnd.sourceDigest,emptySeed:true,
    archive:archive?{ref:archive.file,sha256:archive.sha256}:null,elapsedMs,
    elapsedKind:runMode==='live'?'live-preparation-playback-and-drain':'offline-preparation-and-processing'};
}
form.addEventListener('submit',event=>{
  event.preventDefault();if(batchController)return;
  void runSelectedCase().catch(error=>{message.textContent=String(error);});
});

batchStart.addEventListener('click',async()=>{
  if(controller||batchController||pendingInternal)return;
  const selected=[...batchCases.selectedOptions];
  if(!selected.length||selected.length>16){batchStatus.textContent='비교할 사례를 1~16개 선택하세요.';return;}
  if(contrastNameFallback||preparedSource||inputProvider||pairedTargets.length||nativeAcquisition||rgbaRecovery||fractionalPortrait||minInputIntervalMs!==undefined||inputOfferFloorMs!==undefined||localCropPixels||nameRawResultPolicy!=='resample'||warmNameReaders){
    batchStatus.textContent='일괄 비교는 기본 /dev/scanner.html에서 실행하세요. 다른 입력 실험을 함께 사용하지 않습니다.';return;
  }
  const variant=batchVariant.value;
  if(variant!=='gray'&&variant!=='fractional'&&variant!=='contrast'){batchStatus.textContent='비교 방식을 선택하세요.';return;}
  const jobs:ScannerBatchJob[]=selected.flatMap(option=>(['baseline',variant] as const).map(variant=>({caseId:option.value,variant,mode:'offline'})));
  const labels=new Map(selected.map(option=>[option.value,option.text]));
  batchController=new AbortController();const signal=AbortSignal.any([page.signal,batchController.signal]);busy(true);
  batchResult.textContent='';
  if(batchDownloadUrl){URL.revokeObjectURL(batchDownloadUrl);batchDownloadUrl=undefined;}
  try{
    const report=await runScannerBatch(jobs,{signal,
      run:async(job,jobSignal)=>{
        corpusSelect.value=job.caseId;mode.value=job.mode;captureOnly.checked=false;sessionRecording.checked=false;filesInput.value='';
        const summary=await runSelectedCase({caseId:job.caseId,mode:job.mode,gray:job.variant==='gray',fractional:job.variant==='fractional',contrast:job.variant==='contrast',signal:jobSignal});
        if(!summary)throw Error('선행 실행이 끝나지 않았거나 비교 입력을 시작하지 못했습니다.');
        return summary;
      },
      onProgress:progress=>{
        if(page.signal.aborted)return;
        const active=progress.activeIndex===null?null:jobs[progress.activeIndex];
        batchStatus.textContent=active?`${progress.result.runs.length}/${jobs.length}개 완료 · ${labels.get(active.caseId)} · ${active.variant==='baseline'?'기본':active.variant==='gray'?'회색조':active.variant==='contrast'?'대비 보완':'미세 위치 보정'} · ${progress.phase==='starting'?'검사 중':'기록 저장 완료'}`:
          `${progress.result.runs.length}/${jobs.length}개 실행 · ${progress.result.status==='completed'?'일괄 실행 완료':'부분 결과'} · ${progress.result.clean?'수량·확인 항목 일치':'개별 판독 결과 확인 필요'}`;
        batchResult.textContent=JSON.stringify(progress.result,null,2);
      },
    });
    const metadata={...report,scope:'Sequential offline program observations with empty seeds. Semantic card fields exclude images, diagnostics and timing. No human truth or live-latency claim.'};
    const blob=new Blob([JSON.stringify(metadata,null,2)],{type:'application/json'});
    if(blob.size>256*1024)throw Error('일괄 비교 요약이 256KiB를 초과했습니다. 개별 실행 기록을 확인하세요.');
    batchDownloadUrl=URL.createObjectURL(blob);
  }catch(error){batchStatus.textContent=`일괄 비교 중단 · ${String(error).slice(0,1000)}`;}
  finally{batchController=undefined;(controller as AbortController|undefined)?.abort();controller=undefined;busy(false);}
});
batchSave.addEventListener('click',()=>{
  if(controller||batchController||!batchDownloadUrl)return;
  const anchor=document.createElement('a');anchor.href=batchDownloadUrl;anchor.download=`loacard-batch-${Date.now()}.json`;anchor.click();
});

refresh.addEventListener('click', () => { void loadCorpus(); });
corpusSelect.addEventListener('change', () => { if (corpusSelect.value) filesInput.value = ''; });
filesInput.addEventListener('change', () => { if (filesInput.files?.length) corpusSelect.value = ''; });
stop.addEventListener('click', () => {batchController?.abort();controller?.abort();});
window.addEventListener('pagehide', () => { batchController?.abort();controller?.abort(); page.abort();stateTrace.dispose();monitorPreview.dispose();if(batchDownloadUrl)URL.revokeObjectURL(batchDownloadUrl); });
if (import.meta.hot) {
  const invalidate = () => { batchController?.abort();if (controller) { sourceInvalidated = true; controller.abort(); } };
  import.meta.hot.on('vite:beforeUpdate', invalidate);
  import.meta.hot.dispose(() => { invalidate();stateTrace.dispose();monitorPreview.dispose(); import.meta.hot?.off('vite:beforeUpdate', invalidate); });
}
async function validationReport(signal:AbortSignal) {
  signal.throwIfAborted();
  if(reportBlob)return reportBlob;
  const execution=await stateTrace.snapshotBlob();signal.throwIfAborted();
  // Small values/counters only, with the canonical result consumed by corpus compare.
  // Never serialize raw ScannerState, which contains original frames and crops.
  const report = {
    version: 1, result: latest?reproductionResult(latest):{expected:null,read:0,unidentified:0,experience:null,cards:[]},
    diagnostics: latest?summary(latest):{status:'판독 관측 없이 실행 종료',noObservations:true},
    diagnosticSummary:createScanDiagnosticSummary(latest,ended),
    performance: { elapsedMs, clockOrigin:runClockOrigin, mainThreadWork, transportEncoding, inputPreparation, liveTiming, feedbackDeliveries, feedbackSummary,monitorPresentation:monitorPreview.stats(),feedbackReceipts:monitorPreview.feedbackStats(),live: latest?.livePerformance, recovery: latest?.recoveryPerformance,
      inputPipeline:latest?.liveInputPipeline,scrollPreview:latest?.scrollPreviewPerformance,sourceStore:latest?.sourceStore,
      nameOcr:latest?.nameOcrMetrics,
      scrollCaptureDiagnosticError:latest?.scrollCaptureDiagnosticError??null,
      presentation: latest?.resultPresentation, finishTiming: latest?.finishTiming,stateTrace:stateTrace.stats },
    replayEvidence,replayComparison,sessionEvidence,providerEvidence:comparison?.snapshot()??null,pairedCropEvidence,sourcePlaybackOrigin,
    ...(capturedGridHash||capturedInventoryHash||capturedInputHash||capturedUnknownHash||capturedFreshnessHash?{executionExpected:{
      ...(capturedGridHash?{gridHash:capturedGridHash}:{}),
      ...(capturedInventoryHash?{inventoryHash:capturedInventoryHash}:{}),
      ...(capturedInputHash?{inputHash:capturedInputHash}:{}),
      ...(capturedUnknownHash?{unknownHash:capturedUnknownHash}:{}),
      ...(capturedFreshnessHash?{freshnessHash:capturedFreshnessHash}:{}),
    }}:{}),runtimeConfiguration,completionCheck,
    validation: {
      caseId: runCaseId, mode:playbackOnly?'playback-only':replayEvidence?'recorded-input-reinterpretation':inputProvider?`${runMode}-${inputProvider}-v1`:runMode, input: inputDescription, captureOnly: runCaptureOnly,
      inputProvider:inputProvider?{requested:inputProvider,source:providerOriginal??null,prepared:providerPreparation??null,scheduling:'serial-all-decoded-samples',rawRecovery:false}:null,
      pairedCropTargets:pairedTargets,
      nameOptions:{grayFullRetry:runGrayNameFallback,recipe:runGrayNameFallback?'gray-first-line-v1':'disabled',rawResultPolicy:replayEvidence?.configuration.rawResultPolicy??nameRawResultPolicy,
        configuration:replayEvidence?.configuration??runNameConfiguration,prepared:warmNameReaders},
      rowMode: 'all', scheduling: playbackOnly?'native-playback-transport-control':replayEvidence?'recorded-input-sequential-reinterpretation':runMode==='live'?'paced-native-video-screen-loop':inputProvider?'offline-serial-custom-input-acquisition-worker':'offline-serial-input', hardwareConcurrency: navigator.hardwareConcurrency,
      screenOptions:runMode==='live'?{preparedSource,preparedSourceMode:preparedSource?preparedSourceMode:null,nativeAcquisition,rgbaRecovery,fractionalPortrait:runFractionalPortrait,minInputIntervalMs:minInputIntervalMs??null,inputOfferFloorMs:inputOfferFloorMs??null,localCropPixels,nameRawResultPolicy,trackFrames:false,parallelRecovery:true}:null,
      recordingEnabled:sessionEvidence!==null,
      ui:'production-monitor-panel',
      visibility:runVisibility,
      stateRecording:playbackOnly?'source-playback-callbacks-only':inputProvider?'grid-inventory-facts-and-provider-input-consumption':'grid-commands-inventory-evidence-input-selection-and-recovery-facts',
      inputOrder: runCaseId ? 'manifest' : 'file-list', timeUnknown: runImages,
      inputClock: replayEvidence?'recorded-capture-time; sequential reinterpretation':runMode==='live'?'browser-capture-clock; 1x media source':runImages ? 'synthetic-zero; order preserved, capture time unknown' : 'media-timeline',
      completed: ended, outcome, error:runError, startedAt, finishedAt, startedWithCards: replayEvidence?.seedCount??0,
      integrity: providerOriginal?'original-blob-sha256-verified-before-run':'not-checked-by-runner', build: import.meta.env.VITE_BUILD_REVISION ?? 'local',
      serverStartSignature: import.meta.env.VITE_REPLAY_SIGNATURE ?? null,
      sourceStart, sourceEnd, sourceChanged, browser: navigator.userAgent,
      interpretation: playbackOnly?`Playback transport control only; no detection or recognition. Continuous encoding: ${transportRecording}. Not scanner performance.`:runMode==='live'?'Program observation via paced video, not human-verified truth or OS screen-capture throughput.'
        :'Program observation, not human-verified expected values or live throughput.',
    },
  };
  // Embed bounded JSON string batches directly; do not parse them into a second
  // in-memory event array just to serialize the report again.
  const blob = new Blob([JSON.stringify(report,null,2).slice(0,-1),',"execution":',execution,'}'],{type:'application/json'});
  if (blob.size > 16 * 1024 * 1024) throw Error('검사 요약이 16 MiB를 초과해 저장하지 않았습니다.');
  reportBlob=blob;return blob;
}

async function archiveRun(signal:AbortSignal) {
  archivedRun=null;
  if(!runCaseId||!inputDescription.length)return;
  archiveMessage.textContent='로컬 검증 사례에 실행 기록을 저장하고 있습니다.';
  try {
    const saved=await archiveCorpusRun(runCaseId,await validationReport(signal),signal);
    archivedRun=saved;
    archiveMessage.textContent=`로컬 검증 사례에 ${saved.created?'기록했습니다':'같은 기록이 있습니다'} · ${saved.sha256.slice(0,12)} · 프로그램 관측 결과`;
    retryArchive.hidden=true;
  }catch(error) {
    archiveMessage.textContent=signal.aborted?'로컬 기록 저장이 중단됐습니다.':`${String(error)} 결과 JSON 저장도 사용할 수 있습니다.`;
    retryArchive.hidden=false;
  }
}

saveSession.addEventListener('click',()=>{
  if(controller||!persistedSessionFile)return;
  const url=URL.createObjectURL(createReproductionBundle(persistedSessionFile)),anchor=document.createElement('a');
  anchor.href=url;anchor.download=`loacard-session-${persistedSessionFile.metadata.sessionId??Date.now()}.loareplay`;anchor.click();
  setTimeout(()=>URL.revokeObjectURL(url),10000);
});
save.addEventListener('click', async() => {
  if ((!latest&&!reportBlob) || controller) return;
  controller=new AbortController();const signal=controller.signal;busy(true);
  try {
  const blob=await validationReport(signal);
  const url = URL.createObjectURL(blob), anchor = document.createElement('a'); anchor.href = url;
  anchor.download = `loacard-validation-${runCaseId?.slice(0, 12) ?? 'files'}-${Date.now()}.json`;
  anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch(error) {message.textContent=signal.aborted?'결과 저장 준비 중지':String(error);}
  finally {controller=undefined;busy(false);}
});
retryArchive.addEventListener('click',async()=>{
  if(controller||!reportBlob||!runCaseId)return;
  controller=new AbortController();const signal=controller.signal;busy(true);
  try {await archiveRun(signal);}
  finally {controller=undefined;busy(false);}
});
replayState.addEventListener('click',async()=>{
  if(controller||!latest)return;
  controller=new AbortController();const signal=controller.signal;busy(true);
  replayMessage.textContent='상태 기록을 재생하고 있습니다. OCR은 다시 실행하지 않습니다.';
  try {
    const replay=await replayRunStateTrace(await stateTrace.snapshotBlob(),signal);
    const checks=[
      {name:'진행창',expected:capturedGridHash,actual:replay.grid.hash},
      {name:'카드 근거',expected:capturedInventoryHash,actual:replay.inventory.hash},
      {name:'입력 선택',expected:capturedInputHash,actual:replay.input.settled?replay.input.hash:null},
      {name:'미식별 상태',expected:capturedUnknownHash,actual:replay.unknownLifecycle.complete?replay.unknownLifecycle.hash:null},
      {name:'최신 필드 상태',expected:capturedFreshnessHash,actual:replay.freshness.complete?replay.freshness.hash:null},
    ].filter(check=>check.expected!==null);
    const mismatch=checks.filter(check=>check.expected!==check.actual);
    const freshnessUnverified=replay.freshness.supported&&(!replay.freshness.complete||capturedFreshnessHash===null);
    replayMessage.textContent=freshnessUnverified?'상태 재생 미확인 · 최신 필드 상태의 전체 기록과 검증점이 필요합니다.'
      :!checks.length?'원래 상태 해시가 없어 일치 검증을 완료하지 못했습니다.'
      :mismatch.length?`상태 재생 불일치 · ${mismatch.map(check=>check.name).join(' · ')}`
      :`상태 재생 일치 · ${checks.map(check=>check.name).join(' · ')} · ${replay.grid.commands.toLocaleString()}개 지도 명령`;
  } catch(error) {replayMessage.textContent=signal.aborted?'상태 재생 중지':String(error);}
  finally {controller=undefined;busy(false);}
});
void loadCorpus();
