/** The scan of a shared screen and the state it publishes (docs/scanner-session-design.md). The
 * earlier frame-by-frame scanner loop was removed in v0.3.0; screen shares are read by the
 * row-centred scan (row-scanner.ts). */
import {type ScanGridSnapshot} from '../session/scan-grid';
import type {ObservationSource} from '../session/observation-execution';
import type {NameAttempt} from '../recognition/name-diagnostics';
import {createCanonicalCapture} from '../reproduction/canonical-capture';
import {createPreparedLiveSource} from '../acquisition/prepared-live-source';
import {guardScan} from '../ui/scan-watchdog';
import {CardReadAttempts} from '../recognition/card-read-budget';
import {type ScanActivityItem} from '../ui/scan-activity';
import type {PreparedScanner} from '../session/scanner-preparation';
import {type ScannerNameConfiguration} from '../session/scanner-name-configuration';
import {createScannerNameOperation} from '../session/scanner-name-operation';
import type {FrameObstructionProbeEvent} from '../acquisition/acquisition-client';
import {type DetectorProfile} from '../acquisition/detector-profile';
import type {AcquisitionProfileSummary} from '../acquisition/acquisition-profile';
import type {AcquisitionTiming} from '../acquisition/acquisition-client';
import type {LedgerSnapshot} from "../session/scan-ledger";
import {type FinishTiming} from '../session/finish-timing';
import type {CardSort} from "../recognition/capture-metadata";
import {inputScale} from "../acquisition/detector";
import {createRecognizer} from "../recognition/recognizer";
import type {ScannedCard} from "../recognition/recognizer-types";
import type {PortraitDiagnostics} from '../recognition/portrait-diagnostics';
import {CompletionInputDiagnostic} from '../session/completion-input-diagnostic';
import {type AdvisoryExperimentSummary} from '../session/advisory-obstruction-experiment';
import {ScrollCoverage} from '../session/scroll-coverage';
import type {ScrollGap} from '../session/scroll-coverage';
import {type CountSourceProbeStats} from '../recognition/count-source-probe';
import type {LiveInventorySnapshot} from '../session/live-inventory';
import {type PositiveCompletionReceipt} from '../session/positive-completion';
import {type RecognitionNeededSlot} from '../session/recognition-needed';
import type {PendingCardFields} from '../session/current-scan-fields';
import {SourceBindingMetadataDiagnostics} from '../acquisition/saved-acquisition';
import type {DrainInputLoss,DrainInputLossReason} from '../session/completion-drain-loss';
import type {AutoCompletionDiagnostic} from '../session/auto-completion-diagnostics';

