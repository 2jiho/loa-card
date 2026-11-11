import {parseMoveReuseProfile,validateMoveReuseProfileInput} from './move-reuse-profile';
import {compareReplayResult} from './replay-result';
import {observeMainThreadWork} from './main-thread-work';
import {recordContinuous} from '../src/features/card-scanner/capture/continuous-capture';
import type {ReproductionResult} from '../src/features/card-scanner/reproduction/scan-reproduction';
import {openVerifiedReplayCase,verifiedReplayRun,type ReplayProof} from './replay-run-integrity';
import {devReplayRecognitionOptions,reproductionInput} from '../src/features/card-scanner/reproduction/reproduction-input';
import {parseReplayComparisonOptions,selectReplayComparison} from './replay-comparison-options';
import {openReproduction} from '../src/features/card-scanner/reproduction/scan-reproduction';
import { runScanner } from '../src/features/card-scanner/orchestration/scanner';
import type { ScannerState } from '../src/features/card-scanner/orchestration/scanner';
import { createScanDiagnosticSummary,reproductionResult } from '../src/features/card-scanner/reproduction/scan-reproduction';
import type { SourceSnapshot } from './source-snapshot';
import {RunStateTrace,replayRunStateTrace,drainReplayScope,parseSourceBindingMetadataSummary,replaySourceUseFromFrame} from './run-state-trace';
import {prepareLiveVideoInput,type LiveVideoInput} from './live-video-input';
import type {ScanMonitorState} from '../src/features/card-scanner/ui/scan-monitor-store';
import {createMonitorPreview} from './scan-monitor-preview';
import {archiveCorpusRun,type ArchivedRun} from './run-archive-client';
import {runScannerBatch,type ScannerBatchJob,type ScannerBatchRunSummary} from './scanner-batch';
import {beginReproduction,createReproductionBundle} from '../src/features/card-scanner/reproduction/scan-reproduction';
import {watchRecordingReadiness} from '../src/features/card-scanner/reproduction/recording-readiness';
import {archivePendingReplaySessions,createArchiveDependencies} from '../src/features/card-scanner/reproduction/dev-replay-archive';
import {createIdleSessionArchive} from './idle-session-archive';
import {archiveDirectInputs,classifyDirectInputs,createDirectInputSelection} from './direct-input-client';
import type {DirectInputReceipt,DirectInputSelection} from './direct-input-client';
import type {ReproductionFile} from '../src/features/card-scanner/reproduction/scan-reproduction';
import type {ExactRecorder} from '../src/features/card-scanner/reproduction/exact-recording';
import {executionSummary} from '../src/features/card-scanner/reproduction/exact-recording-codec';
import {createExactRecording} from '../src/features/card-scanner/reproduction/exact-recording';
import {RGBA_WINDOW_POLICY} from '../src/features/card-scanner/reproduction/rgba-window-policy';
import {createReproductionSessionStore} from '../src/features/card-scanner/reproduction/reproduction-session-store';
import {recordingBudget} from './recording-budget';
import {prepareScanner,type PreparedScanner} from '../src/features/card-scanner/session/scanner-preparation';
import {parseScannerNameConfiguration} from '../src/features/card-scanner/session/scanner-name-configuration';
import {parseUnknownSourcePolicy} from '../src/features/card-scanner/session/unknown-source-policy';
import {loadVideoInput,VideoInputLoadTimeoutError,VIDEO_INPUT_LOAD_TIMEOUT_MS} from './video-input-loader';
import {createRunVisibilityObserver,type RunVisibilitySummary} from './run-visibility';
import type {createComparisonFrames} from './native-yuv-frames';
import {loadComparisonOriginal} from './comparison-original';
import {createRunCallbackScope} from './run-callback-scope';
import {assertNormalPairedCropRun,parsePairedCropTargets} from './paired-crop-config';
import {createScannerFeedback} from '../src/features/card-scanner/ui/scanner-feedback';
import type {createPairedCropCollector} from './paired-crop-collector';
import type {createRecognitionCropJournal} from './recognition-crop-journal';
import type {createCropIndexedDbSink} from './recognition-crop-indexeddb';
import type {RecognitionInputMeta} from '../src/features/card-scanner/recognition/recognition-input-observer';
import {cropRereadChoices} from './crop-reread-core';
import {parseLatestPixelGate,parsePreparedCropProofRequest,parseRestoredHandoff,parseScannerExperiment,parseAdvisoryFence,validateAdvisoryFenceInput} from './latest-pixel-gate-report';
import type {createReaderCropBindingObserver,ReaderCropComparison} from './reader-crop-binding';
import {createFrameObstructionDiagnostics} from './frame-obstruction-diagnostics';
import {createCountSourceDiagnostics} from './count-source-diagnostics';
import {parseRejectedTransport,validateRejectedTransportInput,parseRejectedReplay,validateRejectedReplayInput,rejectedReplayEvidence} from './rejected-transport-options';

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
let directFileSelection:DirectInputSelection|undefined;
const corpusSelect = document.querySelector<HTMLSelectElement>('#corpus')!;
const corpusStatus = document.querySelector<HTMLParagraphElement>('#corpus-status')!;
const refresh = document.querySelector<HTMLButtonElement>('#refresh-corpus')!;
const captureOnly = document.querySelector<HTMLInputElement>('#capture-only')!;
const sessionRecording=document.querySelector<HTMLInputElement>('#session-recording')!;
const cropRecording=document.querySelector<HTMLInputElement>('#crop-recording')!;
const cropRunId=document.querySelector<HTMLInputElement>('#crop-run-id')!;
const listCrops=document.querySelector<HTMLButtonElement>('#list-crops')!;
const cropRuns=document.querySelector<HTMLSelectElement>('#crop-runs')!;
const verifyCrops=document.querySelector<HTMLButtonElement>('#verify-crops')!;
const cropReads=document.querySelector<HTMLSelectElement>('#crop-reads')!;
const rereadCrop=document.querySelector<HTMLButtonElement>('#reread-crop')!;
const deleteCrops=document.querySelector<HTMLButtonElement>('#delete-crops')!;
const cropMessage=document.querySelector<HTMLParagraphElement>('#crop-message')!;
let verifiedCropRunId:string|null=null;
function clearCropChoices(){verifiedCropRunId=null;cropReads.replaceChildren(new Option('먼저 기록을 확인하세요',''));cropReads.disabled=true;rereadCrop.disabled=true;}
const devRecordingBudget=recordingBudget(new URLSearchParams(location.search).get('recordingBudgetMiB'));
const devSessionStore=createReproductionSessionStore({dbName:devRecordingBudget.database,limits:{maxBytes:devRecordingBudget.bytes}});
let sessionEvidence:unknown=null;
let persistedSessionFile:ReproductionFile|undefined;
const saveSession=document.querySelector<HTMLButtonElement>('#save-session')!;
const sessionMessage=document.querySelector<HTMLParagraphElement>('#session-message')!;
const sessionCorpusMessage=document.querySelector<HTMLParagraphElement>('#session-corpus-message')!;
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
const unknownSourcePolicy=parseUnknownSourcePolicy(location.search);
if(unknownSourcePolicy){
  const note=document.querySelector<HTMLParagraphElement>('#unknown-policy-note')!;
  note.hidden=false;
  note.textContent='실험 중: 다른 프레임에서 카드를 다시 보여줘도 이전 미식별 입력이 자동 해소되지 않습니다. 같은 입력 재시도 또는 새 스캔이 필요할 수 있으며 자동 완료가 막힐 수 있습니다.';
}
const nativeAcquisition=new URLSearchParams(location.search).get('native')==='1';
const replayCompare=parseReplayComparisonOptions(location.search);
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
const restoredHandoff=parseRestoredHandoff(location.search,preparedSource);
const preparedCropProof=parsePreparedCropProofRequest(location.search,preparedSource);
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
const rejectedTransport=parseRejectedTransport(location.search);
const rejectedReplay=parseRejectedReplay(location.search);
const latestPixelGate=parseLatestPixelGate(location.search);
const completionDrain=parseScannerExperiment(location.search,'completionDrain');
const fastOcrAssist=parseScannerExperiment(location.search,'fastOcrAssist');
const obstructionFence=parseScannerExperiment(location.search,'obstructionFence');
const freshnessParam=new URLSearchParams(location.search).get('freshness');
if(freshnessParam!==null&&freshnessParam!=='1'&&freshnessParam!=='2')throw Error('최신 관측 실험은 freshness=1 또는 freshness=2만 지원합니다.');
const freshnessVersion=freshnessParam==='2'?2 as const:1 as const;
const advisoryFence=parseAdvisoryFence(location.search);
const moveReuseProfile=parseMoveReuseProfile(location.search);
const frameObstructionProbe=parseScannerExperiment(location.search,'frameObstructionProbe');
const frameObstructionHash=parseScannerExperiment(location.search,'frameObstructionHash');
const countSourceProbe=parseScannerExperiment(location.search,'countSourceProbe');
const hiddenUnknownProbe=parseScannerExperiment(location.search,'hiddenUnknownProbe');
if(hiddenUnknownProbe&&unknownSourcePolicy)throw Error('숨은 실패 진단은 기본 group-v1 정책에서만 사용할 수 있습니다.');
const overflowOptions=new URLSearchParams(location.search).getAll('visualOverflow');
if(overflowOptions.length>1||overflowOptions.some(value=>value!=='0'&&value!=='1'))throw Error('시각 판독 비교는 visualOverflow=0 또는 1만 지원합니다.');
const visualOverflow=overflowOptions[0]==='1';
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
if(fastOcrAssist&&(visualOverflow||preparedSource||inputProvider||nativeAcquisition||rgbaRecovery||fractionalPortrait||inputFps!==undefined||inputOfferFloorMs!==undefined||grayNameFallback||localCropPixels||warmNameReaders||nameRawResultPolicy!=='resample'||contrastNameFallback||pairedTargets.length||latestPixelGate||completionDrain||obstructionFence||advisoryFence||moveReuseProfile||frameObstructionProbe||frameObstructionHash||countSourceProbe||hiddenUnknownProbe||unknownSourcePolicy||freshnessVersion!==1||rejectedTransport||rejectedReplay))
  throw Error('OCR 양도 비교는 다른 실험 옵션 없이 기본 입력으로 실행하세요.');
