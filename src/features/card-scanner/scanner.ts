import {ScanGrid,type ScanGridSnapshot} from './scan-grid';
import {copyScannerInput,normalizeScannerInputFrame} from './scanner-input-frame';
import type {ScannerInputFrame,ScannerInputProvenance} from './scanner-input-frame';
import type {DecodedRgbaMetadata} from './decoded-rgba-client';
import {withMediaLineage,parseMediaInputLink} from './media-lineage';
import type {MediaDecodedFrame,MediaLineageFact} from './media-lineage';
import {ObservationWork} from './observation-work';
import type {ObservationFact,ObservationSource} from './observation-execution';
import type {ScannerFeedback,FeedbackReadContext} from './scanner-feedback';
import type {NameAttempt} from './name-diagnostics';
import {InventoryEvidence,inventoryEventData,inventorySeedSnapshot,hashInventoryEvidence} from './inventory-evidence';
import type {InventorySource} from './inventory-evidence';
import {recordScanGrid,scanGridReplaySnapshot,hashScanGridReplay} from './scan-grid-command';
import {createCoalescedPublisher} from './coalesced-publisher';
import {ReadingFeedback,createFeedbackPublisher} from './reading-feedback';
import type {ScanMonitorState} from './scan-monitor-store';
import {createCandidatePreviewEncoder} from './candidate-preview';
import type {ExactRecorder} from './exact-recording';
import {createCanonicalCapture,type CanonicalRawLease} from './canonical-capture';
import {createSourcePreparation} from './source-preparation';
import type {SourcePreparationMode} from './source-preparation-protocol';
import {createPreparedLiveSource} from './prepared-live-source';
import type {PreparedAcquisitionInput,SourceRasterReceipt} from './source-raster-receipt';
import {MAX_FRAME_BYTES} from './exact-recording-codec';
import type {RecordingJournal} from './recording-journal';
import { initializeWithin } from './initialization';
import {settleDisposals} from './resource-cleanup';
import {guardScan} from './scan-watchdog';
import {CardReadAttempts,CardReadBudget,CardReadTimeout} from './card-read-budget';
import {beginRecognitionInspection,type RecognitionInputObserver,type RecognitionInspection,type RecognitionInputMeta} from './recognition-input-observer';
import {scrollCardLocation,estimateScrollRows} from './scroll-card-location';
import {InventoryPosition,StationaryInventoryView} from './inventory-position';
import {ObservedInventoryLayout} from './observed-inventory-layout';
import {RecentScanActivity,type ScanActivityItem} from './scan-activity';
import type {PreparedScanner} from './scanner-preparation';
import {parseScannerNameConfiguration,type ScannerNameConfiguration} from './scanner-name-configuration';
import {createScannerNameOperation} from './scanner-name-operation';
import { createVisualClient } from './visual-client';
import type { VisualResult } from './visual-client';
import { decodedFrames } from "./decoded-frames";
import { scanCompletion } from "./completion";
import { retryEligible } from "./retry-quality";
import { imageInputs, startLiveFrames, waitForInput, yieldForCapture, type StillImageSources } from "./input-source";
import { acquireCards, createCardAcquirer } from "./card-acquisition";
import { createAcquisitionClient } from './acquisition-client';
import {addAcquisitionProfile} from './acquisition-profile';
import {addDetectorProfile,type DetectorProfile} from './detector-profile';
import type {AcquisitionProfileSummary} from './acquisition-profile';
import {createLiveCapturePipeline} from './live-capture-pipeline';
import {createLiveInputAdmission} from './live-input-admission';
import {inputArrival,parseInputBackupReservation} from './input-arrival';
import {parseAcquisitionCapture,parseRecognitionCapture} from './capture-provenance';
import type {InputStamp} from './live-input-admission';
import {InputDecisionReplay} from './live-input-decision-replay';
import {freezeLiveFrameTimed,type FrozenLiveFrame} from './freeze-live-frame';
import {createLiveRawSource} from './live-raw-source';
import {createLiveOriginalCapture} from './live-original-capture';
import {waitForReaderMetadata,deferCompletionForMetadata} from './metadata-scheduling';
import {MetadataOrder,metadataSortChanged,type CapturedMetadata} from './metadata-order';
import type { AcquisitionTiming } from './acquisition-client';
import { tryStartTrackFrames } from './track-frame-source';
import { ScanLedger } from "./scan-ledger";
import {UnknownLifecycle,hashUnknownLifecycle} from './unknown-lifecycle';
import {UNKNOWN_LIFECYCLE_LIMITS} from './unknown-lifecycle-types';
import {UnknownDiagnosticSidecars} from './unknown-diagnostic-sidecars';
import {replacePendingCandidate,replaceRetryCandidate,retryCandidateIndex} from './retry-candidate';
import type { LedgerSnapshot } from "./scan-ledger";
import { CandidateQueue } from "./candidate-queue";
import { FreshObservations } from './fresh-observation';
import {FreshnessEvidence,hashFreshnessEvidence} from './freshness-evidence';
import {FRESHNESS_EVIDENCE_LIMITS,type FreshnessFact} from './freshness-evidence-types';
import {FreshnessObservationBridge} from './freshness-observation-bridge';
import { FinishTimer, type FinishTiming } from './finish-timing';
import { estimateRowShift } from "./grid-motion";
import { CaptureObservations, settledFields } from "./capture-quality";
import type { CardSort } from "./capture-metadata";
import { createDetector } from "./detector";
import type {Box} from './detector';
import {
  createRecognizer,
  crop,
} from "./recognizer";
import type { ScannedCard } from "./recognizer";
import { confirmSortedNames } from "./name-confirmation";
import { readScrollGeometry } from "./scroll-position";
import {parseScrollCaptureFact} from './scroll-capture-diagnostic';
import type {CaptureFrameIdentity} from './scroll-capture-diagnostic';
import type {PortraitDiagnostics} from './portrait-diagnostics';
import {createCapturedHeaderReads} from './captured-header-read';
import type {CapturedHeaderRegion} from './captured-header-read';
import {LiveScrollPreview} from './live-scroll-preview';
import {FrozenViewportHints} from './frozen-viewport-hint';
import {correlateSourceFrame} from './source-frame-correlation';
import { ScrollCoverage } from './scroll-coverage';
import type { ScrollGap } from './scroll-coverage';
import { countReliability, CountObservations } from "./count-confidence";
import { replayDebugFrames } from "./debug-capture";
import { mergeFrames } from "./merge-frames";
import { createDebugEncoder } from "./debug-encoder";
import { createCaptureOriginals } from "./capture-originals";
import { recordContinuous, recordedFrames } from "./continuous-capture";
import {startOptionalRecording,shouldRecordContinuous} from './optional-recording';
import {preparedRecoveryPrefetch} from './prepared-recovery-prefetch';
import type { ContinuousRecording } from "./continuous-capture";
import type { DebugCapture, DebugFrame } from "./debug-capture";
import { LiveReaderSchedule, LiveRetrySchedule, shiftOcrRetry, retryWorkPriority, timedCaptureOrder, liveLanePlan } from "./live-scan-policy";
import { LiveWorkPriority } from './live-work-priority';
import {LiveInventory} from './live-inventory';
import type {LiveInventorySnapshot} from './live-inventory';
import { runJoinedWorkers } from './joined-workers';
import { runRecoveryPipeline } from './recovery-pipeline';
import { fieldRetryIdentity, obsoleteFieldRetry, pruneFieldRetries } from './field-retry';
import { canSkipRecovery, canFinishVerifiedCapture, confirmedReadingCount, freshCaptureTail } from './recovery-completion';
import { pendingScanFields, projectCurrentScanFields } from './current-scan-fields';
import { FieldDiagnosticImages } from './field-diagnostic-images';
import type { PendingCardFields } from './current-scan-fields';
import { saveAcquisition, resolvedSavedObservation, coveredSavedAcquisition, needsLatestSavedProof,
  selectObservationSourceFrameId,sourceObservationFrame,exactSourceSavedObservation } from './saved-acquisition';
import type { SavedAcquisition, SavedObservation } from './saved-acquisition';
import {AutoCompletionHold,canFinishEndedCapture,canSkipCoveredOriginals,canStopSharing,confirmedCaptureCount,hasCompleteCaptureEvidence,stopCompletedShare} from './auto-completion';
const cardCollator = new Intl.Collator("ko");

export interface ScannerState {
  /** Chosen name-reader behavior, independent of capture/identity evidence. */
  nameConfiguration?:ScannerNameConfiguration;
  grid?:ScanGridSnapshot;
  activity?:ScanActivityItem[];
  interrupted?: 'stalled' | 'cancelled' | 'failed';
  processingWarning?: string;
  workPhase?: import('./read-progress').ScanWorkPhase;
  recoveryPercent?: number;
  currentRunNames?: number;
  currentRunRead?: number;
  unattributedFieldReviews?: number;
  pendingFields?: PendingCardFields[];
  status: string;
  percent: number;
  sampled: number;
  stable: number;
  expected: number | null;
  capacity: number | null;
  cards: ScannedCard[];
  seededCards?: number;
  growthPoints?: { current: number; maximum: number | null } | null;
  growthPointsEstimated?: boolean;
  growthHistory?: import('../growth/complete-growth').GrowthCompletion[];
  sort?: CardSort | null;
  captureWindows?: number;
  collectedCrops?: number;
  rowShift?: number | null;
  located: boolean;
  unreadable: number;
  queued: number;
  /** Active observation reads, distinct from queued jobs and confirmed cards. */
  activeReadings?: number;
  droppedFrames: number;
  liveMissedFrames?: number;
  liveInput?: 'video' | 'track';
  liveInputPipeline?: {offered:number;processed:number;replaced:number;capacityDropped:number;sourceCapacityDeferred?:number;selectionHints:number;selectionMs:number;maxSelectionMs:number;freezeMs:number;maxFreezeMs:number;queueWaitMs:number;maxQueueWaitMs:number};
  sourceStore?:{kind:'canonical';preparation?:ReturnType<typeof createPreparedLiveSource>['stats']}&ReturnType<typeof createCanonicalCapture>['stats'];
  captureWarning?: string;
  scrollCaptureDiagnosticError?:string;
  ledger?: LedgerSnapshot;
  recoveryFrames?: number;
  recoveryPerformance?: {frames:number;acquisitionMs:number;copyMs:number;detectMs:number;cropMs:number;readings:number;readMs:number;detectorProfile?:DetectorProfile};
  /** Final bounded per-reader name request metrics; not inference-only timing. */
  nameOcrMetrics?:ReturnType<Awaited<ReturnType<typeof createRecognizer>>['nameOcrMetrics']>[];
  recoverySkipped?: boolean;
  unresolvedFieldChanges?:number;
  recoveryReuse?: { frames:number; observations:number; skippedOriginals:number };
  autoStopped?: boolean;
  resultPresentation?: { observations: number; updates: number; milliseconds: number };
  liveOcrStarted?: { short: number; full: number };
  retryWork?: { skippedFields:number; reusedIdentities:number };
  identifiedAfterSharing?: { id: string; name: string }[];
  sharingEndedAt?: number;
  finishTiming?: FinishTiming;
  scrollPreviewPerformance?: {samples:number;readMs:number;maxReadMs:number;duringAcquisition:number};
  shareEndInventory?: LiveInventorySnapshot;
  livePerformance?: { acquisitionMs: number; recognized: number; uniqueCards: number; firstResultMs: number | null; lagMs: number;
    acquisitionProfile?:AcquisitionProfileSummary;
    detectorProfile?:DetectorProfile;
    stages?: AcquisitionTiming & { copyMs:number; samples:number };
    stagesByLocation?: Partial<Record<'located'|'unlocated', AcquisitionTiming & {copyMs:number;samples:number}>> };
  unidentified: { image: string; recognitionImage?:string; time: number; captureOrder?: number; pending: boolean; group?: number; reason?:string; location?:import('./scroll-card-location').ScrollCardLocation; source?:ObservationSource; nameAttempts?:readonly NameAttempt[] }[];
  captureDiagnostics?: {
    acquired: number; rejected: number; duplicates: number; improved: number;
    reasons: Record<string, number>;
    samples: { image: string; time: number; slot: number; reason: string; accepted: boolean; sharpness: number }[];
  };
  scrollPosition?: number | null;
  scrollGaps?: ScrollGap[];
  scrollCoverageInfo?: ReturnType<ScrollCoverage['snapshot']>;
  scrollStartSeen?: boolean;
  scrollEndSeen?: boolean;
}
export async function runScanner(...args:Parameters<typeof runScannerInternal>) {
  const [video,source,signal,update,seed,onReady,rowMode,stillImages,captureOnly,debug,prepared,feedback]=args;
  let active=true;
  let publish!:(state:ScannerState)=>void,ready!:()=>void;
  const operation=createScannerNameOperation({prepared,configuration:debug?.nameConfiguration,
    legacyDevPolicy:debug?.nameRawResultPolicy,development:import.meta.env.DEV,input:debug??{},
    onSettled:()=>debug?.onInternalSettled?.(),
    diagnostic:()=>{try{debug?.recordingError?.('인식 엔진 자원 종료에 실패했습니다.');}catch{/* Optional diagnostics. */}},
    run:(guardSignal,nameConfiguration,transferred)=>runScannerInternal(video,source,guardSignal,publish,seed,()=>{
      if(guardSignal.aborted)return;ready();onReady?.();
    },rowMode,stillImages,captureOnly,{...debug,nameConfiguration},transferred,
      feedback?state=>{if(active&&!guardSignal.aborted)feedback(state);}:undefined),
  });
  try {await guardScan({signal,update,
    onRunSettled:operation.settled,
    sharing:()=>source==='screen'&&!!(video.srcObject as MediaStream|null)?.getVideoTracks().some(t=>t.readyState==='live'),
    cancelResources:()=>{
      try{debug?.feedbackProbe?.cancel();}catch{/* Guard cancellation also fences late timing callbacks. */}
      operation.cancel();
      if(source==='screen')(video.srcObject as MediaStream|null)?.getTracks().forEach(t=>t.stop());
    },
    run:(guardSignal,guardPublish,guardReady)=>{publish=guardPublish;ready=guardReady;return operation.run(guardSignal);},
  });}finally{active=false;}
}