export type UnidentifiedObservation = { image: string; recognitionImage?:string; time: number; captureOrder?: number; pending: boolean; group?: number; reason?:string; location?:import('../session/scroll-card-location').ScrollCardLocation; source?:ObservationSource; nameAttempts?:readonly NameAttempt[]; portraitDiagnostics?:PortraitDiagnostics|null };
export interface ScannerState {
  /** Current-run proof, emitted only at the final joined evidence boundary. */
  completionReceipt?: PositiveCompletionReceipt;
  /** Chosen name-reader behavior, independent of capture/identity evidence. */
  nameConfiguration?:ScannerNameConfiguration;
  grid?:ScanGridSnapshot;
  activity?:ScanActivityItem[];
  interrupted?: 'stalled' | 'cancelled' | 'failed';
  processingWarning?: string;
  workPhase?: import('../ui/read-progress').ScanWorkPhase;
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
  growthHistory?: import('../../growth/complete-growth').GrowthCompletion[];
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
  liveInputPipeline?: {offered:number;processed:number;replaced:number;capacityDropped:number;sourceCapacityDeferred?:number;selectionHints:number;selectionMs:number;maxSelectionMs:number;freezeMs:number;maxFreezeMs:number;queueWaitMs:number;maxQueueWaitMs:number;
    /** Development comparison label; absent in older reports. */
    selector?:'arrival'|'coverage';coverage?:{complete:number;partial:number;none:number;chosen:number;dropped:number;scored:number}};
  sourceStore?:{kind:'canonical';preparation?:ReturnType<typeof createPreparedLiveSource>['stats']}&ReturnType<typeof createCanonicalCapture>['stats'];
  captureWarning?: string;
  /** The shared picture is smaller than the supported size (row-scanner-state.ts, smallScreenNotice). */
  resolutionNotice?: string;
  /** An independently displayed, unresolved storage header conflict. */
  headerConflict?: boolean;
  scrollCaptureDiagnosticError?:string;
  ledger?: LedgerSnapshot;
  recoveryFrames?: number;
  recoveryPerformance?: {frames:number;acquisitionMs:number;copyMs:number;detectMs:number;cropMs:number;readings:number;readMs:number;detectorProfile?:DetectorProfile};
  /** Final bounded per-reader name request metrics; not inference-only timing. */
  nameOcrMetrics?:ReturnType<Awaited<ReturnType<typeof createRecognizer>>['nameOcrMetrics']>[];
  recoverySkipped?: boolean;
  /** Unresolved observations/evidence, not necessarily distinct identified cards. */
  unresolvedFieldChanges?:number;
  /** Lower bound from this scan's unidentified entries and unresolved ledger groups. */
  unresolvedObservations?:number;
  /** Observations resolved as repeats of an already-collected card. Kept as a
   * diagnostic count, not as unidentified cards or completion evidence. */
  duplicateUnidentifiedObservations?:number;
  /** Observations resolved at finalization by fixed-row rescue or duplicate
   * classification; subtracted from the ledger's lower bound. */
  resolvedUnidentifiedObservations?:number;
  /** Source evidence was lost or conflicted; a new scan is required. */
  unknownEvidenceLost?:boolean;
  /** Slots whose only captures were positively obstructed by a tooltip/cursor.
   * Presentation only: no card identity or field value is inferred. */
  recognitionNeeded?:RecognitionNeededSlot[];
  /** Row-centred scan only: what to show again, worked out from the list table
   * (session/list-guidance.ts). `asks` are requests; `notes` are what the table cannot decide.
   * Presentation only: it supplies no card, no value and no completion evidence. */
  listGuidance?:{readonly asks:readonly string[];readonly notes:readonly string[];readonly map?:import('../session/list-guidance').ListGuidanceMap};
  recoveryReuse?: { frames:number; observations:number; skippedOriginals:number };
  /** DEV-only restored buffer handoff counters, not an acquisition/OCR proof. */
  restoredHandoff?:{consumed:number;unavailable:number;failed:number;prefetchTransfers:number|null};
  sourceBindingMetadata?:ReturnType<SourceBindingMetadataDiagnostics['snapshot']>;
  autoStopped?: boolean;
  /** DEV-only exact ROI experiment; page-side timings do not include GPU/OS capture. */
  completionPixelGate?:{referenceSamples:number;referenceMs:number;referenceMaxMs:number;currentSamples:number;currentMs:number;currentMaxMs:number;retained:number;retentionMs:number;retentionMaxMs:number;retentionFailures:number;estimatedFrameBytes:number;matches:number;mismatches:number;unavailable:number;lastReason:string|null;roiBytes:number};
  /** DEV-only, bounded delivered-input metadata; not a completion gate. */
  completionInputDiagnostic?:ReturnType<CompletionInputDiagnostic['snapshot']>;
  /** DEV-only lost input is not a field issue or state-replay evidence. */
  drainInputLoss?:DrainInputLoss;
  completionDrainExperiment?:{started:number;expired:number;invalidated:number;finished:number;guardedFrames:number;blindFrames:number;
    bufferedFrames:number;verifiedBufferedFrames:number;bufferFailures:number;peakBufferedBytes:number;unresolvedInputLoss:boolean;
    firstLossReason:DrainInputLossReason|null;
    candidateChecks:number;heldChecks:number;metadataPendingChecks:number;reservedWithMetadata:number;primaryBlocked:number;previewBlocked:number;readersBlocked:number;unsupportedInput:number};
  /** DEV experiment only: state-event replay does not yet reproduce this fence. */
  obstructionExperiment?:{notices:number;lastCaptureTime:number|null;pending:number;replaySupported:false};
  /** DEV-only, sampled counterfactual; never a complete obstruction detector. */
  advisoryExperiment?:AdvisoryExperimentSummary;
  /** DEV-only, observational counters; never used by recognition or completion. */
  countSourceProbe?:CountSourceProbeStats;
  frameObstructionProbe?:{submitted:number;results:number;skipped:number;errors:number;candidates:number;truncated:number;readbackBytes:number;readbackMs:number;computeMs:number;hashRequested:number;hashSucceeded:number;hashFailed:number;pending:number;hashPending:number;unexpectedResults:number;trackingOverflow:boolean;last:FrameObstructionProbeEvent|null};
  /** Image-free explanation of the most recent automatic-stop check. */
  autoCompletionDiagnostic?:AutoCompletionDiagnostic;
  resultPresentation?: { observations: number; updates: number; milliseconds: number; previewOmitted?:number;
    /** Concurrent caller waits at automatic track stop; overlap and abandoned native work are not counted as separate cards. */
    previewAttachmentsAtAutoStop?:number;previewEncodingAwaitedAtAutoStop?:number;previewCreditWaitAtAutoStop?:number;
    /** Final presentation flush only; null means the clock was unavailable. */
    previewFlushMs?:number|null };
  liveOcrStarted?: { short: number; full: number };
  /** DEV comparison only; page JS heap excludes Worker, GPU and process memory. */
  visualOverflow?: {requested:boolean;readyWorkers:number;usedWorkers:number;readsStarted:number;pageHeapBefore:number|null;pageHeapAfter:number|null};
  /** DEV dispatch counts and overlapping wall time, not completed card reads or CPU time. */
  fastOcrAssist?: {requested:true;dispatches:number;settled:number;wallMs:number};
  retryWork?: { skippedFields:number; reusedIdentities:number; capacityUnidentified?:number; capacityFields?:number };
  /** DEV-only estimated retained Canvas RGBA bytes, not process memory. */
  /** Development cleanup snapshot of bounded read-admission metadata; not heap usage. */
  readAttemptStats?:ReturnType<CardReadAttempts['stats']>;
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
  /** DEV estimates of omitted logical RGBA bytes, not measured transfer or heap. */
  rejectedTransport?:{frames:number;omitted:number;kept:number;omittedRgbaBytes:number};
  unidentified: UnidentifiedObservation[];
  /** Hard-to-read observations moved out of `unidentified` at finalization.
   * They retain their images/reasons for the recognition-needed UI but never
   * supply a card identity or value. */
  discardedObservations?: UnidentifiedObservation[];
  /** Evidence-only fixed-row re-crops of unidentified observations. Never used
   * to publish a card identity or to complete a scan. */
  fixedRowRescue?: import('../acquisition/fixed-grid-rescue').FixedGridRescueState;
  captureDiagnostics?: {
    acquired: number; rejected: number; duplicates: number; improved: number;
    reasons: Record<string, number>;
    samples: { image: string; time: number; slot: number; reason: string; accepted: boolean; sharpness: number }[];
  };
  scrollPosition?: number | null;
  scrollGaps?: ScrollGap[];
  scrollCoverageUncertain?: boolean;
  scrollCoverageInfo?: ReturnType<ScrollCoverage['snapshot']>;
  scrollStartSeen?: boolean;
  scrollEndSeen?: boolean;
}