if(visualOverflow&&(preparedSource||inputProvider||nativeAcquisition||rgbaRecovery||fractionalPortrait||inputFps!==undefined||inputOfferFloorMs!==undefined||grayNameFallback||localCropPixels||warmNameReaders||nameRawResultPolicy==='continue'||contrastNameFallback||pairedTargets.length))throw Error('시각 판독 병렬 비교는 기본 입력에서 단독 실행하세요.');
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
if(visualOverflow){providerNotice.hidden=false;providerNotice.textContent='시각 판독 병렬 실험 · 입력과 카드 판독·자원 사용을 기본 방식과 비교';}
if(fastOcrAssist){providerNotice.hidden=false;providerNotice.textContent='개발 실험 · 유휴 시각 판독 lane의 OCR 양도 · 입력 누락·지연 및 정확성 별도 검증 필요';}
if(latestPixelGate){providerNotice.hidden=false;providerNotice.textContent='최신 입력 픽셀 종료 게이트 실험 · 영상 1배속 원본 video 경로만 지원 · 미관측 입력은 증명하지 않음';}
if(obstructionFence){providerNotice.hidden=false;providerNotice.textContent='가림 재관측 실험 · 영상 1배속 원본 video 경로만 지원 · 상태 재생은 가림 판단만 검증';}
if(freshnessVersion===2){providerNotice.hidden=false;providerNotice.textContent='개발 실험 · 다른 관측의 미확정 근거를 보존 · 카드 정답이나 모든 입력 완전성 증명 아님';}
if(moveReuseProfile){providerNotice.hidden=false;providerNotice.textContent='개발 실험 · 행 이동 캐시 비교 계측 · 결과는 실시간 속도 향상이나 카드 정답이 아닙니다';}
if(advisoryFence){providerNotice.hidden=false;providerNotice.textContent='개발 실험 · 표본 가림 후보가 감지되면 전체 최신 카드 재확인까지 종료 보류 · 후보 없음은 가림 부재가 아닙니다';}
if(frameObstructionProbe){providerNotice.hidden=false;providerNotice.textContent='다중 칸 가림 후보 진단 · 화면 픽셀 검사 결과만 별도 기록 · OCR·상태 재생·전체 프레임 커버리지 아님';}
if(countSourceProbe){providerNotice.hidden=false;providerNotice.textContent='장수 관측 출처 진단 · 메타데이터만 저장 · 물리 입력이나 독립 재관측 검증 아님';}
if(localCropPixels){providerNotice.hidden=false;providerNotice.textContent='카드 픽셀 전달 실험 · 영상 1배속 · 정수·불투명 카드만 직접 전달 · 기본 스캐너와 별도 검증';}
if(rejectedTransport){providerNotice.hidden=false;providerNotice.textContent='개발 실험 · 거절된 카드의 반복 이미지 전달 생략 · 전체 픽셀 재현이나 실제 공유 속도 증명 아님';}
if(rejectedReplay){providerNotice.hidden=false;providerNotice.textContent=`저장 입력 Worker 비교 · ${rejectedReplay} · 원래 입력 출처, Worker 입력 픽셀 및 실시간 성능 미검증`;}
if(nameRawResultPolicy==='continue'){providerNotice.hidden=false;providerNotice.textContent='이름 OCR 연속 판독 실험 · 기본 영상·이미지 입력 · 같은 판독 안의 원본 이름 결과만 재사용 · 기본 스캐너와 별도 검증';}
if(replayCompare){providerNotice.hidden=false;providerNotice.textContent=`저장 입력 비교 · ${replayCompare==='baseline'?'기본':'미세 위치 보정'} · 원래 판독 재현이 아닌 별도 순차 재판독`;}
let comparison:ReturnType<typeof createComparisonFrames>|undefined;
let providerOriginal:{sha256:string;bytes:number}|undefined;
let replayOriginalProof:ReplayProof<ReproductionFile>|undefined,replayOriginalUsed:ReproductionFile|undefined;
let providerPreparation:{readers:number;visualWorkers:number;acquisitionReady:boolean}|undefined;
let pairedCropEvidence:unknown=null;
let cropEvidence:unknown=null;
let frameObstructionEvidence:unknown=null;
let countSourceEvidence:unknown=null;
let readerCropEvidence:unknown=null;
let sourceBindingEvidence:{summary:ReturnType<typeof parseSourceBindingMetadataSummary>;traceAccepted:boolean}|null=null;
let hiddenUnknownEvidence:unknown=null;
let verifyingCrops=false;
let sourcePlaybackOrigin:unknown=null;
let controller: AbortController | undefined;
let batchController:AbortController|undefined,batchDownloadUrl:string|undefined,batchInitialized=false;
let pendingInternal:object|null=null;
const devArchive=createIdleSessionArchive({
  idle:()=>!page.signal.aborted&&!controller&&!batchController&&!pendingInternal&&!verifyingCrops,
  archive:(signal,notify)=>archivePendingReplaySessions(signal,notify,createArchiveDependencies(devSessionStore)),
  notify:event=>{
    sessionCorpusMessage.textContent=event.state==='saving'?'재현 입력을 로컬 검증 사례에 보관 중입니다.':
      event.state==='stored'?event.storage==='raw'?'원시 부분 기록 보관 · 재생 가능한 입력 없음':
        event.storage==='raw-and-replay'?`원시 기록과 재현 구간 보관 · ${event.coverage==='partial'?'부분 기록':'재현 범위 미확인'}`:'재현 입력을 로컬 검증 사례에 보관했습니다.':
      event.state==='waiting'?'재현 기록 봉인을 기다리고 있습니다.':event.state==='unavailable'?'재현 입력이 없어 브라우저 진단만 보호합니다.':
        '로컬 검증 사례 보관 실패 · 브라우저 기록 보호 중';
  },
});
let archivedRun:ArchivedRun|null=null,runGrayNameFallback=grayNameFallback,runFractionalPortrait=fractionalPortrait;
let runNameConfiguration=nameConfiguration;
const monitorPreview=createMonitorPreview(document.querySelector<HTMLElement>('#monitor-preview')!,()=>controller?.abort());
let latest: ScannerState | undefined;
let inputDescription: InputDescription[] = [];
let runCaseId: string | null = null;
let ended = false;
let runCaptureOnly = false;
let runImages = false;
let replayEvidence:{kind:string;seedCount:number;partial:boolean;configurationRecorded:boolean;configuration:typeof nameConfiguration;
  devRecognition:ReturnType<typeof devReplayRecognitionOptions>;verifiedFrames:number;
  comparison:ReturnType<typeof selectReplayComparison>|null;
  sourceUseTrace:{version:1;runId:string;scope:'report-local-decoded-frame-metadata';coverage:'unknown';readerPixelsVerified:false}|null}|null=null;
let startedAt: string | null = null;
let finishedAt: string | null = null;
let elapsedMs = 0;
let inputPreparation:VideoInputPreparation|null=null;
let directRegistration:{startedAt:string;elapsedMs:number;outcome:'registered'|'failed'|'cancelled';bytes:number;caseId:string|null;
  selectionId:string|null;selectionSha256:string|null;fileModifiedTimes:readonly {index:number;lastModifiedMs:number|null}[]}|null=null;