async function runScannerInternal(
  video: HTMLVideoElement,
  source: "video" | "screen",
  signal: AbortSignal,
  update: (state: ScannerState) => void,
  seed: ScannedCard[] = [],
  onReady?: () => void,
  rowMode: "all" | "top" | "stable" = "all",
  stillImages?: StillImageSources,
  captureOnly = false,
  debug: { nameConfiguration?:ScannerNameConfiguration; feedbackProbe?:ScannerFeedback; comparisonInput?:boolean; preparedSource?:boolean; preparedSourceMode?:SourcePreparationMode; localCropPixels?:boolean; nameRawResultPolicy?:'continue'|'resample'; grayNameFallback?:boolean; recognitionObserver?:RecognitionInputObserver; nativeAcquisition?: boolean; rgbaRecovery?:boolean; fractionalPortrait?:boolean; minInputIntervalMs?:number; inputOfferFloorMs?:number; exact?: ExactRecorder; journal?:RecordingJournal; trace?: (type:string,value:unknown,time:number)=>void; parallelRecovery?: boolean; trackFrames?: boolean; replay?: DebugCapture; replayInputs?: AsyncIterable<ScannerInputFrame>; record?: (frame: DebugFrame) => void;
    continuous?: (recording: ContinuousRecording) => void;
    continuousRecording?: 'disabled'|'fail-start';
    recordingMode?: 'diagnostic'|'detailed';
    snapshots?: () => AsyncIterable<{ element: HTMLImageElement; image: string; time: number; percent: number }>;
    preview?: (image: string) => void; recording?: () => boolean; recordingError?: (message: string) => void;
    onInternalSettled?:()=>void } = {},
  prepared?: PreparedScanner,
  feedback?: (state:ScanMonitorState)=>void,
) {
  const nameConfiguration=parseScannerNameConfiguration(debug.nameConfiguration);
  const nameRawResultPolicy=nameConfiguration.rawResultPolicy;
  // Input semantics must survive an unavailable/failed recording backend.
  // Saved pixel replay is not a live stream even when its original source was screen.
  const liveScreen = source === 'screen' && !debug.replay && !!video.srcObject;
  const isStill = !!stillImages || debug.replay?.source === "images";
  const state: ScannerState = {
    nameConfiguration,
    status: captureOnly ? "카드 화면 검출 준비 중 · OCR 실행 안 함" : "인식 엔진 준비 중",
    percent: 0,
    sampled: 0,
    stable: 0,
    expected: null,
    capacity: null,
    cards: [...seed],
    seededCards: seed.length,
    located: false,
    unreadable: 0,
    queued: 0,
    activeReadings: 0,
    droppedFrames: 0,
    unidentified: [],
    captureDiagnostics: { acquired: 0, rejected: 0, duplicates: 0, improved: 0, reasons: {}, samples: [] },
  };
  const ledger = new ScanLedger();
  const activity=new RecentScanActivity();
  const observationRecorder=debug.exact||debug.trace?(fact:ObservationFact)=>trace('observation-fact',fact):undefined;
  // Only the synchronous start of an accepted Candidate supplies this context.
  // It is not retained across awaits or inferred from current display positions.
  let feedbackReadContext:FeedbackReadContext|undefined;
  const probeObservation=(fact:ObservationFact)=>{
    observationRecorder?.(fact);
    try{debug.feedbackProbe?.observation(fact,feedbackReadContext);}catch{/* Optional timing is not execution authority. */}
  };
  const rawGrid=new ScanGrid(debug.feedbackProbe?probeObservation:observationRecorder,
    debug.feedbackProbe?(snapshot,entries,previous)=>debug.feedbackProbe!.grid(snapshot,entries,previous):undefined);
  const grid=observationRecorder?recordScanGrid(rawGrid,command=>trace('grid-command',command)):rawGrid;
  const previews=createCandidatePreviewEncoder({signal});
  const inventoryPosition=new InventoryPosition();
  const stationaryInventory=new StationaryInventoryView();
  const observedLayout=new ObservedInventoryLayout();
  let auditComplete = false;
  let refreshCards: (() => void) | undefined;
  let refreshGrid: (() => void) | undefined;
  let refreshFeedback: (() => number) | undefined;
  let feedbackState:ScanMonitorState|undefined;
  const publishFeedback=(gridSnapshot:ScanGridSnapshot,completed=state.currentRunRead)=>{
    feedbackState={grid:gridSnapshot,currentRunRead:completed,expected:state.expected,capacity:state.capacity,interrupted:state.interrupted,
      unresolvedFieldChanges:state.unresolvedFieldChanges,
      queued:state.queued,activeReadings:state.activeReadings,unresolvedCount:state.unidentified.length,hasInput:state.sampled>0};
    feedback?.(feedbackState);
  };
  const feedbackPublisher=createFeedbackPublisher(signal,()=>{
    if(!feedback)return;
    const completed=refreshFeedback?.()??state.currentRunRead;
    publishFeedback(grid.snapshot(),completed);
  });
  const publisher = createCoalescedPublisher(() => {
    refreshCards?.();
    refreshGrid?.();
    state.ledger = ledger.snapshot(auditComplete);
    state.activity=activity.snapshot();
    state.grid=grid.snapshot();
    if(feedback)publishFeedback(state.grid);
    update({ ...state, cards: [...state.cards], captureDiagnostics: state.captureDiagnostics ? { ...state.captureDiagnostics, reasons: { ...state.captureDiagnostics.reasons }, samples: [...state.captureDiagnostics.samples] } : undefined });
  });
  const emit = (force = false) => {publisher.request(force);if(feedback)feedbackPublisher.request(force);};
  emit();
  state.status = '화면 검출 모듈 준비 중'; emit(true);
  const detector = prepared?.detector ?? await initializeWithin(createDetector(), signal, value => value.dispose());
  let recognizer: Awaited<ReturnType<typeof createRecognizer>> | undefined = prepared?.readers[0],
    stopInput: (() => void) | undefined;
  let encoder: ReturnType<typeof createDebugEncoder> | ReturnType<typeof createCanonicalCapture> | undefined;
  let canonicalSource:ReturnType<typeof createCanonicalCapture>|undefined,canonicalStore:ExactRecorder|undefined,ownCanonicalStore=false;
  let sourcePreparation:Awaited<ReturnType<typeof createSourcePreparation>>|undefined,preparedSources:ReturnType<typeof createPreparedLiveSource>|undefined;
  let originals: ReturnType<typeof createCaptureOriginals> | undefined;
  let recordingFailure = "";
  let continuous: ReturnType<typeof recordContinuous> | undefined;
  const finishTimer = new FinishTimer();
  let recordingStart = performance.now();
  const trace=(type:string,value:unknown)=>{const time=(performance.now()-recordingStart)/1000;debug.exact?.event(type,value,time);debug.trace?.(type,value,time);};
  // Diagnostic state uses the same reducer as imported traces. A recording
  // failure invalidates its checkpoint without stopping frame acquisition.
  let inputReplay:InputDecisionReplay|undefined,inputRecordingFailed=false;
  const inputRecordingError=(error:unknown)=>{
    if(inputRecordingFailed)return;
    inputRecordingFailed=true;
    try{debug.exact?.incomplete('입력 선택 기록 실패');}catch{/* An optional recorder cannot stop capture. */}
    try{trace('input-recording-error',{error:String(error)});}catch{/* The failed sink may also reject this loss marker. */}
  };
  const recordInput=(type:'input-admission'|'input-decision'|'input-link',value:unknown)=>{
    if(!inputReplay||inputRecordingFailed)return;
    try {
      if(type==='input-admission')inputReplay.admission(value);
      else if(type==='input-decision')inputReplay.pipeline(value);
      else inputReplay.link(value);
      trace(type,value);
    }catch(error){inputRecordingError(error);}
  };
  const recordInputDiagnostic=(type:'input-arrival'|'input-backup-reservation'|'backup-capacity-deferral',value:()=>unknown)=>{
    if(!(debug.exact||debug.trace)||inputRecordingFailed)return;
    try{trace(type,value());}catch(error){inputRecordingError(error);}
  };
  let captureRecordingFailed=false,recognitionCaptureOrdinal=0;
  const recordCaptureEvidence=(type:'acquisition-capture'|'recognition-capture',value:()=>unknown)=>{
    if(!(debug.exact||debug.trace)||captureRecordingFailed)return;
    try{trace(type,value());}catch(error){
      captureRecordingFailed=true;
      try{debug.exact?.incomplete('카드 입력 근거 기록 실패');}catch{/* Optional recording never stops acquisition. */}
      try{trace('capture-recording-error',{error:String(error)});}catch{/* The failed sink may also reject the loss marker. */}
    }
  };
  // Optional viewport/header facts have their own failure latch. A diagnostic
  // error must not prevent later mandatory card acquisition receipts.
  let scrollRecordingFailed=false;
  const scrollRecordingError=(error:unknown)=>{
    if(scrollRecordingFailed)return;scrollRecordingFailed=true;
    let detail='진단 오류';try{detail=String(error).slice(0,300);}catch{/* Even an invalid error payload is optional. */}
    state.scrollCaptureDiagnosticError=detail;
    state.captureWarning??='스크롤·보관함 진단 일부를 기록하지 못했습니다.';
    try{debug.exact?.incomplete('스크롤·보관함 진단 기록 실패');}catch{/* Diagnostic failure cannot stop capture. */}
    // Mark the trace-only sink partial too, without sharing the mandatory
    // acquisition-receipt failure latch or suppressing its later records.
    try{trace('capture-recording-error',{error:`스크롤·보관함 진단: ${detail}`});}catch{/* A failed sink may also reject its loss marker. */}
  };
  const recordScrollEvidence=(type:'scroll-capture'|'inventory-header-read',value:()=>unknown)=>{
    if(!(debug.exact||debug.trace)||scrollRecordingFailed)return false;
    try{trace(type,value());return true;}catch(error){scrollRecordingError(error);return false;}
  };
  const headerReads=createCapturedHeaderReads(fact=>recordScrollEvidence('inventory-header-read',()=>fact),scrollRecordingError);
  let headerOrigin:CapturedHeaderRegion|undefined,finalHeaderOrigin:CapturedHeaderRegion|undefined;
  let mediaRecordingFailed=false;
  const mediaRecordingError=(error:unknown)=>{
    if(mediaRecordingFailed)return;mediaRecordingFailed=true;
    try{debug.exact?.incomplete('영상 입력 계보 기록 실패');}catch{/* Optional diagnostics. */}
    try{trace('media-recording-error',{error:String(error)});}catch{/* Failed sink may also reject this marker. */}
  };
  const recordMedia=(type:'media-lineage'|'media-input-link',value:()=>unknown)=>{
    if(!(debug.exact||debug.trace)||mediaRecordingFailed)return;
    try{trace(type,value());}catch(error){mediaRecordingError(error);}
  };
  const mediaFact=(fact:MediaLineageFact)=>recordMedia('media-lineage',()=>fact);
  const inventoryCheckpoint=async()=>{
    if(!inventory)throw Error('카드 근거 초기화 미완료');
    return hashInventoryEvidence(inventory.snapshot());
  };
  const inputCheckpoint=async()=>{
    if(!inputReplay||inputRecordingFailed)throw Error('입력 선택 기록 누락');
    const input=await inputReplay.summary();
    if(!input.settled||!input.hash)throw Error('입력 선택 기록이 정착되지 않았습니다.');
    return input.hash;
  };
  ledger.observe((type,value)=>{if(type==='stage'){const event=value as {id:number;stage:string};grid.stage(event.id,event.stage);}if(debug.exact||debug.trace)trace(type,value);});
  let recovering = false;
  let releasePending: (() => void) | undefined;
  let acquisition: ReturnType<typeof createAcquisitionClient> | undefined = prepared?.acquisition;
  let finalHeader: HTMLCanvasElement | undefined;
  let lastLocatedTime = -Infinity;
  let checkingCompletion=false;
  let liveCollection: Promise<void> | undefined;
  let disposeLiveCapture:(()=>void)|undefined;
  let inventory:InventoryEvidence|undefined;
  let unknownLifecycle:UnknownLifecycle|undefined;
  let freshness:FreshnessEvidence|undefined;
  const visuals: ReturnType<typeof createVisualClient>[] = [...(prepared?.visuals ?? [])];
  const lanePlan=liveLanePlan(navigator.hardwareConcurrency);
  const extraRecognizers: Awaited<ReturnType<typeof createRecognizer>>[] = prepared?.readers.slice(1) ?? [];
  const abortPrepared = () => { prepared?.cancel(); encoder?.cancel(); void continuous?.finish(); };
  signal.addEventListener('abort', abortPrepared, { once: true });
  let primaryFailure=false,primaryError:unknown;
  const propagateFailure=(error:unknown):never=>{
    if(!primaryFailure){primaryFailure=true;primaryError=error;}
    throw primaryError;
  };
  const cleanupDiagnostic=(error:unknown)=>{
    try{debug.exact?.incomplete('인식 엔진 종료 진단 실패');}catch{/* The sink may also be failing. */}
    try{trace('capture-recording-error',{error:String(error).slice(0,1000)});}catch{/* Optional diagnostics cannot skip resource cleanup. */}
  };
  const finalTrace=(type:string,value:unknown)=>{
    try{trace(type,value);return true;}catch(error){cleanupDiagnostic(error);return false;}
  };
  const incompleteFinalRecord=(reason:string)=>{try{debug.exact?.incomplete(reason);}catch{/* Preserve the original scan/cleanup failure. */}};
  const disposeReaders=async()=>{
    // Call only after active acquisition/read work has joined. One failed
    // disposer must not skip the remaining independent readers or termination.
    const errors=await settleDisposals([()=>signal.removeEventListener('abort',abortPrepared),
      ...(prepared?[()=>prepared.dispose()]:[()=>detector.dispose(),()=>recognizer?.dispose(),
        ...extraRecognizers.map(reader=>()=>reader.dispose())])]);
    for(const error of errors)cleanupDiagnostic(error);
    if(errors.length&&!primaryFailure)throw new AggregateError(errors,'인식 엔진 종료 실패');
  };
  try {
    signal.throwIfAborted();
    if (!prepared && source === 'screen' && !debug.replay) acquisition = createAcquisitionClient(signal,
      {...(import.meta.env.DEV&&debug.preparedSource?{pixelTransport:true}:{}),
       ...(import.meta.env.DEV&&debug.localCropPixels?{localCropPixels:true}:{})});
    if (!prepared && !captureOnly) recognizer = await createRecognizer((message) => {
      state.status = message;
      emit();
    }, signal,{nameRawResultPolicy,...(nameConfiguration.contrastNameFallback?{contrastNameFallback:true}:{})});
    // Each consumer owns its OCR session: multi-line CTC and adaptive caches
    // cannot safely interleave requests from different cards in one reader.
    if (!prepared && recognizer && source === 'screen' && !debug.replay)
      for(let i=1;i<lanePlan.readers;i++) {
        signal.throwIfAborted();
        state.status = `병렬 인식 준비 ${i + 1} / ${lanePlan.readers}`; emit(true);
        extraRecognizers.push(await createRecognizer(() => {}, signal,{nameRawResultPolicy,...(nameConfiguration.contrastNameFallback?{contrastNameFallback:true}:{})}));
      }
    if (!prepared && recognizer && acquisition) for(let i=0;i<lanePlan.fast;i++) visuals.push(createVisualClient(signal));
    if (!prepared) await Promise.all([acquisition?.ready(),...visuals.map(worker=>worker?.ready())]);
    signal.throwIfAborted();
    if (liveScreen) {
      const mode=import.meta.env.DEV?debug.continuousRecording:undefined;
      const recording=startOptionalRecording(shouldRecordContinuous(debug.recordingMode,mode,import.meta.env.DEV),()=>{
        if(mode==='fail-start')throw Error('개발 검사: 녹화 시작 실패');
        return recordContinuous(new MediaStream((video.srcObject as MediaStream).getVideoTracks()),message=>{
          state.captureWarning=message;emit(true);
        },undefined,undefined,undefined,undefined,undefined,debug.journal);
      });
      if(recording.status==='active')continuous=recording.recording;
      else if(recording.status==='failed'||mode==='disabled')state.captureWarning=recording.warning;
      trace('recording-availability',{status:recording.status,liveScreen});
    }
    if(continuous&&!debug.record&&!debug.snapshots){
      const size=(video.srcObject as MediaStream|null)?.getVideoTracks()[0]?.getSettings();
      const width=video.videoWidth||size?.width||0,height=video.videoHeight||size?.height||0;
      if(width>0&&height>0&&width*height*4<=MAX_FRAME_BYTES){
        if(debug.exact?.supportsSourceReads)canonicalStore=debug.exact;
        else if(!debug.exact)try{
          const {createExactRecording}=await import('./exact-recording');
          const temporary=await createExactRecording();
          if(temporary.supportsSourceReads){canonicalStore=temporary;ownCanonicalStore=true;}
          else await temporary.dispose();
        }catch{/* Unsupported temporary stores retain the existing raw backup. */}
      }
    }
    if(debug.exact&&!canonicalStore){
      try{if(!acquisition)throw Error('입력 기록 Worker 없음');acquisition.startRecording(debug.exact.takePort());}
      catch(error){debug.exact.incomplete(String(error));}
    }
    if(debug.preparedSource){
      if(!import.meta.env.DEV||!continuous||!canonicalStore||!debug.exact||!acquisition||debug.nativeAcquisition||debug.replay||debug.replayInputs)
        throw Error('공통 입력 실험은 개발 영상 1배속·세션 기록에서 단독으로 실행합니다.');
      sourcePreparation=await createSourcePreparation(signal,{mode:debug.preparedSourceMode??'auto',
        ...(debug.exact.nativeAttestationIdentity?{attestation:debug.exact.takePreparationAttestation()}:{} )});
    }
    // One unusually large source must still fit. The fixed session budget
    // limits how many snapshots can coexist; later resize drops are explicit.
    const sourceSize=(video.srcObject as MediaStream|null)?.getVideoTracks()[0]?.getSettings();
    const maxRetainedRasterBytes=Math.max(64*1024*1024,
      (video.videoWidth||sourceSize?.width||0)*(video.videoHeight||sourceSize?.height||0)*4);
    trace('configuration',{source,rowMode,captureOnly,liveScreen,continuousRecording:!!continuous,lanePlan,hardwareConcurrency:navigator.hardwareConcurrency,build:import.meta.env.VITE_BUILD_REVISION,
      recordingControl:import.meta.env.DEV?debug.continuousRecording??'default':'default',
      recordingMode:debug.recordingMode??'diagnostic',
      nativeAcquisition:debug.nativeAcquisition===true,rgbaRecovery:debug.rgbaRecovery===true,
      preparedSource:debug.preparedSource===true,
      localCropPixels:import.meta.env.DEV&&debug.localCropPixels===true,
      nameRawResultPolicy,
      nameConfiguration,
      preparedSourceMode:debug.preparedSource?debug.preparedSourceMode??'auto':null,
      grayFirstLineFallback:debug.grayNameFallback===true?'full-bypass-cache-greedy-v1':'disabled',
      portraitRegistration:debug.fractionalPortrait===true?'full-retry-near-quarter-v1':'integer-cell-v1',
      liveInputSelection:{pendingFrames:2,maxRetainedBytes:maxRetainedRasterBytes,hint:'same-frozen-scrollbar',minIntervalMs:debug.minInputIntervalMs??null,offerFloorMs:import.meta.env.DEV?debug.inputOfferFloorMs??null:null},
      sourceStore:canonicalStore?{kind:'canonical-lossless',backupsPerSecond:4,selectedInputs:!!debug.exact}:
        continuous||debug.record?{kind:'legacy-raw-backup'}:{kind:'none'}});
    onReady?.();
    // The same evidence reducer drives live input and recorded event replay.
    // Queue scheduling, images and published projections remain separate effects.
    inventory = new InventoryEvidence(seed,observationRecorder?{
      onEvent:event=>trace('inventory-event',inventoryEventData(event)),
    }:{});
    if(observationRecorder)trace('inventory-seed',{version:1,cards:inventorySeedSnapshot(seed)});
    const cards=inventory.cards,evidence=inventory.evidence;
    const captures = new CaptureObservations();
    const countObservations = new CountObservations();
    let previousVectors: Uint8Array[] = [];
    const captureSession = crypto.randomUUID();
    const freshnessSeed={version:1 as const,sessionId:captureSession,limits:FRESHNESS_EVIDENCE_LIMITS};
    freshness=new FreshnessEvidence(freshnessSeed,{
      confirmedFields:()=>inventory!.confirmedFieldOrder,
      ...(observationRecorder?{
        onEvent:(fact:FreshnessFact)=>trace('freshness-event',fact),
        onIncomplete:(loss:string)=>{
          try{debug.exact?.incomplete(`최신 필드 상태 기록 누락: ${loss}`);}catch{/* Optional recording. */}
          try{trace('freshness-recording-error',{loss});}catch{/* A failed sink may reject its own marker. */}
        },
      }:{}),
    });
    if(observationRecorder)try{trace('freshness-seed',freshnessSeed);}
    catch{freshness.markIncomplete('event-sink-failed');}
    const freshnessBridge=new FreshnessObservationBridge(freshness);
    const unknownSeed={version:1 as const,sessionId:captureSession,origin:'scan' as const,limits:UNKNOWN_LIFECYCLE_LIMITS};
    unknownLifecycle=new UnknownLifecycle(unknownSeed,observationRecorder?{
      onEvent:fact=>trace('unknown-event',fact),
      onIncomplete:loss=>{
        try{debug.exact?.incomplete(`미식별 상태 기록 누락: ${loss}`);}catch{/* Optional recorder. */}
        try{trace('unknown-recording-error',{loss});}catch{/* A failed sink may reject its own loss marker. */}
      },
    }:{});
    if(observationRecorder)try{trace('unknown-seed',unknownSeed);}
    catch{unknownLifecycle.markIncomplete('event-sink-failed');}
    const metadataOrder=new MetadataOrder();
    let metadata:CapturedMetadata|undefined,
      lastMetadataTime = -Infinity;
    let lastMetadataFrame: HTMLVideoElement | HTMLImageElement | HTMLCanvasElement | OffscreenCanvas | undefined;
    type Candidate = {
      source:InventorySource;
      recognitionInput?:Pick<RecognitionInputMeta,'processingFrame'|'sourceBox'|'sourceWidth'|'sourceHeight'>;
      /** Reuse recorded provenance when present; probe-only runs retain one
       * scalar on the existing bounded Candidate, never a second source map. */
      feedbackFrame?:number;
      /** Recovery has execution facts without replacing current spatial cells. */
      execution?:ObservationWork;
      savedObservation?:SavedObservation;
      changedFields?:boolean;
      pixelKey:string;
      verifiedVisual?:object;
      needsIdentity?: boolean;
      fieldTarget?: {id:string;order:number};
      knownIdentity?: NonNullable<Awaited<ReturnType<NonNullable<typeof recognizer>['identify']>>>;
      group: number; priorityGroup: number; trace: number; image: HTMLCanvasElement; feature: Uint8Array; time: number; stable: boolean;
      borderAlignment: number; order: number; position: NonNullable<ScannedCard["capturePosition"]>;
      preview: string; previewCanvas?: HTMLCanvasElement; previewTask?:Promise<string>; sortReading?: Promise<Awaited<ReturnType<NonNullable<typeof recognizer>["metadata"]>>>;
    };
    const freshObservations = new FreshObservations<SavedObservation>(2048,
      observation=>resolvedSavedObservation(observation,confirmedFieldOrder),freshnessBridge);
    const releaseCandidate = (item: Candidate) => { item.execution?.cancel();freshObservations.finish(item.savedObservation); item.image.width = 0; item.image.height = 0; if (item.previewCanvas) item.previewCanvas.width = 0; };
    const queue = new CandidateQueue<Candidate>(1600, item => {
      ledger.finish(item.trace, "superseded", { reason: "같은 관측 묶음의 더 좋은 이미지로 교체", group: item.group });
      releaseCandidate(item);
    },replacePendingCandidate);
    const deferred: (Candidate & { feature: Uint8Array })[] = [];
    const fullRetries: (Candidate & { feature: Uint8Array })[] = [];
    const readAttempts=new CardReadAttempts();
    let diagnosticReadOrdinal=0;
    releasePending = () => {
      let item: Candidate | undefined;
      while ((item = queue.shift())) { ledger.finish(item.trace, "dropped", { group: item.group, reason: "처리 중지" }); releaseCandidate(item); }
      for (const pending of [...deferred,...fullRetries]) { ledger.finish(pending.trace, "dropped", { group: pending.group, reason: "보조 판독 중지" }); releaseCandidate(pending); }
      deferred.length = 0;fullRetries.length=0;
    };
    const unknownDiagnostics=new UnknownDiagnosticSidecars();
    const refreshUnknown=()=>{state.unidentified=unknownDiagnostics.project(unknownLifecycle!.active());};
    const unknownSource=(source:ObservationSource):ObservationSource=>({sessionId:source.sessionId,frameId:source.frameId,
      observationId:source.observationId,captureOrder:source.captureOrder,captureTime:source.captureTime,phase:source.phase,slot:source.slot});
    let captureOrder = Math.max(
      0,
      ...seed.map((card) => card.captureOrder ?? 0),
    );
    const initialCaptureOrder = captureOrder;
    const inputAdmission = createLiveInputAdmission();
    const livePriority = new LiveWorkPriority();
    const scrollCoverage = new ScrollCoverage();
    const liveIdentities = new Set<string>();
    const liveInventory = new LiveInventory();
    const confirmedFieldOrder = inventory.confirmedFieldOrder;
    const confirmedNameOrder = inventory.confirmedNameOrder;
    const latestIdentityOrder = inventory.latestIdentityOrder;
    const latestFieldObservations = inventory.latestFieldObservations;
    const fieldImages = new FieldDiagnosticImages();
    const pendingFieldDiagnostics = () => pendingScanFields(latestFieldObservations.values(),fieldEvidence)
      .map(field=>({...field,recognitionImage:fieldImages.get(field.id,field.captureOrder)}));
    const fieldEvidence = {latest:latestIdentityOrder,confirmed:confirmedFieldOrder};
    const exactObservations=new Map<string,SavedObservation>();
    const discardObsoleteRetry = (item:Candidate) => {
      ledger.finish(item.trace,'superseded',{group:item.group,reason:'더 최신 화면에서 이름·각성·장수 확정'});
      releaseCandidate(item);
      state.retryWork??={skippedFields:0,reusedIdentities:0};
      state.retryWork.skippedFields++;
    };
    const retrySchedules=new WeakMap<object,LiveRetrySchedule>();
    const identifiedThisRun = new Set<string>();
    let lastDiagnosticSample = -Infinity;
    let lastNameValidation = -Infinity;
    let cardsDirty = false;
    let lastLayoutKey='';
    let livePositions:{id:string;slot:number}[]=[];
    const readingFeedback=new ReadingFeedback();
    refreshFeedback=()=>{
      state.unresolvedFieldChanges=freshObservations.unresolvedChanges();
      const {completed,statuses}=readingFeedback.snapshot(cards,fieldEvidence);
      // Reuse spatial placements. Graph reconstruction belongs to the slower
      // inventory lane; current field status must not wait behind that work.
      if(!auditComplete)grid.placeLive(livePositions.filter(p=>statuses.has(p.id)),statuses);
      return completed;
    };
    refreshGrid=()=>{
      if(auditComplete)return;
      const current=state.cards.filter(card=>latestIdentityOrder.has(card.id)&&!card.review.includes('이름 확인'));
      const ids=current.map(card=>card.id),anchors=inventoryPosition.verifiedPositions();
      // Publish new spatial evidence with the next result, without a second
      // 250ms gate. Repeated status/viewport updates do not rebuild the graph.
      const key=JSON.stringify([observedLayout.revision,ids,anchors]);
      if(key!==lastLayoutKey) {
        lastLayoutKey=key;
        livePositions=observedLayout.resolve(ids,anchors,false);
      }
      const statuses=new Map(current.map(card=>[card.id,
        confirmedReadingCount({cards:[card],latest:latestIdentityOrder,confirmed:confirmedFieldOrder})?'read' as const:
          card.review.length?'review' as const:'waiting' as const]));
      grid.placeLive(livePositions.filter(p=>statuses.has(p.id)),statuses);
    };
    // Consensus/evidence stay synchronous for every observation. Sorting and
    // neighbour validation only build the published view; intermediate views
    // are never consumed by recognition and need not be rebuilt per card.
    refreshCards = () => {
      if (!cardsDirty) return;
      const started = performance.now();
      const ordered = [...cards.values()].sort((a, b) => cardCollator.compare(a.name, b.name));
      if (recognizer && started - lastNameValidation >= 500) {
        state.cards = confirmSortedNames(ordered, [...evidence.values()].flat(), recognizer.catalog);
        lastNameValidation = started;
      } else state.cards = ordered;
      state.cards = projectCurrentScanFields(state.cards,fieldEvidence);
      readingFeedback.remember(cards,state.cards);
      state.pendingFields = pendingFieldDiagnostics();
      state.unresolvedFieldChanges=freshObservations.unresolvedChanges();
      state.currentRunRead = confirmedReadingCount({cards:state.cards,...fieldEvidence});
      if(state.expected&&state.currentRunRead===state.expected&&state.cards.length===state.expected&&state.sort?.kind==='name') {
        const ids=state.cards.map(card=>card.id);
        const directions=state.sort.direction==='unknown'?['asc','desc']:[state.sort.direction];
        for(const direction of directions)for(const location of inventoryPosition.order(direction==='desc'?[...ids].reverse():ids))
          grid.register(location.frame,location.top);
      }
      cardsDirty = false;
      state.resultPresentation ??= { observations: 0, updates: 0, milliseconds: 0 };
      state.resultPresentation.updates++;
      state.resultPresentation.milliseconds += performance.now() - started;
    };
    const frame = document.createElement("canvas");
    // Recovery/file frames often repeat. Reuse only exact geometry + RGBA
    // analysis, retaining every observation for stability and field consensus.
    const acquireFrame=createCardAcquirer((width,height)=>{
      const canvas=document.createElement('canvas');canvas.width=width;canvas.height=height;return canvas;
    },true);
    const frameContext = frame.getContext("2d", { willReadFrequently: true })!;
    const scrollStrip = document.createElement("canvas");
    scrollStrip.width = 16;
    scrollStrip.height = 942;
    const scrollContext = scrollStrip.getContext("2d", {
      willReadFrequently: true,
    })!;
    const previewStrip=document.createElement('canvas');previewStrip.width=16;previewStrip.height=942;
    // Keep source-video scaling on the GPU; CPU-backed drawImage can convert
    // an entire high-resolution video for a tiny strip on every callback.
    const previewContext=previewStrip.getContext('2d',{willReadFrequently:false})!;
    const stripPixels=(source:CanvasImageSource,box:Box,w:number,h:number)=>{
      previewContext.drawImage(source,box.x,box.y,box.width,box.height,0,0,w,h);
      return previewContext.getImageData(0,0,w,h).data;
    };
    const scrollPreview=new LiveScrollPreview<CanvasImageSource>(stripPixels);
    const selectionHints=new FrozenViewportHints<CanvasImageSource>(stripPixels);
    let previous: Uint8Array[] = [],
      lastLocation = "",
      header: HTMLCanvasElement | undefined,
      capturing = true,
      captureError: unknown;
    const reportUnknown = (
      image: HTMLCanvasElement,
      time: number,
      pending: boolean,
      preview: string | undefined,
      group: number,
      order: number,
      location:import('./scroll-card-location').ScrollCardLocation|undefined,
      reason:string,
      diagnostic:{source:ObservationSource;pixelKey:string;nameAttempts?:readonly NameAttempt[];portraitDiagnostics?:PortraitDiagnostics|null},
    ) => {
      const effect=unknownLifecycle!.apply({version:1,kind:'upsert',key:{kind:'group',sessionId:captureSession,group},
        source:unknownSource(diagnostic.source),captureOrder:order,captureTime:time,pending,reason,location:location??null});
      if(effect.upserted){
        unknownDiagnostics.remember(effect.upserted,{pixelKey:diagnostic.pixelKey,
          preview:()=>preview??image.toDataURL('image/webp',.9),recognition:()=>image.toDataURL('image/png'),
          nameAttempts:diagnostic.nameAttempts,portraitDiagnostics:diagnostic.portraitDiagnostics});
        refreshUnknown();emit(true);
      }
    };
    let inputFrame: HTMLVideoElement | HTMLImageElement | HTMLCanvasElement | OffscreenCanvas = video;
    let frameTime = 0;
    let replayProvenance:ScannerInputProvenance|undefined;
    let replayAnalysis:SavedAcquisition|undefined;
    let replayCanonicalFrameId:number|undefined;
    let replayRawSourceFrameId:number|undefined;
    let replayRgba:Uint8Array<ArrayBuffer>|undefined;
    let replayNative:VideoFrame|undefined;
    let replayPreparedInput:PreparedAcquisitionInput|undefined,replayPreparedSourceId:number|undefined;
    let replaySourceHash:string|undefined;
    let decodedInput:DecodedRgbaMetadata|undefined;
    let decoderLineage:MediaDecodedFrame|undefined;
    let readingJobs=0;
    let primaryOcrReading=false;
    recordingStart = continuous?.startedAt ?? performance.now();
    // Diagnostic clock bridge only. Source PTS/capture times keep their own
    // domains; this anchor never contributes recognition or completion proof.
    try{trace('scanner-clock',{version:1,clock:'page-performance-now',phase:'input-and-recognition',originMs:recordingStart});}
    catch{/* An unavailable optional clock bridge must not stop recognition. */}
    const directOriginals = !!continuous && !debug.record && !debug.snapshots;
    if (continuous && !debug.snapshots && !directOriginals) originals = createCaptureOriginals({ rowMode, captureOnly }, signal);
    if(canonicalStore){
      canonicalSource=createCanonicalCapture(canonicalStore,message=>{recordingFailure=message;state.captureWarning=message;emit(true);},
        {onUse:value=>trace('canonical-source-use',value),ownedRgba:!!sourcePreparation,
          ...(sourcePreparation?{onTiming:value=>trace('canonical-source-timing',value)}:{}),
          onRasterReceipt:value=>trace('canonical-raster-receipt',value),
          ...(canonicalStore.nativeAttestationIdentity?{attestation:canonicalStore.nativeAttestationIdentity,
            onStorageAttestation:value=>trace('canonical-storage-attestation',value)}:{})});
      if(sourcePreparation){
        trace('canonical-raster-contract',{version:1});
        if(canonicalStore.nativeAttestationIdentity)trace('canonical-storage-contract',
          {...canonicalStore.nativeAttestationIdentity,mode:'prepared-native-attestation-v1'});
        preparedSources=createPreparedLiveSource(canonicalSource,sourcePreparation,signal,
          canonicalStore.nativeAttestationIdentity?{attestNative:true}:{});
      }
      encoder=canonicalSource;
    }else if (debug.record || originals || directOriginals) {
      try { encoder = createDebugEncoder(value => { debug.record?.(value); originals?.add(value); emit(); }, message => {
        recordingFailure = message; state.captureWarning = message; emit(true);
      }); }
      catch { recordingFailure = "원본 캡처 Worker를 시작하지 못했습니다. 연속 영상 판독은 계속됩니다.";
        state.captureWarning = recordingFailure; }
    }
    let rawLiveSource:ReturnType<typeof createLiveRawSource>|undefined;
    const liveOriginals=createLiveOriginalCapture<import('./bitmap-dispatch').SnapshotSource>((source,time,elapsed)=>{
      if(!encoder?.active||debug.recording?.()===false||originals?.active===false)return;
      return preparedSources?preparedSources.submit(source,time,elapsed):rawLiveSource?rawLiveSource.backup(source,time,elapsed):encoder.submit(source,time,elapsed);
    });
    if(canonicalSource&&!preparedSources)rawLiveSource=createLiveRawSource(canonicalSource,{
      remember:elapsed=>liveOriginals.remember(elapsed),
      backupDeferred:value=>recordInputDiagnostic('backup-capacity-deferral',()=>value),
    });
    const collect = async (acquire = true, deliveredTime?: number, frozen?:FrozenLiveFrame, capturedAt?:number, originalId?:number, inputStamp?:InputStamp) => {
      // Completion waits for already accepted snapshots; only admission pauses.
      if(acquire&&checkingCompletion&&!frozen)return;
      if (signal.aborted || (!frozen && !recovering && !stillImages && !debug.replay && video.readyState < 2)) return;
      if (!acquire) {
        if (!encoder?.active || debug.recording?.() === false || originals?.active === false) return;
        const elapsed = performance.now() - recordingStart;
        // Freeze the video frame directly. Full-screen pixel readback and raw
        // storage belong to the Worker, independently of source playback.
        liveOriginals.capture(video,elapsed);
        return;
      }
      if (!debug.replay && !recovering && inputFrame === video) frameTime = deliveredTime ?? video.currentTime;
      if(preparedSources&&(!Number.isFinite(frameTime)||frameTime<0))throw Error('공통 입력의 음수 미디어 시각은 지원하지 않습니다. 원래 PTS를 임의 보정하지 않았습니다.');
      const width = frozen?.width ?? ("videoWidth" in inputFrame ? inputFrame.videoWidth : "naturalWidth" in inputFrame ? inputFrame.naturalWidth : inputFrame.width);
      const height = frozen?.height ?? ("videoHeight" in inputFrame ? inputFrame.videoHeight : "naturalHeight" in inputFrame ? inputFrame.naturalHeight : inputFrame.height);
      if (!width || !height) return;
      const nativeFrame=frozen&&'displayWidth' in frozen.source?frozen.source:undefined;
      const nativeAcquisition=!!(debug.nativeAcquisition&&acquisition?.supportsNative&&continuous&&!recovering&&(!frozen||nativeFrame));
      const copyStarted=performance.now();
      if (frame.width !== width || frame.height !== height) { frame.width = width; frame.height = height; }
      if(!nativeAcquisition&&(!preparedSources||recovering&&!replayRgba&&!replayNative&&!replayPreparedInput))copyScannerInput(frameContext,frozen?.source ?? inputFrame);
      const copyMs=performance.now()-copyStarted;
      const recordingActive = !continuous && !recovering && encoder?.active && debug.recording?.() !== false;
      if (recordingActive) {
        const elapsed = performance.now() - recordingStart;
        // A screen video's media clock can already include model warm-up.
        // Saved PNGs and the new recording must share a recording-local clock.
        encoder!.submit(frame, continuous ? elapsed / 1000 : frameTime, elapsed);
      }
      // Detector, metadata and crops must use the exact pixels saved to PNG,
      // rather than reading a video element again after its decoder advances.
      const currentFrame = frame;
      // Both consumers freeze the same source, not two reads of a moving video.
      const ownedNative=nativeAcquisition&&!nativeFrame?new VideoFrame(video):undefined;
      const frozenNative=nativeFrame??ownedNative;
      let savedId=originalId??(recovering?replayPreparedSourceId:undefined);
      const elapsed=(capturedAt??performance.now())-recordingStart;
      if(continuous&&!recovering&&!frozen) {
        savedId=liveOriginals.capture(nativeAcquisition?frozenNative!:currentFrame,elapsed);
      }
      if(preparedSources){
        if(recovering&&replayCanonicalFrameId!==undefined&&replayRgba){savedId=replayCanonicalFrameId;}
        else if(savedId===undefined){
          savedId=preparedSources.submit(frozen?.source??replayNative??(recovering?currentFrame:video),frameTime,elapsed,recovering?'recovery':'input');
          preparedSources.retain(savedId);
        }
        if(savedId===undefined)throw Error('공통 입력 원본 예약 실패');
        if(!recovering)liveOriginals.remember(frameTime*1000);
      }else if(canonicalSource){
        savedId=canonicalSource.input(frozenNative??currentFrame,frameTime,elapsed,recovering?'recovery':'input',
          recovering?replayCanonicalFrameId:savedId,!!debug.exact&&debug.recording?.()!==false);
        if(!recovering&&savedId!==undefined&&canonicalSource.active)liveOriginals.remember(frameTime*1000);
      }
      const originReceipt=replayAnalysis?.rasterReceipt;
      const cached=recovering&&replayAnalysis?.width===width&&replayAnalysis.height===height&&(!preparedSources||
        !!originReceipt&&canonicalSource?.canReuseAnalysis(originReceipt)&&originReceipt.sourceFrameId===savedId&&
        originReceipt.captureTime===frameTime&&originReceipt.hash===replaySourceHash)?replayAnalysis:undefined;
      const omittedCrops=cached?new Set<number>():undefined;
      let recordedFrameId:number|undefined;
      // Cached acquisitions do not enter the worker again; record their exact
      // input explicitly. Uncached recovery is acquired AND recorded once there.
      if(canonicalSource&&recovering&&cached&&acquisition)recordedFrameId=acquisition.reserveFrameId();
      else if(debug.exact&&recovering&&(cached||!acquisition)){try{if(!acquisition)throw Error('복구 입력 기록 Worker 없음');recordedFrameId=await acquisition.recordOnly(currentFrame,frameTime);}catch(error){debug.exact.incomplete(String(error));}}
      let remote:(Omit<Awaited<ReturnType<NonNullable<typeof acquisition>['detectAndAcquire']>>,'rasterReceipt'>&{rasterReceipt?:SourceRasterReceipt})|undefined;
      try {
        // Reuse binds to a measured origin for this exact physical source.
        // Painting restored bytes preserves every main-thread metadata consumer.
        if(preparedSources&&cached&&replayRgba)frameContext.putImageData(new ImageData(new Uint8ClampedArray(replayRgba.buffer),width,height),0,0);
        remote = cached ? {frameId:recordedFrameId??state.sampled+1,layout:cached.layout,
          ...(preparedSources&&cached.rasterReceipt?{rasterReceipt:{...cached.rasterReceipt,kind:'analysis-reused' as const,
            acquisitionFrameId:recordedFrameId!,originAcquisitionFrameId:cached.rasterReceipt.acquisitionFrameId}}:{}),cells:cached.cells.map((cell,index)=>{
          const omitted=resolvedSavedObservation(cached.observations[index],confirmedFieldOrder);
          if(omitted)omittedCrops!.add(index);
          return {...cell,image:omitted?document.createElement('canvas'):crop(currentFrame,cell.content)};
        })} :
          preparedSources&&acquisition ? await acquisition.detectPrepared(recovering&&replayRgba&&savedId===replayCanonicalFrameId?
          {pixels:replayRgba,width,height,binding:{sourceFrameId:savedId!,captureTime:frameTime}}:replayPreparedInput??await preparedSources.take(savedId!),currentFrame) :
          acquisition ? nativeAcquisition
          ? await acquisition.detectNative(frozenNative!,currentFrame,frameTime)
          : await acquisition.detectAndAcquire(currentFrame,frameTime,recovering?'recovery':'input') : undefined;
      } finally {ownedNative?.close();}
      if(cached){state.recoveryReuse??={frames:0,observations:0,skippedOriginals:0};state.recoveryReuse.frames++;}
      if(liveScreen&&!recovering&&remote?.timing) {
        state.livePerformance??={acquisitionMs:0,recognized:0,uniqueCards:0,firstResultMs:null,lagMs:0};
        const {profile,detectorProfile,...timing}=remote.timing;
        state.livePerformance.detectorProfile=addDetectorProfile(state.livePerformance.detectorProfile,detectorProfile);
        state.livePerformance.acquisitionProfile=addAcquisitionProfile(state.livePerformance.acquisitionProfile,profile);
        const old=state.livePerformance.stages,samples=(old?.samples??0)+1;
        const stages={...timing,copyMs,samples};
        for(const key of ['copyMs','freezeMs','roundTripMs','workerMs','detectMs','cropMs','materializeMs'] as const)
          stages[key]=(old?.[key]??0)+(stages[key]-(old?.[key]??0))/samples;
        state.livePerformance.stages=stages;
        const locationKind=remote.layout?'located':'unlocated';
        const groups=state.livePerformance.stagesByLocation??={};
        const previousStage=groups[locationKind],groupSamples=(previousStage?.samples??0)+1;
        const groupStage={...timing,copyMs,samples:groupSamples};
        for(const key of ['copyMs','freezeMs','roundTripMs','workerMs','detectMs','cropMs','materializeMs'] as const)
          groupStage[key]=(previousStage?.[key]??0)+(groupStage[key]-(previousStage?.[key]??0))/groupSamples;
        groups[locationKind]=groupStage;
      }
      const layout = remote ? remote.layout : detector.detect(frame);
      if(liveScreen&&!recovering){
        const source=preparedSources?currentFrame:frozen?.source??currentFrame,at=capturedAt??copyStarted;
        scrollPreview.bind(source,width,height,layout,at);
        selectionHints.bind(source,width,height,layout,at);
      }
      let saved:SavedAcquisition|undefined=cached;
      const measuredOrigin=remote?.rasterReceipt?.kind==='measured'?remote.rasterReceipt:cached?.rasterReceipt;
      if(savedId!==undefined&&!layout)encoder?.attachAnalysis(savedId,saveAcquisition(width,height,null,[],measuredOrigin));
      if(recovering&&remote?.timing){
        const p=state.recoveryPerformance??={frames:0,acquisitionMs:0,copyMs:0,detectMs:0,cropMs:0,readings:0,readMs:0};
        p.frames++;p.acquisitionMs+=remote.timing.roundTripMs;p.copyMs+=copyMs;p.detectMs+=remote.timing.detectMs;p.cropMs+=remote.timing.cropMs;
        p.detectorProfile=addDetectorProfile(p.detectorProfile,remote.timing.detectorProfile);
      }
      state.sampled++;
      const sourceFrameId=replayProvenance?.frameId??remote?.frameId??state.sampled;
      // Acquisition retries of one physical source share an observation key,
      // including when its analysis cache was evicted or could not be joined.
      const physicalSourceId=selectObservationSourceFrameId(preparedSources?'prepared':canonicalSource?'canonical':'unbound',savedId);
      // These domains have different producers. A legacy encoder read receipt
      // or verified archive source never becomes a live canonical store ID.
      const rawSourceId=!canonicalSource&&encoder?(recovering?replayRawSourceFrameId:savedId):undefined;
      const archiveSourceId=replayProvenance?.sourceFrameId;
      const observationFrame=physicalSourceId!==undefined?sourceObservationFrame(captureSession,physicalSourceId,state.sampled):
        rawSourceId!==undefined?sourceObservationFrame(captureSession,rawSourceId,state.sampled,'raw-source'):
        archiveSourceId!==undefined?sourceObservationFrame(captureSession,archiveSourceId,state.sampled,'archive-source'):
        sourceObservationFrame(captureSession,undefined,state.sampled);
      const diagnosticSource:CaptureFrameIdentity|undefined=debug.exact||debug.trace?{
        sessionId:captureSession,processingFrame:state.sampled,acquisitionFrameId:sourceFrameId,
        canonicalSourceFrameId:physicalSourceId??null,
        observationFrameId:observationFrame,inputId:inputStamp?.inputId??null,
        captureTime:frameTime,phase:recovering?'recovery':'input',sourceWidth:width,sourceHeight:height,
      }:undefined;
      if(!preparedSources||savedId===undefined||preparedSources.isPersistent(savedId))
        canonicalSource?.use(savedId,sourceFrameId,recovering?'recovery':'input',frameTime,remote?.rasterReceipt);
      else trace('canonical-source-gap',{kind:'ephemeral-unrecorded',sourceFrameId:savedId,acquisitionFrameId:sourceFrameId,
        phase:recovering?'recovery':'input',captureTime:frameTime});
      if(inputStamp)recordInput('input-link',{inputId:inputStamp.inputId,frameId:sourceFrameId,captureTime:frameTime,phase:recovering?'recovery':'input'});
      if(decoderLineage)recordMedia('media-input-link',()=>parseMediaInputLink({version:1,
        sequenceId:decoderLineage!.sequenceId,sourceId:decoderLineage!.sourceId,role:decoderLineage!.role,ordinal:decoderLineage!.ordinal,
        processingFrame:state.sampled,acquisitionFrameId:sourceFrameId,captureTime:frameTime,phase:recovering?'recovery':'input'}));
      trace('frame',{frame:state.sampled,sourceFrameId,time:frameTime,phase:recovering?'recovery':'input',layout,
        ...(replayProvenance?{provenance:replayProvenance}:{}),...(decodedInput?{decoded:decodedInput}:{}),
        ...(decoderLineage?{lineage:decoderLineage}:{})});

      ledger.frame(!!layout);
      state.located = !!layout;
      if(!recovering)grid.begin(!!layout);
      if (!layout) {
        if(diagnosticSource)recordScrollEvidence('scroll-capture',()=>parseScrollCaptureFact({version:1,source:diagnosticSource,
          state:'not-located',bar:null,geometry:null,headerFactId:headerReads.latestFactId}));
        if(!recovering)stationaryInventory.reset();
        previous = [];
        previousVectors = [];
        state.status = "성장 탭과 카드 격자 위치를 찾는 중";
        emit();
        return;
      }
      const location = `${Math.round(layout.area.x / 10)},${Math.round(layout.area.y / 10)}`;
      if (location !== lastLocation) {
        previous = [];
        previousVectors = [];
        lastLocation = location;
        if (state.expected === null) {header = undefined;headerOrigin=undefined;}
      }
      let frameMetadata:Candidate['sortReading'];
      if (
        !captureOnly && !metadata && !metadataRead && !primaryOcrReading &&
        ((isStill && lastMetadataFrame !== inputFrame) ||
          state.growthPoints == null ||
          state.sort == null ||
          frameTime - lastMetadataTime >= 2)
      ) {
        const metadataTime=frameTime;
        const reading = recognizer!.metadata(currentFrame, layout).catch(error=>{
          // A shared OCR Worker may restart after a card deadline. Metadata is
          // optional here and will be retried from a fresh frame, never invented.
          if(error instanceof CardReadTimeout)return {growthPoints:null,sort:null};
          throw error;
        });
        metadata={time:metadataTime,reading};
        // Historical candidates retain their own sort, even when this reading
        // is too old to replace the current global metadata.
        frameMetadata = reading;
        lastMetadataTime = metadataTime;
        lastMetadataFrame = inputFrame;
      }
      if (!captureOnly && !header && state.expected === null) {
        header = crop(currentFrame, layout.header);
        headerOrigin=diagnosticSource?{source:diagnosticSource,headerBox:{...layout.header}}:undefined;
      }
      if (liveScreen && !recovering && !captureOnly) {
        finalHeader??=document.createElement('canvas');
        const box=layout.header,w=Math.round(box.width),h=Math.round(box.height);
        if(finalHeader.width!==w)finalHeader.width=w;
        if(finalHeader.height!==h)finalHeader.height=h;
        finalHeader.getContext('2d',{willReadFrequently:true})!.drawImage(currentFrame,box.x,box.y,box.width,box.height,0,0,w,h);
        finalHeaderOrigin=diagnosticSource?{source:diagnosticSource,headerBox:{...box}}:undefined;
        lastLocatedTime=frameTime;
      }
      if (queue.length >= 1600) {
        if(diagnosticSource)recordScrollEvidence('scroll-capture',()=>parseScrollCaptureFact({version:1,source:diagnosticSource,
          state:'queue-full',bar:{...layout.scrollbar},geometry:null,headerFactId:headerReads.latestFactId}));
        remote?.cells.forEach(cell=>{cell.image.width=0;if(cell.previewImage)cell.previewImage.width=0;});
        state.droppedFrames++;
        state.status = "판독 대기열이 찼습니다. 잠시 스크롤을 멈춰 주세요.";
        emit();
        return;
      }
      const bar = layout.scrollbar;
      let scrollGeometry:ReturnType<typeof readScrollGeometry>=null;
      if (
        bar.x >= 0 &&
        bar.y >= 0 &&
        bar.x + bar.width <= width &&
        bar.y + bar.height <= height
      ) {
        scrollContext.drawImage(
          currentFrame,
          bar.x,
          bar.y,
          bar.width,
          bar.height,
          0,
          0,
          16,
          942,
        );
        scrollGeometry = readScrollGeometry(
          scrollContext.getImageData(0, 0, 16, 942).data,
          16,
          942,
        );
        if(diagnosticSource)recordScrollEvidence('scroll-capture',()=>parseScrollCaptureFact({version:1,source:diagnosticSource,
          state:scrollGeometry?'measured':'unreadable',bar:{...bar},geometry:scrollGeometry,headerFactId:headerReads.latestFactId}));
        state.scrollPosition=scrollGeometry?.position??null;
        if(!recovering) {
          grid.geometry(estimateScrollRows(scrollGeometry));
          grid.viewport(inventoryPosition.estimateTop(scrollGeometry));
        }
        if (state.scrollPosition !== null) {
          state.scrollStartSeen ||= state.scrollPosition <= 0.02;
          state.scrollEndSeen ||= state.scrollPosition >= 0.98;
        }
      } else {
        if(diagnosticSource)recordScrollEvidence('scroll-capture',()=>parseScrollCaptureFact({version:1,source:diagnosticSource,
          state:'out-of-bounds',bar:{...bar},geometry:null,headerFactId:headerReads.latestFactId}));
        state.scrollPosition = null;
      }
      const acquired: (ReturnType<typeof acquireCards>[number]&{previewImage?:HTMLCanvasElement})[] = remote?.cells ?? acquireFrame(frame, layout);
      if(savedId!==undefined){saved=saveAcquisition(width,height,layout,acquired,measuredOrigin);encoder?.attachAnalysis(savedId,saved);}
      const coverageSlots=acquired.map(cell=>cell.quality.reason==='미보유 카드 뒷면 · 빈 슬롯');
      if (signal.aborted) { acquired.forEach(cell => { cell.image.width = 0;if(cell.previewImage)cell.previewImage.width=0; }); signal.throwIfAborted(); }
      const images = acquired.map(cell => cell.image), vectors = acquired.map(cell => cell.art),
        observations = acquired.map(cell => cell.feature), alignedCells = acquired;
      state.rowShift = estimateRowShift(previousVectors, vectors);
      state.status = captureOnly ? "카드 획득·품질 검사 중 · OCR 실행 안 함" : "카드별 획득 · 품질 검사 · 판독 중";
      const diagnostics = state.captureDiagnostics!;
      let collectedThisFrame = 0;
      const record = (image: HTMLCanvasElement, slot: number, reason: string, accepted: boolean, sharpness: number) => {
        // Bounded representative examples; retain rejection reasons even after
        // releasing canvas memory. These are observations, not unique card IDs.
        if (!accepted && diagnostics.samples.some(item => !item.accepted && item.reason === reason)) return;
        // Representative diagnostics must not JPEG/WebP-encode every accepted
        // observation on the capture path. Actual candidate previews are lazy.
        if (accepted && performance.now() - lastDiagnosticSample < 250) return;
        if (accepted) lastDiagnosticSample = performance.now();
        const example = { image: image.toDataURL("image/jpeg", .92), time: frameTime, slot, reason, accepted, sharpness };
        if (accepted) {
          const good = diagnostics.samples.filter(item => item.accepted);
          if (good.length >= 24) diagnostics.samples.splice(diagnostics.samples.indexOf(good[0]), 1);
        }
        diagnostics.samples.push(example);
      };
      const stableRows =
        rowMode === "stable"
          ? Array.from(
              { length: Math.ceil(images.length / 10) },
              (_, row) =>
                observations
                  .slice(row * 10, row * 10 + 10)
                  .filter(
                    (v, col) =>
                      settledFields(v, row * 10 + col, previous),
                  ).length >= 8,
            )
          : [];
      const gridGroups=Array<number|undefined>(40).fill(undefined);
      for (let i = 0; i < images.length; i++) {
        diagnostics.acquired++;
        const box = alignedCells[i].content;
        const savedObservation=cached?.observations[i]??(recovering&&preparedSources?
          exactSourceSavedObservation(replayAnalysis,{sourceFrameId:savedId,captureTime:frameTime,width,height,hash:replaySourceHash},alignedCells[i]):undefined);
        const stable = savedObservation?.stable ?? (isStill || settledFields(observations[i], i, previous));
        const trace = ledger.acquire({ frame: state.sampled, time: frameTime, slot: i, box, phase: recovering ? "recording" : "input" });
        // The acquisition Worker has already inspected the same uncompressed
        // pixels. Do not read every returned crop back again on the UI thread.
        const quality = acquired[i].quality;
        recordCaptureEvidence('acquisition-capture',()=>parseAcquisitionCapture({
          version:1,sessionId:captureSession,observationId:String(trace),processingFrame:state.sampled,
          acquisitionFrameId:sourceFrameId,canonicalSourceFrameId:physicalSourceId??null,
          captureTime:frameTime,phase:recovering?'recovery':'input',slot:i,pixelKey:acquired[i].pixelKey,
          ...(acquired[i].fieldRevision?{fieldRevision:acquired[i].fieldRevision}:{}),
          sourceWidth:width,sourceHeight:height,cropState:omittedCrops?.has(i)?'omitted-resolved':'materialized',
          cropWidth:omittedCrops?.has(i)?null:images[i].width,cropHeight:omittedCrops?.has(i)?null:images[i].height,
          nominalBox:layout.cells[i],contentBox:acquired[i].content,previewBox:acquired[i].preview,
          capture:{stable,stabilitySource:savedObservation?'saved-observation':isStill?'still-image':'settled-fields',
            complete:acquired[i].complete??null,intact:acquired[i].intact??null,labelVisible:acquired[i].labelVisible??null,
            borderAlignment:acquired[i].alignment??null,borderSides:acquired[i].borderSides??null},
          quality:{...quality},
        }));
        if(!recovering)grid.cell(i,quality.reason==='미보유 카드 뒷면 · 빈 슬롯'?'empty':quality.usable?'unknown':'review',quality.reason);
        // A duplicate live crop can borrow an observation only when acquisition
        // proved every source pixel and its geometry identical.
        const exactObservation=exactObservations.get(acquired[i].pixelKey);
        if(saved&&!saved.observations[i]&&exactObservation)saved.observations[i]=exactObservation;
        if(recovering&&resolvedSavedObservation(savedObservation,confirmedFieldOrder)) {
          coverageSlots[i]=true;ledger.finish(trace,'duplicate',{reason:'같은 원본의 최신 확정 관측 재사용'});
          state.recoveryReuse??={frames:0,observations:0,skippedOriginals:0};state.recoveryReuse.observations++;
          images[i].width=0;continue;
        }
        if (!quality.usable) {
          ledger.finish(trace, "rejected", { reason: quality.reason });
          diagnostics.rejected++;
          diagnostics.reasons[quality.reason] = (diagnostics.reasons[quality.reason] ?? 0) + 1;
          record(images[i], i, quality.reason, false, quality.sharpness);
          images[i].width = 0;
          continue;
        }
        if (
          (rowMode === "top" && i >= 10) ||
          (rowMode === "stable" && !stableRows[Math.floor(i / 10)])
        ) {
          ledger.finish(trace, "filtered", { reason: "스캔 줄 선택 설정" });
          images[i].width = 0;
          continue;
        }
        // Briefly visible complete names can survive a fast scroll. Keep their
        // evidence separate so rejecting one frame cannot suppress a stable pair.
        const group = captures.offerDetailed(observations[i], i % 10, quality.sharpness, stable);
        const freshRetry = liveScreen && !recovering && group.decision === 'duplicate' ?
          freshObservations.retryPlan(group.id, acquired[i].pixelKey, frameTime, stable,
            observation => resolvedSavedObservation(observation, confirmedFieldOrder),
            observation => needsLatestSavedProof(observation,latestIdentityOrder,confirmedFieldOrder),acquired[i].fieldRevision) : undefined;
        const offered = savedObservation || freshRetry ? 'better' : group.decision;
        gridGroups[i]=group.id;
        // Capture chronology is shared by live and pixel replay. Recovery frames
        // may arrive later while still describing an older card value.
        const order = savedObservation?.order ?? (liveScreen || replayProvenance || debug.replay?.source==='screen'
          ? timedCaptureOrder(initialCaptureOrder, frameTime, i) : offered!=='duplicate'?++captureOrder:captureOrder);
        const groupGrid=(accepted:boolean)=>{if(!recovering)grid.group(i,group.id,trace,accepted,undefined,{
          sessionId:captureSession,frameId:sourceFrameId,observationId:String(trace),
          captureOrder:order,captureTime:frameTime,phase:'input',slot:i,
        });};
        if (offered !== "duplicate") {
          collectedThisFrame++;
          if (offered === "better") diagnostics.improved++;
          record(images[i], i, offered === "better" ? "더 좋은 관측으로 갱신" : "판독 후보", true, quality.sharpness);
          state.collectedCrops = (state.collectedCrops ?? 0) + 1;
          const observation=savedObservation??{order,stable,frame:observationFrame};
          const observationSource:InventorySource={sessionId:captureSession,frameId:sourceFrameId,observationId:String(trace),
            captureOrder:order,captureTime:frameTime,phase:recovering?'recovery':'input',slot:i,frame:observation.frame};
          if(liveScreen&&!recovering)freshnessBridge.use(observation,acquired[i].pixelKey,observationSource);
          const commit=()=>{
            // A large field/name change can form a new visual group. Its
            // unidentified source cannot be retired by the old inventory total.
            if(liveScreen&&!recovering)freshObservations.remember(group.id,acquired[i].pixelKey,frameTime,observation,acquired[i].fieldRevision,true);
            if(saved)saved.observations[i]=observation;
            exactObservations.set(acquired[i].pixelKey,observation);
            while(exactObservations.size>2048)exactObservations.delete(exactObservations.keys().next().value!);
          };
          ledger.finish(trace, captureOnly ? "selected" : "queued", { group: group.id });
          if (captureOnly) { commit();groupGrid(true);coverageSlots[i]=true;images[i].width = 0; continue; }
          const cell=acquired[i];
          const preview = cell.previewImage ?? crop(currentFrame, alignedCells[i].preview);
          cell.previewImage=undefined;
          const execution=recovering&&(observationRecorder||debug.feedbackProbe)?new ObservationWork({
            sessionId:captureSession,frameId:sourceFrameId,observationId:String(trace),
            captureOrder:order,captureTime:frameTime,phase:'recovery',slot:i,
          },debug.feedbackProbe?probeObservation:observationRecorder):undefined;
          const enqueued = queue.push({
            source:observationSource,
            ...(debug.recognitionObserver||debug.exact||debug.trace?{recognitionInput:{processingFrame:state.sampled,
              sourceBox:{...cell.content},sourceWidth:width,sourceHeight:height}}:{}),
            ...(debug.feedbackProbe&&!debug.recognitionObserver&&!debug.exact&&!debug.trace?{feedbackFrame:state.sampled}:{}),
            execution,
            savedObservation:observation,pixelKey:cell.pixelKey,
            ...(freshRetry?.reason==='changed-fields'?{changedFields:true}:{}),
            ...(freshRetry?.exactConfirmed?.identity ? {
              verifiedVisual:freshRetry,knownIdentity:freshRetry.exactConfirmed.identity,
              needsIdentity:false,fieldTarget:{id:freshRetry.exactConfirmed.identity.id,order},
            } : {}),
            group: group.id, trace,
            priorityGroup: liveScreen ? livePriority.group(observations[i],i%10) : -1,
            preview: "", previewCanvas: preview,
            image: images[i],
            feature: observations[i],
            time: frameTime,
            stable,
            borderAlignment: alignedCells[i].alignment,
            order,
            position: { frame: observation?.frame ?? observationFrame, slot: i, stable,
              sort: null,location:scrollCardLocation(scrollGeometry,i,stable) },
            sortReading: frameMetadata,
          });
          coverageSlots[i]=enqueued;
          if(enqueued)commit();
          groupGrid(enqueued);
          if(enqueued){
            try{debug.feedbackProbe?.queued({sessionId:captureSession,frameId:sourceFrameId,observationId:String(trace),
              captureOrder:order,captureTime:frameTime,phase:recovering?'recovery':'input',slot:i},state.sampled);
            }catch{/* A diagnostic failure cannot reject an accepted crop. */}
          }
          if (!enqueued) {
            if(liveScreen&&!recovering){
              freshObservations.rejectChanged(group.id,frameTime,observation);
              // A saved exact original can resolve this rejected source later.
              // This does not commit admission or invent a current identity.
              if(saved)saved.observations[i]=observation;
            }
            execution?.cancel();ledger.finish(trace, "dropped", { group: group.id, reason: "판독 대기열 용량 초과 또는 과거 후보" }); images[i].width = 0; preview.width = 0;
          }
        } else { groupGrid(false);coverageSlots[i]=true;ledger.finish(trace, "duplicate", { group: group.id }); diagnostics.duplicates++; images[i].width = 0; }
      }
      if(!recovering) {
        observedLayout.capture(gridGroups);
        grid.record(state.sampled);
        for(const location of inventoryPosition.capture(state.sampled,gridGroups,scrollGeometry,stationaryInventory.observe(gridGroups,scrollGeometry)))grid.register(location.frame,location.top);
      }
      if(scrollGeometry) {
        scrollCoverage.offer(scrollGeometry.position,scrollGeometry.pageSpan,coverageSlots);
        state.scrollGaps=scrollCoverage.gaps();
        if(import.meta.env.DEV)state.scrollCoverageInfo=scrollCoverage.snapshot();
      } else {
        // Unlocated observations may have covered the apparent gap. Never
        // report an unknown scrollbar interval as proven missing acquisition.
        scrollCoverage.reset();state.scrollGaps=[];
        if(import.meta.env.DEV)state.scrollCoverageInfo=scrollCoverage.snapshot();
      }
      for(const cell of acquired)if(cell.previewImage)cell.previewImage.width=0;
      if (collectedThisFrame) {
        state.captureWindows = (state.captureWindows ?? 0) + 1;
        previousVectors = vectors;
      }
      previous = observations;
      state.queued = queue.length + deferred.length + fullRetries.length;
    };
    let metadataRead: Promise<void> | undefined;
    const settleMetadata = () => metadataRead ??= (async () => {
      signal.throwIfAborted();
      if (metadata) {
        const pending = metadata;
        metadata = undefined;
        const next = metadataOrder.accept(pending.time,await pending.reading);
        if (metadataSortChanged(state.sort??null,next.sort)) {
          grid.resetPositions();
          inventoryPosition.resetPositions();
          stationaryInventory.reset();
          observedLayout.resetPositions();
          livePositions=[];lastLayoutKey='';
          previousVectors = [];
          previous = [];
          scrollCoverage.reset();state.scrollGaps=[];
        }
        if (next.growthPoints) state.growthPoints = next.growthPoints;
        if(next.sort)state.sort=next.sort;
      }
      if (recognizer && header && state.expected === null) {
        const pendingHeader=header,pendingOrigin=headerOrigin;
        const total = await headerReads.read(pendingOrigin,'initial',()=>recognizer!.total(
          pendingHeader,
          {
            x: 0,
            y: 0,
            width: pendingHeader.width,
            height: pendingHeader.height,
          },
          isStill,
        ));
        if (total) {
          state.expected = total.owned;
          state.capacity = total.capacity;
        } else if(header===pendingHeader) {header=undefined;headerOrigin=undefined;}
      }
    })().finally(() => { metadataRead = undefined; });
    const metadataWork={pending:()=>!!(metadata||metadataRead),settle:settleMetadata};
    const drainOne = async (includeDeferred = false, reader = recognizer, fast = false, deferredOnly = false, visual = visuals[0], fullOnly = false) => {
      const quick = deferredOnly;
      if (!fast && reader===recognizer) {
        await waitForReaderMetadata(true,metadataWork);
      }
      // An initial header can arrive while the primary OCR reader is busy.
      // Other lanes must not start total/header OCR on its session then.
      else if(!primaryOcrReading)void settleMetadata().catch(error => { captureError=error; capturing=false; });
      const queued = deferredOnly || fullOnly ? undefined : queue.shift(fast ? item=>livePriority.priority(item.priorityGroup) : undefined);
      const retryPriority=liveScreen ? (item:Candidate)=>
        retryWorkPriority(item,livePriority.retryPriority(item.priorityGroup),confirmedFieldOrder,latestIdentityOrder) : undefined;
      const takeRetry=(work:Candidate[])=>{
        pruneFieldRetries(work,confirmedFieldOrder,discardObsoleteRetry);
        if(!retryPriority)return shiftOcrRetry(work);
        let schedule=retrySchedules.get(reader!);
        if(!schedule){schedule=new LiveRetrySchedule();retrySchedules.set(reader!,schedule);}
        return schedule.shift(work,retryPriority);
      };
      const item = queued ?? (includeDeferred ? fullOnly ? takeRetry(fullRetries) : takeRetry(deferred) ?? (!quick ? takeRetry(fullRetries) : undefined) : undefined);
      state.queued = queue.length + deferred.length + fullRetries.length;
      if (!item) return;
      const visualOnly=fast||!!item.verifiedVisual;
      const fullRead=!quick&&(isStill||!queued||deferred.length>=512);
      const readStage=visualOnly?'visual':fullRead?'full':'short';
      if(recovering&&resolvedSavedObservation(item.savedObservation,confirmedFieldOrder)) {
        discardObsoleteRetry(item);
        state.recoveryReuse??={frames:0,observations:0,skippedOriginals:0};state.recoveryReuse.observations++;
        return;
      }
      const recoveryReadStart=recovering?performance.now():undefined;
      const finishReading=liveScreen&&!recovering
        ? ledger.beginRead(item.trace,readStage,(performance.now()-recordingStart)/1000,
          {priorityGroup:item.priorityGroup,priorReads:livePriority.priority(item.priorityGroup),priorOcrAttempts:livePriority.attempts(item.priorityGroup)})
        : undefined;
      if(liveScreen&&!recovering&&!visualOnly)livePriority.attempted(item.priorityGroup);
      if(liveScreen&&capturing&&!recovering&&!visualOnly&&(quick||fullOnly)&&
          (video.srcObject as MediaStream|null)?.getVideoTracks().some(track=>track.readyState==='live')){
        state.liveOcrStarted??={short:0,full:0};
        state.liveOcrStarted[fullOnly?'full':'short']++;
      }
      let retained = false;
      let failedFieldIdentity: string | undefined;
      let activityStatus:ScanActivityItem['status']='review';
      let attempt:{budget:CardReadBudget;finish:()=>void}|null|undefined;
      let budget=new CardReadBudget();
      let visualResult: VisualResult | undefined;
      let acceptedIdentity: Candidate['knownIdentity'];
      let inspectionIdentity:Candidate['knownIdentity'];
      let inspection:RecognitionInspection|undefined,inspectionStarted=0,inspectionBudgetStart=0;
      let identifyExecuted=false,nameMatchCount=0,inspectionTimedOut=false,inspectionError:string|null=null;
      const finishPreview=async()=>{if(item.previewTask)item.preview=await item.previewTask;signal.throwIfAborted();};
      const reject = async () => { ledger.finish(item.trace, "unidentified", { group: item.group, reason: "이름 판독 실패", nameAttempts: reader?.nameDiagnostics(item.image) }); await finishPreview();reportUnknown(item.image, item.time, false, item.preview, item.group, item.order,item.position.location,'이름 확인 필요',{source:item.source,pixelKey:item.pixelKey,nameAttempts:reader?.nameDiagnostics(item.image),portraitDiagnostics:reader?.portraitDiagnostics(item.image)}); };
      const linkIdentity = (identity:NonNullable<Candidate['knownIdentity']>) => {
        const effect=unknownLifecycle!.confirmName({kind:'group',sessionId:captureSession,group:item.group},identity.id,
          unknownSource(item.source),identity.review);
        if(effect?.retiredVersions.length){unknownDiagnostics.retire(effect.retiredVersions);refreshUnknown();}
        if(!identity.review.includes('이름 확인')) {
          inventory!.confirmName(item.source,identity.id);
          observedLayout.identify(item.group,identity.id);
          grid.identify(item.group,identity.id);
          for(const location of inventoryPosition.identify(item.group,identity.id))grid.register(location.frame,location.top);
        }
      };
      const defer = async (unknown = true, fieldId?:string) => {
        if(item.verifiedVisual)return false;
        if ((!queued && !quick) || isStill) return false;
        const fieldTarget=!unknown&&fieldId ? {id:fieldId,order:item.order} : undefined;
        if(obsoleteFieldRetry({needsIdentity:unknown,fieldTarget},confirmedFieldOrder))return false;
        const knownIdentity=!unknown ? acceptedIdentity : undefined;
        const target = quick ? fullRetries : deferred;
        const fields = visualResult?.fields ?? await reader!.inspect(item.image);
        // Retry eligibility belongs to image quality, not awakening support:
        // growthless cards have legitimate labels but no five-jewel observation.
        if (!retryEligible({ ...fields, needsIdentity: unknown, stable: item.stable, borderAlignment: item.borderAlignment }))
          return false;
        const feature = item.feature;
        const previous = retryCandidateIndex(target,item);
        if (previous >= 0) {
          retained=replaceRetryCandidate(target,previous,{...item,feature,needsIdentity:unknown,fieldTarget,knownIdentity},old=>{
            ledger.finish(old.trace,"superseded",{group:old.group,reason:"재시도 이미지 개선"});
            releaseCandidate(old);
          });
        } else if (target.length < 512) {
          target.push({ ...item, feature, needsIdentity: unknown, fieldTarget, knownIdentity });
          retained = true;
        } else if (item.stable) {
          const replace = target.findIndex((old) => !old.stable);
          if (replace >= 0) {
            const old = target[replace];
            ledger.finish(old.trace, "dropped", { group: old.group, reason: "재시도 보관 용량 초과" });
            reportUnknown(old.image, old.time, false, old.preview, old.group, old.order,old.position.location,'이름 확인 필요',{source:old.source,pixelKey:old.pixelKey});
            releaseCandidate(old);
            target[replace] = { ...item, feature, needsIdentity: unknown, fieldTarget, knownIdentity };
            retained = true;
          }
        }
        if (retained) {
          activityStatus='waiting';
          item.execution?.finish('waiting');
          ledger.finish(item.trace, "deferred", { group: item.group, reason: unknown ? "이름 보조 판독 대기" : "장수·각성 보조 판독 대기" });
          state.queued = queue.length + deferred.length + fullRetries.length;
          if (unknown) {await finishPreview();reportUnknown(item.image, item.time, true, item.preview, item.group,item.order,item.position.location,'이름 확인 필요',{source:item.source,pixelKey:item.pixelKey,nameAttempts:reader?.nameDiagnostics(item.image),portraitDiagnostics:reader?.portraitDiagnostics(item.image)});}
        }
        return retained;
      };
      readingJobs++;
      state.activeReadings=readingJobs;
      let gridRead:number|undefined;
      let activityRead:number|undefined;
      let executionRead:number|undefined;
      try {
        if (item.previewCanvas) {
          // The thumbnail owns its canvas until encoding settles. Recognition
          // starts immediately on the separate crop and retries share the job.
          item.previewTask = previews.encodeOwned(item.previewCanvas);
          item.previewCanvas = undefined;
        }
        signal.throwIfAborted();
        if(debug.feedbackProbe){
          const processingFrame=item.recognitionInput?.processingFrame??item.feedbackFrame;
          if(processingFrame!==undefined){
            const {sessionId,frameId,observationId,captureOrder,captureTime,phase,slot}=item.source;
            feedbackReadContext={source:{sessionId,frameId,observationId,captureOrder,captureTime,phase,slot},processingFrame};
          }
        }
        try{
          gridRead=grid.start(item.trace);
          executionRead=item.execution?.start();
        }finally{feedbackReadContext=undefined;}
        activityRead=activity.start(item.trace,item.preview);
        if(item.previewTask)void item.previewTask.then(image=>{
          if(signal.aborted)return;
          item.preview=image;
          // Update only this trace: do not reorder the activity strip or reset
          // a newer status when a slow optional thumbnail arrives.
          if(activity.updateImage(item.trace,image))emit();
        }).catch(()=>{/* Optional thumbnail presentation cannot reject a reader. */});
        emit();
        attempt=item.verifiedVisual ? readAttempts.beginVerifiedVisual(item.verifiedVisual) : readAttempts.begin(item.pixelKey,readStage);
        budget=attempt?.budget ?? new CardReadBudget();
        if(debug.recognitionObserver&&item.recognitionInput){
          inspectionStarted=performance.now();inspectionBudgetStart=budget.remaining();
          inspection=beginRecognitionInspection(debug.recognitionObserver,{
            ...item.recognitionInput,diagnosticReadId:++diagnosticReadOrdinal,slot:item.position.slot,
            source:{...item.source},group:item.group,trace:item.trace,pixelKey:item.pixelKey,
            stage:readStage,stable:item.stable,borderAlignment:item.borderAlignment,
            cropWidth:item.image.width,cropHeight:item.image.height,
          });
        }
        // An exact-pixel short pass may already be running for an earlier
        // observation. Retain this candidate for its reserved full pass rather
        // than treating admission coalescing as an unreadable latest capture.
        if(!attempt&&readStage==='short'&&readAttempts.canBegin(item.pixelKey,'full')) {
          acceptedIdentity=fieldRetryIdentity(item);
          if(await defer(!acceptedIdentity,acceptedIdentity?.id))return;
        }
        if(!attempt)throw new CardReadTimeout();
        // Full retries use the best retained crop and an independent reader;
        // they can run during sharing without serializing source acquisition.
        if (item.sortReading) {
          const assignSort = (meta: Awaited<NonNullable<typeof item.sortReading>>) => {
            item.position.sort = meta.sort ? { ...meta.sort } : null;
            // Metadata may settle after this observation was recorded. Keep
            // that change explicit rather than mutating an archived object.
            if(acceptedIdentity&&inventory!.observeSort(item.source,acceptedIdentity.id,item.position.sort))cardsDirty=true;
          };
          if (visualOnly) void item.sortReading.then(assignSort).catch(error => { captureError=error; capturing=false; });
          else assignSort(await item.sortReading);
        }
        if (fast && visual) visualResult=await budget.wait(()=>visual.read(item.image),()=>{
          visual.dispose();const index=visuals.indexOf(visual);if(index>=0)visuals[index]=createVisualClient(signal);
        });
        const retainedIdentity=fieldRetryIdentity(item);
        if(retainedIdentity){state.retryWork??={skippedFields:0,reusedIdentities:0};state.retryWork.reusedIdentities++;}
        identifyExecuted=!retainedIdentity&&!visualOnly;
        // This is the identity-selection boundary. A retained identity and a
        // completed visual-worker result are explicit paths, not new OCR calls.
        if(item.recognitionInput)recordCaptureEvidence('recognition-capture',()=>parseRecognitionCapture({
          version:1,invocationId:++recognitionCaptureOrdinal,
          source:{sessionId:item.source.sessionId,frameId:item.source.frameId,observationId:item.source.observationId,
            captureOrder:item.source.captureOrder,captureTime:item.source.captureTime,phase:item.source.phase,slot:item.source.slot},
          acquisition:{sessionId:item.source.sessionId,observationId:item.source.observationId},
          processingFrame:item.recognitionInput!.processingFrame,stage:readStage,stable:item.stable,
          borderAlignment:item.borderAlignment,structural:item.borderAlignment>=.8,fullRead,
          portraitRefinement:identifyExecuted&&fullRead&&debug.fractionalPortrait===true,
          grayNameFallback:identifyExecuted&&fullRead&&debug.grayNameFallback===true,
          cropWidth:item.image.width,cropHeight:item.image.height,
          identityPath:retainedIdentity?'retained':visualOnly?fast&&visual?'visual-worker':'visual-reader':'ocr-reader',
        }));
        const identity = retainedIdentity ?? (visualOnly ? (visualResult ? visualResult.identity : reader!.identifyVisual(item.image)) : await reader!.identify(
          item.image,
          fullRead,
          item.stable,
          item.borderAlignment >= .8,
          budget,
          fullRead&&debug.fractionalPortrait===true,
          inspection?(pixels,recipe)=>{nameMatchCount++;inspection!.captureLabel(pixels,recipe);}:undefined,
          fullRead&&debug.grayNameFallback===true,
        ));
        inspectionIdentity=identity??undefined;
        if (!identity) {
          const inspected = visualResult?.fields ?? await reader!.inspect(item.image);
          const visibleCard =
            inspected?.awakening != null ||
            (item.stable && (inspected?.labelPixels ?? 0) >= 35);
          if (await defer()) return;
          ledger.finish(item.trace, "unidentified", { group: item.group, reason: "이름 판독 실패", nameAttempts: reader!.nameDiagnostics(item.image) });
          if (!queued || visibleCard) {
            await finishPreview();
            reportUnknown(item.image, item.time, false, item.preview, item.group,item.order,item.position.location,'이름 확인 필요',{source:item.source,pixelKey:item.pixelKey,nameAttempts:reader?.nameDiagnostics(item.image),portraitDiagnostics:reader?.portraitDiagnostics(item.image)});
          }
          return;
        }
        if ((queued || quick) && identity.review.includes("이름 확인")) {
          // A stable frame can still have a damaged name. It must receive the
          // same full retry as an uncertain scrolling frame before completion.
          if (await defer()) return;
          if (!item.stable && identity.confidence < .9) { await reject(); return; }
        }
        acceptedIdentity=identity;
        if(item.savedObservation)item.savedObservation.identity=identity;
        freshnessBridge.linkIdentity(item.savedObservation,item.source,item.pixelKey);
        inventory!.acceptIdentity(item.source,identity.id);
        cardsDirty=true;
        // A failed visual attempt must not make a still-unknown portrait wait
        // behind known cards. Count service only after an identity is accepted,
        // including identities recovered by the independent OCR reader.
        if (liveScreen) livePriority.serviced(item.priorityGroup);
        ledger.finish(item.trace, "identified", { group: item.group, cardId: identity.id, name: identity.name });
        if(recovering&&cards.has(identity.id)&&resolvedSavedObservation({order:item.order,frame:item.position.frame,stable:item.stable,identity},confirmedFieldOrder)) {
          // Identify THIS crop first. A same/newer confirmed capture already
          // proves its fields; do not manufacture another count observation.
          // If an even newer capture failed, keep that current review visible.
          linkIdentity(identity);
          activityStatus=confirmedReadingCount({cards:[cards.get(identity.id)!],...fieldEvidence})?'read':'review';
          state.recoveryReuse??={frames:0,observations:0,skippedOriginals:0};state.recoveryReuse.observations++;
          grid.finish(item.trace,activityStatus,gridRead);item.execution?.finish(activityStatus,executionRead);emit();
          return;
        }
        let values:Awaited<ReturnType<NonNullable<typeof reader>['read']>>;
        try {values=visualResult?.values ?? await reader!.read(item.image, identity.id, false, !visualOnly,budget);}
        catch(error){if(!(error instanceof CardReadTimeout)||item.verifiedVisual)throw error;values=await reader!.read(item.image,identity.id,false,false);}
        const identified = item.feature;
        const repeatedCount = countObservations.offer(identity.id, item.position.frame, identified, {
          borderAlignment: item.borderAlignment, awakening: values.awakening,
          extraCopies: values.extraCopies, pattern: values.countDiagnostics?.pattern });
        const resolveCountReliability = () => countReliability({ stable: item.stable,
          repeatedCount,
          borderAlignment: item.borderAlignment, awakening: values.awakening,
          maxAwakening: identity.maxAwakening, extraCopies: values.extraCopies,
          pattern: values.countDiagnostics?.pattern,
          iconPresent: values.countDiagnostics?.iconPresent,
          patternOcrAgreed: values.countDiagnostics?.patternOcrAgreed,
          ocrConfirmedValue: values.countDiagnostics?.ocrConfirmedValue });
        let reliability = resolveCountReliability();
        if (!visualOnly && reliability === "unconfirmed" && values.awakening !== null &&
            values.countDiagnostics?.pattern?.value != null && !identity.review.length) {
          try{values = await reader!.read(item.image, identity.id, true,true,budget);}
          catch(error){if(!(error instanceof CardReadTimeout))throw error;}
          reliability = resolveCountReliability();
        }
        if (values.extraCopies === 0 && reliability === "unconfirmed") {
          values.extraCopies = null;
          if (values.countDiagnostics)
            values.countDiagnostics.reason = "추가 카드 표시 없음 · 온전한 카드 또는 안정된 장수 영역 확인 필요";
        }
        if (values.awakening === null) {
          state.unreadable++;
        }
        state.stable++;
        identifiedThisRun.add(identity.id);
        // Native input can drain several queued frames after the track ends.
        // Do not count that useful tail work as recognition during sharing.
        const recognizedLive=liveScreen && capturing && !recovering &&
            (video.srcObject as MediaStream | null)?.getVideoTracks().some(track => track.readyState === 'live');
        if (recognizedLive) {
          const elapsed = performance.now() - recordingStart;
          state.livePerformance ??= { acquisitionMs: 0, recognized: 0, uniqueCards: 0, firstResultMs: null, lagMs: 0 };
          state.livePerformance.recognized++;
          liveIdentities.add(identity.id);
          state.livePerformance.uniqueCards = liveIdentities.size;
          state.livePerformance.firstResultMs ??= elapsed;
          state.livePerformance.lagMs = Math.max(0, elapsed - item.time * 1000);
        }
        linkIdentity(identity);
        const review = [...identity.review];
        if (values.countDiagnostics) values.countDiagnostics.reliability = reliability;
        if (values.awakening === null) review.push("각성 확인");
        if (values.extraCopies === null) review.push("추가 장수 확인");
        // Image publication waits only after identity/field work has overlapped
        // the optional encode; never attach a late image to a newer card result.
        await finishPreview();
        const observation:ScannedCard={
          ...identity,
          ...values,
          nameEvidence: identity.nameEvidence.map(r => ({ ...r, stable: item.stable, frame: item.position.frame })),
          review,
          image: item.preview,
          time: item.time,
          captureOrder: item.order,
          capturePosition: item.position,
          countReliable: reliability !== "unconfirmed",
          observations: 1,
        };
        const change=inventory!.recordObservation(item.source,observation,item.borderAlignment);
        if(change.latestDiagnostic) {
          if(change.diagnosticResolved)fieldImages.resolved(identity.id,item.order);
          else failedFieldIdentity=identity.id;
        }
        if(recognizedLive)liveInventory.record(observation);
        if(change.fieldsConfirmed) {
          pruneFieldRetries(deferred,confirmedFieldOrder,discardObsoleteRetry);
          pruneFieldRetries(fullRetries,confirmedFieldOrder,discardObsoleteRetry);
          state.queued=queue.length+deferred.length+fullRetries.length;
        }
        if(debug.trace)trace('position-debug',inventoryPosition.diagnostics());
        {const card=cards.get(identity.id)!;trace('card',{trace:item.trace,order:item.order,time:item.time,id:card.id,name:card.name,awakening:card.awakening,extraCopies:card.extraCopies,review:card.review});}
        activityStatus=cards.get(identity.id)!.review.length||reliability==='unconfirmed'?'review':'read';
        state.currentRunNames=confirmedCaptureCount({cards:[...cards.values()],latest:latestIdentityOrder,confirmedNames:confirmedNameOrder});
        if (liveScreen && !recovering) {
          if (!identity.review.includes('이름 확인')) finishTimer.record(identity.id, item.time * 1000);
          if (state.finishTiming?.expected !== state.expected) state.finishTiming = undefined;
          if (!state.finishTiming && state.currentRunNames === state.expected)
            state.finishTiming = finishTimer.coverage([...latestIdentityOrder.keys()], state.expected, performance.now() - recordingStart);
        }
        cardsDirty = true;
        state.resultPresentation ??= { observations: 0, updates: 0, milliseconds: 0 };
        state.resultPresentation.observations++;
        state.status = recovering ? "연속 기록 정밀 판독 중" :
          state.queued > 0
            ? `카드 스캔 중 · ${state.queued}개 판독 대기`
            : "카드 스캔 중";
        // Mark the cell before publishing; optional retry inspection may await.
        grid.finish(item.trace,activityStatus==='read'?'read':activityStatus==='review'?'review':'waiting',gridRead);
        item.execution?.finish(activityStatus==='read'?'read':activityStatus==='review'?'review':'waiting',executionRead);
        emit();
        if ((fast || quick) && (reliability === "unconfirmed" || values.awakening === null)) await defer(false,identity.id);
      } catch (error) {
        inspectionTimedOut=error instanceof CardReadTimeout;
        inspectionError=error instanceof Error?`${error.name}: ${error.message}`:String(error);
        if(error instanceof CardReadTimeout){
          signal.throwIfAborted();
          if(item.fieldTarget){
            // The identity was already accepted. Leave its unresolved fields
            // reviewable instead of creating a duplicate unnamed card.
            ledger.finish(item.trace,'identified',{group:item.group,cardId:item.fieldTarget.id,reason:error.message});
          }else{
            ledger.finish(item.trace,'unidentified',{group:item.group,reason:error.message,nameAttempts:reader?.nameDiagnostics(item.image)});
            await finishPreview();
            reportUnknown(item.image,item.time,false,item.preview,item.group,item.order,item.position.location,error.message,{source:item.source,pixelKey:item.pixelKey,nameAttempts:reader?.nameDiagnostics(item.image),portraitDiagnostics:reader?.portraitDiagnostics(item.image)});
          }
          return;
        }
        ledger.finish(item.trace, "dropped", { group: item.group, reason: "판독 처리 오류" });
        throw error;
      } finally {
        activity.finish(item.trace,activityStatus,acceptedIdentity?.name??item.knownIdentity?.name,activityRead);
        grid.finish(item.trace,({read:'read',waiting:'waiting',review:'review',reading:'waiting'} as const)[activityStatus],gridRead);
        item.execution?.finish(activityStatus==='read'?'read':activityStatus==='review'?'review':'waiting',executionRead);
        readingJobs--;
        state.activeReadings=readingJobs;
        const inspectionBudgetEnd=inspection?budget.remaining():0;
        attempt?.finish();
        // Successful and failed crops cross the same diagnostic boundary. PNG
        // and SHA work belongs to the injected dev collector after scanning.
        if(inspection){
          const elapsedMs=performance.now()-inspectionStarted;
          inspection.captureCard(item.image);
          inspection.finish({admitted:!!attempt,identifyExecuted,nameMatchCount,
            budgetRemainingAtStart:inspectionBudgetStart,budgetRemainingAtEnd:inspectionBudgetEnd,
            elapsedMs,timedOut:inspectionTimedOut,error:inspectionError,
            identified:inspectionIdentity?{id:inspectionIdentity.id,name:inspectionIdentity.name,
              review:inspectionIdentity.review.slice(),confidence:inspectionIdentity.confidence}:null,
            acceptedIdentity:acceptedIdentity?{id:acceptedIdentity.id,name:acceptedIdentity.name}:null,
            status:activityStatus,retained,diagnostics:identifyExecuted?reader?.nameDiagnostics(item.image)??[]:[],
          });
        }
        if(failedFieldIdentity && latestFieldObservations.get(failedFieldIdentity)?.card.captureOrder === item.order) {
          // Encode exact failed pixels after the OCR budget closes. Encoding
          // must not consume a later retry's time or include preview borders.
          try {
            fieldImages.capture(failedFieldIdentity,item.order,item.pixelKey,()=>item.image.toDataURL('image/png'));
            cardsDirty = true;
          } catch { /* Diagnostics must never block card recognition. */ }
        }
        if(recoveryReadStart!==undefined&&state.recoveryPerformance){state.recoveryPerformance.readings++;state.recoveryPerformance.readMs+=performance.now()-recoveryReadStart;}
        finishReading?.((performance.now()-recordingStart)/1000);
        // Thumbnail encoding owns a separate canvas and cannot delay releasing
        // this recognition crop once its readers have settled.
        if (!retained) {
          freshObservations.finish(item.savedObservation);
          item.image.width = 0;
          item.image.height = 0;
        }
        emit();
      }
    };
    if (debug.replay || stillImages || source === "video") {
      const originalUrl=video.currentSrc||video.src;
      const decoded=()=>observationRecorder?withMediaLineage(decodedFrames(originalUrl,signal),originalUrl,signal,
        {role:'original-file',parentCaptureSessionId:captureSession,onFact:mediaFact,onError:mediaRecordingError}):decodedFrames(originalUrl,signal);
      const inputs = debug.replay ? debug.replayInputs ?? replayDebugFrames(debug.replay, signal) : stillImages ? imageInputs(stillImages, signal) : decoded();
      for await (const input of inputs) {
        const origin=debug.replay?normalizeScannerInputFrame(input as ScannerInputFrame):undefined;
        replayProvenance=origin?.provenance;
        decoderLineage=(origin??input as ScannerInputFrame).lineage;
        recovering=replayProvenance?.phase==='recovery';
        inputFrame = input.element;
        if ("time" in input) frameTime = input.time;
        if (debug.replay && "image" in input && input.image) debug.preview?.(input.image);
        state.percent = input.percent;
        try {
          await collect();
          while (queue.length) await drainOne();
        } finally {recovering=false;replayProvenance=undefined;decoderLineage=undefined;}
        emit();
      }
    } else {
      // Recording and original snapshots continue alongside bounded live
      // acquisition. OCR consumes crops independently while the share is live.
      let lastSnapshotTime = -Infinity;
      const stopped = () => {
        scrollPreview.clear();grid.liveViewport(undefined,false);
        state.sharingEndedAt??=(performance.now()-recordingStart)/1000;
        state.workPhase = 'reading';
        capturing = false;
        if(liveScreen&&recognizer)state.shareEndInventory=liveInventory.finish(recognizer.catalog);
        void continuous?.finish();
        emit(true);
      };
      const failed = (error: unknown) => { captureError = error; stopped(); };
      const autoCompletion=new AutoCompletionHold();
      let lastCompletionCheck=-Infinity;
      const captureCompletion=()=>({expected:state.expected,finalExpected:state.expected,
        fieldChangesSettled:freshness!.guard('capture').settled,
        cards:confirmSortedNames([...cards.values()],[...evidence.values()].flat(),recognizer!.catalog),
        latest:latestIdentityOrder,confirmedNames:confirmedNameOrder,confirmed:confirmedFieldOrder,
        // Preparing a shifted candidate's preview is not an idle boundary:
        // the identity of that observation has not yet been checked.
        inputSettled:!liveCollection&&previews.waiting===0,headerAvailable:!!finalHeader?.width&&Number.isFinite(lastLocatedTime)});
      const tryAutoStop=async()=>{
        if(!liveScreen||!recognizer||!capturing||signal.aborted||captureError||state.autoStopped)return;
        const now=performance.now();
        if(now-lastCompletionCheck<100)return;
        lastCompletionCheck=now;
        if(state.expected!==latestIdentityOrder.size||!hasCompleteCaptureEvidence(captureCompletion())){
          // Header/experience OCR must not freeze acquisition and every reader
          // while unseen cards or their latest fields still need observations.
          if(!primaryOcrReading)void settleMetadata().catch(failed);
          autoCompletion.reset();return;
        }
        // Reserve a gap only after names AND latest fields are ready. Recheck
        // after flushing accepted input, which may invalidate that evidence.
        if(liveCollection) {
          checkingCompletion=true;
          try {await liveCollection;} finally {checkingCompletion=false;}
          signal.throwIfAborted();
          if(captureError||!capturing)return;
        }
        if(await deferCompletionForMetadata(hasCompleteCaptureEvidence(captureCompletion()),metadataWork,
          paused=>{checkingCompletion=paused;}))return;
        const input=captureCompletion();
        if(!autoCompletion.observe(input,performance.now())||!finalHeader)return;
        // Reserve the idle OCR session and freeze the header during this final
        // check. Source backup continues until tracks are actually stopped.
        checkingCompletion=true;
        try {
          const total=await headerReads.read(finalHeaderOrigin,'auto-completion',()=>recognizer!.total(finalHeader!,{x:0,y:0,width:finalHeader!.width,height:finalHeader!.height}));
          signal.throwIfAborted();
          const media=video.srcObject as MediaStream|null;
          if(capturing&&media?.getVideoTracks().some(track=>track.readyState==='live')&&
            canStopSharing({...captureCompletion(),finalExpected:total?.owned??null})) {
            state.autoStopped=true;
            stopCompletedShare(media,()=>{stopInput?.();stopped();});
            state.status='전체 카드 수집 완료 · 화면 공유 자동 종료';emit(true);
          } else autoCompletion.reset();
        } catch(error) {
          autoCompletion.reset();
          if(signal.aborted)throw error;
        } finally {checkingCompletion=false;}
      };
      const recordSnapshot = (time: number) => {
        if (continuous && (time < lastSnapshotTime || time - lastSnapshotTime >= .25)) {
          lastSnapshotTime = time;
          void collect(false, time).catch(failed);
        }
      };
      if(observationRecorder)inputReplay=new InputDecisionReplay(new AbortController().signal);
      const inputStats=state.liveInputPipeline={offered:0,processed:0,replaced:0,capacityDropped:0,sourceCapacityDeferred:0,selectionHints:0,selectionMs:0,maxSelectionMs:0,freezeMs:0,maxFreezeMs:0,queueWaitMs:0,maxQueueWaitMs:0};
      const capturePipeline=createLiveCapturePipeline<{frame:FrozenLiveFrame;at:number;originalId?:number;rawLease?:CanonicalRawLease;stamp:InputStamp}>({
        now:()=>performance.now()-recordingStart,
        maxPendingFrames:2,maxRetainedBytes:maxRetainedRasterBytes,
        frameBytes:input=>input.frame.width*input.frame.height*4,
        onDecision:decision=>{
          if(decision.kind==='replaced')inputStats.replaced++;
          if(decision.kind==='released'&&decision.reason==='capacity')inputStats.capacityDropped++;
          if(observationRecorder)recordInput('input-decision',decision);
        },
        onRecordError:inputRecordingError,
        yieldTask:()=>yieldForCapture(signal),
        consume:async(input,time)=>{
          signal.throwIfAborted();
          const started=performance.now();
          inputStats.processed++;
          const delay=Math.max(0,started-input.at);
          inputStats.queueWaitMs+=(delay-inputStats.queueWaitMs)/inputStats.processed;
          inputStats.maxQueueWaitMs=Math.max(inputStats.maxQueueWaitMs,delay);
          trace('input-accept',{inputId:input.stamp.inputId,time});
          // Only a representative actually entering acquisition becomes a new
          // physical source. A policy backup already has its own exact ID.
          let originalId=input.originalId;
          if(originalId===undefined&&input.rawLease){
            if(canonicalSource?.active&&debug.recording?.()!==false)
              originalId=rawLiveSource!.commit(input.rawLease,input.frame.source,time,time*1000);
            else input.rawLease.release();
          }
          await collect(true,time,input.frame,input.at,originalId,input.stamp);
          const completion={kind:'completed' as const,startedAtMs:started-recordingStart,endedAtMs:performance.now()-recordingStart};
          inputAdmission.completed(completion.startedAtMs,completion.endedAtMs);
          recordInput('input-admission',completion);
          state.livePerformance ??= { acquisitionMs: 0, recognized: 0, uniqueCards: 0, firstResultMs: null, lagMs: 0 };
          state.livePerformance.acquisitionMs = inputAdmission.snapshot().acquisitionMs;
          emit();
        },
        release:input=>{input.rawLease?.release();preparedSources?.release(input.originalId);input.frame.close();},onError:failed,
      });
      disposeLiveCapture=()=>capturePipeline.dispose();
      signal.addEventListener('abort',disposeLiveCapture,{once:true});
      const acquireLiveFrame = (time: number, nativeFrame?: VideoFrame, delivered?:Readonly<{mediaTime:number;presentedFrames:number;missedFrames:number}>) => {
        const at=performance.now();
        // Limit source snapshots, independently of the lightweight scrollbar.
        // Slow CPU fallback must not recopy a 60 Hz full screen while busy.
        const stamp=inputAdmission.stamp(time,at-recordingStart);
        // Record callback coordinates even for cadence/verification skips.
        // They are not frozen-pixel evidence and never enter policy stamps.
        recordInputDiagnostic('input-arrival',()=>inputArrival(stamp,nativeFrame?.timestamp,delivered));
        const persistRawInput=!!rawLiveSource&&!!debug.exact&&canonicalSource?.active===true&&debug.recording?.()!==false;
        const gates={capturing,checkingCompletion,...(persistRawInput?{sourceCapacity:rawLiveSource!.capacity(nativeFrame??video)}:{}),
          ...(debug.minInputIntervalMs===undefined?{}:{minIntervalMs:debug.minInputIntervalMs}),
          ...(import.meta.env.DEV&&debug.inputOfferFloorMs!==undefined?{offerFloorMs:debug.inputOfferFloorMs}:{})};
        const admission=inputAdmission.consider(stamp,gates);
        recordInput('input-admission',{kind:'consider',stamp,gates,
          expected:admission.kind==='freeze'?'freeze':admission.reason});
        if(admission.kind==='skip') {
          if(admission.reason==='source-capacity')inputStats.sourceCapacityDeferred++;
          trace('input-skip',{inputId:stamp.inputId,time,reason:admission.reason});return liveCollection;
        }
        // Freeze before yielding. A later read of video would give old capture
        // times to new pixels. Preserve bounded representatives of distinct
        // views while acquisition runs; OCR has its own candidate queue.
        // Admission/diagnostic bookkeeping is not pixel snapshot work. Keep
        // its cost out of the adaptive freeze cadence measurement.
        // Hold byte credit while this immutable representative is queued. No
        // source ID or storage job exists until acquisition or a policy backup
        // commits it; replacement can therefore release unused credit cheaply.
        const rawLease=persistRawInput?rawLiveSource!.lease(nativeFrame??video):undefined;
        let snapshot:ReturnType<typeof freezeLiveFrameTimed>;
        try{snapshot=freezeLiveFrameTimed(nativeFrame??video);}
        catch(error){rawLease?.release();throw error;}
        const {frame:frozen,freezeMs}=snapshot;
        let handedOff=false,originalId:number|undefined;
        try {
          inputAdmission.frozen(stamp,{succeeded:!!frozen,freezeMs});
          recordInput('input-admission',{kind:'frozen',stamp,succeeded:!!frozen,freezeMs});
          if(!frozen)return liveCollection;
          if(frozen.width*frozen.height*4>maxRetainedRasterBytes){
            state.captureWarning='공유 화면의 해상도가 입력 보관 한도를 초과했습니다. 화면 공유를 다시 시작해 주세요.';
          }
          inputStats.offered++;inputStats.freezeMs+=(freezeMs-inputStats.freezeMs)/inputStats.offered;
          inputStats.maxFreezeMs=Math.max(inputStats.maxFreezeMs,freezeMs);
          const selectionStarted=performance.now();
          const hint=selectionHints.read(frozen.source,frozen.width,frozen.height,at);
          const selectionMs=performance.now()-selectionStarted;
          if(hint)inputStats.selectionHints++;
          inputStats.selectionMs+=(selectionMs-inputStats.selectionMs)/inputStats.offered;
          inputStats.maxSelectionMs=Math.max(inputStats.maxSelectionMs,selectionMs);
          // Correlation annotates these immutable pixels after admission. It
          // never changes captureTime or turns a source clock into freshness.
          const offeredStamp:InputStamp='timestamp' in frozen.source?
            {...stamp,source:correlateSourceFrame(frozen.source.timestamp,delivered)}:stamp;
          // Keep the existing backup cadence. Only a due backup consumes the
          // lease now; otherwise the representative carries its reserved credit
          // into consume(). Already committed backups survive replacement.
          originalId=persistRawInput?liveOriginals.capture(frozen.source,time*1000,
            (source,captureTime,elapsed)=>rawLiveSource!.commit(rawLease,source,captureTime,elapsed,'backup')):
            liveOriginals.capture(frozen.source,time*1000);
          recordInputDiagnostic('input-backup-reservation',()=>parseInputBackupReservation({version:1,inputId:stamp.inputId,
            captureTime:stamp.captureTime,store:preparedSources?'prepared-native':'capture-originals',reservationId:originalId??null}));
          preparedSources?.retain(originalId);
          capturePipeline.offer({frame:frozen,at:recordingStart+time*1000,originalId,rawLease,stamp:offeredStamp},time,offeredStamp,hint);
          handedOff=true;
          if(!liveCollection)liveCollection=capturePipeline.flush().finally(()=>{liveCollection=undefined;});
          return liveCollection;
        }finally{
          if(!handedOff){rawLease?.release();preparedSources?.release(originalId);frozen?.close();}
        }
      };
      // Experimental opt-in until real-input accuracy and speed are verified.
      const trackInput = debug.trackFrames && liveScreen ? tryStartTrackFrames(video, signal, async stamp => {
        if (stamp.missedFrames !== undefined)
          state.liveMissedFrames = (state.liveMissedFrames ?? 0) + stamp.missedFrames;
        await acquireLiveFrame(Math.max(0, (stamp.capturedAt - recordingStart) / 1000), stamp.frame);
        if (captureError) throw captureError;
      }, stopped, failed) : undefined;
      state.liveInput = trackInput ? 'track' : 'video';
      const publishScrollPreview=()=>{
        // Only the small scrollbar strip is read, independently of OCR.
        if(capturing&&video.readyState>=2) {
          const previewStarted=performance.now();
          const geometry=scrollPreview.read(video,video.videoWidth,video.videoHeight,previewStarted);
          if(geometry!==undefined) {
            if(geometry) {
              const duration=performance.now()-previewStarted;
              const stats=state.scrollPreviewPerformance??={samples:0,readMs:0,maxReadMs:0,duringAcquisition:0};
              stats.samples++;stats.readMs+=duration;stats.maxReadMs=Math.max(stats.maxReadMs,duration);
              if(liveCollection)stats.duringAcquisition++;
            }
            const top=inventoryPosition.estimateTop(geometry);
            if(grid.liveViewport(top)) {
              try{debug.feedbackProbe?.viewport(top,previewStarted);}catch{/* Preview timing is display-only. */}
              if(feedback)publishFeedback(grid.viewportSnapshot(feedbackState?.grid??state.grid),feedbackState?.currentRunRead);
              else {
                state.grid=grid.viewportSnapshot(state.grid);
                update({...state});
              }
            }
          }
        }
      };
      const videoInput = startLiveFrames(
        video,
        signal,
        stamp => {
          const time = stamp?.mediaTime ?? video.currentTime;
          if (trackInput) {recordSnapshot(time);return;}
          state.liveMissedFrames = (state.liveMissedFrames ?? 0) + (stamp?.missedFrames ?? 0);
          // The encoder records every delivered source frame independently.
          // A four-row page can pass within one second during fast scrolling.
          // Keep four frozen originals/s without main-thread raster readback.
          if (liveScreen) {
            const started = performance.now();
            void acquireLiveFrame((started - recordingStart) / 1000,undefined,stamp);
          } else if (!liveCollection) {
            liveCollection = collect(true, time).catch(error => { captureError = error; capturing = false; })
              .finally(() => { liveCollection = undefined; });
          }
          recordSnapshot(time);
        },
        () => { if (!trackInput) stopped(); },
        failed,
        33, publishScrollPreview,
      );
      stopInput = () => { videoInput(); trackInput?.(); };
      state.workPhase = 'capture';
      state.status = "화면 공유 실시간 수집·판독 중";
      emit();
      // All readers share one UI time budget; four independent 8 ms budgets
      // could otherwise occupy one browser turn for over 32 ms.
      let lastYield=performance.now();
      const consumers = [recognizer, ...extraRecognizers].map(async (reader, index) => {
        const schedule=new LiveReaderSchedule();
        try {
          while (capturing || liveCollection || queue.length || deferred.length || fullRetries.length) {
            signal.throwIfAborted();
            if (captureError) throw captureError;
            if(checkingCompletion){await waitForInput(signal);continue;}
            if(index===0)await tryAutoStop();
            const job=schedule.next(index,lanePlan,{queued:queue.length,short:deferred.length,full:fullRetries.length,live:capturing||!!liveCollection});
            if (job) {
              const fast=job==='fast';
              // The sole reader must service OCR during sharing, but metadata
              // acquisition cannot enqueue another use of that same session.
              const primaryRetry=!fast&&reader===recognizer;
              if(primaryRetry)primaryOcrReading=true;
              try {await drainOne(!fast,reader,fast,job==='short',visuals[index],job==='full');}
              finally {if(primaryRetry)primaryOcrReading=false;}
              // Small time slices avoid a clamped timer after every cheap card,
              // while still giving video callbacks a turn within about 8ms.
              if(performance.now()-lastYield>=8) {
                await yieldForCapture(signal);lastYield=performance.now();
              }
            } else await waitForInput(signal);
          }
        } catch (error) {
          captureError = error; capturing = false; stopInput?.();
          throw error;
        }
      });
      // Join all consumers before releasing canvases or their OCR sessions.
      await Promise.allSettled(consumers);
      if (captureError) throw captureError;
      signal.throwIfAborted();
      await liveCollection;
      state.workPhase = 'verifying'; emit(true);
      await settleMetadata();
      while(metadata || metadataRead)await settleMetadata();
      const finalCards=recognizer ? confirmSortedNames([...cards.values()], [...evidence.values()].flat(), recognizer.catalog) : [];
      const completionInput={expected:state.expected,finalExpected:state.expected,cards:finalCards,
        fieldChangesSettled:freshness!.guard('recovery').settled,
        latest:latestIdentityOrder,confirmed:confirmedFieldOrder,pending:queue.length+deferred.length+fullRetries.length,
        unresolved:Math.max(state.unidentified.length,ledger.snapshot().unresolvedGroups),dropped:state.droppedFrames,
        inputSettled:!capturing&&!liveCollection,
        tailFresh:freshCaptureTail(state.located,state.autoStopped===true,lastLocatedTime,state.sharingEndedAt)};
      trace('completion-check',{autoStopped:state.autoStopped,lastLocatedTime,sharingEndedAt:state.sharingEndedAt,
        fieldChangesSettled:completionInput.fieldChangesSettled,
        pending:completionInput.pending,unresolved:completionInput.unresolved,dropped:completionInput.dropped,
        tailFresh:completionInput.tailFresh,read:confirmedReadingCount(completionInput),expected:state.expected});
      // Check the final acquired header again, after OCR sessions are idle.
      // This prevents an initial total or a restored list from certifying completion.
      let verifiedFinalExpected:number|null=state.autoStopped?state.expected:null;
      if(canFinishVerifiedCapture(completionInput,state.autoStopped===true))state.recoverySkipped=true;
      else if(recognizer&&finalHeader&&completionInput.tailFresh) {
        try {
          const total=await headerReads.read(finalHeaderOrigin,'ended-capture',()=>recognizer!.total(finalHeader!,{x:0,y:0,width:finalHeader!.width,height:finalHeader!.height}));
          signal.throwIfAborted();
          verifiedFinalExpected=total?.owned??null;
          const verifiedTail={...completionInput,finalExpected:verifiedFinalExpected};
          // Input can end before the last live reader finishes. Apply the same
          // current-name/field proof as auto-stop once every accepted job is
          // joined and the fresh final header has independently been read.
          // Unmatched crops remain visible; this does not identify/discard them.
          state.recoverySkipped=canSkipRecovery(verifiedTail)||canFinishEndedCapture({
            ...verifiedTail,confirmedNames:confirmedNameOrder,inputClosed:!capturing,
            headerVerified:verifiedFinalExpected!==null,headerAvailable:!!finalHeader.width,
            inputSettled:completionInput.inputSettled&&!readingJobs&&previews.waiting===0&&!metadata&&!metadataRead,
          });
        } catch {
          signal.throwIfAborted();
          // A failed optional completion check must retain the recovery path.
          state.recoverySkipped=false;
        }
      }
      const recording = await continuous?.finish();
      // This gate never ends recovery. The encoder additionally checks each
      // exact receipt (or every remaining receipt) before omitting any pixels.
      // Other queued/active observations and unanalysed video still run.
      const canFinishOriginals=()=>!captureError&&!!recognizer&&canSkipCoveredOriginals({
        ...completionInput,expected:state.expected,finalExpected:verifiedFinalExpected,
        fieldChangesSettled:freshness!.guard('recovery').settled,
        cards:confirmSortedNames([...cards.values()],[...evidence.values()].flat(),recognizer.catalog),
        confirmedNames:confirmedNameOrder,dropped:state.droppedFrames,
        inputClosed:!capturing&&!liveCollection,headerVerified:verifiedFinalExpected!==null,
        headerAvailable:!!finalHeader?.width,metadataSettled:!metadata&&!metadataRead,
      });
      const snapshots = directOriginals && encoder ? async function*(){await preparedSources?.flush();yield* encoder!.frames(signal,{
        ready:canFinishOriginals,covered:analysis=>coveredSavedAcquisition(analysis,confirmedFieldOrder),
        skipped:count=>{state.recoveryReuse??={frames:0,observations:0,skippedOriginals:0};state.recoveryReuse.skippedOriginals+=count;},
      });} : debug.snapshots ?? originals?.frames;
      if(state.recoverySkipped) {
        state.workPhase = 'cleanup';
        state.recoveryFrames=0;
        state.status='전체 카드 검증 완료 · 임시 기록 정리 중';emit(true);
        if(recording)debug.continuous?.(recording);
        // Explicit debug exports still finish; ordinary internal backups can
        // release their raw frames without encoding every frame into PNG.
        if(encoder&&!debug.record)await encoder.discard();
      } else if (recording || (encoder && snapshots)) {
        if (recording) debug.continuous?.(recording);
        if (encoder && snapshots && !directOriginals) {
          state.status = `공유 종료 · ${encoder.captured}개 원본 캡처 준비 중`; emit(true);
          await encoder.finish();
        }
        // Unknown encoded intervals are still acquired. Exact lossless originals
        // carry their own acquisition receipts; no timestamp-nearest reuse.
        recovering = true;
        state.workPhase = 'recovery'; state.recoveryPercent = 0;
        previous = []; previousVectors = []; lastMetadataTime = -Infinity;
        state.recoveryFrames = 0;
        state.status = "연속 기록에서 누락 카드 보완 중"; emit(true);
        async function* snapshotsSafely() {
          try { yield* snapshots!(); }
          catch (error) {
            signal.throwIfAborted();
            recordingFailure = `원본 캡처 보완 실패: ${error instanceof Error ? error.message : "기록 읽기 실패"}`;
            state.captureWarning = recordingFailure; emit(true);
          }
        }
        // A failed/oversized continuous file must not erase valid originals.
        const recoveryDecodeOptions={explicitRgba:debug.rgbaRecovery,nativePrepared:!!preparedSources,
          ...(observationRecorder?{lineage:{role:'re-recorded-video' as const,parentCaptureSessionId:captureSession,
            onFact:mediaFact,onError:mediaRecordingError}}:{})};
        const recoveryInputs = recording
          ? encoder && snapshots
            ? mergeFrames(recordedFrames(recording, signal,recoveryDecodeOptions), snapshotsSafely(), signal)
            : recordedFrames(recording, signal,recoveryDecodeOptions)
          : snapshotsSafely();
        // Preparation owns at most one future input. Actual acquisition and
        // state mutation remain ordered in collectRecovery; no decoder sample
        // is dropped or treated as a newer capture because it finishes first.
        const prefetched=preparedSources?preparedRecoveryPrefetch(recoveryInputs,preparedSources,signal,{elapsed:()=>performance.now()-recordingStart}):undefined;
        type RecoveryInput={element:HTMLCanvasElement|HTMLVideoElement|HTMLImageElement|OffscreenCanvas;time:number;percent:number;analysis?:SavedAcquisition;canonicalFrameId?:number;rawSourceFrameId?:number;decoded?:DecodedRgbaMetadata;lineage?:MediaDecodedFrame;preparedSourceId?:number;preparedInput?:PreparedAcquisitionInput};
        const recovery:AsyncIterable<RecoveryInput>=prefetched??recoveryInputs;
        const collectRecovery = async (input:RecoveryInput) => {
          if(captureError)throw captureError;
          inputFrame = input.element; frameTime = input.time;
          replayAnalysis=input.analysis;
          replayCanonicalFrameId=input.canonicalFrameId;
          replayRawSourceFrameId=input.rawSourceFrameId;
          replayRgba='rgba' in input?input.rgba as Uint8Array<ArrayBuffer>|undefined:undefined;
          replayNative='nativeFrame' in input?input.nativeFrame as VideoFrame|undefined:undefined;
          replayPreparedInput=input.preparedInput;replayPreparedSourceId=input.preparedSourceId;
          replaySourceHash='sourceHash' in input?input.sourceHash as string|undefined:undefined;
          // A decoded sample receipt describes only this input. Raw snapshots
          // must not inherit the previous decoded sample's ordinal or digest.
          decodedInput=input.decoded;
          decoderLineage=input.lineage;
          state.percent = input.percent;
          try{await collect();}finally{decodedInput=undefined;decoderLineage=undefined;replayRgba=undefined;replayNative=undefined;replaySourceHash=undefined;replayPreparedInput=undefined;replayPreparedSourceId=undefined;replayRawSourceFrameId=undefined;}
          state.recoveryFrames=(state.recoveryFrames??0)+1;
          // Merged sources have different frame totals. Use their common capture
          // timeline, and reserve 100% until both iterators have been exhausted.
          state.recoveryPercent = state.sharingEndedAt && state.sharingEndedAt > 0
            ? Math.max(state.recoveryPercent ?? 0, Math.min(99, input.time / state.sharingEndedAt * 100)) : undefined;
          state.status = `연속 기록 보완 중 · ${state.recoveryFrames}프레임 검사`;
          emit();
        };
        if(debug.parallelRecovery!==false&&recognizer&&visuals.length) {
          const readers=[recognizer,...extraRecognizers],schedules=readers.map(()=>new LiveReaderSchedule());
          let lastYield=performance.now();
          await runRecoveryPipeline(recovery,signal,{
            collect:collectRecovery,pending:()=>queue.length+deferred.length+fullRetries.length,
            lanes:readers.length,highWaterMark:80,
            consume:async index=>{
              if(captureError)throw captureError;
              const job=schedules[index].next(index,lanePlan,{queued:queue.length,short:deferred.length,full:fullRetries.length,live:false});
              if(!job)return false;
              const fast=job==='fast',primaryRetry=!fast&&index===0;
              if(primaryRetry)primaryOcrReading=true;
              try {await drainOne(!fast,readers[index],fast,job==='short',visuals[index],job==='full');}
              finally {if(primaryRetry)primaryOcrReading=false;}
              if(performance.now()-lastYield>=8){await yieldForCapture(signal);lastYield=performance.now();}
              return true;
            },
          });
        } else for await(const input of recovery) {
          await collectRecovery(input);
          while(queue.length)await drainOne();
        }
        if(prefetched)trace('prepared-recovery-prefetch',prefetched.stats);
        state.recoveryPercent = 100;
      }
    }
    state.workPhase = 'reading'; emit(true);
    if (debug.parallelRecovery !== false && recovering && recognizer) {
      await runJoinedWorkers([recognizer, ...extraRecognizers].map(reader => async stopped => {
        while (!stopped() && (deferred.length || fullRetries.length)) {
          signal.throwIfAborted();
          await drainOne(true, reader);
        }
      }));
    } else while (deferred.length || fullRetries.length) await drainOne(true);
    while(metadata||metadataRead)await settleMetadata();
    if (captureError) throw captureError;
    state.workPhase = 'verifying'; emit(true);
    refreshCards();
    if (recognizer) state.cards = confirmSortedNames([...cards.values()], [...evidence.values()].flat(), recognizer.catalog).sort((a,b) => cardCollator.compare(a.name,b.name));
    state.cards=projectCurrentScanFields(state.cards,fieldEvidence);
    state.pendingFields=pendingFieldDiagnostics();
    state.currentRunNames=confirmedCaptureCount({cards:state.cards,latest:latestIdentityOrder,confirmedNames:confirmedNameOrder});
    state.currentRunRead=confirmedReadingCount({cards:state.cards,latest:latestIdentityOrder,confirmed:confirmedFieldOrder});
    state.unresolvedFieldChanges=freshness!.guard('final').unresolved;
    if(liveScreen)state.identifiedAfterSharing=state.cards.filter(card=>identifiedThisRun.has(card.id)&&!liveIdentities.has(card.id)).map(({id,name})=>({id,name}));
    refreshGrid=undefined;
    refreshFeedback=undefined;
    if(!state.unresolvedFieldChanges&&state.expected&&state.currentRunRead===state.expected&&state.cards.length===state.expected&&state.cards.every(card=>!card.review.length)) {
      grid.confirm(state.cards.map(card=>card.id));
      grid.restoreOrder(inventoryPosition.verifiedOrder());
      grid.restorePositions(observedLayout.resolve(state.cards.map(card=>card.id),inventoryPosition.verifiedPositions()));
    }
    state.percent = 100;
    state.status = captureOnly ? "카드 획득·품질 검사 완료 · OCR 실행 안 함"
      : scanCompletion(state.expected, state.cards.length, Math.max(state.cards.filter(card => card.review.length).length,
        (state.currentRunNames??0)-(state.currentRunRead??0)),state.currentRunNames??0,state.unidentified.filter(item=>!item.pending).length);
    if(state.unresolvedFieldChanges)state.status+=` · 최신 필드 관측 ${state.unresolvedFieldChanges}개 확인 필요`;
    emit(true);
  } catch(error) {
    propagateFailure(error);
  } finally {
    try {
      state.workPhase = 'cleanup'; emit(true);
      stopInput?.();
      disposeLiveCapture?.();
      if(disposeLiveCapture)signal.removeEventListener('abort',disposeLiveCapture);
      await liveCollection?.catch(()=>{});
      if(finalHeader)finalHeader.width=0;
      if(debug.exact&&!canonicalSource)try{await acquisition?.stopRecording();}catch(error){debug.exact.incomplete(String(error));}
      acquisition?.dispose();
      try{await preparedSources?.finish();}catch(error){debug.exact?.incomplete(String(error));}
      preparedSources?.dispose();await sourcePreparation?.dispose();
      for(const visual of visuals) visual?.dispose();
      releasePending?.();
      auditComplete = true;
      const finalRecording = await continuous?.finish();
      if (finalRecording) debug.continuous?.(finalRecording);
      if (finalRecording && !debug.continuous) await finalRecording.dispose?.();
      const finalStatus = state.status;
      // Internal backups have no consumers left, including when recovery failed
      // before its raw iterator started. Never launch an unused PNG export here.
      if(encoder&&!debug.record)await encoder.discard();
      else if(encoder) {
        if(!signal.aborted) { state.status = `카드 판독 종료 · ${encoder.captured}개 캡처 원본 준비 중`; emit(true); }
        await encoder.finish();
      }
      if(ownCanonicalStore)await canonicalStore?.dispose();
      if(canonicalSource)state.sourceStore={kind:'canonical',...canonicalSource.stats,...(preparedSources?{preparation:preparedSources.stats}:{})};
      // Snapshot only after the reads settle. Metrics must not add work to the
      // live UI publisher or make a diagnostic getter stop a valid scan.
      try{state.nameOcrMetrics=[recognizer,...extraRecognizers].flatMap(reader=>
        reader&&typeof reader.nameOcrMetrics==='function'?[reader.nameOcrMetrics()]:[]);}
      catch{/* Optional request counters do not determine card evidence. */}
      if (originals) {
        try { await originals.dispose(); }
        catch { state.captureWarning = "임시 원본 캡처 정리에 실패했습니다."; }
      }
      state.status = finalStatus;
      if (recordingFailure) debug.recordingError?.(recordingFailure);
      emit(true);
    } catch(error) {
      propagateFailure(error);
    } finally {
      publisher.cancel();
      try {
        finalTrace('end',{aborted:signal.aborted,expected:state.expected,read:state.currentRunRead,cards:state.cards.map(({id,name,awakening,extraCopies,review})=>({id,name,awakening,extraCopies,review}))});
        await disposeReaders();
        if (state.finishTiming && state.finishTiming.expected === state.expected && state.percent === 100 && !signal.aborted) {
          state.finishTiming = finishTimer.finish(state.finishTiming, performance.now() - recordingStart);
          emit(true);
        }
        // No remaining publisher or reader may mutate this checkpoint while
        // hashing. This diagnostic boundary does not gate live card feedback.
        publisher.dispose();feedbackPublisher.dispose();
        if(observationRecorder) {
          try {finalTrace('grid-checkpoint',{complete:true,hash:await hashScanGridReplay(scanGridReplaySnapshot(grid))});}
          catch(error) {incompleteFinalRecord('진행 상태 검증점 생성 실패');finalTrace('grid-checkpoint',{complete:false,error:String(error)});}
          try {finalTrace('inventory-checkpoint',{complete:true,hash:await inventoryCheckpoint()});}
          catch(error) {incompleteFinalRecord('카드 근거 검증점 생성 실패');finalTrace('inventory-checkpoint',{complete:false,error:String(error)});}
          if(unknownLifecycle){
            const snapshot=unknownLifecycle.snapshot();
            let recorded=false;
            try{recorded=finalTrace('unknown-checkpoint',{version:1,complete:snapshot.complete,events:snapshot.facts,hash:await hashUnknownLifecycle(snapshot)});}
            catch{/* Hash failure also leaves the checkpoint incomplete. */}
            if(!recorded){
              unknownLifecycle.markIncomplete('event-sink-failed');
              finalTrace('unknown-checkpoint',{version:1,complete:false,events:snapshot.facts,hash:null});
            }
          }
          if(freshness){
            const snapshot=freshness.snapshot();
            let recorded=false;
            try{recorded=finalTrace('freshness-checkpoint',{version:1,complete:snapshot.complete,events:snapshot.facts,
              hash:snapshot.complete?await hashFreshnessEvidence(snapshot):null});}
            catch{/* A failed hash must not certify this state channel. */}
            if(!recorded){
              freshness.markIncomplete('event-sink-failed');
              finalTrace('freshness-checkpoint',{version:1,complete:false,events:snapshot.facts,hash:null});
            }
          }
          if(inputReplay) {
            try {
              finalTrace('input-checkpoint',{complete:true,hash:await inputCheckpoint()});
            }catch(error){incompleteFinalRecord('입력 선택 검증점 생성 실패');finalTrace('input-checkpoint',{complete:false,error:String(error)});}
          }
        }
      } finally {publisher.dispose();feedbackPublisher.dispose();await previews.dispose();}
    }
  }
}