/** What the development and app callers may pass to a scan. */
export interface ScannerOptions {
  /** The name reading configuration (session/scanner-name-configuration.ts). */
  nameConfiguration?:unknown;
  /** Development only: the earlier raw-result policy, kept for its configuration check. */
  nameRawResultPolicy?:unknown;
  /** The scan's work, including the release of prepared readers, has ended. */
  onInternalSettled?:()=>void;
  /** Releasing the scan's resources may not have finished. */
  onInternalCleanupUncertain?:()=>void;
  /** A message about the scan's own resources (diagnostics only). */
  recordingError?:(message:string)=>void;
  /** Development only: a frame the card window was found in. */
  onFrameLocated?:(captureTime:number)=>void;
  /** Development only: server-side recording of a live share (docs/dev-recording.md). */
  shareRecording?:'on'|'off';onShareRecording?:(id:string)=>void;
  /** Development probe of display feedback timing; cancelled with the scan. */
  feedbackProbe?:{cancel():void};
}

/** Development only: told each time the card window was located in a frame.
 * Set while a share recording is open. */
let locatedFrameSink:(()=>void)|null=null;

/** Scans a shared screen: the row-centred scan (row-scanner.ts, docs/scanner-session-design.md)
 * under the scan guard (watchdog, cancellation) and the name operation that owns the prepared
 * readers. In development the share is also recorded to the local server (docs/dev-recording.md). */