let mainThreadWork:ReturnType<ReturnType<typeof observeMainThreadWork>['stop']>|null=null;
let transportEncoding:{bytes:number|null;peakPendingBytes:number;finishMs:number;warnings:string[]}|null=null;
let outcome: 'completed' | 'cancelled' | 'failed' | 'interrupted' | 'source-changed' | 'source-unverified' = 'failed';
let sourceStart: SourceSnapshot | null = null;
let sourceEnd: SourceSnapshot | null = null;
let sourceChanged: boolean | null = null;
let sourceInvalidated = false;
let stateTrace = new RunStateTrace();
let capturedGridHash:string|null = null;
let capturedInventoryHash:string|null=null,capturedInputHash:string|null=null,capturedUnknownHash:string|null=null,capturedFreshnessHash:string|null=null,capturedObstructionHash:string|null=null;
let runMode:'offline'|'live'='offline';
let runShareRecordingId:string|null=null;
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
  const locked=value||!!batchController||verifyingCrops;
  const scanLocked=locked||pendingInternal!==null;
  start.disabled = filesInput.disabled = corpusSelect.disabled = captureOnly.disabled = sessionRecording.disabled = cropRecording.disabled = mode.disabled = refresh.disabled = scanLocked;
  verifyCrops.disabled=deleteCrops.disabled=listCrops.disabled=cropRunId.disabled=cropRuns.disabled=scanLocked;
  const cropVerified=verifiedCropRunId!==null&&verifiedCropRunId===cropRunId.value.trim();
  cropReads.disabled=scanLocked||!cropVerified||cropReads.options.length<2;
  rereadCrop.disabled=scanLocked||!cropVerified||!cropReads.value;
  batchVariant.disabled=scanLocked;batchCases.disabled=scanLocked;batchStart.disabled=scanLocked||batchCases.options.length===0;batchSave.disabled=locked||!batchDownloadUrl;
  cleanupStatus.hidden=locked||pendingInternal===null;
  cleanupStatus.textContent=cleanupStatus.hidden?'':'이전 판독기 정리 중입니다. 정리가 끝나면 새 검사를 시작할 수 있습니다. 오래 지속되면 이 페이지를 새로고침해 주세요.';
  saveSession.disabled=locked||!persistedSessionFile;
  stop.disabled = !value&&!batchController; save.disabled = locked || (!latest&&!reportBlob);
  replayState.disabled = locked || !latest;
  retryArchive.disabled=locked||!reportBlob||!runCaseId;
  if(scanLocked)devArchive.cancel();else devArchive.schedule();
}
async function sourceSnapshot(signal: AbortSignal): Promise<SourceSnapshot> {
  const response = await fetch('/__corpus/environment', { cache: 'no-store', signal: AbortSignal.any([signal, AbortSignal.timeout(10000)]) });
  if (!response.ok) throw new Error('실행 소스를 확인하지 못했습니다. 코드 변경이 끝난 뒤 다시 검사하세요.');
  return response.json();
}
interface SingleRunOptions {caseId:string;mode:'offline'|'live';gray:boolean;fractional:boolean;contrast:boolean;signal:AbortSignal}
async function runSelectedCase(options?:SingleRunOptions):Promise<ScannerBatchRunSummary|null> {
  if(controller||pendingInternal)return null;
  const replayTraceRunId=crypto.randomUUID();
  let selectedId = options?.caseId??corpusSelect.value;
  // Direct inputs retain FileList order too; no implicit filename sorting.
  const files = options?[]:[...filesInput.files ?? []];
  if(!selectedId)try{classifyDirectInputs(files);}
  catch(error){message.textContent=error instanceof Error?error.message:'코퍼스 사례 또는 영상·이미지·.loareplay를 선택하세요.';return null;}
  devArchive.cancel();controller = new AbortController(); const runController=controller;
  const signal=AbortSignal.any([runController.signal,page.signal,...(options?[options.signal]:[])]);
  const runRecording=options?false:sessionRecording.checked;
  const runCropRecording=options?false:cropRecording.checked;
  const frameProbeDiagnostics=frameObstructionProbe?createFrameObstructionDiagnostics():undefined;
  const countDiagnostics=countSourceProbe?createCountSourceDiagnostics():undefined;
  runFractionalPortrait=options?.fractional??fractionalPortrait;
  runGrayNameFallback=options?.gray??grayNameFallback;archivedRun=null;
  runNameConfiguration=options?parseScannerNameConfiguration({version:1,rawResultPolicy:'resample',contrastNameFallback:options.contrast}):nameConfiguration;
  const callbacks=createRunCallbackScope(()=>controller===runController);
  let lastTraceAccepted=false,traceCallbackOpen=true;
  let liveInput:LiveVideoInput|undefined,liveFailure:unknown;
  let preparedComparison:PreparedScanner|undefined;
  let preparedTransferred=false;
  let runComparison:ReturnType<typeof createComparisonFrames>|undefined;
  let pairedCollector:ReturnType<typeof createPairedCropCollector>|undefined;
  let cropJournal:ReturnType<typeof createRecognitionCropJournal>|undefined;
  let readerBinding:ReturnType<typeof createReaderCropBindingObserver>|undefined;
  const readerCropResults:ReaderCropComparison[]=[];
  let readerCropOmitted=0;
  let cropSink:Awaited<ReturnType<typeof createCropIndexedDbSink>>|undefined;
  let cropId:string|undefined;
  let mainThreadObserver:ReturnType<typeof observeMainThreadWork>|undefined;
  let sessionRun:ReturnType<typeof beginReproduction>|undefined,devExact:ExactRecorder|undefined;
  let recordingUiLive=true;
  let clockStarted = performance.now(); startedAt = new Date().toISOString();
  runClockOrigin={clock:'page-performance-now',runStartedAtMs:clockStarted,scannerTraceOriginMs:null,runReturnedAtMs:null};
  replayEvidence=null;replayBaseline=null;replayComparison=null;replayComparisonMessage.textContent='';
  latest = undefined; ended = false; elapsedMs = 0; inputPreparation=null;directRegistration=null; finishedAt = null; outcome = 'failed'; inputDescription = [];
  comparison=undefined;providerOriginal=undefined;providerPreparation=undefined;replayOriginalProof=undefined;replayOriginalUsed=undefined;
  pairedCropEvidence=null;
  cropEvidence=runCropRecording?{requested:true,status:'not-started',scope:'recognition-crops-only'}:null;
  frameObstructionEvidence=null;
  countSourceEvidence=null;readerCropEvidence=null;sourceBindingEvidence=null;hiddenUnknownEvidence=null;
  cropMessage.textContent='';
  mainThreadWork=null;
  transportEncoding=null;
  sourcePlaybackOrigin=null;
  persistedSessionFile=undefined;sessionEvidence=null;sessionMessage.textContent='';
  reportBlob=undefined;runError=null;archiveMessage.textContent='';retryArchive.hidden=true;
  sourceStart = sourceEnd = null; sourceChanged = null; sourceInvalidated = false;
  stateTrace.dispose();
  stateTrace = new RunStateTrace();capturedGridHash=null;capturedInventoryHash=null;capturedInputHash=null;capturedUnknownHash=null;capturedFreshnessHash=null;capturedObstructionHash=null;replayMessage.textContent='';
  const runTrace=stateTrace;
  runtimeConfiguration=completionCheck=null;
  runShareRecordingId=null;
  runMode=options?.mode??(mode.value==='live'?'live':'offline');liveTiming=null;feedbackDeliveries=0;feedbackSummary=null;monitor.textContent='';
  monitorPreview.clear();monitorPreview.setStatus({busy:true,sharing:false,preparing:true});
  const feedbackProbe=createScannerFeedback({now:()=>performance.now(),signal});
  monitorPreview.setFeedback(feedbackProbe);
  const visibilityObserver=createRunVisibilityObserver(document);
  runVisibility=visibilityObserver.snapshot();
  runCaseId = selectedId || null; runCaptureOnly = options?false:captureOnly.checked; runImages = false;
  busy(true); result.textContent = ''; message.textContent = '입력을 준비하고 있습니다.';
  try {
    let directReceipt:DirectInputReceipt|undefined;
    if(!selectedId){
      const registeredAt=performance.now(),startedAt=new Date().toISOString(),bytes=files.reduce((sum,file)=>sum+file.size,0),
        fileModifiedTimes=files.map((file,index)=>({index,lastModifiedMs:Number.isSafeInteger(file.lastModified)&&file.lastModified>=0?file.lastModified:null}));
      // A restored FileList has no observed change event; never invent its
      // selection time. Keep the same selection identity for a retry.
      directFileSelection??=createDirectInputSelection(files,null);
      try{
        directReceipt=await archiveDirectInputs(files,{signal,selection:directFileSelection,onProgress:progress=>{
          if(!signal.aborted)message.textContent=progress.phase==='hashing'?
            `입력 무결성 확인 중 · ${progress.index+1} / ${progress.count}개`:'입력을 로컬 검증 사례에 보관하고 있습니다.';
        }});
        selectedId=directReceipt.caseId;runCaseId=selectedId;
        directRegistration={startedAt,elapsedMs:performance.now()-registeredAt,outcome:'registered',bytes,caseId:selectedId,
          selectionId:directReceipt.selection.id,selectionSha256:directReceipt.selection.sha256,fileModifiedTimes};
      }catch(error){directRegistration={startedAt,elapsedMs:performance.now()-registeredAt,outcome:signal.aborted?'cancelled':'failed',bytes,caseId:null,
        selectionId:directFileSelection.id,selectionSha256:null,fileModifiedTimes};throw error;}
    }
    sourceStart = await sourceSnapshot(signal);
    // Keep source hashing overhead outside the scanner/preparation measurement.
    clockStarted = performance.now(); startedAt = new Date().toISOString();
    runClockOrigin.runStartedAtMs=clockStarted;
    let urls: string[], images: boolean, replayFile:ReproductionFile|undefined;
    if (selectedId) {
      const response = await fetch(`/__corpus/cases/${selectedId}`, { signal });
      if (!response.ok) throw new Error('코퍼스 입력이 없거나 유효하지 않습니다. npm run corpus -- verify로 확인하세요.');
      const item: CorpusCase = await response.json();
      if(directReceipt&&(item.id!==directReceipt.caseId||item.kind!==directReceipt.kind||item.inputs.length!==directReceipt.inputs.length||
        item.inputs.some((input,index)=>{const expected=directReceipt!.inputs[index];return input.index!==expected.index||input.bytes!==expected.bytes||
          input.sha256!==expected.sha256||!input.name.toLowerCase().endsWith(expected.extension);})))
        throw Error('등록된 입력 사례가 선택한 파일과 일치하지 않습니다.');
      if(item.kind==='replay'){
        if(item.id!==selectedId||item.inputs.length!==1)throw Error('재현 사례 ID 또는 입력 파일이 일치하지 않습니다.');
        message.textContent='재현 파일 원본을 읽고 있습니다.';
        const verified=await openVerifiedReplayCase(item.id,item.inputs[0],signal,openReproduction,
          {onProgress:(bytes,total)=>{if(!signal.aborted)message.textContent=`재현 파일 무결성 확인 중 · ${Math.floor(bytes/total*100)}%`;}});
        replayFile=verified.replay;replayOriginalProof=verified.proof;
      }
      images = item.kind === 'images'; urls = item.inputs.map(input => input.url);
      inputDescription = item.inputs.map(({ index, name, bytes, type, sha256 }) => ({ index, name, bytes, type, sha256 }));
    } else throw Error('등록된 입력 사례가 없습니다.');
    runImages = images;
    if(completionDrain&&!latestPixelGate)throw Error('입력 drain 실험에는 latestPixelGate=1이 필요합니다.');
    if(latestPixelGate&&(images||replayFile||runMode!=='live'||runCaptureOnly||inputProvider||preparedSource||nativeAcquisition||rgbaRecovery||playbackOnly||options))
      throw Error('최신 입력 픽셀 종료 게이트는 원본 영상 1배속·판독 경로에서만 검사하세요.');
    validateMoveReuseProfileInput({enabled:moveReuseProfile,images,replay:!!replayFile,mode:runMode,captureOnly:runCaptureOnly,
      cropRecording:runCropRecording,recording:runRecording,batch:!!options,caseId:runCaseId,mediaTypes:inputDescription.map(input=>input.type)});
    validateAdvisoryFenceInput({enabled:advisoryFence,images,replay:!!replayFile,mode:runMode,captureOnly:runCaptureOnly,
      cropRecording:runCropRecording,recording:runRecording,batch:!!options,caseId:runCaseId,
      mediaTypes:inputDescription.map(input=>input.type)});
    validateRejectedTransportInput({enabled:rejectedTransport,images,replay:!!replayFile,mode:runMode,captureOnly:runCaptureOnly,
      cropRecording:runCropRecording,recording:runRecording,batch:!!options,caseId:runCaseId,
      mediaTypes:inputDescription.map(input=>input.type),recordingMode});
    if(obstructionFence&&(images||replayFile||runMode!=='live'||runCaptureOnly||inputProvider||preparedSource||nativeAcquisition||rgbaRecovery||playbackOnly||options||
      latestPixelGate||runCropRecording||runRecording||visualOverflow||localCropPixels||fractionalPortrait||grayNameFallback||inputFps!==undefined||inputOfferFloorMs!==undefined||pairedTargets.length||warmNameReaders||nameRawResultPolicy!=='resample'||contrastNameFallback))
      throw Error('가림 재관측 실험은 다른 실험·상세 기록 없이 원본 영상 1배속 판독으로 검사하세요.');
    if(frameObstructionProbe&&(images||replayFile||runMode!=='live'||runCaptureOnly||inputProvider||preparedSource||nativeAcquisition||rgbaRecovery||playbackOnly||options||
      latestPixelGate||obstructionFence||runCropRecording||runRecording||visualOverflow||localCropPixels||fractionalPortrait||grayNameFallback||inputFps!==undefined||inputOfferFloorMs!==undefined||pairedTargets.length||warmNameReaders||nameRawResultPolicy!=='resample'||contrastNameFallback))
      throw Error('다중 칸 가림 후보 진단은 다른 실험·상세 기록 없이 원본 영상 1배속 판독으로 검사하세요.');
    if(frameObstructionHash&&!frameObstructionProbe)throw Error('ROI 해시 진단은 다중 칸 가림 후보 진단과 함께 사용하세요.');
    if(countSourceProbe&&(images||replayFile||runMode!=='live'||runCaptureOnly||inputProvider||preparedSource||nativeAcquisition||rgbaRecovery||playbackOnly||options||
      latestPixelGate||obstructionFence||frameObstructionProbe||runCropRecording||runRecording||visualOverflow||localCropPixels||fractionalPortrait||grayNameFallback||inputFps!==undefined||inputOfferFloorMs!==undefined||pairedTargets.length||warmNameReaders||nameRawResultPolicy!=='resample'||contrastNameFallback))
      throw Error('장수 관측 출처 진단은 다른 실험·상세 기록 없이 원본 영상 1배속 판독으로 검사하세요.');
    if(runCropRecording&&(runCaptureOnly||runRecording||playbackOnly||pairedTargets.length))
      throw Error('판독 크롭 기록은 판독 모드에서 선택 관측·전체 세션 저장 없이 실행하세요.');
    if(continuousRecording&&(playbackOnly||runMode!=='live'||images||replayFile||runRecording||inputProvider||preparedSource||nativeAcquisition||rgbaRecovery||recordingCodecPolicy||options))
      throw Error('연속 기록 대조는 단일 영상 1배속·세션 저장 끔·입력 실험 끔에서 실행하세요.');
    if(transportRecording&&!playbackOnly)throw Error('인코딩 대조는 playbackOnly=1에서만 실행하세요.');
    if(playbackOnly&&(runMode!=='live'||images||replayFile||runCaptureOnly||runRecording||inputProvider||
      preparedSource||nativeAcquisition||rgbaRecovery||localCropPixels||warmNameReaders||pairedTargets.length||options||
      runFractionalPortrait||inputFps!==undefined||runGrayNameFallback||requestedNamePolicy!==null||recordingCodecPolicy))
      throw Error('재생 전달 대조는 단일 영상·1배속·획득만 검사 끔·세션 저장 끔·입력 실험 끔으로 실행하세요.');
    if(replayCompare&&(!replayFile?.exact||options||runMode!=='offline'||runCaptureOnly||runRecording||runCropRecording))
      throw Error('저장 입력 비교는 픽셀 기록이 있는 단일 재현 파일·전체 프레임 순차 판독·기록 끔으로 실행하세요.');
    if(replayFile&&(runMode!=='offline'||runCaptureOnly||runRecording||preparedSource||nativeAcquisition||inputProvider||rgbaRecovery||runFractionalPortrait||inputFps!==undefined||runGrayNameFallback||localCropPixels||visualOverflow||warmNameReaders||requestedNamePolicy!==null||pairedTargets.length||recordingCodecPolicy))
      throw Error('저장된 입력은 실험 옵션 없이 전체 프레임 순차·판독 모드·세션 저장 끔으로 실행하세요.');
    const replayInput=replayFile?reproductionInput(replayFile,signal,count=>{if(replayEvidence)replayEvidence.verifiedFrames=count;}):undefined;
    validateRejectedReplayInput({variant:rejectedReplay,exact:!!replayFile?.exact,source:replayInput?.options.replay.source,
      seedCount:replayInput?.seed.length??-1,mode:runMode,captureOnly:runCaptureOnly,cropRecording:runCropRecording,
      recording:runRecording,batch:!!options,caseId:runCaseId,recordingMode:recordingMode??undefined});
    let replayDevRecognition:ReturnType<typeof devReplayRecognitionOptions>|undefined;
    let replayComparisonOptions:ReturnType<typeof selectReplayComparison>|null=null;
    if(replayInput){
      replayDevRecognition=devReplayRecognitionOptions(replayInput.options.nameConfiguration,replayInput.devRecognitionOptions,
        {fractionalPortrait:runFractionalPortrait,grayNameFallback:runGrayNameFallback});
      if(replayCompare){
        replayComparisonOptions=selectReplayComparison(replayCompare,replayInput.options.nameConfiguration,
          replayInput.configurationRecorded,replayInput.devRecognitionOptions);
        replayDevRecognition={...replayDevRecognition,applied:replayComparisonOptions.applied};
      }
      runFractionalPortrait=replayDevRecognition.applied.fractionalPortrait;
      runGrayNameFallback=replayDevRecognition.applied.grayNameFallback;
    }
    if(replayInput)replayOriginalUsed=replayFile;
    if(replayFile)replayBaseline=replayFile.metadata.result;
    if(replayInput)replayEvidence={kind:replayFile!.exact?'stored-exact-pixels':'decoded-recorded-video',seedCount:replayInput.seed.length,
      partial:replayInput.options.replay.truncated,configurationRecorded:replayInput.configurationRecorded,configuration:replayInput.options.nameConfiguration,
      devRecognition:replayDevRecognition!,verifiedFrames:0,comparison:replayComparisonOptions,
      sourceUseTrace:replayFile!.exact?{version:1,runId:replayTraceRunId,scope:'report-local-decoded-frame-metadata',coverage:'unknown',readerPixelsVerified:false}:null};
    if(pairedTargets.length&&!inputProvider)assertNormalPairedCropRun({
      mode:runMode,images,inputCount:urls.length,recording:runRecording,captureOnly:runCaptureOnly,
      preparedSource,nativeAcquisition,rgbaRecovery,fractionalPortrait:runFractionalPortrait,fpsRequested:inputFps!==undefined,
      grayNameFallback:runGrayNameFallback,localCropPixels,nameRawResultPolicy,warmNameReaders,
    });
    if(images&&runMode==='live')throw Error('사진은 전체 프레임 순차 검사로 실행하세요.');
    if(fastOcrAssist&&(images||replayFile||urls.length!==1||runMode!=='live'||runCaptureOnly||runRecording||runCropRecording||playbackOnly||options))
      throw Error('OCR 양도 비교는 단일 영상 1배속·전체 판독·상세 기록 끔으로 실행하세요.');
    if(visualOverflow&&(images||runMode!=='live'||runCaptureOnly||runRecording))throw Error('시각 판독 병렬 비교는 영상 1배속·전체 판독·세션 저장 끔으로 실행하세요.');
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
      const sessionSourceStart=sourceStart.sourceDigest;
      let recordingIssue=false;
      sessionRun=beginReproduction([],{browser:navigator.userAgent,catalog:'dev-corpus',build:`source-snapshot:${sessionSourceStart}`},
        {record:true,exact:devExact,store:devSessionStore,nameConfiguration:runNameConfiguration,protectForArchive:true,
          devRecognitionOptions:{version:1,fractionalPortrait:runFractionalPortrait,grayNameFallback:runGrayNameFallback},
          onRecordingIssue:()=>{recordingIssue=true;if(recordingUiLive&&controller===runController&&!signal.aborted)
            sessionMessage.textContent='세션 기록 일부가 누락될 수 있습니다. 카드 검사는 계속됩니다.';},
          sourceVersion:async()=>{
            let endDigest:string|null=null;try{endDigest=(await sourceSnapshot(page.signal)).sourceDigest;}catch{/* Boundary remains unknown. */}
            const hotUpdate=sourceInvalidated;
            return {version:1,startDigest:sessionSourceStart,endDigest,startBeforeScanner:true,hotUpdate,
              changed:hotUpdate?true:endDigest?sessionSourceStart!==endDigest:null};
          }});
      if(!recordingIssue)sessionMessage.textContent='세션 기록 저장을 준비하고 있습니다.';
      watchRecordingReadiness(sessionRun.ready,()=>recordingUiLive&&controller===runController&&!signal.aborted,
        ()=>{if(!recordingIssue)sessionMessage.textContent='세션 입력 기록 중';},
        ()=>{sessionMessage.textContent='세션 기록을 저장할 수 없습니다. 카드 검사는 계속됩니다.';});
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
        monitorPreview.setStatus({busy:true,sharing:false,preparing:true});
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
    if(runCropRecording){
      cropId=crypto.randomUUID();clearCropChoices();cropRunId.value=cropId;
      try{
        const [{createCropIndexedDbSink},{createRecognitionCropJournal}]=await Promise.all([
          import('./recognition-crop-indexeddb'),import('./recognition-crop-journal')]);
        signal.throwIfAborted();
        cropSink=await createCropIndexedDbSink(cropId);signal.throwIfAborted();
        cropJournal=createRecognitionCropJournal({version:2,captureBoundary:'recognition-input-v2',sessionId:null,
          build:sourceStart.sourceDigest,catalog:`source-snapshot:${sourceStart.sourceDigest}`,
          modelSignature:null,nameConfiguration:replayInput?.options.nameConfiguration??runNameConfiguration,
          recognitionOptions:{fractionalPortrait:runFractionalPortrait,grayNameFallback:runGrayNameFallback}},cropSink);
        cropMessage.textContent=`판독 크롭 기록 중 · ${cropId} · 원본 화면은 포함하지 않음`;
      }catch(error){
        cropSink?.close();cropSink=undefined;
        cropEvidence={requested:true,id:cropId,status:'unavailable',scope:'recognition-crops-only',error:String(error).slice(0,1000)};
        cropMessage.textContent=`판독 크롭 기록을 시작하지 못했습니다. 스캔은 계속합니다 · ${String(error).slice(0,300)}`;
        signal.throwIfAborted();
      }
    }
    if(preparedCropProof){
      const {createReaderCropBindingObserver}=await import('./reader-crop-binding');
      signal.throwIfAborted();
      readerBinding=createReaderCropBindingObserver(null,signal,value=>{
        if(controller!==runController)return;
        if(readerCropResults.length<512)readerCropResults.push(value);else readerCropOmitted++;
      },{},pairedCollector??cropJournal?.observer);
    }
    preparedTransferred=true;
    const internalToken={};if(!playbackOnly)pendingInternal=internalToken;
    mainThreadObserver=observeMainThreadWork();
    if(playbackOnly){
      runtimeConfiguration={playbackOnly:true,transportRecording,latestPixelGateRequested:latestPixelGate,obstructionFenceRequested:obstructionFence,playbackSourcePresentation:visiblePlaybackSource?'visible':'detached'};
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
      monitorPreview.setStatus({busy:true,sharing:runMode==='live',preparing:false});
      if(liveInput)void liveInput.start().catch(error=>{if(!signal.aborted){liveFailure=error;runController.abort(error);}});
    }), 'all', images?urls:undefined, runCaptureOnly, {
      ...sessionRun?.options,
      feedbackProbe,unknownSourcePolicy,...(hiddenUnknownProbe?{hiddenUnknownProbe:true,
        onHiddenUnknownSummary:callbacks.wrap((value:unknown)=>{hiddenUnknownEvidence=value;})}:{}),
      onInternalSettled:()=>{
        if(pendingInternal!==internalToken)return;
        pendingInternal=null;
        if(!page.signal.aborted&&!controller&&!batchController)busy(false);
      },
      ...(readerBinding||pairedCollector||cropJournal?{recognitionObserver:readerBinding?.observer??pairedCollector??cropJournal?.observer}:{}),
      nameConfiguration:replayInput?.options.nameConfiguration??runNameConfiguration,comparisonInput:!!inputProvider,continuousRecording:continuousRecording??undefined,
      recordingMode:recordingMode??sessionRun?.options.recordingMode,
      preparedSource,preparedSourceMode,restoredHandoff,preparedCropProof,nativeAcquisition,rgbaRecovery,fractionalPortrait:runFractionalPortrait,minInputIntervalMs,inputOfferFloorMs,grayNameFallback:runGrayNameFallback,localCropPixels,visualOverflow,fastOcrAssist,rejectedTransport,rejectedReplay,nameRawResultPolicy:replayInput?.options.nameConfiguration.rawResultPolicy??nameRawResultPolicy,
      ...(latestPixelGate?{latestPixelGate:true}:{}),
      ...(completionDrain?{completionDrain:true}:{}),
      ...(obstructionFence?{obstructionFence:true}:{}),
      freshnessVersion,
      ...(advisoryFence?{advisoryFence:true}:{}),
      ...(moveReuseProfile?{moveReuseProfile:true}:{}),
      ...(frameObstructionProbe?{frameObstructionProbe:true,frameObstructionEvent:callbacks.wrap(frameProbeDiagnostics!.record)}:{}),
      ...(frameObstructionHash?{frameObstructionHash:true}:{}),
      ...(countSourceProbe?{countSourceProbe:true,countSourceRecord:(event:Parameters<NonNullable<typeof countDiagnostics>['record']>[0])=>controller===runController&&countDiagnostics!.record(event)}:{}),
      traceAck:()=>traceCallbackOpen&&controller===runController&&lastTraceAccepted,
      trace:callbacks.wrap((type:string,value:unknown,time:number)=>{
        lastTraceAccepted=false;
        if(type==='scanner-clock'&&runClockOrigin&&value&&typeof value==='object'){
          const anchor=value as {version?:unknown;clock?:unknown;phase?:unknown;originMs?:unknown};
          if(anchor.version===1&&anchor.clock==='page-performance-now'&&anchor.phase==='input-and-recognition'
            &&typeof anchor.originMs==='number'&&Number.isFinite(anchor.originMs)&&anchor.originMs>=0)
            runClockOrigin.scannerTraceOriginMs=anchor.originMs;
        }
        if(type==='frame'&&runComparison)runComparison.noteConsumed(value);
        if(type==='frame'&&replayEvidence?.sourceUseTrace){
          let sourceUse:unknown=null;
          try{sourceUse=replaySourceUseFromFrame(value,replayTraceRunId);}catch{/* Record a dropped fact; never invent provenance. */}
          runTrace.record('replay-source-use',sourceUse,time);
        }
        if(type==='configuration'||type==='completion-check') {
          try {
            const encoded=JSON.stringify(value);
            if(encoded.length<=8192) {
              const detached:unknown=JSON.parse(encoded);
              if(type==='configuration')runtimeConfiguration={
                ...(detached&&typeof detached==='object'&&!Array.isArray(detached)?detached:{configuration:detached}),
                recordingCodecPolicy:recordingCodecPolicy??null,
                recordingBudgetBytes:devRecordingBudget.bytes,
                restoredHandoffRequested:restoredHandoff,
      preparedCropProofRequested:preparedCropProof,
      rejectedTransportRequested:rejectedTransport||rejectedReplay==='reduced',
                rejectedReplayRequested:rejectedReplay??null,
                latestPixelGateRequested:latestPixelGate,
                completionDrainRequested:completionDrain,
                fastOcrAssistRequested:fastOcrAssist,
                obstructionFenceRequested:obstructionFence,
                advisoryFenceRequested:advisoryFence,
                moveReuseProfileRequested:moveReuseProfile,
                frameObstructionProbeRequested:frameObstructionProbe,
                frameObstructionHashRequested:frameObstructionHash,countSourceProbeRequested:countSourceProbe,
                hiddenUnknownProbeRequested:hiddenUnknownProbe,
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
        if(!inGrid)lastTraceAccepted=runTrace.record(type,value,time);
        if(type==='source-binding-metadata-summary'){
          try{sourceBindingEvidence={summary:parseSourceBindingMetadataSummary(value),traceAccepted:lastTraceAccepted};}
          catch{sourceBindingEvidence=null;}
        }
        if(['grid-checkpoint','inventory-checkpoint','input-checkpoint','unknown-checkpoint','freshness-checkpoint','obstruction-checkpoint'].includes(type)&&value&&typeof value==='object') {
          const checkpoint=value as {complete?:boolean;hash?:unknown};
          const hash=checkpoint.complete&&typeof checkpoint.hash==='string'&&/^[a-f0-9]{64}$/.test(checkpoint.hash)
            ?checkpoint.hash:null;
          if(type==='grid-checkpoint')capturedGridHash=hash;
          else if(type==='inventory-checkpoint')capturedInventoryHash=hash;
          else if(type==='input-checkpoint')capturedInputHash=hash;
          else if(type==='unknown-checkpoint')capturedUnknownHash=hash;
          else if(type==='freshness-checkpoint')capturedFreshnessHash=hash;
          else capturedObstructionHash=hash;
        }
      }),
      ...replayInput?.options,
      // Server-side recording of the share (docs/dev-recording.md): on by default, ?rec=0 to measure without it, never for a replay.
      shareRecording:new URLSearchParams(location.search).get('rec')==='0'?'off' as const:'on' as const,
      onShareRecording:(id:string)=>{runShareRecordingId=id;},
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
    recordingUiLive=false;
    if(readerBinding){
      const before=readerBinding.stats();readerBinding.close();
      const accountingComplete=before.pending===0&&before.captures===before.delivered&&before.failures===0&&!before.countersTruncated&&readerCropOmitted===0;
      readerCropEvidence={requested:true,scope:'reader-canvas-snapshot-vs-worker-claim',
        status:before.captures===0?'no-input':accountingComplete?'recorded':'partial',accountingComplete,
        pendingAtClose:before.pending,omittedResults:readerCropOmitted,stats:before,results:readerCropResults};
    }
    mainThreadWork=mainThreadObserver?.stop()??null;
    // Close this owned source while its diagnostic callback scope still
    // accepts the terminal playback fact. No scanner/native reader is freed.
    liveInput?.dispose();
    traceCallbackOpen=false;callbacks.close();frameProbeDiagnostics?.close();countDiagnostics?.close();
    frameObstructionEvidence=frameProbeDiagnostics?.snapshot()??null;
    countSourceEvidence=countDiagnostics?.snapshot()??null;
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
    if(cropJournal){
      const cropFinishStarted=performance.now();
      let cropTimeout:ReturnType<typeof setTimeout>|undefined;
      try{
        const timeout=new Promise<never>((_,reject)=>{cropTimeout=setTimeout(()=>reject(Error('판독 크롭 기록 마무리 시간 초과')),10000);});
        const checkpoint=await Promise.race([cropJournal.finish(),timeout]);
        const complete=checkpoint.complete&&ended&&pendingInternal===null;
        cropEvidence={requested:true,id:cropId,status:complete?'complete':'partial',scope:'recognition-crops-only',checkpoint,
          scanEnded:ended,scannerSettled:pendingInternal===null,finalizationMs:performance.now()-cropFinishStarted};
        cropMessage.textContent=`판독 크롭 ${complete?'기록 완료':'부분 기록'} · ${checkpoint.captured}/${checkpoint.attempts}회 · `+
          `고유 ${checkpoint.unique}개 · 공유 ${checkpoint.shared}개 · 누락 ${checkpoint.lost}개${checkpoint.reason?` · ${checkpoint.reason}`:''}`;
      }catch(error){
        cropEvidence={requested:true,id:cropId,status:'partial',scope:'recognition-crops-only',error:String(error).slice(0,1000),
          finalizationMs:performance.now()-cropFinishStarted};
        cropMessage.textContent=`판독 크롭 부분 기록 · ${String(error).slice(0,300)}`;
      }finally{clearTimeout(cropTimeout);cropSink?.close();}
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
        const match=(value:boolean|null|undefined)=>value===true?'일치':value===false?'불일치':'미확인';
        sessionMessage.textContent=`저장 세션 ${index?.status??'미확인'} · ${(index?.bytes??0).toLocaleString()}바이트 · 저장된 입력의 상태: `+
          `카드 근거 ${match(restored?.inventory.matchesCapturedState)} · 입력 선택 ${match(restored?.input.matchesCapturedState)} · `+
          `미식별 상태 ${match(restored?.unknownLifecycle.matchesCapturedState)} · 최신 필드 ${match(restored?.freshness.matchesCapturedState)}`+
          `${index?.reason?` · ${index.reason}`:''}`;
      }catch(error){sessionEvidence={error:String(error),timings,finishTiming:sessionRun.finalizationTiming(),finalizationMs:performance.now()-savingStarted};sessionMessage.textContent=String(error);}
    }else await devExact?.dispose();
    runVisibility=visibilityObserver.dispose();
    if(liveInput&&liveTiming) {
      liveTiming.inputSeconds=liveInput.inputSeconds;liveTiming.durationSeconds=liveInput.durationSeconds;
      liveTiming.naturalEnd=liveInput.ended;liveInput.dispose();
    }
    video.pause(); video.removeAttribute('src'); video.load();
    // The run's abort signal may already be cancelled. Verify the end source
    // independently so partial results still carry useful provenance.
    try { sourceEnd = await sourceSnapshot(page.signal); }
    catch { /* A failed snapshot remains unknown, never a verified baseline. */ }
    sourceChanged = sourceInvalidated || (sourceStart && sourceEnd ? sourceStart.sourceDigest !== sourceEnd.sourceDigest : null);
    if(runCropRecording&&sourceChanged!==false&&cropEvidence&&typeof cropEvidence==='object'){
      cropEvidence={...cropEvidence,status:'partial',sourceChanged};
      cropMessage.textContent+=' · 실행 소스 변경 또는 확인 불가';
    }
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
cropRuns.addEventListener('change',()=>{clearCropChoices();if(cropRuns.value)cropRunId.value=cropRuns.value;});
cropRunId.addEventListener('input',clearCropChoices);
cropReads.addEventListener('change',()=>{rereadCrop.disabled=!verifiedCropRunId||verifiedCropRunId!==cropRunId.value.trim()||!cropReads.value||!!controller||!!batchController||verifyingCrops||pendingInternal!==null;});
rereadCrop.addEventListener('click',()=>{
  if(!verifiedCropRunId||verifiedCropRunId!==cropRunId.value.trim()||!cropReads.value||controller||batchController||verifyingCrops||pendingInternal!==null)return;
  const target=new URL('./crop-reread.html',location.href);
  target.searchParams.set('run',verifiedCropRunId);target.searchParams.set('read',cropReads.value);
  try{
    // Keep the unsaved scanner report and session in this tab. Open an empty
    // tab under the user's click first so a blocked popup can be reported.
    const opened=window.open('','_blank');
    if(!opened){cropMessage.textContent='새 탭을 열지 못했습니다. 브라우저의 팝업 차단을 확인해 주세요.';return;}
    try{opened.opener=null;opened.location.href=target.href;}
    catch(error){opened.close();throw error;}
  }catch{cropMessage.textContent='재판독 탭을 열지 못했습니다. 브라우저 설정을 확인해 주세요.';}
});
listCrops.addEventListener('click',async()=>{
  if(controller||batchController||pendingInternal||verifyingCrops)return;
  verifyingCrops=true;busy(true);cropMessage.textContent='저장된 판독 크롭 기록을 읽고 있습니다.';
  try{
    const {listCropIndexedDbRuns}=await import('./recognition-crop-indexeddb');
    const listed=await listCropIndexedDbRuns();
    cropRuns.replaceChildren(new Option('기록 선택',''),...listed.runs.map(run=>new Option(
      `${run.id} · ${run.status==='open'?'미봉인':run.status==='complete'?'저널 봉인':'부분 기록'} · ${run.events}개 이벤트`,run.id)));
    cropMessage.textContent=`저장된 기록 ${listed.runs.length}개${listed.truncated?' · 일부만 표시':''} · 미봉인 기록은 무결성 확인 시 부분 기록입니다.`;
  }catch(error){cropMessage.textContent=`기록 목록을 읽지 못했습니다 · ${String(error).slice(0,500)}`;}
  finally{verifyingCrops=false;busy(false);}
});
verifyCrops.addEventListener('click',async()=>{
  if(controller||batchController||pendingInternal||verifyingCrops)return;
  const id=cropRunId.value.trim();if(!id){cropMessage.textContent='기록 ID를 입력하세요.';return;}
  clearCropChoices();verifyingCrops=true;busy(true);cropMessage.textContent='판독 크롭 기록의 순서와 픽셀 해시를 확인하고 있습니다.';
  let run:Awaited<ReturnType<typeof import('./recognition-crop-indexeddb')['loadCropIndexedDbRun']>>|undefined;
  try{
    const [{loadCropIndexedDbRun},{replayRecognitionCropJournal}]=await Promise.all([
      import('./recognition-crop-indexeddb'),import('./recognition-crop-journal')]);
    run=await loadCropIndexedDbRun(id);
    const retained:{readId:number;meta:RecognitionInputMeta}[]=[];
    const result=await replayRecognitionCropJournal(run.seed,run.events,run.checkpoint,run.read,(event,meta)=>{retained.push({readId:event.readId,meta});},
      AbortSignal.any([page.signal,AbortSignal.timeout(120000)]));
    const selectable=cropRereadChoices(retained,run.events);
    cropReads.replaceChildren(new Option('관측 선택',''),...selectable.choices.map(choice=>new Option(
      `${choice.needsReview?'확인 필요 · ':''}${choice.readId}번 · ${choice.phase==='input'?'수집':'복구'} ${choice.captureTime.toFixed(2)}초 · ${choice.slot+1}칸 · ${choice.stage} · ${choice.name??'이름 미식별'}`,String(choice.readId))));
    verifiedCropRunId=id;
    const timing=run.seed.version===2?'v2 판독 직전 픽셀':'v1 판독 종료 시점 픽셀 · 당시 입력 동일 여부 미확인';
    cropMessage.textContent=`무결성 확인 ${result.complete?'완료':'부분 기록'} · 크롭 ${result.crops}회 · `+
      `고유 ${result.unique}개 · 공유 ${result.shared}개 · ${timing} · 선택 가능 ${selectable.total}건`+
      `${selectable.omitted?` (앞 ${selectable.choices.length}건 표시)`:''} · 원본 화면 재현은 수행하지 않음`;
  }catch(error){cropMessage.textContent=`판독 크롭 무결성 확인 실패 · ${String(error).slice(0,500)}`;}
  finally{run?.close();verifyingCrops=false;busy(false);}
});
deleteCrops.addEventListener('click',async()=>{
  if(controller||batchController||pendingInternal||verifyingCrops)return;
  const id=cropRunId.value.trim();if(!id){cropMessage.textContent='삭제할 기록 ID를 입력하세요.';return;}
  if(!window.confirm(`이 브라우저에서 판독 크롭 기록 ${id}만 삭제할까요? 이 작업은 되돌릴 수 없습니다.`))return;
  verifyingCrops=true;busy(true);
  try{
    const {deleteCropIndexedDbRun}=await import('./recognition-crop-indexeddb');
    const deleted=await deleteCropIndexedDbRun(id);clearCropChoices();
    cropMessage.textContent=deleted?'선택한 판독 크롭 기록을 삭제했습니다.':'해당 기록을 찾지 못했습니다.';
  }catch(error){cropMessage.textContent=`기록을 삭제하지 못했습니다 · ${String(error).slice(0,500)}`;}
  finally{verifyingCrops=false;busy(false);}
});
corpusSelect.addEventListener('change', () => { if (corpusSelect.value) {filesInput.value = '';directFileSelection=undefined;} });
filesInput.addEventListener('change', () => {
  directFileSelection=undefined;
  const files=[...filesInput.files??[]];
  if(files.length){
    corpusSelect.value = '';
    try{directFileSelection=createDirectInputSelection(files,new Date().toISOString());}catch{/* Invalid selections are reported on start. */}
  }
});
stop.addEventListener('click', () => {batchController?.abort();controller?.abort();});
window.addEventListener('pagehide', () => { devArchive.dispose();batchController?.abort();controller?.abort(); page.abort();stateTrace.dispose();monitorPreview.dispose();if(batchDownloadUrl)URL.revokeObjectURL(batchDownloadUrl); });
if (import.meta.hot) {
  const invalidate = () => { batchController?.abort();if (controller) { sourceInvalidated = true; controller.abort(); } };
  import.meta.hot.on('vite:beforeUpdate', invalidate);
  import.meta.hot.dispose(() => { devArchive.dispose();invalidate();stateTrace.dispose();monitorPreview.dispose(); import.meta.hot?.off('vite:beforeUpdate', invalidate); });
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
    performance: { shareRecordingId:runShareRecordingId, elapsedMs, clockOrigin:runClockOrigin, mainThreadWork, transportEncoding, directRegistration, inputPreparation, liveTiming, feedbackDeliveries, feedbackSummary,monitorPresentation:monitorPreview.stats(),feedbackReceipts:monitorPreview.feedbackStats(),live: latest?.livePerformance, recovery: latest?.recoveryPerformance,
      inputPipeline:latest?.liveInputPipeline,scrollPreview:latest?.scrollPreviewPerformance,sourceStore:latest?.sourceStore,
      rejectedTransport:latest?.rejectedTransport??null,
      readAttempts:latest?.readAttemptStats??null,
      visualOverflow:latest?.visualOverflow,
      fastOcrAssist:latest?.fastOcrAssist??null,
      restoredHandoff:latest?.restoredHandoff??null,
      completionPixelGate:latest?.completionPixelGate??null,
      completionInputDiagnostic:latest?.completionInputDiagnostic??null,
      completionDrainExperiment:latest?.completionDrainExperiment??null,
      obstructionExperiment:latest?.obstructionExperiment??null,
      advisoryExperiment:latest?.advisoryExperiment??null,
      frameObstructionProbe:latest?.frameObstructionProbe??null,
      countSourceProbe:latest?.countSourceProbe??null,
      nameOcr:latest?.nameOcrMetrics,
      scrollCaptureDiagnosticError:latest?.scrollCaptureDiagnosticError??null,
      presentation: latest?.resultPresentation, finishTiming: latest?.finishTiming,stateTrace:stateTrace.stats },
    replayEvidence,replayComparison,sessionEvidence,providerEvidence:comparison?.snapshot()??null,pairedCropEvidence,cropEvidence,frameObstructionEvidence,countSourceEvidence,readerCropEvidence,sourceBindingEvidence,hiddenUnknownEvidence,sourcePlaybackOrigin,
    ...(capturedGridHash||capturedInventoryHash||capturedInputHash||capturedUnknownHash||capturedFreshnessHash||capturedObstructionHash?{executionExpected:{
      ...(capturedGridHash?{gridHash:capturedGridHash}:{}),
      ...(capturedInventoryHash?{inventoryHash:capturedInventoryHash}:{}),
      ...(capturedInputHash?{inputHash:capturedInputHash}:{}),
      ...(capturedUnknownHash?{unknownHash:capturedUnknownHash}:{}),
      ...(capturedFreshnessHash?{freshnessHash:capturedFreshnessHash}:{}),
      ...(capturedObstructionHash?{obstructionHash:capturedObstructionHash}:{}),
    }}:{}),runtimeConfiguration,completionCheck,
    validation: {
      caseId: runCaseId, mode:playbackOnly?'playback-only':replayEvidence?'recorded-input-reinterpretation':inputProvider?`${runMode}-${inputProvider}-v1`:runMode, input: inputDescription, captureOnly: runCaptureOnly,
      latestPixelGateRequested:latestPixelGate,
      restoredHandoffRequested:restoredHandoff,
      preparedCropProofRequested:preparedCropProof,
      rejectedTransportRequested:rejectedTransport||rejectedReplay==='reduced',
      rejectedReplay:rejectedReplay?rejectedReplayEvidence(rejectedReplay):null,
      completionDrainRequested:completionDrain,
      fastOcrAssistRequested:fastOcrAssist,
      obstructionFenceRequested:obstructionFence,
      freshnessVersion,
      advisoryFenceRequested:advisoryFence,
      moveReuseProfileRequested:moveReuseProfile,
      frameObstructionProbeRequested:frameObstructionProbe,
      frameObstructionHashRequested:frameObstructionHash,countSourceProbeRequested:countSourceProbe,
      inputProvider:inputProvider?{requested:inputProvider,source:providerOriginal??null,prepared:providerPreparation??null,scheduling:'serial-all-decoded-samples',rawRecovery:false}:null,
      pairedCropTargets:pairedTargets,
      nameOptions:{grayFullRetry:runGrayNameFallback,recipe:runGrayNameFallback?'gray-first-line-v1':'disabled',rawResultPolicy:replayEvidence?.configuration.rawResultPolicy??nameRawResultPolicy,
        configuration:replayEvidence?.configuration??runNameConfiguration,prepared:warmNameReaders},
      rowMode: 'all', scheduling: playbackOnly?'native-playback-transport-control':replayEvidence?(rejectedReplay?'recorded-screen-input-sequential-worker-reinterpretation':'recorded-input-sequential-reinterpretation'):runMode==='live'?'paced-native-video-screen-loop':inputProvider?'offline-serial-custom-input-acquisition-worker':'offline-serial-input', hardwareConcurrency: navigator.hardwareConcurrency,
      screenOptions:runMode==='live'?{preparedSource,preparedSourceMode:preparedSource?preparedSourceMode:null,nativeAcquisition,rgbaRecovery,fractionalPortrait:runFractionalPortrait,minInputIntervalMs:minInputIntervalMs??null,inputOfferFloorMs:inputOfferFloorMs??null,localCropPixels,nameRawResultPolicy,latestPixelGateRequested:latestPixelGate,fastOcrAssistRequested:fastOcrAssist,obstructionFenceRequested:obstructionFence,advisoryFenceRequested:advisoryFence,moveReuseProfileRequested:moveReuseProfile,frameObstructionProbeRequested:frameObstructionProbe,frameObstructionHashRequested:frameObstructionHash,countSourceProbeRequested:countSourceProbe,rejectedTransportRequested:rejectedTransport,trackFrames:false,parallelRecovery:true}:null,
      recordingEnabled:sessionEvidence!==null,
      ui:'production-monitor-panel',
      visibility:runVisibility,
      stateRecording:playbackOnly?'source-playback-callbacks-only':inputProvider?'grid-inventory-facts-and-provider-input-consumption':'grid-commands-inventory-evidence-input-selection-and-recovery-facts',
      obstructionStateReplay:obstructionFence?(capturedObstructionHash?'reducer-state-checkpoint-recorded':'reducer-state-unverified'):'not-requested',
      inputOrder: runCaseId ? 'manifest' : 'file-list', timeUnknown: runImages,
      inputClock: replayEvidence?'recorded-capture-time; sequential reinterpretation':runMode==='live'?'browser-capture-clock; 1x media source':runImages ? 'synthetic-zero; order preserved, capture time unknown' : 'media-timeline',
      completed: ended, outcome, error:runError, startedAt, finishedAt, startedWithCards: replayEvidence?.seedCount??0,
      integrity: (providerOriginal&&outcome!=='cancelled')||verifiedReplayRun(replayOriginalProof,{caseId:runCaseId,inputs:inputDescription,
        replay:replayOriginalUsed,started:replayEvidence!==null,outcome})?'original-blob-sha256-verified-before-run':'not-checked-by-runner', build: import.meta.env.VITE_BUILD_REVISION ?? 'local',
      serverStartSignature: import.meta.env.VITE_REPLAY_SIGNATURE ?? null,
      sourceStart, sourceEnd, sourceChanged, browser: navigator.userAgent,
      interpretation: rejectedReplay?'Stored scanner input reread with acquisition Worker and screen replay semantics; original capture source and Worker input pixels not attested, not live throughput or human truth.':replayEvidence?.comparison?'Explicit stored-input counterfactual reread; not original recognition settings, human truth, or live throughput.':playbackOnly?`Playback transport control only; no detection or recognition. Continuous encoding: ${transportRecording}. Not scanner performance.`:runMode==='live'?'Program observation via paced video, not human-verified truth or OS screen-capture throughput.'
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
  replayMessage.textContent='현재 실행의 별도 상태 기록을 재생하고 있습니다. 저장 세션 검사와 별개이며 OCR은 다시 실행하지 않습니다.';
  try {
    const replay=await replayRunStateTrace(await stateTrace.snapshotBlob(),signal);
    const checks=[
      {name:'진행창',expected:capturedGridHash,actual:replay.grid.hash},
      {name:'카드 근거',expected:capturedInventoryHash,actual:replay.inventory.hash},
      {name:'입력 선택',expected:capturedInputHash,actual:replay.input.settled?replay.input.hash:null},
      {name:'미식별 상태',expected:capturedUnknownHash,actual:replay.unknownLifecycle.complete?replay.unknownLifecycle.hash:null},
      {name:'최신 필드 상태',expected:capturedFreshnessHash,actual:replay.freshness.complete?replay.freshness.hash:null},
      {name:'가림 판단 상태',expected:capturedObstructionHash,actual:replay.obstruction.complete?replay.obstruction.hash:null},
    ].filter(check=>check.expected!==null);
    const mismatch=checks.filter(check=>check.expected!==check.actual);
    const freshnessUnverified=replay.freshness.supported&&(!replay.freshness.complete||capturedFreshnessHash===null);
    const obstructionUnverified=obstructionFence&&(!replay.obstruction.supported||!replay.obstruction.complete||capturedObstructionHash===null);
    replayMessage.textContent=obstructionUnverified?'현재 실행 상태 재생 미확인 · 가림 판단 상태의 전체 기록과 검증점이 필요합니다.'
      :freshnessUnverified?'현재 실행 상태 재생 미확인 · 최신 필드 상태의 전체 기록과 검증점이 필요합니다.'
      :!checks.length?'현재 실행의 원래 상태 해시가 없어 일치 검증을 완료하지 못했습니다.'
      :mismatch.length?`현재 실행 상태 재생 불일치 · ${mismatch.map(check=>check.name).join(' · ')}`
      :`현재 실행 상태 재생 일치 · ${checks.map(check=>check.name).join(' · ')} · ${replay.grid.commands.toLocaleString()}개 지도 명령 · 가림 판단은 상태만 재생 · 픽셀·저장 세션의 완전성과는 별개 · 추정 위치 표시는 일치 검증 제외`;
    const drain=drainReplayScope(completionDrain,latest.drainInputLoss?{drainInputLoss:latest.drainInputLoss}:{});
    replayMessage.textContent+=drain.reportedLoss?' · 입력 손실 진단 기록 있음: 손실 부채와 자동 종료 판단은 재생·검증되지 않았습니다.'
      :' · 입력 손실 부채와 자동 종료 판단은 재생·검증되지 않았습니다. 손실 기록이 없어도 무손실을 뜻하지 않습니다.';
  } catch(error) {replayMessage.textContent=signal.aborted?'상태 재생 중지':String(error);}
  finally {controller=undefined;busy(false);}
});
void loadCorpus();