export async function runScanner(video:HTMLVideoElement,signal:AbortSignal,update:(state:ScannerState)=>void,
  onReady?:()=>void,debug:ScannerOptions={},prepared?:PreparedScanner) {
  let cleanupUncertain=false;
  let publish!:(state:ScannerState)=>void,ready!:()=>void;
  const operation=createScannerNameOperation({prepared,configuration:debug.nameConfiguration,
    legacyDevPolicy:debug.nameRawResultPolicy,development:import.meta.env.DEV,input:{},
    onSettled:()=>debug.onInternalSettled?.(),
    isCleanupUncertain:()=>cleanupUncertain,onCleanupUncertain:()=>{cleanupUncertain=true;debug.onInternalCleanupUncertain?.();},
    diagnostic:()=>{try{debug.recordingError?.('인식 엔진 자원 종료에 실패했습니다.');}catch{/* Optional diagnostics. */}},
    // The row scan loads its own readers; the prepared ones are released by the operation as usual.
    run:guardSignal=>import('./row-scanner').then(({runRowScannerInternal})=>runRowScannerInternal({video,signal:guardSignal,update:publish,
      onReady:()=>{if(guardSignal.aborted)return;ready();onReady?.();},
      onLocated:()=>{try{debug.onFrameLocated?.(0);locatedFrameSink?.();}catch{/* Development recording is optional. */}}})),
  });
  // Development only: record the frames the scanner locates the card window in
  // to the local server, off the scan's path. Never alters or delays the scan;
  // failures only mark the recording.
  let shareRecorder:{stop():Promise<unknown>}|null=null;
  // The live scan's own result is saved next to the recording for comparison.
  let liveReporter:{update(state:ScannerState):void;finish(meta:{sha256:string|null;complete:boolean;frames:number}|null):Promise<void>}|null=null;
  // The recording's state is shown in the tab title, so a recording that is not
  // being saved is visible while scanning.
  let indicator:{stop(frames:number|null,note?:string):void;failed(reason:string):void}|null=null;
  if(import.meta.env.DEV&&debug.shareRecording!=='off'&&video.srcObject){
    let indicatorModule:typeof import('../reproduction/recording-indicator')|undefined;
    try{indicatorModule=await import('../reproduction/recording-indicator');}catch{/* The indicator is optional. */}
    try{
      const {startShareRecorder}=await import('../reproduction/share-recorder');
      const {createLiveRunReporter}=await import('../reproduction/live-run-report');
      const recorder=startShareRecorder(video.srcObject as MediaStream,{environment:{userAgent:navigator.userAgent,build:import.meta.env.VITE_BUILD_REVISION},
        onFailure:message=>console.warn('[share-recorder]',message)});
      if(recorder){
        shareRecorder=recorder;
        indicator=indicatorModule?.showRecordingIndicator(()=>recorder.stats())??null;
        liveReporter=createLiveRunReporter({recordingId:recorder.id,build:String(import.meta.env.VITE_BUILD_REVISION??'local')});
        // The scanner tells the recorder when it located the card window.
        locatedFrameSink=()=>recorder.located();
        // Development only: keep the whole share, also when the card window is never found, so a
        // failure can be studied. On with ?record=all; on by itself for an input size whose
        // fitted scale no recording has covered yet, and when no window is found in the first
        // 5 seconds. (A share where the window is found keeps only its card-window spans.)
        {
          const TESTED_SCALES=[1,.98,.75];
          const media=video as HTMLVideoElement,scale=inputScale(media.videoWidth,media.videoHeight);
          const always=(typeof location!=='undefined'&&new URLSearchParams(location.search).get('record')==='all')||
            (scale!==null&&!TESTED_SCALES.some(tested=>Math.abs(tested-scale)<.015));
          let everLocated=false,timer:ReturnType<typeof setInterval>|undefined;
          const keepAll=()=>{timer??=setInterval(()=>{try{recorder.located();}catch{/* Development recording is optional. */}},500);};
          locatedFrameSink=()=>{everLocated=true;recorder.located();};
          if(always)keepAll();
          const fallback=setTimeout(()=>{if(!everLocated)keepAll();},5000);
          if(always)console.info('[share-recorder] recording the whole share (input',media.videoWidth+'x'+media.videoHeight,'scale',scale,')');
          shareRecorder={stop:()=>{clearTimeout(fallback);if(timer)clearInterval(timer);return recorder.stop();},stats:()=>recorder.stats()} as typeof shareRecorder;
        }
        try{debug.onShareRecording?.(recorder.id);}catch{/* Optional callback. */}
      }else{
        const reason='공유 영상 트랙을 읽을 수 없음';
        console.warn('[share-recorder] not started:',reason);
        indicatorModule?.showRecordingIndicator(()=>({read:0,recorded:0,dropped:0,failure:null})).failed(reason);
      }
    }catch(error){
      console.warn('[share-recorder] could not start',error);
      try{indicatorModule?.showRecordingIndicator(()=>({read:0,recorded:0,dropped:0,failure:null})).failed(String(error instanceof Error?error.message:error));}catch{/* Optional. */}
    }
  }
  const observed:typeof update=state=>{try{liveReporter?.update(state);}catch{/* Development tooling only. */}update(state);};
  try {await guardScan({signal,update:observed,
    onRunSettled:operation.settled,
    sharing:()=>!!(video.srcObject as MediaStream|null)?.getVideoTracks().some(t=>t.readyState==='live'),
    cancelResources:()=>{
      try{debug.feedbackProbe?.cancel();}catch{/* Guard cancellation also fences late timing callbacks. */}
      operation.cancel();
      (video.srcObject as MediaStream|null)?.getTracks().forEach(t=>t.stop());
    },
    run:(guardSignal,guardPublish,guardReady)=>{publish=guardPublish;ready=guardReady;return operation.run(guardSignal);},
  });}finally{
    locatedFrameSink=null;
    if(shareRecorder){
      const reporter=liveReporter;
      // Seal first: the final report carries the sealed recording's hash.
      const shown=indicator,recorderStats=(shareRecorder as unknown as {stats?:()=>{failure:string|null}}).stats;
      void shareRecorder.stop().then(meta=>{
        const sealed=meta as {sha256:string|null;complete:boolean;frames:number}|null;
        shown?.stop(sealed?.frames??null,recorderStats?.()?.failure??undefined);
        return reporter?.finish(sealed);
      }).catch(()=>{});
    }
  }
}

