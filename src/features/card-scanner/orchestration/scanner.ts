import {InputLossEvidence,LIVE_INPUT_LOSS_MESSAGE,candidateQueueInputLoss,pipelineInputLoss,type InputLossFact} from '../session/input-loss-evidence';
import {ScanGrid,type ScanGridSnapshot} from '../session/scan-grid';
import {copyScannerInput,normalizeScannerInputFrame} from '../capture/scanner-input-frame';
import type {ScannerInputFrame,ScannerInputProvenance} from '../capture/scanner-input-frame';
import type {DecodedRgbaMetadata} from '../acquisition/decoded-rgba-client';
import {withMediaLineage,parseMediaInputLink} from '../capture/media-lineage';
import type {MediaDecodedFrame,MediaLineageFact} from '../capture/media-lineage';
import {ObservationWork} from '../session/observation-work';
import type {ObservationFact,ObservationSource} from '../session/observation-execution';
import type {ScannerFeedback,FeedbackReadContext} from '../ui/scanner-feedback';
import {scannerFeedbackState} from '../ui/scanner-feedback-state';
import type {NameAttempt} from '../recognition/name-diagnostics';
import {InventoryEvidence,inventoryEventData,inventorySeedSnapshot,hashInventoryEvidence,CURRENT_INVENTORY_CONSENSUS_POLICY} from '../session/inventory-evidence';
import type {InventorySource} from '../session/inventory-evidence';
import {recordScanGrid,scanGridReplaySnapshot,hashScanGridReplay} from '../session/scan-grid-command';
import {createCoalescedPublisher} from '../capture/coalesced-publisher';
import {ReadingFeedback,createFeedbackPublisher} from '../session/reading-feedback';
import {ActiveReadingCounter} from '../session/active-reading-counter';
import {createLiveObstructionHint,type LiveObstructionHint} from '../session/live-obstruction-hint';
import type {ScanMonitorState} from '../ui/scan-monitor-store';
import {createCandidatePreviewEncoder} from '../ui/candidate-preview';
import {createPreviewPresentation,finishCandidatePreview,previewFlushTimer} from '../ui/preview-presentation';
import {beginFinalCardVerification} from '../ui/preview-finalization-status';
import type {ExactRecorder} from '../reproduction/exact-recording';
import {createCanonicalCapture,type CanonicalRawLease} from '../reproduction/canonical-capture';
import {publishCanonicalSource,reportCanonicalSourceGap} from '../reproduction/canonical-source-publication';
import {createSourcePreparation} from '../acquisition/source-preparation';
import type {SourcePreparationMode} from '../acquisition/source-preparation-protocol';
import {createPreparedLiveSource} from '../acquisition/prepared-live-source';
import type {PreparedAcquisitionInput,SourceRasterReceipt} from '../acquisition/source-raster-receipt';
import {MAX_FRAME_BYTES} from '../reproduction/exact-recording-codec';
import type {RecordingJournal} from '../persistence/recording-journal';
import { initializeWithin } from '../capture/initialization';
import {settleDisposals} from '../capture/resource-cleanup';
import {guardScan} from '../ui/scan-watchdog';
import {cardReadDenialLosesEvidence,cardReadSourceKey,CardReadAdmissionDenied,CardReadAttempts,CardReadBudget,CardReadTimeout,OcrImageLimit,isIncompleteCardRead} from '../recognition/card-read-budget';
import {emitOcrResourceNotice} from '../recognition/ocr-resource-notice';
import {beginRecognitionInspection,reservedRecognitionBudget,type RecognitionInputObserver,type RecognitionInspection,type RecognitionInputMeta,type ReaderCropClaim} from '../recognition/recognition-input-observer';
import {scrollCardLocation,estimateScrollRows} from '../session/scroll-card-location';
import {InventoryPosition,StationaryInventoryView} from '../session/inventory-position';
import {ObservedInventoryLayout} from '../session/observed-inventory-layout';
import {RecentScanActivity,type ScanActivityItem} from '../ui/scan-activity';
import type {PreparedScanner} from '../session/scanner-preparation';
import {parseScannerNameConfiguration,type ScannerNameConfiguration} from '../session/scanner-name-configuration';
import {createScannerNameOperation} from '../session/scanner-name-operation';
import { createVisualClient } from '../recognition/visual-client';
import { createVisualBatchClient } from '../recognition/visual-batch';
import type { VisualBatchStats } from '../recognition/visual-batch';
import {CompletionWake} from '../session/completion-wake';
import {ReaderDispatches,ReaderWorkWake} from '../session/reader-work-wake';
import type { VisualResult } from '../recognition/visual-client';
import { decodedFrames } from "../capture/decoded-frames";
import { canConfirmScanGrid } from "../session/completion";
import {sessionFinalization} from '../session/session-finalization';
import {collectFastDuplicateItems, hasCollectedNameCandidate, rankSlowDuplicateCandidates} from '../session/session-duplicate';
import {orchestrateSessionFinalization} from '../session/session-orchestrator';
import { retryEligible } from "../session/retry-quality";
import { imageInputs, startLiveFrames, yieldForCapture, type StillImageSources } from "../capture/input-source";
import { acquireCards, createCardAcquirer } from "../acquisition/card-acquisition";
import { createAcquisitionClient } from '../acquisition/acquisition-client';
import type {FrameObstructionProbeEvent} from '../acquisition/acquisition-client';
import {addAcquisitionProfile} from '../acquisition/acquisition-profile';
import {addDetectorProfile,type DetectorProfile} from '../acquisition/detector-profile';
import type {AcquisitionProfileSummary} from '../acquisition/acquisition-profile';
import {createLiveCapturePipeline} from '../capture/live-capture-pipeline';
import {createLiveInputAdmission} from '../capture/live-input-admission';
import {createCoverageFrameSelector,devCoverageSelectorRequested} from '../capture/coverage-frame-selector';
import {inputArrival,parseInputBackupReservation} from '../capture/input-arrival';
import {parseAcquisitionCapture,parseRecognitionCapture} from '../capture/capture-provenance';
import type {InputStamp} from '../capture/live-input-admission';
import {InputDecisionReplay} from '../reproduction/live-input-decision-replay';
import {freezeLiveFrameTimed,type FrozenLiveFrame} from '../capture/freeze-live-frame';
import {createLiveRawSource} from '../capture/live-raw-source';
import {createLiveOriginalCapture} from '../capture/live-original-capture';
import {canReserveCompletionDrain,waitForReaderMetadata,deferCompletionForMetadata} from '../session/metadata-scheduling';
import {MetadataOrder,type CapturedMetadata} from '../session/metadata-order';
import {resetPositionsForSort} from '../session/sort-position-reset';
import type { AcquisitionTiming, RejectedTransportAcquisition, RejectedTransportCell } from '../acquisition/acquisition-client';
import { tryStartTrackFrames } from '../capture/track-frame-source';
import { ScanLedger } from "../session/scan-ledger";
import {observedCard,readFieldReliability,settleReadFields} from '../session/field-acceptance';
import {UnknownLifecycle,hashUnknownLifecycle} from '../session/unknown-lifecycle';
import {HiddenUnknownGuard,hiddenUnknownEnabled,type HiddenDiagnosticEvent,type HiddenDiagnosticSummary} from '../session/unknown-hidden-guard';
import {UNKNOWN_LIFECYCLE_LIMITS} from '../session/unknown-lifecycle-types';
import {UnknownDiagnosticSidecars} from '../session/unknown-diagnostic-sidecars';
import {UnknownScanSession} from '../session/unknown-scan-session';
import {sourceScopedUnknownEnabled,type UnknownSourcePolicy} from '../session/unknown-source-policy';
import {admitRetryCandidate,replacePendingCandidate} from '../session/retry-candidate';
import type { LedgerSnapshot } from "../session/scan-ledger";
import { CandidateQueue, candidateOffer, sourceCandidateKey, sourceQueueSettled } from "../acquisition/candidate-queue";
import { FreshObservations } from '../session/fresh-observation';
import {FreshnessEvidence,hashFreshnessEvidence} from '../session/freshness-evidence';
import {FRESHNESS_EVIDENCE_LIMITS,type FreshnessFact} from '../session/freshness-evidence-types';
import {FreshnessObservationBridge} from '../session/freshness-observation-bridge';
import { FinishTimer, type FinishTiming } from '../session/finish-timing';
import { estimateRowShift } from "../session/grid-motion";
import { CaptureObservations, settledFields } from "../acquisition/capture-quality";
import { BoundedFrameRing } from '../capture/bounded-frame-ring';
import { appendFixedGridRescue, confirmFixedGridRescue, fixedGridCell, rescueFixedRowSlot } from '../acquisition/fixed-grid-rescue';
import type { FixedGridRescueRecord } from '../acquisition/fixed-grid-rescue';
import { packCount, stablePreviewEmptyCandidate } from '../recognition/count-pattern';
import { areaGray } from '../acquisition/area-gray';
import { cutRescueArea, rescueAreaBounds } from '../acquisition/rescue-area';
import type { RescueArea } from '../acquisition/rescue-area';
import type { CardSort } from "../recognition/capture-metadata";
import { createDetector } from "../acquisition/detector";
import type {Box} from '../acquisition/detector';
import {
  createRecognizer,
  crop,
} from "../recognition/recognizer";
import type { ScannedCard } from "../recognition/recognizer-types";
import { confirmSortedNames } from "../recognition/name-confirmation";
import { readScrollGeometry } from "../session/scroll-position";
import {parseScrollCaptureFact} from '../session/scroll-capture-diagnostic';
import type {CaptureFrameIdentity} from '../session/scroll-capture-diagnostic';
import type {PortraitDiagnostics} from '../recognition/portrait-diagnostics';
import {createCapturedHeaderReads} from '../capture/captured-header-read';
import type {CapturedHeaderRegion} from '../capture/captured-header-read';
import {snapshotHeader,headerSnapshotMatches,compareInventoryHeaderTotal,nextHeaderConflict} from '../session/completion-header-snapshot';
import type {CompletionHeaderSnapshot,InventoryHeaderTotal} from '../session/completion-header-snapshot';
import {LatestAcquisitionGate} from '../acquisition/latest-acquisition-gate';
import {CompletionInputDiagnostic} from '../session/completion-input-diagnostic';
import {CompletionViewSnapshot,currentCompletionViewMatches} from '../session/completion-current-view';
import {completionViewRoi} from '../session/completion-view-roi';
import {CompletionFrameRetention} from '../session/completion-frame-retention';
import {UnidentifiedObstructionFence,unidentifiedObstruction} from '../session/completion-obstruction-debt';
import {AdvisoryObstructionExperiment,type AdvisoryExperimentSummary} from '../session/advisory-obstruction-experiment';
import {hashObstructionEvidence} from '../reproduction/obstruction-evidence-replay';
import {obstructionEventAdmitted} from '../session/obstruction-recording-receipt';
import type {ExactEventQueueStats} from '../reproduction/exact-recording';
import {LiveScrollPreview} from '../ui/live-scroll-preview';
import {FrozenViewportHints} from '../ui/frozen-viewport-hint';
import {correlateSourceFrame} from '../capture/source-frame-correlation';
import { ScrollCoverage } from '../session/scroll-coverage';
import type {ScrollCoverageDiagnostic} from '../session/scroll-coverage-diagnostic';
import type { ScrollGap } from '../session/scroll-coverage';
import type { CountObservationSource } from "../recognition/count-confidence";
import {CountSourceProbe,type CountSourceProbeStats} from '../recognition/count-source-probe';
import type {CountProvenanceEvent} from '../recognition/count-source-provenance';
import { replayDebugFrames } from "../reproduction/debug-capture";
import { mergeFrames } from "../session/merge-frames";
import { createCaptureEncoder as createDebugEncoder } from "../capture/capture-encoder";
import { createCaptureOriginals } from "../capture/capture-originals";
import { recordContinuous, recordedFrames } from "../capture/continuous-capture";
import {startOptionalRecording,shouldRecordContinuous} from '../reproduction/optional-recording';
import {preparedRecoveryPrefetch} from '../acquisition/prepared-recovery-prefetch';
import type { ContinuousRecording } from "../capture/continuous-capture";
import type { DebugCapture, DebugFrame } from "../reproduction/debug-capture";
import { LiveReaderSchedule, LiveRetrySchedule, shiftOcrRetry, retryWorkPriority, timedCaptureOrder, liveLanePlan } from "../session/live-scan-policy";
import { LiveWorkPriority } from '../session/live-work-priority';
import {LiveInventory} from '../session/live-inventory';
import type {LiveInventorySnapshot} from '../session/live-inventory';
import { runJoinedWorkers } from '../capture/joined-workers';
import { runRecoveryPipeline } from '../session/recovery-pipeline';
import { coveredFieldRetry, fieldRetryIdentity, pruneFieldRetries, retryNeedsIdentity } from '../session/field-retry';
import { PREVIEW_ZERO_REASON, needsPreviewZeroProof, previewFieldRegion, previewZeroReading, selectZeroPreview } from '../session/preview-zero';
import { canSkipRecovery, canFinishVerifiedCapture, confirmedReadingCount, freshCaptureTail } from '../session/recovery-completion';
import {issuePositiveCompletionReceipt,type PositiveCompletionReceipt} from '../session/positive-completion';
import { pendingScanFields, projectCurrentScanFields } from '../session/current-scan-fields';
import {clearRecognitionNeeded,recordRecognitionNeeded,recognitionNeededSlots,type RecognitionNeededSlot} from '../session/recognition-needed';
import {canClassifyFinalDuplicates,finalDuplicateIdentity} from '../session/final-duplicate';
import {FINAL_DUPLICATE_VARIANTS,finalDuplicateCanvas} from '../recognition/name-preprocessing';
import { FieldDiagnosticImages, previewOrCapture } from '../acquisition/field-diagnostic-images';
import type { PendingCardFields } from '../session/current-scan-fields';
import { saveAcquisition, beginNewCaptureSlot, newSavedObservation, resolvedSavedObservation, coveredSavedAcquisition, needsLatestSavedProof,
  selectObservationSourceFrameId,sourceObservationFrame,exactSourceSavedObservation,canReuseVerifiedRecovery,SourceBindingMetadataDiagnostics } from '../acquisition/saved-acquisition';
import type { SavedAcquisition, SavedObservation } from '../acquisition/saved-acquisition';
import {AutoCompletionHold,canFinishEndedCapture,canSkipCoveredOriginals,canStopSharing,captureInputSettled,confirmedCaptureCount,currentHeaderAvailable,hasCompleteCaptureEvidence,stopCompletedShare} from '../session/auto-completion';
import {AutoCompletionDiagnostics,InputWaitSampler,completionEvidenceGate} from '../session/auto-completion-diagnostics';
import {CompletionDrainReservation} from '../session/completion-drain-reservation';
import {CompletionDrainInputBuffer} from '../session/completion-drain-input-buffer';
import {CompletionDrainRecovery} from '../session/completion-drain-recovery';
import {drainClockObservationFailure} from '../session/completion-drain-clock';
import {DRAIN_INPUT_LOSS_MESSAGE,drainLossFinal,unresolvedWithDrainLoss} from '../session/completion-drain-loss';
import type {DrainInputLoss,DrainInputLossReason} from '../session/completion-drain-loss';
import type {AutoCompletionDiagnostic,AutoCompletionGate} from '../session/auto-completion-diagnostics';
const cardCollator = new Intl.Collator("ko");

/** Own unadmitted crops across cooperative yields and apply positional changes
 * only after the active frame has finished staging. This scope never owns a
 * canvas after it has been transferred to the reader queue. */
export class FrameAdmissionScope<T extends {width:number}> {
  private active=false;
  private readonly owned=new Set<T>();
  private readonly commits:Array<()=>void>=[];
  begin(resources:Iterable<T>){
    if(this.active)throw Error('A frame is already being admitted');
    this.active=true;
    for(const resource of resources)this.owned.add(resource);
  }
  track(resource:T){if(this.active)this.owned.add(resource);}
  transfer(...resources:T[]){if(this.active)for(const resource of resources)this.owned.delete(resource);}
  commit(action:()=>void){if(this.active)this.commits.push(action);else action();}
  finish(){
    if(!this.active)return;
    this.active=false;
    let failure:unknown;
    for(const resource of this.owned)try{resource.width=0;}catch(error){failure??=error;}
    this.owned.clear();
    for(const action of this.commits.splice(0))try{action();}catch(error){failure??=error;}
    if(failure!==undefined)throw failure;
  }
}

export interface CountCalibrationRow {
  id:string;name:string;awakening:number|null;extraCopies:number|null;countReliable:boolean|null;observations:number|null;
  reliability:string|null;reason:string|null;
  samples:{stable:boolean;hasIcon:boolean|null;candidate:boolean;iconColor:boolean;numericEvidence:boolean;iconRemnant:boolean;
    emptyFields:boolean;iconFlat:boolean;digitsFlat:boolean;highFrequencyCover:boolean;flatCover:boolean;grayMarker:boolean;visibleBackground:boolean}[];
}
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
/** Development only: told each time the card window was located in a frame.
 * Set while a share recording is open. */
let locatedFrameSink:(()=>void)|null=null;
export async function runScanner(...args:Parameters<typeof runScannerInternal>) {
  const [video,source,signal,update,seed,onReady,rowMode,stillImages,captureOnly,debug,prepared,feedback]=args;
  let active=true,cleanupUncertain=false;
  let publish!:(state:ScannerState)=>void,ready!:()=>void;
  const operation=createScannerNameOperation({prepared,configuration:debug?.nameConfiguration,
    legacyDevPolicy:debug?.nameRawResultPolicy,development:import.meta.env.DEV,input:debug??{},
    onSettled:()=>debug?.onInternalSettled?.(),
    isCleanupUncertain:()=>cleanupUncertain,onCleanupUncertain:()=>debug?.onInternalCleanupUncertain?.(),
    diagnostic:()=>{try{debug?.recordingError?.('인식 엔진 자원 종료에 실패했습니다.');}catch{/* Optional diagnostics. */}},
    run:(guardSignal,nameConfiguration,transferred)=>runScannerInternal(video,source,guardSignal,publish,seed,()=>{
      if(guardSignal.aborted)return;ready();onReady?.();
    },rowMode,stillImages,captureOnly,{...debug,nameConfiguration,onCleanupFailure:()=>{cleanupUncertain=true;}},transferred,
      feedback?state=>{if(active&&!guardSignal.aborted)feedback(state);}:undefined),
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
  if(import.meta.env.DEV&&source==='screen'&&debug?.shareRecording!=='off'&&video.srcObject){
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
        try{debug?.onShareRecording?.(recorder.id);}catch{/* Optional callback. */}
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
    sharing:()=>source==='screen'&&!!(video.srcObject as MediaStream|null)?.getVideoTracks().some(t=>t.readyState==='live'),
    cancelResources:()=>{
      try{debug?.feedbackProbe?.cancel();}catch{/* Guard cancellation also fences late timing callbacks. */}
      operation.cancel();
      if(source==='screen')(video.srcObject as MediaStream|null)?.getTracks().forEach(t=>t.stop());
    },
    run:(guardSignal,guardPublish,guardReady)=>{publish=guardPublish;ready=guardReady;return operation.run(guardSignal);},
  });}finally{
    active=false;locatedFrameSink=null;
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
  debug: { /** Development only: server-side recording of a live share (docs/dev-recording.md). */ shareRecording?:'on'|'off';onShareRecording?:(id:string)=>void;unknownEvidenceImages?:boolean; recognitionNeededSlots?:readonly {slot:number;captureTime:number;reason:string}[]; rejectedTransport?:boolean; rejectedReplay?:'baseline'|'reduced'; freshnessVersion?:1|2; unknownSourcePolicy?:UnknownSourcePolicy; hiddenUnknownProbe?:boolean; onHiddenUnknownSummary?:(report:{supported:boolean;summary:HiddenDiagnosticSummary|null;summaryTraceAdmitted:boolean|null;error?:string})=>void; nameConfiguration?:ScannerNameConfiguration; feedbackProbe?:ScannerFeedback; comparisonInput?:boolean; preparedSource?:boolean; preparedSourceMode?:SourcePreparationMode; restoredHandoff?:boolean; preparedCropProof?:boolean; localCropPixels?:boolean; visualOverflow?:boolean; fastOcrAssist?:boolean; latestPixelGate?:boolean; completionDrain?:boolean; obstructionFence?:boolean; advisoryFence?:boolean; moveReuseProfile?:boolean; frameObstructionProbe?:boolean; frameObstructionHash?:boolean; countSourceProbe?:boolean; countSourceRecord?:(event:CountProvenanceEvent)=>boolean; frameObstructionEvent?:(event:FrameObstructionProbeEvent)=>void; nameRawResultPolicy?:'continue'|'resample'; grayNameFallback?:boolean; recognitionObserver?:RecognitionInputObserver; nativeAcquisition?: boolean; rgbaRecovery?:boolean; fractionalPortrait?:boolean; minInputIntervalMs?:number; inputOfferFloorMs?:number; exact?: ExactRecorder; journal?:RecordingJournal; trace?: (type:string,value:unknown,time:number)=>void; traceAck?:()=>boolean; parallelRecovery?: boolean; trackFrames?: boolean; replay?: DebugCapture; replayInputs?: AsyncIterable<ScannerInputFrame>; record?: (frame: DebugFrame) => void;
    continuous?: (recording: ContinuousRecording) => void;
    continuousRecording?: 'disabled'|'fail-start';
    recordingMode?: 'diagnostic'|'detailed';
    snapshots?: () => AsyncIterable<{ element: HTMLImageElement; image: string; time: number; percent: number }>;
    preview?: (image: string) => void; recording?: () => boolean; recordingError?: (message: string) => void;
    onAutoCompletion?: (diagnostic:AutoCompletionDiagnostic) => void;
    /** Development observation: called with a frame's capture time (seconds)
     * each time one of its crops enters the recognition queue. */
    onFrameAdmitted?: (captureTime:number) => void;
    /** Development measurement, run after the final card values are known: for every
     * card, the empty-counter evidence of each stored observation image. Never
     * changes a card or the scan. */
    onCountCalibration?: (rows:CountCalibrationRow[]) => void;
    /** Development observation: a frame whose card grid was located. */
    onFrameLocated?: (captureTime:number) => void;
    /** Development measurement per recovery frame: whether the recovery-skip proof holds now. */
    onRecoveryProbe?: (probe:{frame:number;time:number;idle:boolean;completeProof:boolean;read:number;unresolved:number;
      expected:number|null;finalExpected:number|null;tailFresh:boolean}) => void;
    /** Development measurement per card read: where the time of one read went, in order.
     * setup (thumbnail hand-off, grid/activity marks, admission), visual (visual worker round trip),
     * identity (name reading when the artwork did not decide, acceptance), fields (field reading,
     * reliability, merge), publish (lists, counts, state publication), preview (waiting for the
     * thumbnail), retry (queueing a follow-up read), cleanup. */
    onReadProfile?: (profile:{stage:'visual'|'short'|'full';identified:boolean;spans:Readonly<Record<string,number>>}) => void;
    /** Development experiment (docs/scanner-live-redesign.md 12.4, step 2), live screen input only.
     * The visual reading of a frame's admitted crops is sent as one message per worker when the
     * frame is admitted, and a successful read no longer waits in its lane for the thumbnail.
     * Which crops are read, the reading itself, acceptance, merge and completion are unchanged;
     * a crop without a batch result is read on the ordinary path. */
    frameBatchVisual?: boolean;
    /** Development measurement for `frameBatchVisual`: the batch counters after each frame. */
    onVisualBatch?: (stats:VisualBatchStats) => void;
    /** Development check of how the fixed-row rescue feature of an admitted crop is read. The
     * scanner reads the area of all cells once per frame and cuts each cell out of that copy.
     * 'tile' uses the earlier per-cell tile-canvas read instead (for comparison runs);
     * 'verify' reads both ways and counts features that differ. */
    rescueFeature?: 'tile'|'verify';
    /** Development measurement with `rescueFeature: 'verify'`: calls, time and the comparison. */
    onRescueFeature?: (stats:{calls:number;ms:number;compared:number;different:number}) => void;
    /** Development measurement of the live input flow, updated as frames arrive: video frame
     * callbacks and the presented frames they skipped, admission skips by reason, frames
     * frozen and offered, and how long the offered frames spent being collected (consume)
     * against how long the pipeline had nothing in hand (idle between consumes). */
    onFrameFlow?: (flow:Readonly<{callbacks:number;missedPresented:number;firstCallbackMs:number|null;lastCallbackMs:number|null;
      maxCallbackGapMs:number;callbackGapsOver100Ms:number;skips:Readonly<Record<string,number>>;offered:number;consumed:number;
      consumeMs:number;maxConsumeMs:number;idleMs:number}>) => void;
    /** Development measurement per replayed frame: screen handling (collect), card reading (drain), cards read. */
    onFrameLoop?: (loop:{time:number;collectMs:number;drainMs:number;drained:number}) => void;
    /** Development measurement per input frame: canvas copy, the acquisition round trip
     * (transfer + worker detection and crops) and the worker's own stage timings. */
    onFrameProfile?: (profile:{time:number;located:boolean;copyMs:number;acquireMs:number;detectMs:number;timing?:Record<string,number>}) => void;
    /** Advisory live display only; never recognition or completion evidence. */
    onLiveObstructionHint?: (hint:LiveObstructionHint) => void;
    onInternalSettled?:()=>void;onInternalCleanupUncertain?:()=>void;onCleanupFailure?:()=>void } = {},
  prepared?: PreparedScanner,
  feedback?: (state:ScanMonitorState)=>void,
) {
  const nameConfiguration=parseScannerNameConfiguration(debug.nameConfiguration);
  const nameRawResultPolicy=nameConfiguration.rawResultPolicy;
  // Input semantics must survive an unavailable/failed recording backend.
  // Saved pixel replay is not a live stream even when its original source was screen.
  const liveScreen = source === 'screen' && !debug.replay && !!video.srcObject;
  if(debug.fastOcrAssist&&(!import.meta.env.DEV||!liveScreen||captureOnly||!!stillImages||!!prepared||rowMode!=='all'||seed.length>0||
    !!debug.replayInputs||!!debug.visualOverflow||!!debug.rejectedTransport||!!debug.rejectedReplay))
    throw Error('OCR 양도 비교는 개발 단일 화면 입력·전체 판독·빈 목록에서만 지원합니다.');
  if(debug.rejectedTransport&&(!import.meta.env.DEV||!liveScreen||captureOnly||!!stillImages||rowMode!=='all'||!!prepared||seed.length>0||
    debug.recordingMode==='detailed'||debug.continuousRecording==='fail-start'||!!debug.exact||!!debug.journal||!!debug.record||!!debug.snapshots||
    !!debug.recognitionObserver||!!debug.preparedSource||!!debug.preparedCropProof||!!debug.nativeAcquisition||!!debug.localCropPixels||!!debug.rgbaRecovery||
    !!debug.replay||!!debug.replayInputs||!!debug.frameObstructionProbe||!!debug.countSourceProbe||!!debug.comparisonInput||
    !!debug.latestPixelGate||!!debug.completionDrain||!!debug.obstructionFence||!!debug.advisoryFence||!!debug.moveReuseProfile||
    !!debug.visualOverflow||!!debug.fastOcrAssist||!!debug.hiddenUnknownProbe||!!debug.unknownSourcePolicy||debug.freshnessVersion===2||
    debug.minInputIntervalMs!==undefined||debug.inputOfferFloorMs!==undefined))throw Error('거절 이미지 전송 실험은 개발 단일 영상 1배속과 일반 진단에서만 지원합니다.');
  // DEV-only A/B: both variants use the same acquisition Worker on a stored
  // screen capture. The archive seed is never silently replaced.
  if(debug.rejectedReplay!==undefined&&(!import.meta.env.DEV||!['baseline','reduced'].includes(debug.rejectedReplay)||
    source!=='screen'||!debug.replay||debug.replay.source!=='screen'||!debug.replayInputs||liveScreen||
    captureOnly||!!stillImages||rowMode!=='all'||!!prepared||seed.length>0||!!debug.rejectedTransport||
    debug.recordingMode==='detailed'||!!debug.continuousRecording||!!debug.exact||!!debug.journal||!!debug.record||!!debug.snapshots||
    !!debug.recognitionObserver||!!debug.preparedSource||!!debug.preparedCropProof||!!debug.nativeAcquisition||!!debug.localCropPixels||!!debug.rgbaRecovery||
    !!debug.frameObstructionProbe||!!debug.countSourceProbe||!!debug.comparisonInput||!!debug.latestPixelGate||!!debug.completionDrain||
    !!debug.obstructionFence||!!debug.advisoryFence||!!debug.moveReuseProfile||!!debug.visualOverflow||!!debug.fastOcrAssist||!!debug.hiddenUnknownProbe||
    !!debug.unknownSourcePolicy||debug.freshnessVersion===2||debug.minInputIntervalMs!==undefined||debug.inputOfferFloorMs!==undefined))
    throw Error('저장 입력 전송 비교는 빈 초기 목록과 단일 화면 기록 판독에서만 지원합니다.');
  if(debug.rejectedReplay&&(typeof OffscreenCanvas==='undefined'||typeof createImageBitmap==='undefined'||typeof Worker==='undefined'))
    throw Error('저장 입력 전송 비교에는 획득 Worker가 필요합니다.');
  const reducedTransport=debug.rejectedTransport===true||debug.rejectedReplay==='reduced';
  // Saved screen inputs retain the same chronological evidence rules as the
  // original share, even though they do not own a live MediaStream.
  const screenEvidenceInput = liveScreen || debug.replay?.source === 'screen';
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
    recognitionNeeded: [],
    ...(import.meta.env.DEV&&debug.restoredHandoff?{restoredHandoff:{consumed:0,unavailable:0,failed:0,prefetchTransfers:null}}:{}),
    unresolvedObservations: 0,
    captureDiagnostics: { acquired: 0, rejected: 0, duplicates: 0, improved: 0, reasons: {}, samples: [] },
  };
  const ledger = new ScanLedger();
  const recognitionNeeded=new Map<number,RecognitionNeededSlot>();
  for(const target of debug.recognitionNeededSlots??[])
    recordRecognitionNeeded(recognitionNeeded,target.slot,target.captureTime,target.reason,true);
  // The source-scoped policy is an explicitly selected development experiment.
  const sourceScopedUnknown=sourceScopedUnknownEnabled(import.meta.env.DEV,debug.unknownSourcePolicy);
  let unknownSourceSession:UnknownScanSession|undefined;
  const unresolvedObservations=()=>{
    const raw=Math.max(state.unidentified.length,ledger.unresolvedGroups,unknownSourceSession?.unresolved()??0);
    const resolved=Math.max(0,state.resolvedUnidentifiedObservations??0);
    const discarded=state.discardedObservations?.length??0;
    const remaining=Math.max(0,raw-resolved-discarded);
    // A discard is a separate recognition-needed bucket, not a missing card.
    // Evidence loss remains visible through unknownEvidenceLost and the status.
    if(discarded>0)return remaining;
    return Math.max(remaining,Number(state.unknownEvidenceLost===true));
  };
  const syncUnresolvedObservations=()=>state.unresolvedObservations=unresolvedObservations();
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
  const frameBatch=import.meta.env.DEV&&debug.frameBatchVisual===true;
  // The batch experiment lets more thumbnails encode behind the readers instead of holding a lane.
  const previewPresentation=createPreviewPresentation(signal,frameBatch?256:16);
  const inventoryPosition=new InventoryPosition();
  const stationaryInventory=new StationaryInventoryView();
  const observedLayout=new ObservedInventoryLayout();
  let auditComplete = false;
  let closeCoverageTrace:(()=>void)|undefined;
  let refreshCards: (() => void) | undefined;
  let refreshGrid: (() => void) | undefined;
  let refreshFeedback: (() => number) | undefined;
  let feedbackState:ScanMonitorState|undefined;
  const publishFeedback=(gridSnapshot:ScanGridSnapshot,completed=state.currentRunRead)=>{
    feedbackState=scannerFeedbackState(state,gridSnapshot,completed,syncUnresolvedObservations());
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
    syncUnresolvedObservations();
    state.ledger = ledger.snapshot(auditComplete);
    state.activity=activity.snapshot();
    state.grid=grid.snapshot();
    if(feedback)publishFeedback(state.grid);
    update({ ...state, cards: [...state.cards], captureDiagnostics: state.captureDiagnostics ? { ...state.captureDiagnostics, reasons: { ...state.captureDiagnostics.reasons }, samples: [...state.captureDiagnostics.samples] } : undefined });
  });
  let hasLiveAcquisitionLoss=false;
  let readAttemptStatsReader:(()=>ReturnType<CardReadAttempts['stats']>)|undefined;
  const snapshotReadAttempts=()=>{
    if(import.meta.env.DEV&&readAttemptStatsReader)try{state.readAttemptStats=readAttemptStatsReader();}
    catch{/* Optional counters do not determine scan evidence. */}
  };
  const emit = (force = false) => {
    state.recognitionNeeded=recognitionNeededSlots(recognitionNeeded);
    if(!state.drainInputLoss&&hasLiveAcquisitionLoss)state.captureWarning=LIVE_INPUT_LOSS_MESSAGE;
    if(state.drainInputLoss){state.captureWarning=DRAIN_INPUT_LOSS_MESSAGE;
      if(state.percent===100&&(state.workPhase==='verifying'||state.workPhase==='cleanup')){
        state.status=DRAIN_INPUT_LOSS_MESSAGE;state.unresolvedFieldChanges=Math.max(1,state.unresolvedFieldChanges??0);
      }}
    publisher.request(force);if(feedback)feedbackPublisher.request(force);
  };
  emit();
  state.status = '화면 검출 모듈 준비 중'; emit(true);
  const detector = prepared?.detector ?? await initializeWithin(createDetector(), signal, value => value.dispose());
  let recognizer: Awaited<ReturnType<typeof createRecognizer>> | undefined = prepared?.readers[0],
    stopInput: (() => void) | undefined;
  let encoder: ReturnType<typeof createDebugEncoder> | ReturnType<typeof createCanonicalCapture> | undefined;
  let sourceBindingMetadata:SourceBindingMetadataDiagnostics|undefined;
  let canonicalSource:ReturnType<typeof createCanonicalCapture>|undefined,canonicalStore:ExactRecorder|undefined,ownCanonicalStore=false;
  let sourcePreparation:Awaited<ReturnType<typeof createSourcePreparation>>|undefined,preparedSources:ReturnType<typeof createPreparedLiveSource>|undefined;
  let originals: ReturnType<typeof createCaptureOriginals> | undefined;
  let recordingFailure = "";
  let continuous: ReturnType<typeof recordContinuous> | undefined;
  const finishTimer = new FinishTimer();
  let recordingStart = performance.now();
  const trace=(type:string,value:unknown)=>{const time=(performance.now()-recordingStart)/1000;debug.exact?.event(type,value,time);debug.trace?.(type,value,time);};
  // Record the projection policy before the first observation. Historical
  // recordings without this explicit command retain the legacy projection.
  grid.enableSourceWorkProjection();
  // Diagnostic state uses the same reducer as imported traces. A recording
  // failure invalidates its checkpoint without stopping frame acquisition.
  let inputReplay:InputDecisionReplay|undefined,inputRecordingFailed=false;
  const inputRecordingError=(error:unknown)=>{
    if(inputRecordingFailed)return;
    inputRecordingFailed=true;
    try{debug.exact?.incomplete('입력 선택 기록 실패');}catch{/* An optional recorder cannot stop capture. */}
    try{trace('input-recording-error',{error:String(error)});}catch{/* The failed sink may also reject this loss marker. */}
  };
  const recordInput=(type:'input-admission'|'input-decision'|'input-link'|'input-recovery',value:unknown)=>{
    if(!inputReplay||inputRecordingFailed)return;
    try {
      if(type==='input-admission')inputReplay.admission(value);
      else if(type==='input-decision')inputReplay.pipeline(value);
      else if(type==='input-recovery')inputReplay.recovery(value);
      else inputReplay.link(value);
      trace(type,value);
    }catch(error){inputRecordingError(error);}
  };
  const recordInputDiagnostic=(type:'input-arrival'|'input-backup-reservation'|'backup-capacity-deferral'|'input-acquisition-skip'|'input-loss-contract'|'input-loss',value:()=>unknown)=>{
    if(!(debug.exact||debug.trace)||inputRecordingFailed)return;
    try{trace(type,value());}catch(error){inputRecordingError(error);}
  };
  const inputLoss=new InputLossEvidence();
  inputLoss.seed({version:1});
  const noteInputLoss=(fact:InputLossFact)=>{
    if(!inputLoss.accept(fact)){
      if(inputLoss.summary().overflow)inputRecordingError(Error('입력 손실 추적 한도 초과'));
      return;
    }
    state.droppedFrames++;
    const firstLoss=!hasLiveAcquisitionLoss;
    hasLiveAcquisitionLoss=true;
    state.captureWarning=LIVE_INPUT_LOSS_MESSAGE;
    recordInputDiagnostic('input-loss',()=>fact);
    if(firstLoss)emit(true);
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
  let finalCaptureHeaderProof:{mode:'auto'|'ended';expected:number;tailFresh:boolean;available:boolean;time:number}|undefined;
  let lastLocatedTime = -Infinity;
  let checkingCompletion=false;
  let completionCaptureOpen=false;
  let finalHeaderFrame=0;
  let liveCollection: Promise<void> | undefined;
  let disposeLiveCapture:(()=>void)|undefined;
  let disposeCompletionFrames:(()=>void)|undefined;
  let disposeCompletionDrain:(()=>void)|undefined;
  let inventory:InventoryEvidence|undefined;
  let unknownLifecycle:UnknownLifecycle|undefined;
  let hiddenUnknownGuard:HiddenUnknownGuard|undefined,hiddenUnknownError=false;
  const hiddenRequested=hiddenUnknownEnabled(import.meta.env.DEV,debug.hiddenUnknownProbe);
  const observeHidden=(fn:(guard:HiddenUnknownGuard)=>void)=>{
    if(!hiddenUnknownGuard||hiddenUnknownError)return;
    try{fn(hiddenUnknownGuard);}catch{hiddenUnknownError=true;}
  };
  let freshness:FreshnessEvidence|undefined;
  let obstructionFence:UnidentifiedObstructionFence|undefined;
  let advisoryExperiment:AdvisoryObstructionExperiment|undefined;
  let obstructionNotices=0;
  let obstructionLastCaptureTime:number|null=null;
  let countSourceProbe:CountSourceProbe|undefined;
  let obstructionTraceComplete=true,obstructionTraceErrorReported=false;
  const visuals: ReturnType<typeof createVisualClient>[] = [...(prepared?.visuals ?? [])];
  let visualBatch: ReturnType<typeof createVisualBatchClient>;
  let usedOverflowWorkers:WeakSet<object>|undefined;
  const lanePlan=liveLanePlan(navigator.hardwareConcurrency);
  const extraRecognizers: Awaited<ReturnType<typeof createRecognizer>>[] = prepared?.readers.slice(1) ?? [];
  const abortPrepared = () => { disposeCompletionDrain?.();disposeCompletionFrames?.(); prepared?.cancel(); encoder?.cancel(); void continuous?.finish(); };
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
  const recognizerInitializationCleanupError=(error:unknown)=>{
    // A failed factory never transfers its reader to disposeReaders(). Keep
    // its cleanup uncertainty visible to the outer engine ownership gate.
    try{debug.onCleanupFailure?.();}catch{/* Diagnostics cannot replace the original failure. */}
    cleanupDiagnostic(error);
  };
  const finalTrace=(type:string,value:unknown)=>{
    try{trace(type,value);return true;}catch(error){cleanupDiagnostic(error);return false;}
  };
  const acknowledgeObstructionTrace=(recordAttempted=true,exactBefore?:ExactEventQueueStats)=>{
    try{if(!obstructionEventAdmitted({attempted:recordAttempted,exactRequested:!!debug.exact,traceRequested:!!debug.trace,
      before:exactBefore,after:debug.exact?.eventQueueStats,traceAck:debug.trace?debug.traceAck?.():undefined}))obstructionTraceComplete=false;}
    catch{obstructionTraceComplete=false;}
    if(!obstructionTraceComplete&&!obstructionTraceErrorReported){
      obstructionTraceErrorReported=true;
      finalTrace('obstruction-recording-error',{reason:'가림 근거 기록 수신을 확인하지 못했습니다.'});
    }
  };
  const incompleteFinalRecord=(reason:string)=>{try{debug.exact?.incomplete(reason);}catch{/* Preserve the original scan/cleanup failure. */}};
  const disposeReaders=async()=>{
    // Call only after active acquisition/read work has joined. One failed
    // disposer must not skip the remaining independent readers or termination.
    const errors=await settleDisposals([()=>signal.removeEventListener('abort',abortPrepared),
      ...(prepared?[()=>prepared.dispose()]:[()=>detector.dispose(),()=>recognizer?.dispose(),
        ...extraRecognizers.map(reader=>()=>reader.dispose())])]);
    if(errors.length){try{debug.onCleanupFailure?.();}catch{/* Keep cleanup independent of diagnostics. */}}
    for(const error of errors)cleanupDiagnostic(error);
    if(errors.length&&!primaryFailure)throw new AggregateError(errors,'인식 엔진 종료 실패');
  };
  try {
    signal.throwIfAborted();
    if (!prepared && source === 'screen' && (!debug.replay || !!debug.rejectedReplay)) acquisition = createAcquisitionClient(signal,
      {...(import.meta.env.DEV&&debug.preparedSource?{pixelTransport:true}:{}),
       ...(import.meta.env.DEV&&debug.preparedCropProof?{experimentalCropProof:true}:{}),
       ...(import.meta.env.DEV&&debug.localCropPixels?{localCropPixels:true}:{}),
       ...(import.meta.env.DEV&&debug.moveReuseProfile?{moveReuseProfile:true}:{}),
       ...(import.meta.env.DEV&&reducedTransport?{experimentalRejectedTransport:true}:{})});
    if(import.meta.env.DEV&&debug.frameObstructionProbe&&source==='screen'&&!debug.replay){
      const stats:NonNullable<ScannerState['frameObstructionProbe']>=state.frameObstructionProbe={submitted:0,results:0,skipped:0,errors:0,candidates:0,truncated:0,readbackBytes:0,readbackMs:0,computeMs:0,hashRequested:0,hashSucceeded:0,hashFailed:0,pending:0,hashPending:0,unexpectedResults:0,trackingOverflow:false,last:null};
      const outstanding=new Map<number,boolean>();
      const enabled=acquisition?.configureObstructionProbe(event=>{
        stats.last=event;
        if(event.kind==='submitted'){stats.submitted++;stats.readbackBytes+=event.readbackBytes;stats.readbackMs+=event.readbackMs;
          if(outstanding.has(event.id))stats.errors++;else if(outstanding.size>=256)stats.trackingOverflow=true;else outstanding.set(event.id,event.hashRequested);if(event.hashRequested)stats.hashRequested++;}
        else if(event.kind==='skipped')stats.skipped++;
        else if(event.kind==='error')stats.errors++;
        else {stats.results++;stats.computeMs+=event.computeMs;if(event.error)stats.errors++;
          const requested=outstanding.get(event.id);if(requested===undefined)stats.unexpectedResults++;else {outstanding.delete(event.id);
            if(requested){if(event.roiHash?.status==='ok')stats.hashSucceeded++;else stats.hashFailed++;}}
          stats.candidates+=event.result?.candidates.length??0;stats.truncated+=Number(event.result?.truncated===true);}
        stats.pending=outstanding.size;stats.hashPending=[...outstanding.values()].filter(Boolean).length;
        try{debug.frameObstructionEvent?.(event);}catch{/* The optional sink must never block collection. */}
        if(event.kind==='result'||event.kind==='error')emit();
      },{hashRoi:debug.frameObstructionHash===true});
      if(!enabled){stats.errors++;stats.last={kind:'error',reason:'acquisition-worker-unavailable'};}
    }
    if (!prepared && !captureOnly) recognizer = await createRecognizer((message) => {
      state.status = message;
      emit();
    }, signal,{nameRawResultPolicy,onInitializationCleanupError:recognizerInitializationCleanupError,
      ...(nameConfiguration.contrastNameFallback?{contrastNameFallback:true}:{})});
    // Each consumer owns its OCR session: multi-line CTC and adaptive caches
    // cannot safely interleave requests from different cards in one reader.
    if (!prepared && recognizer && source === 'screen' && !debug.replay)
      for(let i=1;i<lanePlan.readers;i++) {
        signal.throwIfAborted();
        state.status = `병렬 인식 준비 ${i + 1} / ${lanePlan.readers}`; emit(true);
        extraRecognizers.push(await createRecognizer(() => {}, signal,{nameRawResultPolicy,onInitializationCleanupError:recognizerInitializationCleanupError,
          ...(nameConfiguration.contrastNameFallback?{contrastNameFallback:true}:{})}));
      }
    if (!prepared && recognizer && acquisition) for(let i=0;i<lanePlan.fast;i++) visuals.push(createVisualClient(signal));
    if (!prepared) await Promise.all([acquisition?.ready(),...visuals.map(worker=>worker?.ready())]);
    if(frameBatch&&liveScreen&&recognizer&&acquisition){
      visualBatch=createVisualBatchClient(signal);
      await visualBatch?.ready();
    }
    if(import.meta.env.DEV&&liveScreen&&recognizer&&acquisition) {
      const pageHeap=()=>{const value=(performance as Performance&{memory?:{usedJSHeapSize?:number}}).memory?.usedJSHeapSize;
        return typeof value==='number'&&Number.isFinite(value)&&value>=0?value:null;};
      const before=pageHeap();
      const extra=visuals.length;
      if(debug.visualOverflow)for(let i=extra;i<lanePlan.readers;i++)visuals.push(createVisualClient(signal));
      await Promise.all(visuals.slice(extra).map(worker=>worker?.ready()));
      state.visualOverflow={requested:debug.visualOverflow===true,readyWorkers:visuals.slice(extra).filter(Boolean).length,
        usedWorkers:0,readsStarted:0,pageHeapBefore:before,pageHeapAfter:pageHeap()};
      if(debug.visualOverflow)usedOverflowWorkers=new WeakSet();
    }
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
          const {createExactRecording}=await import('../reproduction/exact-recording');
          const temporary=await createExactRecording();
          if(temporary.supportsSourceReads){canonicalStore=temporary;ownCanonicalStore=true;}
          else await temporary.dispose();
        }catch{/* Unsupported temporary stores retain the existing raw backup. */}
      }
    }
    if(debug.exact&&!canonicalStore){
      try{if(!acquisition)throw Error('입력 기록 Worker 없음');acquisition.startRecording(debug.exact.takePort(),reason=>debug.exact?.incomplete(reason));}
      catch(error){debug.exact.incomplete(String(error));}
    }
    if(debug.restoredHandoff&&(!import.meta.env.DEV||!debug.preparedSource))throw Error('복원 픽셀 이전 실험에는 개발 공통 입력이 필요합니다.');
    if(debug.preparedCropProof&&(!import.meta.env.DEV||!debug.preparedSource))throw Error('크롭 픽셀 비교 실험에는 개발 공통 입력이 필요합니다.');
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
      rejectedTransportRequested:reducedTransport,
      rejectedReplayRequested:debug.rejectedReplay??null,
      unknownSourcePolicy:sourceScopedUnknown?'source-v2':'group-v1',
      nativeAcquisition:debug.nativeAcquisition===true,rgbaRecovery:debug.rgbaRecovery===true,
      preparedSource:debug.preparedSource===true,
      restoredHandoff:import.meta.env.DEV&&debug.restoredHandoff===true,
      preparedCropProof:import.meta.env.DEV&&debug.preparedCropProof===true,
      localCropPixels:import.meta.env.DEV&&debug.localCropPixels===true,
      visualOverflow:import.meta.env.DEV&&debug.visualOverflow===true,
      fastOcrAssistRequested:import.meta.env.DEV&&debug.fastOcrAssist===true,
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
    const captureSession = crypto.randomUUID();
    const countConflictPolicy={version:3 as const,sessionId:captureSession};
    inventory = new InventoryEvidence(seed,{seedPolicy:'prior-run-v3',consensusPolicy:CURRENT_INVENTORY_CONSENSUS_POLICY,countConflictPolicy,trackPresentation:true,...(observationRecorder?{
      onEvent:(event)=>trace('inventory-event',inventoryEventData(event)),
      onPreviewConfirmation:fact=>trace('inventory-preview-confirmation',fact),
    }:{})});
    if(observationRecorder)trace('inventory-seed',{version:6,seedPolicy:'prior-run-v3',consensusPolicy:CURRENT_INVENTORY_CONSENSUS_POLICY,countConflictPolicy,cards:inventorySeedSnapshot(seed)});
    const cards=inventory.cards,evidence=inventory.evidence;
    const captures = new CaptureObservations();
    let previousVectors: Uint8Array[] = [];
    const metadataTrace=trace;
    if(import.meta.env.DEV&&sourceScopedUnknown&&debug.preparedSource&&debug.restoredHandoff&&debug.preparedCropProof)
      sourceBindingMetadata=new SourceBindingMetadataDiagnostics(captureSession);
    const liveObstructionHint=liveScreen&&debug.onLiveObstructionHint?
      createLiveObstructionHint(captureSession,()=>performance.now(),debug.onLiveObstructionHint):undefined;
    if(import.meta.env.DEV&&debug.countSourceProbe){
      countSourceProbe=new CountSourceProbe(captureSession,`${captureSession}:canonical`,debug.countSourceRecord);
      state.countSourceProbe=countSourceProbe.stats;
    }
    const freshnessSeed={version:import.meta.env.DEV&&debug.freshnessVersion===2?2 as const:1 as const,sessionId:captureSession,limits:FRESHNESS_EVIDENCE_LIMITS};
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
    if(sourceScopedUnknown){
      unknownSourceSession=new UnknownScanSession({sessionId:captureSession,
        onEvidenceLoss:()=>{state.unknownEvidenceLost=true;},
        ...(observationRecorder?{recording:{
          // A non-throwing callback is not a receipt. Both configured sinks must
          // admit the event; durable archive validation remains a separate step.
          record:(type,value)=>{
            const before=debug.exact?.eventQueueStats;
            const sent=finalTrace(type,value);
            try{return obstructionEventAdmitted({attempted:sent,exactRequested:!!debug.exact,traceRequested:!!debug.trace,
              before,after:debug.exact?.eventQueueStats,traceAck:debug.trace?debug.traceAck?.():undefined});}
            catch{return false;}
          },
          incomplete:loss=>{
            incompleteFinalRecord(`미식별 상태 기록 누락: ${loss}`);
            finalTrace('unknown-recording-error',{loss});
          },
        }}:{})});
    }else{
      const unknownSeed={version:1 as const,sessionId:captureSession,origin:'scan' as const,limits:UNKNOWN_LIFECYCLE_LIMITS};
      unknownLifecycle=new UnknownLifecycle(unknownSeed,observationRecorder?{
        onEvent:fact=>trace('unknown-event',fact),
        onIncomplete:loss=>{
          try{debug.exact?.incomplete(`미식별 상태 기록 누락: ${loss}`);}catch{/* Optional recorder. */}
          try{trace('unknown-recording-error',{loss});}catch{/* Optional recorder. */}
        },
      }:{});
      if(observationRecorder)try{trace('unknown-seed',unknownSeed);}
      catch{unknownLifecycle.markIncomplete('event-sink-failed');}
      if(hiddenRequested)try{
        const record=debug.exact||debug.trace?(event:HiddenDiagnosticEvent)=>{
          const before=debug.exact?.eventQueueStats;
          try{trace('hidden-unknown-event',event);return obstructionEventAdmitted({attempted:true,
            exactRequested:!!debug.exact,traceRequested:!!debug.trace,before,after:debug.exact?.eventQueueStats,
            traceAck:debug.trace?debug.traceAck?.():undefined});}catch{return false;}
        }:undefined;
        hiddenUnknownGuard=new HiddenUnknownGuard(captureSession,{record});
      }catch{hiddenUnknownError=true;}
    }
    const metadataOrder=new MetadataOrder();
    let metadata:CapturedMetadata|undefined,
      lastMetadataTime = -Infinity;
    let lastMetadataFrame: HTMLVideoElement | HTMLImageElement | HTMLCanvasElement | OffscreenCanvas | undefined;
    type Candidate = {
      source:InventorySource;
      countSource?:CountObservationSource;
      recognitionInput?:Pick<RecognitionInputMeta,'processingFrame'|'sourceBox'|'sourceWidth'|'sourceHeight'>;
      /** Optional comparison claim; never recognition or completion authority. */
      readerCropClaim?:ReaderCropClaim;
      /** Reuse recorded provenance when present; probe-only runs retain one
       * scalar on the existing bounded Candidate, never a second source map. */
      feedbackFrame?:number;
      /** Recovery has execution facts without replacing current spatial cells. */
      execution?:ObservationWork;
      savedObservation?:SavedObservation;
      /** Present only after the prepared recovery path verified its source
       * ID, full RGBA hash and exact content/preview geometry. */
      verifiedRecoveryObservation?:SavedObservation;
      changedFields?:boolean;
      pixelKey:string;
      /** `frameBatchVisual` only: this crop's visual reading, requested when its frame was
       * admitted. Never rejects; null means "read it on the ordinary path". */
      visualPrefetch?:Promise<VisualResult|null>;
      verifiedVisual?:object;
      needsIdentity?: boolean;
      fieldTarget?: {id:string;order:number};
      knownIdentity?: NonNullable<Awaited<ReturnType<NonNullable<typeof recognizer>['identify']>>>;
      group: number; priorityGroup: number; trace: number; image: HTMLCanvasElement; feature: Uint8Array; time: number; stable: boolean;
      /** Fixed-row gray input captured at admission, used only for diagnostic
       * rescue after an identity failure. It is never an identity itself. */
      fixedRowGray?: Float32Array;
      /** Canonical video-7 fixed-row gray, used only as a second rescue attempt. */
      canonicalRowGray?: Float32Array;
      borderAlignment: number; order: number; position: NonNullable<ScannedCard["capturePosition"]>;
      preview: string; previewCanvas?: HTMLCanvasElement; previewTask?:Promise<string>; sortReading?: Promise<Awaited<ReturnType<NonNullable<typeof recognizer>["metadata"]>>>;
    };
    const freshObservations = new FreshObservations<SavedObservation>(2048,
      observation=>resolvedSavedObservation(observation,confirmedFieldOrder),freshnessBridge);
    const releaseCandidate = (item: Candidate) => {
      item.execution?.cancel();freshObservations.finish(item.savedObservation); item.image.width = 0; item.image.height = 0; item.fixedRowGray = undefined; item.canonicalRowGray = undefined; if (item.previewCanvas) item.previewCanvas.width = 0;
    };
    // Source-v2 can retain more independent observations than fuzzy grouping.
    // Bound each raster-owning queue separately; overflow remains visible as
    // unresolved input. These limits are not a measured heap or latency bound.
    const mainQueueLimit=sourceScopedUnknown?160:1600;
    const retryQueueLimit=sourceScopedUnknown?80:512;
    const deferred: (Candidate & { feature: Uint8Array })[] = [];
    const fullRetries: (Candidate & { feature: Uint8Array })[] = [];
    const readerWake=new ReaderWorkWake();
    const queue = new CandidateQueue<Candidate>(mainQueueLimit, item => {
      ledger.finish(item.trace, "superseded", { reason: "같은 관측 묶음의 더 좋은 이미지로 교체", group: item.group });
      releaseCandidate(item);
    },replacePendingCandidate,sourceScopedUnknown?sourceCandidateKey:undefined);
    const readAttempts=new CardReadAttempts();
    if(import.meta.env.DEV)readAttemptStatsReader=()=>readAttempts.stats();
    let diagnosticReadOrdinal=0;
    releasePending = () => {
      let item: Candidate | undefined;
      while ((item = queue.shift())) { ledger.finish(item.trace, "dropped", { group: item.group, reason: "처리 중지" }); releaseCandidate(item); }
      for (const pending of [...deferred,...fullRetries]) { ledger.finish(pending.trace, "dropped", { group: pending.group, reason: "보조 판독 중지" }); releaseCandidate(pending); }
      deferred.length = 0;fullRetries.length=0;
    };
    const unknownDiagnostics=new UnknownDiagnosticSidecars(debug.unknownEvidenceImages?{
      // Dev evidence runs may retain every unresolved observation. Production
      // keeps the bounded defaults so a long scan cannot grow without limit.
      entries:256,previewBytes:8*1024*1024,recognitionEntries:256,recognitionBytes:64*1024*1024,metadataBytes:4*1024*1024,
    }:undefined);
    const refreshUnknown=()=>{
      state.unidentified=unknownSourceSession?unknownSourceSession.active():unknownDiagnostics.project(unknownLifecycle!.active());
      state.unknownEvidenceLost=state.unknownEvidenceLost===true||
        unknownSourceSession?.hasEvidenceLoss()===true||unknownLifecycle?.hasLiveEvidenceLoss()===true;
    };
    const unknownSource=(source:ObservationSource):ObservationSource=>({sessionId:source.sessionId,frameId:source.frameId,
      observationId:source.observationId,captureOrder:source.captureOrder,captureTime:source.captureTime,phase:source.phase,slot:source.slot});
    let captureOrder = Math.max(
      0,
      ...seed.map((card) => card.captureOrder ?? 0),
    );
    const initialCaptureOrder = captureOrder;
    const inputAdmission = createLiveInputAdmission();
    const completionInputDiagnostic=import.meta.env.DEV&&liveScreen?new CompletionInputDiagnostic():undefined;
    const livePriority = new LiveWorkPriority();
    // The optional trace describes this UI hint only; it never changes card
    // evidence, auto-stop, or claims that every original input was delivered.
    let coverageOrdinal=0;
    const coverageTrace=(fact:Omit<Extract<ScrollCoverageDiagnostic,{kind:'seed'|'reset'|'checkpoint'}>,'version'|'sessionId'|'ordinal'>|
      Omit<Extract<ScrollCoverageDiagnostic,{kind:'offer'}>,'version'|'sessionId'|'ordinal'>)=>{
      if(!(import.meta.env.DEV&&debug.trace))return;
      try{trace('scroll-coverage',{version:1,sessionId:captureSession,ordinal:++coverageOrdinal,...fact});}catch{/* Diagnostics do not affect scanning. */}
    };
    const scrollCoverage = new ScrollCoverage(import.meta.env.DEV&&debug.trace?()=>coverageTrace({kind:'reset'}):undefined);
    coverageTrace({kind:'seed'});
    if(import.meta.env.DEV&&debug.trace)closeCoverageTrace=()=>coverageTrace({kind:'checkpoint'});
    const liveIdentities = new Set<string>();
    const liveInventory = new LiveInventory();
    const confirmedFieldOrder = inventory.confirmedFieldOrder;
    const confirmedNameOrder = inventory.confirmedNameOrder;
    const latestIdentityOrder = inventory.latestIdentityOrder;
    obstructionFence=screenEvidenceInput&&!captureOnly?new UnidentifiedObstructionFence():undefined;
    if(import.meta.env.DEV&&debug.advisoryFence&&screenEvidenceInput&&!captureOnly)advisoryExperiment=new AdvisoryObstructionExperiment(captureSession,initialCaptureOrder);
    if(obstructionFence&&import.meta.env.DEV&&debug.obstructionFence)state.obstructionExperiment={notices:0,lastCaptureTime:null,pending:0,replaySupported:false};
    if(obstructionFence&&(debug.exact||debug.trace)){
      const before=debug.exact?.eventQueueStats;
      const sent=finalTrace('obstruction-seed',{version:2,sessionId:captureSession,seedOrder:initialCaptureOrder});
      acknowledgeObstructionTrace(sent,before);
    }
    const obstructionPending=()=>{
      const ids=[...latestIdentityOrder.keys()];
      const count=obstructionFence?.pending(state.expected,ids,confirmedNameOrder,confirmedFieldOrder)??0;
      const advisory=advisoryExperiment?.pending(state.expected,ids,confirmedNameOrder,confirmedFieldOrder)??0;
      if(advisoryExperiment)state.advisoryExperiment=advisoryExperiment.snapshot();
      if(state.obstructionExperiment)state.obstructionExperiment.pending=count;
      return Math.max(count,advisory);
    };
    const latestFieldObservations = inventory.latestFieldObservations;
    const fieldImages = new FieldDiagnosticImages();
    const pendingFieldDiagnostics = () => pendingScanFields(latestFieldObservations.values(),fieldEvidence)
      .map(field=>{
        const source=inventory!.latestFieldObservationSource(field.id);
        return {...field,...(inventory!.hasCountConflict(field.id)?{reason:'각성·장수 판독 확인'}:{}),
          recognitionImage:source?fieldImages.get(field.id,field.captureOrder,source):undefined};
      });
    const fieldEvidence = {latest:latestIdentityOrder,confirmed:confirmedFieldOrder,agreed:inventory.agreedFieldOrder};
    const latestAcquisition=new LatestAcquisitionGate();
    // DEV drain cannot silently discard callback inputs on invalidation.
    // Until those exact observations can be replayed, loss requires rescan.
    // Opt-in evidence experiment. Only the already-frozen input is eligible
    // as reference; no field/name identity or obstruction debt is inferred.
    const pixelStats:ScannerState['completionPixelGate']=import.meta.env.DEV&&debug.latestPixelGate&&liveScreen?(state.completionPixelGate={
      referenceSamples:0,referenceMs:0,referenceMaxMs:0,currentSamples:0,currentMs:0,currentMaxMs:0,
      retained:0,retentionMs:0,retentionMaxMs:0,retentionFailures:0,estimatedFrameBytes:0,
      matches:0,mismatches:0,unavailable:0,lastReason:null,roiBytes:0}):undefined;
    const pixelCanvas=pixelStats?document.createElement('canvas'):undefined;
    const pixelFrames=pixelStats?new CompletionFrameRetention<FrozenLiveFrame['source']>(32*1024*1024,(source,metadata)=>{
      if(typeof VideoFrame==='undefined'||!(source instanceof VideoFrame)||
        source.displayWidth!==metadata.sourceWidth||source.displayHeight!==metadata.sourceHeight)
        throw Error('동일한 불변 VideoFrame을 보관할 수 없음');
      const copy=source.clone();
      if(copy.displayWidth!==metadata.sourceWidth||copy.displayHeight!==metadata.sourceHeight){copy.close();throw Error('불변 프레임 크기 불일치');}
      return {frame:copy,release:()=>copy.close()};
    }):undefined;
    disposeCompletionFrames=()=>{try{pixelFrames?.dispose();}catch(error){if(pixelStats){pixelStats.unavailable++;pixelStats.lastReason=String(error).slice(0,250);}}
      if(pixelCanvas){pixelCanvas.width=0;pixelCanvas.height=0;}};
    const samplePixelView=(source:CanvasImageSource,box:import('../acquisition/detector').Box,geometry:string,inputId:number,captureTime:number)=>{
      if(!pixelCanvas)throw Error('최신 화면 비교 미지원');
      if(pixelCanvas.width!==box.width)pixelCanvas.width=box.width;
      if(pixelCanvas.height!==box.height)pixelCanvas.height=box.height;
      const context=pixelCanvas.getContext('2d',{willReadFrequently:true});if(!context)throw Error('최신 화면 비교 컨텍스트 없음');
      context.globalCompositeOperation='copy';
      context.drawImage(source,box.x,box.y,box.width,box.height,0,0,box.width,box.height);
      return {sessionId:captureSession,inputId,captureTime,geometry,width:box.width,height:box.height,
        pixels:context.getImageData(0,0,box.width,box.height).data};
    };
    const discardObsoleteRetry = (item:Candidate) => {
      ledger.finish(item.trace,'superseded',{group:item.group,reason:'더 최신 화면에서 이름·각성·장수 확정'});
      releaseCandidate(item);
      state.retryWork??={skippedFields:0,reusedIdentities:0};
      state.retryWork.skippedFields++;
    };
    const coveredRetry=(item:Candidate)=>coveredFieldRetry(item,confirmedFieldOrder,confirmedNameOrder);
    const retrySchedules=new WeakMap<object,LiveRetrySchedule>();
    const identifiedThisRun = new Set<string>();
    let lastDiagnosticSample = -Infinity;
    let lastNameValidation = -Infinity;
    let cardsDirty = false;
    let lastLayoutKey='';
    let livePositions:{id:string;slot:number}[]=[];
    const readingFeedback=new ReadingFeedback();
    refreshFeedback=()=>{
      state.unresolvedFieldChanges=unresolvedWithDrainLoss(freshObservations.unresolvedChanges(),obstructionPending(),state.drainInputLoss);
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
        confirmedReadingCount({cards:[card],latest:latestIdentityOrder,confirmed:confirmedFieldOrder,agreed:inventory!.agreedFieldOrder})?'read' as const:
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
      state.unresolvedFieldChanges=unresolvedWithDrainLoss(freshObservations.unresolvedChanges(),obstructionPending(),state.drainInputLoss);
      state.currentRunRead = confirmedReadingCount({cards:state.cards,...fieldEvidence});
      if(state.expected&&state.currentRunRead===state.expected&&state.cards.length===state.expected&&state.sort?.kind==='name'&&state.sort.direction!=='unknown') {
        const ids=state.cards.map(card=>card.id);
        for(const location of inventoryPosition.order(state.sort.direction==='desc'?[...ids].reverse():ids))
          grid.register(location.frame,location.top);
      }
      cardsDirty = false;
      state.resultPresentation ??= { observations: 0, updates: 0, milliseconds: 0 };
      state.resultPresentation.updates++;
      state.resultPresentation.milliseconds += performance.now() - started;
    };
    // Unidentified observations may be re-cropped only from the still-retained
    // acquisition frame. Two full frames are the hard bound: no per-card frame
    // copy, no unbounded history. A third frame evicts the oldest binding.
    const rescueFrames = new BoundedFrameRing<HTMLCanvasElement, { captureTime: number; cells: Box[] }>(
      2,
      () => document.createElement('canvas'),
      (canvas, width, height) => {
        if (canvas.width !== width) canvas.width = width;
        if (canvas.height !== height) canvas.height = height;
      });
    const rescueTile = document.createElement('canvas');
    rescueTile.width = 140;
    rescueTile.height = 210;
    const rescueTileContext = rescueTile.getContext('2d', { willReadFrequently: true })!;
    const rescueFeatureStats={calls:0,ms:0,compared:0,different:0};
    /** Previous canonical-row gray for the same observation group/slot. The
     * second observation can arrive before the first rescue record is appended;
     * retaining the actual gray lets two distinct frames agree without a new
     * observation or a guessed identity. */
    const rescueCanonicalCache = new Map<string,{frameId:number;captureTime:number;gray:Float32Array}>();
    // Recovery/file frames often repeat. Reuse only exact geometry + RGBA
    // analysis, retaining every observation for stability and field consensus.
    const acquireFrame=createCardAcquirer((width,height)=>{
      const canvas=document.createElement('canvas');canvas.width=width;canvas.height=height;return canvas;
    },true);
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
    const positionTargets={grid,inventory:inventoryPosition,stationary:stationaryInventory,
      layout:observedLayout,coverage:scrollCoverage,
      clearTransient:()=>{livePositions=[];lastLayoutKey='';lastLocation='';previousVectors=[];previous=[];state.scrollGaps=[];state.scrollCoverageUncertain=false;}};
    // A yielded acquisition still owns its frame and slot staging. A metadata
    // result may arrive during a yield; apply its sort and its positional reset
    // together after the complete frame is recorded. This prevents a reader
    // from combining a new sort with the old position anchors in between.
    const admissionScope=new FrameAdmissionScope<HTMLCanvasElement>();
    const commitPositionChange=(commit:()=>void)=>admissionScope.commit(commit);
    // This warning belongs only to a valid but differing OCR pair. Failed
    // reads do not erase an existing conflict or overwrite other warnings.
    const checkHeaderTotal=(total:InventoryHeaderTotal|null|undefined)=>{
      const comparison=compareInventoryHeaderTotal({owned:state.expected,capacity:state.capacity},total);
      const nextConflict=nextHeaderConflict(state.headerConflict,comparison);
      if(nextConflict&&!state.headerConflict){
          commitPositionChange(()=>resetPositionsForSort(state.sort??null,{growthPoints:null,sort:null},positionTargets,true));
          state.scrollPosition=null;state.scrollStartSeen=false;state.scrollEndSeen=false;
      }
      state.headerConflict=nextConflict;
      return comparison;
    };
    const reportUnknown = (
      image: HTMLCanvasElement,
      time: number,
      pending: boolean,
      preview: string | undefined,
      group: number,
      order: number,
      location:import('../session/scroll-card-location').ScrollCardLocation|undefined,
      reason:string,
      diagnostic:{source:ObservationSource;pixelKey:string;nameAttempts?:readonly NameAttempt[];portraitDiagnostics?:PortraitDiagnostics|null;skipImages?:boolean},
    ) => {
      const fact={version:1 as const,kind:'upsert' as const,key:{kind:'group' as const,sessionId:captureSession,group},
        source:unknownSource(diagnostic.source),captureOrder:order,captureTime:time,pending,reason,location:location??null};
      const sidecar={pixelKey:diagnostic.pixelKey,
        preview:()=>diagnostic.skipImages?'':previewOrCapture(preview,()=>image.toDataURL('image/webp',.9)),
        recognition:()=>diagnostic.skipImages?'':image.toDataURL('image/png'),
        nameAttempts:diagnostic.nameAttempts,portraitDiagnostics:diagnostic.portraitDiagnostics};
      const priorLoss=state.unknownEvidenceLost===true;
      const priorHidden=hiddenUnknownGuard&&!hiddenUnknownError&&!sourceScopedUnknown
        ?unknownLifecycle!.active().find(entry=>entry.key.kind==='group'&&entry.key.group===group):undefined;
      const effect=unknownSourceSession?unknownSourceSession.report(fact,sidecar):unknownLifecycle!.apply(fact);
      if(hiddenUnknownGuard&&!hiddenUnknownError)observeHidden(guard=>guard.groupEffect(fact,priorHidden,effect));
      if(effect.upserted&&!unknownSourceSession)unknownDiagnostics.remember(effect.upserted,sidecar);
      if(effect.upserted||unknownSourceSession?.hasEvidenceLoss()||unknownLifecycle?.hasLiveEvidenceLoss()) {
        refreshUnknown();
        if(!priorLoss&&state.unknownEvidenceLost)try{debug.exact?.incomplete('미식별 입력 근거 손실');}catch{/* Recording is not live authority. */}
        emit(true);
      }
    };
    /** Builds and records the bounded rescue evidence. It never mutates
     * inventory, unknown lifecycle, name, count or completion state. */
    const rescueRecord = (item: Candidate): FixedGridRescueRecord | null => {
      try {
        const active = recognizer;
        if (!active) return null;
        const frames = rescueFrames.entries().map(entry => ({
          frameId: entry.frameId,
          captureTime: entry.meta.captureTime,
          grayFor: (slot: number) => {
            const cell = entry.meta.cells[slot];
            if (!cell) return null;
            const x = Math.round(cell.x), y = Math.round(cell.y);
            const w = Math.round(cell.width), h = Math.round(cell.height);
            if (x < 0 || y < 0 || w < 24 || h < 32 ||
                x + w > entry.frame.width || y + h > entry.frame.height) return null;
            if (rescueTile.width !== w) rescueTile.width = w;
            if (rescueTile.height !== h) rescueTile.height = h;
            rescueTileContext.clearRect(0, 0, w, h);
            rescueTileContext.drawImage(entry.frame, x, y, w, h, 0, 0, w, h);
            return areaGray(rescueTileContext.getImageData(0, 0, w, h).data, w, h);
          },
        }));
        const result = rescueFixedRowSlot({ slot: item.position.slot, captureTime: item.time,
          source: 'retained-frame', frames, match: gray => active.matchArtworkGray(gray) });
        const feature = item.fixedRowGray ? rescueFixedRowSlot({ slot: item.position.slot, captureTime: item.time,
          source: 'observation-feature',
          frames: [{ frameId: item.source.frameId, captureTime: item.time, grayFor: () => item.fixedRowGray! }],
          match: gray => active.matchArtworkGray(gray) }) : undefined;
        const canonicalKey=`${item.group}:${item.position.slot}`;
        const previousCanonical=rescueCanonicalCache.get(canonicalKey);
        if(item.canonicalRowGray){
          rescueCanonicalCache.delete(canonicalKey);
          rescueCanonicalCache.set(canonicalKey,{frameId:item.source.frameId,captureTime:item.time,gray:item.canonicalRowGray.slice()});
          if(rescueCanonicalCache.size>16){const oldest=rescueCanonicalCache.keys().next().value;if(oldest!==undefined)rescueCanonicalCache.delete(oldest);}
        }
        const canonicalFrames:{frameId:number;captureTime:number;grayFor:(slot:number)=>ArrayLike<number>|null}[]=[];
        if(item.canonicalRowGray)canonicalFrames.push({frameId:item.source.frameId,captureTime:item.time,grayFor:()=>item.canonicalRowGray!});
        if(previousCanonical&&previousCanonical.frameId!==item.source.frameId&&
          Math.abs(previousCanonical.captureTime-item.time)<=.5)
          canonicalFrames.push({frameId:previousCanonical.frameId,captureTime:previousCanonical.captureTime,grayFor:()=>previousCanonical.gray});
        const canonical = canonicalFrames.length ? rescueFixedRowSlot({ slot: item.position.slot, captureTime: item.time,
          source: 'canonical-row',frames:canonicalFrames,
          match: gray => active.matchArtworkGray(gray) }) : undefined;
        const evidence = [...result.evidence, ...(feature?.evidence ?? []), ...(canonical?.evidence ?? [])]
          .sort((a, b) => b.correlation - a.correlation || a.frameId - b.frameId);
        const record: FixedGridRescueRecord = { version: 1, group: item.group, order: item.order,
          slot: item.position.slot, captureTime: item.time, pending: false,
          frameCount: result.frameCount + (feature?.frameCount ?? 0) + (canonical?.frameCount ?? 0),
          unavailable: result.unavailable && !feature && !canonical, evidence };
        state.fixedRowRescue = appendFixedGridRescue(state.fixedRowRescue, record);
        trace('fixed-row-rescue', record);
        emit(true);
        return record;
      } catch { /* Rescue diagnostics never own an observation or a card. */ return null; }
    };
    const rescueUnknown = (item: Candidate) => { rescueRecord(item); };
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
    const displayReadings=new ActiveReadingCounter();
    const drainRecovery=new CompletionDrainRecovery();
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
          ...(import.meta.env.DEV&&debug.restoredHandoff?{experimentalRestoredPixels:{maxFrames:1024,lifetimeMs:300_000,maxWorkingBytes:256*1024*1024}}:{}),
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
    const liveOriginals=createLiveOriginalCapture<import('../acquisition/bitmap-dispatch').SnapshotSource>((source,time,elapsed)=>{
      if(!encoder?.active||debug.recording?.()===false||originals?.active===false)return;
      return preparedSources?preparedSources.submit(source,time,elapsed):rawLiveSource?rawLiveSource.backup(source,time,elapsed):encoder.submit(source,time,elapsed);
    });
    if(canonicalSource&&!preparedSources)rawLiveSource=createLiveRawSource(canonicalSource,{
      remember:elapsed=>liveOriginals.remember(elapsed),
      backupDeferred:value=>recordInputDiagnostic('backup-capacity-deferral',()=>value),
    });
    /** Cells accepted by the latest queued live acquisition; feeds only the
     * development coverage selector's scheduling hint, never scan evidence. */
    let lastCoverageSlots:boolean[]|undefined;
    const collect = async (acquire = true, deliveredTime?: number, frozen?:FrozenLiveFrame, capturedAt?:number, originalId?:number, inputStamp?:InputStamp, drainAttempt=false, sourceUnrecorded=false) => {
      const skipAttempt=(reason:'completion-paused'|'aborted'|'not-ready'|'zero-dimensions')=>{
        if(liveScreen&&!recovering&&!captureOnly&&inputStamp)completionInputDiagnostic?.finish(inputStamp,false);
        if(inputStamp&&!drainAttempt){
          if(!signal.aborted&&!recovering&&!captureOnly&&reason!=='aborted')
            noteInputLoss({version:1,inputId:inputStamp.inputId,captureTime:inputStamp.captureTime,reason});
          recordInputDiagnostic('input-acquisition-skip',()=>({version:1,inputId:inputStamp.inputId,captureTime:inputStamp.captureTime,reason}));
          try{debug.exact?.missingInput('획득 전 생략된 입력이 있어 전체 입력을 재현할 수 없습니다.');}catch{/* Recording cannot stop scanning. */}
        }
      };
      // Completion waits for already accepted snapshots; only admission pauses.
      if(acquire&&checkingCompletion&&!frozen){skipAttempt('completion-paused');return;}
      if(signal.aborted){skipAttempt('aborted');return;}
      if(!frozen && !recovering && !stillImages && !debug.replay && video.readyState < 2){skipAttempt('not-ready');return;}
      if(acquire&&liveScreen&&!recovering&&pixelFrames)try{pixelFrames.clear();}
        catch(error){if(pixelStats){pixelStats.retentionFailures++;pixelStats.lastReason=String(error).slice(0,250);}}
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
      if (!width || !height){skipAttempt('zero-dimensions');return;}
      const frame=rescueFrames.next(width,height);
      const frameContext=frame.getContext('2d',{willReadFrequently:true})!;
      // Keep the fixed-row matcher input for this observation even after the
      // two-frame ring has moved on. This is a 24x32 gray feature, not an
      // identity; it is used only when a later read fails.
      const rescueMode=import.meta.env.DEV?debug.rescueFeature:undefined;
      const tileRowGrayFor=(x:number,y:number,w:number,h:number)=>{
        if(rescueTile.width!==w)rescueTile.width=w;
        if(rescueTile.height!==h)rescueTile.height=h;
        rescueTileContext.clearRect(0,0,w,h);
        rescueTileContext.drawImage(frame,x,y,w,h,0,0,w,h);
        return areaGray(rescueTileContext.getImageData(0,0,w,h).data,w,h);
      };
      // One copy of the area that holds every cell of this frame, read on first use
      // (acquisition/rescue-area.ts). A cell outside it is read on its own.
      let rescueArea:RescueArea|null|undefined;
      const areaRowGrayFor=(x:number,y:number,w:number,h:number,cells:readonly Box[])=>{
        if(rescueArea===undefined){
          const bounds=rescueAreaBounds(frame.width===2560&&frame.height===1440?
            [...cells,...Array.from({length:40},(_,slot)=>fixedGridCell(slot)!)]:cells,frame.width,frame.height);
          rescueArea=bounds?{...bounds,data:frameContext.getImageData(bounds.x,bounds.y,bounds.width,bounds.height).data}:null;
        }
        return areaGray((rescueArea&&cutRescueArea(rescueArea,x,y,w,h))??frameContext.getImageData(x,y,w,h).data,w,h);
      };
      const fixedRowGrayFor=(cell: Box,cells:readonly Box[]=[]): Float32Array | null => {
        const x=Math.round(cell.x),y=Math.round(cell.y);
        const w=Math.round(cell.width),h=Math.round(cell.height);
        if(x<0||y<0||w<24||h<32||x+w>frame.width||y+h>frame.height)return null;
        if(rescueMode==='tile')return tileRowGrayFor(x,y,w,h);
        const started=rescueMode?performance.now():0;
        const gray=areaRowGrayFor(x,y,w,h,cells);
        if(rescueMode){
          rescueFeatureStats.calls++;rescueFeatureStats.ms+=performance.now()-started;
          const tile=tileRowGrayFor(x,y,w,h);
          rescueFeatureStats.compared++;
          if(tile.length!==gray.length||tile.some((value,index)=>value!==gray[index]))rescueFeatureStats.different++;
        }
        return gray;
      };
      const nativeFrame=frozen&&'displayWidth' in frozen.source?frozen.source:undefined;
      const nativeAcquisition=!!(debug.nativeAcquisition&&acquisition?.supportsNative&&continuous&&!recovering&&(!frozen||nativeFrame));
      const copyStarted=performance.now();
      const framePainted=!nativeAcquisition&&(!preparedSources||recovering&&!replayRgba&&!replayNative&&!replayPreparedInput);
      if(framePainted)copyScannerInput(frameContext,frozen?.source ?? inputFrame);
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
          recovering?replayCanonicalFrameId:savedId,!!debug.exact&&debug.recording?.()!==false&&!sourceUnrecorded);
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
      let remote:((Omit<Awaited<ReturnType<NonNullable<typeof acquisition>['detectAndAcquire']>>,'rasterReceipt'>|Omit<RejectedTransportAcquisition,'rasterReceipt'>)&{rasterReceipt?:SourceRasterReceipt})|undefined;
      /** Observation only: a frame the card window was located in. Development
       * recording uses it to decide which spans to keep; it can never alter scanning. */
      const offerLocated=()=>{
        if(recovering)return;
        if(import.meta.env.DEV)try{debug.onFrameLocated?.(frameTime);locatedFrameSink?.();}catch{/* Development recording is optional. */}
      };
      const acquireStarted=performance.now();
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
          acquisition ? reducedTransport&&!recovering ? await (acquisition.detectAndAcquireReduced??(()=>{throw Error('거절 이미지 전송 실험 Worker 미지원');}))(currentFrame,frameTime) : nativeAcquisition
          ? await acquisition.detectNative(frozenNative!,currentFrame,frameTime)
          : await acquisition.detectAndAcquire(currentFrame,frameTime,recovering?'recovery':'input') : undefined;
        if(remote?.layout)offerLocated();
      } finally {ownedNative?.close();}
      const acquireMs=performance.now()-acquireStarted;
      if(reducedTransport&&!recovering){
        if(!remote||!('rejectedTransport' in remote))throw Error('거절 이미지 전송 실험 결과 누락');
        const summary=state.rejectedTransport??={frames:0,omitted:0,kept:0,omittedRgbaBytes:0};
        summary.frames++;summary.omitted+=remote.rejectedTransport.omitted;summary.kept+=remote.rejectedTransport.kept;
        summary.omittedRgbaBytes+=remote.rejectedTransport.omittedRgbaBytes;
      }
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
      if(import.meta.env.DEV&&debug.preparedCropProof&&remote?.experimentalCropProof){
        // Diagnostic worker claim and delivery comparison only; no pixels or completion authority.
        try{trace('prepared-crop-proof',remote.experimentalCropProof);}catch{/* Optional diagnostics cannot change collection. */}
      }
      const detectStarted=performance.now();
      const layout = remote ? remote.layout : detector.detect(frame);
      // Development measurement of where a frame's time goes (see onFrameProfile).
      if(import.meta.env.DEV)try{debug.onFrameProfile?.({time:frameTime,located:!!layout,copyMs,acquireMs,detectMs:performance.now()-detectStarted,
        timing:remote&&'timing' in remote?remote.timing as unknown as Record<string,number>|undefined:undefined});}catch{/* Measurement only. */}
      if(!remote&&layout)offerLocated();
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
      if(liveScreen&&!recovering&&!captureOnly)latestAcquisition.begin(state.sampled);
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
      publishCanonicalSource(canonicalSource,savedId,sourceFrameId,recovering?'recovery':'input',frameTime,remote?.rasterReceipt,
        {recordingExpected:!!debug.exact,...(preparedSources&&savedId!==undefined?{preparedPersistent:preparedSources.isPersistent(savedId)}:{})},
        value=>reportCanonicalSourceGap(value,fact=>trace('canonical-source-gap',fact),debug.exact));
      if(inputStamp){
        recordInput('input-link',{inputId:inputStamp.inputId,frameId:sourceFrameId,captureTime:frameTime,phase:recovering?'recovery':'input'});
      }
      if(decoderLineage)recordMedia('media-input-link',()=>parseMediaInputLink({version:1,
        sequenceId:decoderLineage!.sequenceId,sourceId:decoderLineage!.sourceId,role:decoderLineage!.role,ordinal:decoderLineage!.ordinal,
        processingFrame:state.sampled,acquisitionFrameId:sourceFrameId,captureTime:frameTime,phase:recovering?'recovery':'input'}));
      trace('frame',{frame:state.sampled,sourceFrameId,time:frameTime,phase:recovering?'recovery':'input',layout,
        ...(replayProvenance?{provenance:replayProvenance}:{}),...(decodedInput?{decoded:decodedInput}:{}),
        ...(decoderLineage?{lineage:decoderLineage}:{})});

      ledger.frame(!!layout);
      const previouslyLocated=state.located;
      state.located = !!layout;
      if(!recovering)grid.begin(!!layout);
      if (!layout) {
        if(liveScreen&&!recovering&&!captureOnly&&inputStamp)completionInputDiagnostic?.finish(inputStamp,false);
        if(diagnosticSource)recordScrollEvidence('scroll-capture',()=>parseScrollCaptureFact({version:1,source:diagnosticSource,
          state:'not-located',bar:null,geometry:null,headerFactId:headerReads.latestFactId}));
        if(!recovering){
          // A hidden/invalid growth view may conceal a sort or filter change.
          // Fence any older in-flight metadata before a later view reconnects.
          const invalid=metadataOrder.invalidateUnlocatedSort(frameTime,state.sampled);
          commitPositionChange(()=>resetPositionsForSort(state.sort??null,invalid,positionTargets,previouslyLocated));
          if(invalid.sortInvalidated)state.sort=undefined;
          state.scrollPosition=null;
        }
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
          signal.throwIfAborted();
          if(isIncompleteCardRead(error))return {growthPoints:null,sort:null};
          emitOcrResourceNotice(error,state,()=>emit(true));throw error;
        });
        metadata={time:metadataTime,sourceOrder:state.sampled,reading};
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
        finalHeaderFrame=state.sampled;
        if(pixelStats){
          const started=performance.now();
          try{
            if(state.liveInput!=='video'||!frozen||!inputStamp)throw Error('동일한 비디오 원본 연결 없음');
            const roi=completionViewRoi(layout,width,height);if(!roi)throw Error('전체 비교 영역 미지원 또는 화면 경계 잘림');
            const geometry=JSON.stringify([width,height,roi]);
            pixelFrames!.replace(frozen.source,{box:roi,geometry,sourceWidth:width,sourceHeight:height,
              frame:state.sampled,inputId:inputStamp.inputId,captureTime:frameTime});
            pixelStats.retained++;pixelStats.estimatedFrameBytes=width*height*4;pixelStats.lastReason=null;
          }catch(error){pixelStats.retentionFailures++;pixelStats.lastReason=String(error).slice(0,250);}
          finally{const elapsed=performance.now()-started;pixelStats.retentionMs+=elapsed;pixelStats.retentionMaxMs=Math.max(pixelStats.retentionMaxMs,elapsed);}
        }
      }
      if (queue.length >= mainQueueLimit) {
        if(liveScreen&&!recovering&&!captureOnly&&inputStamp)completionInputDiagnostic?.finish(inputStamp,false);
        if(diagnosticSource)recordScrollEvidence('scroll-capture',()=>parseScrollCaptureFact({version:1,source:diagnosticSource,
          state:'queue-full',bar:{...layout.scrollbar},geometry:null,headerFactId:headerReads.latestFactId}));
        remote?.cells.forEach(cell=>{if(cell.image)cell.image.width=0;if(cell.previewImage)cell.previewImage.width=0;});
        if(inputStamp&&liveScreen&&!drainAttempt&&!recovering&&!captureOnly&&!signal.aborted)
          noteInputLoss({version:1,inputId:inputStamp.inputId,captureTime:inputStamp.captureTime,reason:'queue-full'});
        else if(!inputStamp||sourceScopedUnknown)state.droppedFrames++;
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
      const acquired: ((ReturnType<typeof acquireCards>[number]&{previewImage?:HTMLCanvasElement})|RejectedTransportCell)[] = remote?.cells ?? acquireFrame(frame, layout);
      if(savedId!==undefined){
        if(acquired.some(cell=>cell.image===null))throw Error('생략된 이미지는 저장 원본의 획득 결과로 사용할 수 없습니다.');
        saved=saveAcquisition(width,height,layout,acquired as (ReturnType<typeof acquireCards>[number]&{previewImage?:HTMLCanvasElement})[],measuredOrigin);encoder?.attachAnalysis(savedId,saved);
      }
      const coverageSlots=acquired.map(cell=>cell.quality.reason==='미보유 카드 뒷면 · 빈 슬롯');
      if (signal.aborted) { acquired.forEach(cell => { if(cell.image)cell.image.width = 0;if(cell.previewImage)cell.previewImage.width=0; }); signal.throwIfAborted(); }
      const images = acquired.map(cell => cell.image), vectors = acquired.map(cell => cell.art),
        observations = acquired.map(cell => cell.feature), alignedCells = acquired;
      state.rowShift = estimateRowShift(previousVectors, vectors);
      state.status = captureOnly ? "카드 획득·품질 검사 중 · OCR 실행 안 함" : "카드별 획득 · 품질 검사 · 판독 중";
      const diagnostics = state.captureDiagnostics!;
      let collectedThisFrame = 0;
      const batchCandidates:Candidate[]=[];
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
      let latestFrameComplete=true;
      const partialAdmission=liveScreen&&!recovering&&!captureOnly&&!!feedback;
      const admissionFrame=state.sampled;
      // The queue owns an accepted canvas. On abort only release crops that
      // never transferred; a running reader may still own accepted canvases.
      if(partialAdmission){
        admissionScope.begin(acquired.flatMap(cell=>[cell.image,cell.previewImage].filter((canvas):canvas is HTMLCanvasElement=>!!canvas)));
      }
      let admissionSlice=performance.now();
      try {
      for (let i = 0; i < images.length; i++) {
        if(partialAdmission&&i>0&&performance.now()-admissionSlice>=8){
          // record is the same replayable command used by the final frame. Its
          // still-unprocessed slots are unknown; no absolute position is added.
          grid.record(admissionFrame);feedbackPublisher.request();
          await yieldForCapture(signal);
          if(captureError)throw captureError;
          if(state.sampled!==admissionFrame)throw Error('수집 중인 화면의 순서가 변경됐습니다.');
          // liveViewport clears the hint on any move, even if the thumb has
          // returned before this continuation. Do not re-create it on the
          // next intermediate record of this same captured frame.
          const recent=grid.snapshot().recentFrame;
          if(recent?.frame===admissionFrame&&recent.capturedTop===undefined)grid.viewport(undefined);
          admissionSlice=performance.now();
        }
        diagnostics.acquired++;
        const image=images[i];
        const box = alignedCells[i].content;
        const verifiedRecoveryObservation=recovering&&preparedSources?
          exactSourceSavedObservation(replayAnalysis,{sourceFrameId:savedId,captureTime:frameTime,width,height,hash:replaySourceHash},alignedCells[i]):undefined;
        const savedObservation=cached?.observations[i]??verifiedRecoveryObservation;
        const stable = savedObservation?.stable ?? (isStill || settledFields(observations[i], i, previous));
        const trace = ledger.acquire({ frame: state.sampled, time: frameTime, slot: i, box, phase: recovering ? "recording" : "input" });
        // The acquisition Worker has already inspected the same uncompressed
        // pixels. Do not read every returned crop back again on the UI thread.
        const currentCell=acquired[i],quality=currentCell.quality;
        const omittedRejected='cropState' in currentCell&&currentCell.cropState==='omitted-rejected';
        if(omittedRejected!==!image||(omittedRejected&&(!reducedTransport||recovering||quality.usable)))
          throw Error('거절 이미지 생략 상태가 입력과 일치하지 않습니다.');
        const obstructionReceiptBefore=obstructionFence?debug.exact?.eventQueueStats:undefined;
        recordCaptureEvidence('acquisition-capture',()=>parseAcquisitionCapture({
          version:1,sessionId:captureSession,observationId:String(trace),processingFrame:state.sampled,
          acquisitionFrameId:sourceFrameId,canonicalSourceFrameId:physicalSourceId??null,
          captureTime:frameTime,phase:recovering?'recovery':'input',slot:i,pixelKey:acquired[i].pixelKey,
          ...(acquired[i].fieldRevision?{fieldRevision:acquired[i].fieldRevision}:{}),
          sourceWidth:width,sourceHeight:height,cropState:omittedRejected?'omitted-rejected':omittedCrops?.has(i)?'omitted-resolved':'materialized',
          cropWidth:omittedRejected||omittedCrops?.has(i)?null:image!.width,cropHeight:omittedRejected||omittedCrops?.has(i)?null:image!.height,
          nominalBox:layout.cells[i],contentBox:acquired[i].content,previewBox:acquired[i].preview,
          capture:{stable,stabilitySource:savedObservation?'saved-observation':isStill?'still-image':'settled-fields',
            complete:acquired[i].complete??null,intact:acquired[i].intact??null,labelVisible:acquired[i].labelVisible??null,
            borderAlignment:acquired[i].alignment??null,borderSides:acquired[i].borderSides??null,
            ...(acquired[i].preBorder?{preBorder:acquired[i].preBorder}:{})},
          quality:{...quality},
        }));
        if(obstructionFence&&screenEvidenceInput&&(debug.exact||debug.trace))acknowledgeObstructionTrace(!captureRecordingFailed,obstructionReceiptBefore);
        const confirmedObstruction=unidentifiedObstruction(acquired[i]);
        if(confirmedObstruction)recordRecognitionNeeded(recognitionNeeded,i,frameTime,acquired[i].preBorder?.reason??quality.reason);
        if(advisoryExperiment&&acquired[i].occlusionAdvisory){
          advisoryExperiment.notice({sessionId:captureSession,acquisitionFrameId:sourceFrameId,processingFrame:state.sampled,observationId:String(trace),captureTime:frameTime,slot:i,
            pixelKey:acquired[i].pixelKey,phase:recovering?'recovery':'input'});
        }
        // Advisory-only lower-panel evidence never enters the fence. It may be
        // another dark UI or artwork, and absence says nothing about visibility.
        if((confirmedObstruction||acquired[i].occlusionAdvisory)&&inputStamp&&liveObstructionHint){
            // A track may end while acquisition is in flight, before its ended
            // event reaches the scan loop. Do not show that result afterwards.
            let trackLive=false;
            try{trackLive=(video.srcObject as MediaStream|null)?.getVideoTracks().some(track=>track.readyState==='live')===true;}catch{/* Advisory only. */}
            liveObstructionHint.notice({inputId:inputStamp.inputId,frameId:state.sampled,
              captureTime:frameTime,capturedAtMs:recordingStart+inputStamp.observedAtMs},
              liveScreen&&!recovering&&!captureOnly&&capturing&&!signal.aborted&&!captureError&&trackLive);
        }
        if(obstructionFence&&confirmedObstruction){
          obstructionFence.notice(frameTime,initialCaptureOrder);
          obstructionNotices++;
          obstructionLastCaptureTime=Number.isFinite(frameTime)?Math.max(obstructionLastCaptureTime??-Infinity,frameTime):null;
          if(state.obstructionExperiment){state.obstructionExperiment.notices++;
            state.obstructionExperiment.lastCaptureTime=Math.max(state.obstructionExperiment.lastCaptureTime??-Infinity,frameTime);}
          if(debug.exact||debug.trace){
            const before=debug.exact?.eventQueueStats;
            const sent=finalTrace('obstruction-event',{version:2,kind:'notice',sessionId:captureSession,processingFrame:state.sampled,
              acquisitionFrameId:sourceFrameId,observationId:String(trace),captureTime:frameTime,slot:i,
              preBorderKind:acquired[i].preBorder?.kind??null,phase:recovering?'recovery':'input'});
            acknowledgeObstructionTrace(sent,before);
          }
        }
        if(!recovering)grid.cell(i,quality.reason==='미보유 카드 뒷면 · 빈 슬롯'?'empty':quality.usable?'unknown':'review',
          confirmedObstruction?`인식 필요 · ${quality.reason}`:quality.reason);
        // Equal crop pixels in two distinct captures do not make them the same
        // observation. In particular, A -> B -> A must not let recovery of the
        // last capture inherit the first A's older order and field proof.
        if(!recovering)beginNewCaptureSlot(saved,i);
        if(recovering&&resolvedSavedObservation(savedObservation,confirmedFieldOrder)) {
          coverageSlots[i]=true;ledger.finish(trace,'duplicate',{reason:'같은 원본의 최신 확정 관측 재사용'});
          state.recoveryReuse??={frames:0,observations:0,skippedOriginals:0};state.recoveryReuse.observations++;
          if(image)image.width=0;continue;
        }
        if (!quality.usable) {
          ledger.finish(trace, "rejected", { reason: quality.reason });
          diagnostics.rejected++;
          diagnostics.reasons[quality.reason] = (diagnostics.reasons[quality.reason] ?? 0) + 1;
          if(image){record(image, i, quality.reason, false, quality.sharpness);image.width=0;}
          else if(!diagnostics.samples.some(item=>!item.accepted&&item.reason===quality.reason))
            throw Error('생략된 거절 사유의 대표 이미지가 없습니다.');
          if(quality.reason==='미보유 카드 뒷면 · 빈 슬롯')clearRecognitionNeeded(recognitionNeeded,i,frameTime);
          continue;
        }
        // A usable capture is a clean look at this slot even when OCR later
        // fails; the obstruction warning must not outlive the obstruction.
        clearRecognitionNeeded(recognitionNeeded,i,frameTime);
        if(!image)throw Error('판독 가능한 카드 이미지가 없습니다.');
        if (
          (rowMode === "top" && i >= 10) ||
          (rowMode === "stable" && !stableRows[Math.floor(i / 10)])
        ) {
          ledger.finish(trace, "filtered", { reason: "스캔 줄 선택 설정" });
          image.width = 0;
          continue;
        }
        // Briefly visible complete names can survive a fast scroll. Keep their
        // evidence separate so rejecting one frame cannot suppress a stable pair.
        const group = captures.offerDetailed(observations[i], i % 10, quality.sharpness, stable);
        const freshRetry = screenEvidenceInput && !recovering && group.decision === 'duplicate' ?
          freshObservations.retryPlan(group.id, acquired[i].pixelKey, frameTime, stable,
            observation => resolvedSavedObservation(observation, confirmedFieldOrder),
            observation => needsLatestSavedProof(observation,latestIdentityOrder,confirmedFieldOrder)||
              !!(observation.identity&&(obstructionFence?.needsProof(observation.identity.id,confirmedNameOrder,confirmedFieldOrder)||
                advisoryExperiment?.needsProof(observation.identity.id,confirmedNameOrder,confirmedFieldOrder))),
            acquired[i].fieldRevision) : undefined;
        const offered = candidateOffer(group.decision,!!(savedObservation||freshRetry),sourceScopedUnknown);
        gridGroups[i]=group.id;
        // Capture chronology is shared by live and pixel replay. Recovery frames
        // may arrive later while still describing an older card value.
        const order = savedObservation?.order ?? (liveScreen || replayProvenance || debug.replay?.source==='screen'
          ? timedCaptureOrder(initialCaptureOrder, frameTime, i) : offered!=='duplicate'?++captureOrder:captureOrder);
        const groupGrid=(accepted:boolean)=>{if(!recovering){
          // A fresh crop can be a different card even when its visual group is
          // the same. Record invalidation so saved UI commands replay it too.
          if(accepted&&grid.needsGroupInvalidation(group.id,trace))grid.invalidateGroupIdentity(group.id,trace);
          grid.group(i,group.id,trace,accepted,undefined,{
            sessionId:captureSession,frameId:sourceFrameId,observationId:String(trace),
            captureOrder:order,captureTime:frameTime,phase:'input',slot:i,
          });
        }};
        if (offered !== "duplicate") {
          collectedThisFrame++;
          if (offered === "better") diagnostics.improved++;
          record(image, i, offered === "better" ? "더 좋은 관측으로 갱신" : "판독 후보", true, quality.sharpness);
          state.collectedCrops = (state.collectedCrops ?? 0) + 1;
          const observation=savedObservation??newSavedObservation(order,stable,observationFrame);
          const observationSource:InventorySource={sessionId:captureSession,frameId:sourceFrameId,observationId:String(trace),
            captureOrder:order,captureTime:frameTime,phase:recovering?'recovery':'input',slot:i,frame:observation.frame};
          // DEV-only diagnostic binding: never alter queue admission or OCR.
          const countSource=countSourceProbe?.acquire({sessionId:observationSource.sessionId,frameId:observationSource.frameId,
            observationId:observationSource.observationId,captureOrder:observationSource.captureOrder,
            captureTime:observationSource.captureTime,phase:observationSource.phase,slot:observationSource.slot},remote?.rasterReceipt);
          if(screenEvidenceInput&&!recovering)freshnessBridge.use(observation,acquired[i].pixelKey,observationSource);
          const commit=()=>{
            // A large field/name change can form a new visual group. Its
            // unidentified source cannot be retired by the old inventory total.
            if(screenEvidenceInput&&!recovering)freshObservations.remember(group.id,acquired[i].pixelKey,frameTime,observation,acquired[i].fieldRevision,true);
            if(saved)saved.observations[i]=observation;
          };
          ledger.finish(trace, captureOnly ? "selected" : "queued", { group: group.id });
          if (captureOnly) { commit();groupGrid(true);coverageSlots[i]=true;image.width = 0; continue; }
          const cell=acquired[i];
          const cropDiagnostic=remote?.experimentalCropProof;
          const cropClaim=cropDiagnostic?.status==='accepted'?cropDiagnostic.claim.crops.find(value=>value.slot===i):undefined;
          const preview = cell.previewImage ?? crop(currentFrame, alignedCells[i].preview);
          if(partialAdmission)admissionScope.track(preview);
          cell.previewImage=undefined;
          const execution=recovering&&(observationRecorder||debug.feedbackProbe)?new ObservationWork({
            sessionId:captureSession,frameId:sourceFrameId,observationId:String(trace),
            captureOrder:order,captureTime:frameTime,phase:'recovery',slot:i,
          },debug.feedbackProbe?probeObservation:observationRecorder):undefined;
          const candidate: Candidate = {
            source:observationSource,
            ...(cropDiagnostic?.status==='accepted'&&cropClaim?{readerCropClaim:{frame:cropDiagnostic.claim.frame,crop:cropClaim}}:{}),
            ...(countSource?{countSource}:{}),
            ...(debug.recognitionObserver||debug.exact||debug.trace?{recognitionInput:{processingFrame:state.sampled,
              sourceBox:{...cell.content},sourceWidth:width,sourceHeight:height}}:{}),
            ...(debug.feedbackProbe&&!debug.recognitionObserver&&!debug.exact&&!debug.trace?{feedbackFrame:state.sampled}:{}),
            execution,
            savedObservation:observation,pixelKey:cell.pixelKey,
            ...(verifiedRecoveryObservation&&verifiedRecoveryObservation===savedObservation?{verifiedRecoveryObservation}:{}),
            ...(freshRetry?.reason==='changed-fields'?{changedFields:true}:{}),
            ...(!sourceScopedUnknown&&freshRetry?.exactConfirmed?.identity ? {
              verifiedVisual:freshRetry,knownIdentity:freshRetry.exactConfirmed.identity,
              needsIdentity:false,fieldTarget:{id:freshRetry.exactConfirmed.identity.id,order},
            } : {}),
            group: group.id, trace,
            priorityGroup: liveScreen ? livePriority.group(observations[i],i%10) : -1,
            preview: "", previewCanvas: preview,
            image,
            feature: observations[i],
            time: frameTime,
            stable,
            borderAlignment: alignedCells[i].alignment,
            order,
            position: { frame: observation?.frame ?? observationFrame, slot: i, stable,
              sort: null,location:scrollCardLocation(scrollGeometry,i,stable) },
            sortReading: frameMetadata,
          };
          const admission = queue.pushDetailed(candidate);
          const enqueued=admission==='queued'||admission==='replaced';
          if(framePainted&&enqueued)rescueFrames.bind(frame,sourceFrameId,{captureTime:frameTime,
            cells:layout?.cells.map(value=>({...value}))??[]});
          if(framePainted&&enqueued){
            if(layout)try{
              candidate.fixedRowGray=fixedRowGrayFor(layout.cells[i],layout.cells)??undefined;
              if(frame.width===2560&&frame.height===1440){
                const cell=fixedGridCell(i);
                candidate.canonicalRowGray=cell?fixedRowGrayFor(cell,layout.cells)??undefined:undefined;
              }
            }
            catch{/* A rescue feature cannot reject an accepted crop. */}
          }
          if(enqueued&&partialAdmission)admissionScope.transfer(image,preview);
          if(enqueued)readerWake.request();
          if(enqueued&&visualBatch&&!recovering&&!candidate.verifiedVisual)batchCandidates.push(candidate);
          coverageSlots[i]=enqueued;
          if(enqueued){
            commit();
            if(sourceBindingMetadata)try {
              if(!recovering)sourceBindingMetadata.input(saved,group.id,observationSource,
                !!saved?.rasterReceipt&&canonicalSource?.canReuseAnalysis(saved.rasterReceipt)===true);
              else {
                const original=verifiedRecoveryObservation&&verifiedRecoveryObservation===savedObservation?replayAnalysis:undefined;
                const originalJoined=!!original?.rasterReceipt&&canonicalSource?.canReuseAnalysis(original.rasterReceipt)===true;
                const recoveryJoined=remote?.rasterReceipt?.kind==='measured'&&canonicalSource?.canReuseAnalysis(remote.rasterReceipt)===true;
                const path=cached?'cached':'reacquired';
                const association=sourceBindingMetadata.recovery(original,{sourceFrameId:savedId,captureTime:frameTime,width,height,hash:replaySourceHash},
                  cell,observationSource,path,originalJoined,recoveryJoined);
                if(association)metadataTrace('source-binding-metadata',{...association,path,originalJoinedAtMatch:originalJoined,recoveryJoinedAtMatch:recoveryJoined});
              }
              state.sourceBindingMetadata=sourceBindingMetadata.snapshot();
            }catch{/* Diagnostic collection cannot affect scanning. */}
          }
          groupGrid(enqueued);
          if(enqueued){
            state.queued=queue.length+deferred.length+fullRetries.length;
            // Publish waiting work as each crop is admitted. The independent
            // feedback publisher coalesces this to its 33ms lane, so the map
            // does not wait for all forty slots in this acquisition frame.
            if(feedback)feedbackPublisher.request();
            if(import.meta.env.DEV)try{if(!recovering)debug.onFrameAdmitted?.(frameTime);}catch{/* Observation only; it cannot reject a crop. */}
            try{debug.feedbackProbe?.queued({sessionId:captureSession,frameId:sourceFrameId,observationId:String(trace),
              captureOrder:order,captureTime:frameTime,phase:recovering?'recovery':'input',slot:i},state.sampled);
            }catch{/* A diagnostic failure cannot reject an accepted crop. */}
          }
          if (!enqueued) {
            latestFrameComplete=false;
            // A frame can fill the queue partway through its 40 slots, even
            // when the pre-frame capacity check passed. Record that source as
            // lost so matching card counts alone cannot stop sharing. The
            // input tracker deduplicates multiple rejected slots in one frame.
            const candidateLoss=candidateQueueInputLoss(admission,inputStamp,liveScreen&&!drainAttempt&&!recovering&&!signal.aborted);
            if(candidateLoss)noteInputLoss(candidateLoss);
            // The legacy ledger records debt by fuzzy group; another source's
            // success could clear it. Source-v2 must retain this dropped input
            // separately before its raster is released, even at queue capacity.
            if(unknownSourceSession)reportUnknown(image,frameTime,false,'',group.id,order,
              scrollCardLocation(scrollGeometry,i,stable),'판독 대기열 가득 참 · 다시 보여 주세요',
              {source:observationSource,pixelKey:cell.pixelKey,skipImages:true});
            if(screenEvidenceInput&&!recovering){
              freshObservations.rejectChanged(group.id,frameTime,observation);
              // A saved exact original can resolve this rejected source later.
              // This does not commit admission or invent a current identity.
              if(saved)saved.observations[i]=observation;
            }
            execution?.cancel();ledger.finish(trace, "dropped", { group: group.id, reason: "판독 대기열 용량 초과 또는 과거 후보" }); image.width = 0; preview.width = 0;
          }
        } else { groupGrid(false);coverageSlots[i]=true;ledger.finish(trace, "duplicate", { group: group.id }); diagnostics.duplicates++; image.width = 0; }
      }
      if(liveScreen&&!recovering&&!captureOnly){
        latestAcquisition.finish(state.sampled,latestFrameComplete);
        if(inputStamp)completionInputDiagnostic?.finish(inputStamp,latestFrameComplete);
      }
      if(!recovering) {
        observedLayout.capture(gridGroups);
        grid.record(state.sampled);
        for(const location of inventoryPosition.capture(state.sampled,gridGroups,scrollGeometry,stationaryInventory.observe(gridGroups,scrollGeometry)))grid.register(location.frame,location.top);
      }
      if(inputStamp&&!recovering)lastCoverageSlots=coverageSlots;
      if(scrollGeometry) {
        scrollCoverage.offer(scrollGeometry.position,scrollGeometry.pageSpan,coverageSlots);
        state.scrollGaps=scrollCoverage.gaps();
        state.scrollCoverageUncertain=scrollCoverage.hasUncertainPastGap();
        if(import.meta.env.DEV&&debug.trace)coverageTrace({kind:'offer',processingFrame:state.sampled,inputId:inputStamp?.inputId??null,
          captureTime:frameTime,phase:recovering?'recovery':'input',position:scrollGeometry.position,pageSpan:scrollGeometry.pageSpan,
          slots:coverageSlots.map(value=>value?'1':'0').join(''),gaps:state.scrollGaps.slice(0,64),gapsTruncated:state.scrollGaps.length>64});
        if(import.meta.env.DEV)state.scrollCoverageInfo=scrollCoverage.snapshot();
      } else {
        // Unlocated observations may have covered the apparent gap. Never
        // report an unknown scrollbar interval as proven missing acquisition.
        scrollCoverage.loseGeometry();state.scrollGaps=[];
        state.scrollCoverageUncertain=scrollCoverage.hasUncertainPastGap();
        if(import.meta.env.DEV)state.scrollCoverageInfo=scrollCoverage.snapshot();
      }
      for(const cell of acquired)if(cell.previewImage)cell.previewImage.width=0;
      if(visualBatch&&batchCandidates.length){
        // One request for this frame's admitted crops. A crop a reader already took or a
        // better crop replaced is left out; a refused batch leaves every crop to the readers.
        const waiting=batchCandidates.filter(candidate=>candidate.image.width>0&&!candidate.visualPrefetch);
        const reads=visualBatch.read(waiting.map(candidate=>candidate.image));
        if(reads)waiting.forEach((candidate,index)=>{candidate.visualPrefetch=reads[index];});
        try{debug.onVisualBatch?.(visualBatch.stats());}catch{/* Measurement only. */}
      }
      if(import.meta.env.DEV&&debug.rescueFeature)try{debug.onRescueFeature?.({...rescueFeatureStats});}catch{/* Measurement only. */}
      if (collectedThisFrame) {
        state.captureWindows = (state.captureWindows ?? 0) + 1;
        previousVectors = vectors;
      }
      previous = observations;
      state.queued = queue.length + deferred.length + fullRetries.length;
      // input-link above describes acquisition only. An unlocated layout,
      // full queue, incomplete cell set, or dropped candidate must not make a
      // retained drain frame look processed to the recovery lifecycle.
      if(inputStamp&&drainAttempt)drainRecovery.accept(inputStamp.inputId,acquired,layout.cells.length,latestFrameComplete);
      } finally {
        if(partialAdmission){
          admissionScope.finish();
        }
      }
    };
    let metadataRead: Promise<void> | undefined;
    const settleMetadata = () => metadataRead ??= (async () => {
      signal.throwIfAborted();
      if (metadata) {
        const pending = metadata;
        metadata = undefined;
        const next = metadataOrder.accept(pending.time,await pending.reading,pending.sourceOrder);
        commitPositionChange(()=>{
          resetPositionsForSort(state.sort??null,next,positionTargets);
          if (next.growthPoints) state.growthPoints = next.growthPoints;
          if(next.sortInvalidated)state.sort=undefined;
          else if(next.sort)state.sort=next.sort;
        });
      }
      if (recognizer && header && state.expected === null) {
        const pendingHeader=header,pendingOrigin=headerOrigin;
        let total:Awaited<ReturnType<typeof recognizer.total>>;
        try{total=await headerReads.read(pendingOrigin,'initial',()=>recognizer!.total(
          pendingHeader,
          {
            x: 0,
            y: 0,
            width: pendingHeader.width,
            height: pendingHeader.height,
          },
          isStill,
        ));}catch(error){
          signal.throwIfAborted();
          if(!isIncompleteCardRead(error)){emitOcrResourceNotice(error,state,()=>emit(true));throw error;}
          if(header===pendingHeader){header=undefined;headerOrigin=undefined;}
          state.status=error instanceof OcrImageLimit?'OCR 입력이 너무 큽니다 · 해상도를 낮춰 다시 보여 주세요':'카드 보관함 수량을 다시 확인 중 · 화면을 다시 보여 주세요';emit(true);
          return;
        }
        if (total) {
          state.expected = total.owned;
          state.capacity = total.capacity;
        } else if(header===pendingHeader) {header=undefined;headerOrigin=undefined;}
      }
    })().finally(() => { metadataRead = undefined; });
    const metadataWork={pending:()=>!!(metadata||metadataRead),settle:settleMetadata};
    type ReadIdentity=NonNullable<Awaited<ReturnType<NonNullable<typeof recognizer>['identify']>>>;
    /** Read the fields of ONE identified crop, judge the reliability of its count and merge the
     * observation. This is the whole acceptance of a crop's values. Every path that accepts a
     * crop goes through it, so the rules (unconfirmed zero stays unread, review flags, capture
     * order, one observation per crop) cannot drift apart between paths.
     * `visualResult` carries values the visual worker already read; otherwise `reader` reads them. */
    const readAndRecordFields = async (input:{item:Candidate;identity:ReadIdentity;visualResult:VisualResult|undefined;
      reader:typeof recognizer;visualOnly:boolean;budget:CardReadBudget}) => {
      const {item,identity,visualResult,reader,visualOnly,budget}=input;
      let values:Awaited<ReturnType<NonNullable<typeof reader>['read']>>;
      try {values=visualResult?.values ?? await reader!.read(item.image, identity.id, false, !visualOnly,budget);}
      catch(error){if(!(error instanceof CardReadTimeout)||item.verifiedVisual)throw error;values=await reader!.read(item.image,identity.id,false,false);}
      const identified = item.feature;
      if(countSourceProbe){
        const fence=obstructionFence?.snapshot();
        countSourceProbe.read(identity.id,item.countSource,identified,{borderAlignment:item.borderAlignment,
          awakening:values.awakening,extraCopies:values.extraCopies,pattern:values.countDiagnostics?.pattern},
          {sessionId:captureSession,captureOrder:fence?.order??initialCaptureOrder,
           captureTime:obstructionLastCaptureTime??0});
      }
      const resolveCountReliability = () => readFieldReliability(values,
        {stable: item.stable, borderAlignment: item.borderAlignment, maxAwakening: identity.maxAwakening});
      let reliability = resolveCountReliability();
      if (!visualOnly && reliability === "unconfirmed" && values.awakening !== null &&
          values.countDiagnostics?.pattern?.value != null && !identity.review.length) {
        try{values = await reader!.read(item.image, identity.id, true,true,budget);}
        catch(error){if(!(error instanceof CardReadTimeout))throw error;}
        reliability = resolveCountReliability();
      }
      // The shared acceptance rules (session/field-acceptance.ts): an unconfirmed zero stays
      // unread, and unread values are flagged for review.
      const review = settleReadFields(values, identity.review, reliability);
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
      // Same as drainOne's prepareIdentity: a name under review is not confirmed here.
      if(!identity.review.includes('이름 확인')) inventory!.confirmName(item.source,identity.id,identity.name);
      // Publish the observed fields before waiting for optional image work.
      // The exact observation token below owns any later image attachment.
      const observation:ScannedCard=observedCard({identity,values,review,reliability,
        image:item.preview,time:item.time,order:item.order,stable:item.stable,position:item.position});
      const change=inventory!.recordObservation(item.source,observation,item.borderAlignment);
      return {values,reliability,recognizedLive,observation,change};
    };
    const drainOne = async (includeDeferred = false, reader = recognizer, fast = false, deferredOnly = false, visual: ReturnType<typeof createVisualClient> | null = visuals[0], fullOnly = false) => {
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
        pruneFieldRetries(work,confirmedFieldOrder,discardObsoleteRetry,coveredRetry);
        if(!retryPriority)return shiftOcrRetry(work);
        let schedule=retrySchedules.get(reader!);
        if(!schedule){schedule=new LiveRetrySchedule();retrySchedules.set(reader!,schedule);}
        return schedule.shift(work,retryPriority);
      };
      const item = queued ?? (includeDeferred ? fullOnly ? takeRetry(fullRetries) : takeRetry(deferred) ?? (!quick ? takeRetry(fullRetries) : undefined) : undefined);
      state.queued = queue.length + deferred.length + fullRetries.length;
      if (!item) return;
      const visualOnly=fast||!!item.verifiedVisual;
      const fullRead=!quick&&(isStill||!queued||deferred.length>=retryQueueLimit);
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
      let inspection:RecognitionInspection|undefined,inspectionStarted=0,inspectionBudgetStart:number|null=null;
      let identifyExecuted=false,nameMatchCount=0,inspectionTimedOut=false,inspectionError:string|null=null;
      const finishPreview=()=>finishCandidatePreview(item,previews,signal);
      const reject = async () => { ledger.finish(item.trace, "unidentified", { group: item.group, reason: "이름 판독 실패", nameAttempts: reader?.nameDiagnostics(item.image) }); await finishPreview();rescueUnknown(item);reportUnknown(item.image, item.time, false, item.preview, item.group, item.order,item.position.location,'이름 확인 필요',{source:item.source,pixelKey:item.pixelKey,nameAttempts:reader?.nameDiagnostics(item.image),portraitDiagnostics:reader?.portraitDiagnostics(item.image)}); };
      const prepareIdentity = (identity:NonNullable<Candidate['knownIdentity']>) => {
        if(!identity.review.includes('이름 확인')) inventory!.confirmName(item.source,identity.id,identity.name);
      };
      const publishIdentity = (identity:NonNullable<Candidate['knownIdentity']>) => {
        const key={kind:'group' as const,sessionId:captureSession,group:item.group};
        const priorLoss=state.unknownEvidenceLost===true;
        if(hiddenUnknownGuard&&!hiddenUnknownError)observeHidden(guard=>guard.confirmed(key,unknownSource(item.source),identity.id,identity.review));
        const effect=unknownSourceSession?unknownSourceSession.confirmName(key,identity.id,unknownSource(item.source),identity.review):
          unknownLifecycle!.confirmName(key,identity.id,unknownSource(item.source),identity.review);
        if(effect&&hiddenUnknownGuard&&!hiddenUnknownError)observeHidden(guard=>guard.groupEffect(null,undefined,effect));
        if(effect?.retiredVersions.length){
          if(!unknownSourceSession)unknownDiagnostics.retire(effect.retiredVersions);
          refreshUnknown();
        }
        if(unknownLifecycle?.hasLiveEvidenceLoss()&&!priorLoss){
          refreshUnknown();
          try{debug.exact?.incomplete('미식별 입력 근거 손실');}catch{/* Recording is not live authority. */}
          emit(true);
        }
        if(!identity.review.includes('이름 확인')) commitPositionChange(()=>{
          // A reader can finish while another frame is being admitted. Apply
          // spatial identity only at the frame boundary and check ownership
          // again: the group may have been reused while this commit waited.
          if(!grid.isCurrentObservation(item.group,item.trace))return;
          observedLayout.identify(item.group,identity.id);
          grid.identify(item.group,identity.id);
          const previousRevision=inventoryPosition.revision;
          const locations=inventoryPosition.identify(item.group,identity.id);
          if(inventoryPosition.revision!==previousRevision){
            // Any trusted placement can have descended from the conflicting
            // group. Remove the optional spatial projection as one operation;
            // card identity and capture/completion evidence remain untouched.
            resetPositionsForSort(state.sort??null,{growthPoints:null,sort:null},positionTargets,true);
          } else for(const location of locations)grid.register(location.frame,location.top);
        });
      };
      const defer = async (unknown = true, fieldId?:string) => {
        if(item.verifiedVisual)return false;
        if ((!queued && !quick) || isStill) return false;
        unknown=retryNeedsIdentity(unknown,fieldId,acceptedIdentity);
        const fieldTarget=!unknown&&fieldId ? {id:fieldId,order:item.order} : undefined;
        const knownIdentity=!unknown ? acceptedIdentity : undefined;
        if(coveredFieldRetry({needsIdentity:unknown,fieldTarget,knownIdentity},confirmedFieldOrder,confirmedNameOrder))return false;
        const target = quick ? fullRetries : deferred;
        const fields = visualResult?.fields ?? await reader!.inspect(item.image);
        // Retry eligibility belongs to image quality, not awakening support:
        // growthless cards have legitimate labels but no five-jewel observation.
        if (!retryEligible({ ...fields, needsIdentity: unknown, stable: item.stable, borderAlignment: item.borderAlignment }))
          return false;
        // The retry queue retains a shallow copy. Resolve the unknown preview
        // before copying so it cannot retain a canvas that encoding releases.
        if(unknown)await finishPreview();
        const feature = item.feature;
        const admission=admitRetryCandidate(target,{...item,feature,needsIdentity:unknown,fieldTarget,knownIdentity},retryQueueLimit,old=>{
          ledger.finish(old.trace,"superseded",{group:old.group,reason:"같은 원본의 재시도 이미지 개선"});
          releaseCandidate(old);
        });
        if(admission==='ownership-conflict'){
          state.unknownEvidenceLost=true;
          throw Error('재시도 이미지의 소유권이 중복되어 스캔을 중단합니다.');
        }
        retained=admission==='queued'||admission==='replaced';
        if(retained)readerWake.request();
        if(admission==='full'){
          state.retryWork??={skippedFields:0,reusedIdentities:0};
          if(unknown)state.retryWork.capacityUnidentified=(state.retryWork.capacityUnidentified??0)+1;
          else state.retryWork.capacityFields=(state.retryWork.capacityFields??0)+1;
          // Some field-only retries arrive before this source's latest fields
          // have entered inventory/freshness (including non-screen inputs).
          // Losing that owned crop cannot be covered by a prior card value.
          if(!state.unknownEvidenceLost){
            state.unknownEvidenceLost=true;
            try{debug.exact?.incomplete('재시도 대기열 포화 · 판독 출처 근거 손실');}catch{/* Optional recording cannot stop scanning. */}
          }
          try{trace('retry-capacity',{source:unknownSource(item.source),needsIdentity:unknown});}catch{/* Optional diagnostics. */}
        }
        if(admission==='full'&&unknown){
          // A v1 group may otherwise hide this source; v2 also retains its
          // warning, but neither may silently lose retry ownership.
          reportUnknown(item.image,item.time,false,item.preview,item.group,item.order,item.position.location,
            '판독 대기열 가득 참 · 다시 보여 주세요',{source:item.source,pixelKey:item.pixelKey,
              nameAttempts:reader?.nameDiagnostics(item.image),portraitDiagnostics:reader?.portraitDiagnostics(item.image)});
          emit(true);
        }else if(admission==='full'){
          // Do not mislabel a known card as an unidentified crop. Some paths
          // also have a latest-field review, but do not assume it exists.
          state.captureWarning??='판독 대기열이 가득 찬 적이 있어요. 확인이 필요한 카드가 남으면 다시 보여 주세요.';
          emit(true);
        }
        if (retained) {
          activityStatus='waiting';
          item.execution?.finish('waiting');
          ledger.finish(item.trace, "deferred", { group: item.group, reason: unknown ? "이름 보조 판독 대기" : "장수·각성 보조 판독 대기" });
          state.queued = queue.length + deferred.length + fullRetries.length;
          if (unknown) reportUnknown(item.image, item.time, true, item.preview, item.group,item.order,item.position.location,'이름 확인 필요',{source:item.source,pixelKey:item.pixelKey,nameAttempts:reader?.nameDiagnostics(item.image),portraitDiagnostics:reader?.portraitDiagnostics(item.image)});
        }
        return retained;
      };
      // Development measurement only (onReadProfile): consecutive time spans of this read.
      const readSpans:Record<string,number>|undefined=import.meta.env.DEV&&debug.onReadProfile?{}:undefined;
      let readMark=readSpans?performance.now():0;
      const span=readSpans?(name:string)=>{const now=performance.now();readSpans[name]=(readSpans[name]??0)+now-readMark;readMark=now;}:undefined;
      readingJobs++;
      const displayReading=displayReadings.begin();
      state.activeReadings=displayReadings.active;
      let gridRead:number|undefined;
      let activityRead:number|undefined;
      let executionRead:number|undefined;
      try {
        if (item.previewCanvas) {
          // The thumbnail owns its canvas until encoding settles. Recognition
          // starts immediately on the separate crop and retries share the job.
          const task=previews.tryEncodeOwned(item.previewCanvas);
          if(task){item.previewTask=task;item.previewCanvas=undefined;}
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
          if(!previewPresentation.active)return;
          item.preview=image;
          // Update only this trace: do not reorder the activity strip or reset
          // a newer status when a slow optional thumbnail arrives.
          if(activity.updateImage(item.trace,image))emit();
        }).catch(()=>{/* Optional thumbnail presentation cannot reject a reader. */});
        emit();
        const readSourceKey=cardReadSourceKey(item.source);
        attempt=item.verifiedVisual ? readAttempts.beginVerifiedVisual(item.verifiedVisual) : readAttempts.begin(item.pixelKey,readStage,readSourceKey);
        budget=attempt?.budget ?? new CardReadBudget();
        if(debug.recognitionObserver&&item.recognitionInput){
          inspectionStarted=performance.now();inspectionBudgetStart=reservedRecognitionBudget(attempt);
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
        if(!attempt&&readStage==='short'&&readAttempts.canBegin(item.pixelKey,'full',readSourceKey)) {
          acceptedIdentity=fieldRetryIdentity(item);
          if(await defer(!acceptedIdentity,acceptedIdentity?.id))return;
        }
        if(!attempt){
          const denial=item.verifiedVisual?null:readAttempts.denialReason(item.pixelKey,readStage,readSourceKey);
          if(cardReadDenialLosesEvidence(denial)){
            state.unknownEvidenceLost=true;
            state.captureWarning=denial==='invalid-key'||denial==='mode-conflict'
              ?'판독 출처를 확인할 수 없어 카드 확인 근거가 누락됐어요. 새 스캔을 시작해 주세요.'
              :'판독 작업의 안전 한도에 도달해 카드 확인 근거가 누락됐어요. 새 스캔을 시작해 주세요.';
            try{debug.exact?.incomplete(`판독 시도 근거 한도 또는 오류: ${denial}`);}catch{/* Optional recording cannot stop scanning. */}
            emit(true);
          }
          throw new CardReadAdmissionDenied();
        }
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
        // Observer borrows the actual candidate immediately before the first reader can access it.
        inspection?.captureInput?.(item.image,item.readerCropClaim);
        span?.('setup');
        if(fast&&item.visualPrefetch){
          // The frame's batch already asked for this crop. No result (null) reads it below as usual.
          const prefetch=item.visualPrefetch;item.visualPrefetch=undefined;
          visualResult=await budget.wait(()=>prefetch)??undefined;
        }
        if (fast && visual && !visualResult) visualResult=await budget.wait(()=>{
          const stats=state.visualOverflow,index=visuals.indexOf(visual);
          if(stats&&usedOverflowWorkers&&index>=lanePlan.fast){
            stats.readsStarted++;
            if(!usedOverflowWorkers.has(visual)){usedOverflowWorkers.add(visual);stats.usedWorkers++;}
          }
          return visual.read(item.image);
        },()=>{
          visual.dispose();const index=visuals.indexOf(visual);if(index>=0)visuals[index]=createVisualClient(signal);
        });
        span?.('visual');
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
        let identity = retainedIdentity ?? (visualOnly ? (visualResult ? visualResult.identity : reader!.identifyVisual(item.image)) : await reader!.identify(
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
          const rescue = rescueRecord(item);
          if (rescue) {
            const confirmed = confirmFixedGridRescue({ slot: item.position.slot, captureTime: item.time,
              records: state.fixedRowRescue?.records ?? [], existingIds: new Set(state.cards.map(card => card.id)) });
            const reference = confirmed ? recognizer?.catalog.find(card => card.id === confirmed.id) : undefined;
            if (confirmed && reference) {
              // Two independent fixed-row matches are promoted only to a
              // reviewable identity. Fields still come from the normal reader.
              identity = {
                id: reference.id, name: reference.name, confidence: confirmed.correlation,
                nameEvidence: [{ rawText: '', engine: 'artwork', readingId: crypto.randomUUID(),
                  fingerprint: 'fixed-row-rescue', ocrConfidence: 0, score: confirmed.correlation,
                  gap: confirmed.margin, exact: false }],
                review: ['원화 복원 확인'], identitySource: 'artwork', maxAwakening: reference.maxAwakening,
              } as NonNullable<typeof identity>;
              inspectionIdentity = identity;
            }
          }
          if (!identity) {
            ledger.finish(item.trace, "unidentified", { group: item.group, reason: "이름 판독 실패", nameAttempts: reader!.nameDiagnostics(item.image) });
            if (sourceScopedUnknown || !queued || visibleCard) {
              await finishPreview();
              reportUnknown(item.image, item.time, false, item.preview, item.group,item.order,item.position.location,'이름 확인 필요',{source:item.source,pixelKey:item.pixelKey,nameAttempts:reader?.nameDiagnostics(item.image),portraitDiagnostics:reader?.portraitDiagnostics(item.image)});
            } else if(hiddenUnknownGuard&&!hiddenUnknownError) {
              observeHidden(guard=>guard.failure({version:1,kind:'upsert',key:{kind:'group',sessionId:captureSession,group:item.group},
                source:unknownSource(item.source),captureOrder:item.order,captureTime:item.time,pending:false,
                reason:'이름 확인 필요',location:item.position.location??null},'unreported'));
            }
            return;
          }
        }
        if ((queued || quick) && identity.review.includes("이름 확인")) {
          // A stable frame can still have a damaged name. It must receive the
          // same full retry as an uncertain scrolling frame before completion.
          if (await defer()) return;
          if (!item.stable && identity.confidence < .9) { await reject(); return; }
        }
        acceptedIdentity=identity;
        if(item.source.phase==='recovery'&&item.verifiedRecoveryObservation&&canReuseVerifiedRecovery({
          verified:item.verifiedRecoveryObservation,saved:item.savedObservation,identity,source:item.source,inventory:inventory!,
          freshnessSettled:freshness!.guard('recovery').settled,
          obstructionNeedsProof:!!(obstructionFence?.needsProof(identity.id,confirmedNameOrder,confirmedFieldOrder)||
            advisoryExperiment?.needsProof(identity.id,confirmedNameOrder,confirmedFieldOrder)),
        })){
          // This exact original and crop were confirmed while the recovery
          // candidate waited. Reuse that input proof without creating a new
          // identity event for a different acquisition of the same pixels.
          freshnessBridge.linkIdentity(item.savedObservation,item.source,item.pixelKey);
          if(liveScreen)livePriority.serviced(item.priorityGroup);
          ledger.finish(item.trace,'identified',{group:item.group,cardId:identity.id,name:identity.name});
          publishIdentity(identity);
          activityStatus='read';
          state.recoveryReuse??={frames:0,observations:0,skippedOriginals:0};state.recoveryReuse.observations++;
          grid.finish(item.trace,'read',gridRead);item.execution?.finish('read',executionRead);emit();
          return;
        }
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
          prepareIdentity(identity);publishIdentity(identity);
          activityStatus=confirmedReadingCount({cards:[cards.get(identity.id)!],...fieldEvidence})?'read':'review';
          state.recoveryReuse??={frames:0,observations:0,skippedOriginals:0};state.recoveryReuse.observations++;
          grid.finish(item.trace,activityStatus,gridRead);item.execution?.finish(activityStatus,executionRead);emit();
          return;
        }
        span?.('identity');
        const {values,reliability,recognizedLive,observation,change}=await readAndRecordFields({item,identity,visualResult,reader,visualOnly,budget});
        span?.('fields');
        if(change.latestDiagnostic) {
          if(change.diagnosticResolved)fieldImages.resolved(identity.id,item.order);
          else failedFieldIdentity=identity.id;
        }
        if(change.sourceRejected){
          cardsDirty=true;state.status='카드를 다시 보여 주세요.';
          await finishPreview();
          reportUnknown(item.image,item.time,false,item.preview,item.group,item.order,item.position.location,
            '카드를 다시 보여 주세요',{source:item.source,pixelKey:item.pixelKey});
          return;
        }
        publishIdentity(identity);
        if(recognizedLive)liveInventory.record(observation);
        if(change.fieldsConfirmed) {
          pruneFieldRetries(deferred,confirmedFieldOrder,discardObsoleteRetry,coveredRetry);
          pruneFieldRetries(fullRetries,confirmedFieldOrder,discardObsoleteRetry,coveredRetry);
          state.queued=queue.length+deferred.length+fullRetries.length;
        }
        if(debug.trace)trace('position-debug',inventoryPosition.diagnostics());
        {const card=cards.get(identity.id)!;trace('card',{trace:item.trace,order:item.order,time:item.time,id:card.id,name:card.name,awakening:card.awakening,extraCopies:card.extraCopies,review:card.review});}
        activityStatus=inventory!.hasCountConflict(identity.id)||cards.get(identity.id)!.review.length||reliability==='unconfirmed'?'review':'read';
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
        activity.finish(item.trace,activityStatus,identity.name,activityRead);
        displayReading.pause();state.activeReadings=displayReadings.active;
        emit();
        span?.('publish');
        // Successful previews have their own bounded native work. Attach only
        // to the originating observation, without holding the recognition lane.
        // If native credit or the bounded presentation set is full, wait in
        // this lane within the optional preview deadline. If that expires the
        // list uses its existing catalog artwork/placeholder fallback.
        const attachPreview=(image:string)=>{
          if(!image){state.resultPresentation!.previewOmitted=(state.resultPresentation!.previewOmitted??0)+1;return;}
          if(inventory!.settlePresentationImage(identity.id,change.presentationObservation,image)){
            cardsDirty=true;emit();
          }
        };
        if(frameBatch&&!item.previewTask&&item.previewCanvas){
          // The encoder had no room when this read began. Queue the thumbnail behind the
          // readers (bounded by the presentation set) instead of waiting for it here.
          const canvas=item.previewCanvas;item.previewCanvas=undefined;
          item.previewTask=previews.encodeOwnedWhenAvailable(canvas);
        }
        if(!item.previewTask||!previewPresentation.track(item.previewTask,attachPreview)){
          await finishPreview();attachPreview(item.preview);
        }
        span?.('preview');
        if ((fast || quick) && (reliability === "unconfirmed" || values.awakening === null)) {
          // A retry inspection is real reading work, even though the optional
          // preview is not. The scheduler lane still gates completion while
          // this retry inspection is running.
          displayReading.resume();state.activeReadings=displayReadings.active;
          activityRead=activity.start(item.trace,item.preview);emit();
          await defer(false,identity.id);
          span?.('retry');
        }
      } catch (error) {
        inspectionTimedOut=error instanceof CardReadTimeout;
        inspectionError=error instanceof Error?`${error.name}: ${error.message}`:String(error);
        emitOcrResourceNotice(error,state,()=>emit(true));
        if(isIncompleteCardRead(error)){
          signal.throwIfAborted();
          const retryIdentity=fieldRetryIdentity(item);
          if(retryIdentity){
            // The identity was already accepted. Leave its unresolved fields
            // reviewable instead of creating a duplicate unnamed card.
            ledger.finish(item.trace,'identified',{group:item.group,cardId:retryIdentity.id,reason:error.message});
          }else{
            ledger.finish(item.trace,'unidentified',{group:item.group,reason:error.message,nameAttempts:reader?.nameDiagnostics(item.image)});
            await finishPreview();
            rescueUnknown(item);
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
        displayReading.finish();state.activeReadings=displayReadings.active;
        const inspectionBudgetEnd=inspection?reservedRecognitionBudget(attempt):null;
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
        if(failedFieldIdentity) {
          // Encode exact failed pixels after the OCR budget closes. Encoding
          // must not consume a later retry's time or include preview borders.
          try {
            if(fieldImages.captureCurrent(failedFieldIdentity,item.order,item.pixelKey,()=>item.image.toDataURL('image/png'),
              item.source,inventory!.latestFieldObservationSource(failedFieldIdentity)))cardsDirty = true;
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
          // A saturated encoder has not taken ownership yet. Cancellation or
          // an early reader error must still release this thumbnail canvas.
          if(item.previewCanvas){item.previewCanvas.width=0;item.previewCanvas.height=0;item.previewCanvas=undefined;}
        }
        emit();
        if(readSpans){
          // Whatever a path that returned early left unmarked is counted with cleanup.
          span!('cleanup');
          try{debug.onReadProfile!({stage:readStage,identified:!!acceptedIdentity,spans:readSpans});}catch{/* Measurement only. */}
        }
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
        let collectMs=0,drainMs=0,drained=0;
        try {
          const collectStarted=performance.now();
          await collect();
          const drainStarted=performance.now();collectMs=drainStarted-collectStarted;
          while (queue.length) {await drainOne();drained++;}
          drainMs=performance.now()-drainStarted;
        } finally {recovering=false;replayProvenance=undefined;decoderLineage=undefined;}
        // Development measurement: screen handling (collect) against card reading (drain).
        if(import.meta.env.DEV)try{debug.onFrameLoop?.({time:frameTime,collectMs,drainMs,drained});}catch{/* Measurement only. */}
        emit();
      }
    } else {
      // Recording and original snapshots continue alongside bounded live
      // acquisition. OCR consumes crops independently while the share is live.
      let lastSnapshotTime = -Infinity;
      let drainReservation:CompletionDrainReservation|undefined;
      let drainClockMode:'callback'|'timer'|undefined;
      const cancelDrain=()=>drainReservation?.dispose();
      disposeCompletionDrain=()=>{cancelDrain();signal.removeEventListener('abort',cancelDrain);};
      const stopped = () => {
        disposeCompletionDrain?.();
        disposeCompletionFrames?.();
        scrollPreview.clear();grid.liveViewport(undefined,false);
        state.sharingEndedAt??=(performance.now()-recordingStart)/1000;
        state.workPhase = 'reading';
        capturing = false;
        readerWake.request();
        if(liveScreen&&recognizer)state.shareEndInventory=liveInventory.finish(recognizer.catalog,{cards:inventory!.cards,
          latest:inventory!.latestIdentityOrder,confirmedNames:inventory!.confirmedNameOrder,confirmedFields:inventory!.confirmedFieldOrder,
          agreedFields:inventory!.agreedFieldOrder});
        void continuous?.finish();
        emit(true);
      };
      const failed = (error: unknown) => { captureError = error; stopped(); };
      const autoCompletion=new AutoCompletionHold();
      const autoDiagnostics=new AutoCompletionDiagnostics();
      // A flush can briefly expose an idle boundary between video callbacks.
      // Only the primary reader uses this hint to run the existing check.
      const completionWake=new CompletionWake();
      const drainStats:ScannerState['completionDrainExperiment']=import.meta.env.DEV&&debug.completionDrain&&debug.latestPixelGate&&liveScreen&&!debug.trackFrames?
        (state.completionDrainExperiment={started:0,expired:0,invalidated:0,finished:0,guardedFrames:0,blindFrames:0,
          bufferedFrames:0,verifiedBufferedFrames:0,bufferFailures:0,peakBufferedBytes:0,unresolvedInputLoss:false,firstLossReason:null,
          candidateChecks:0,heldChecks:0,metadataPendingChecks:0,reservedWithMetadata:0,primaryBlocked:0,previewBlocked:0,readersBlocked:0,unsupportedInput:0}):undefined;
      const drainInputs=drainStats?new CompletionDrainInputBuffer<FrozenLiveFrame>():undefined;
      let recoverySequence=0,drainRecoveryActive=false;
      const recordRecovery=(value:Record<string,unknown>)=>recordInput('input-recovery',{version:1,seq:++recoverySequence,...value});
      const markDrainInputLoss=(reason:DrainInputLossReason)=>{
        state.drainInputLoss??={reason,replaySupported:false};
        if(drainStats){drainStats.unresolvedInputLoss=true;drainStats.firstLossReason??=reason;}
        state.unresolvedFieldChanges=Math.max(1,state.unresolvedFieldChanges??0);
        state.captureWarning=DRAIN_INPUT_LOSS_MESSAGE;
      };
      const releaseBuffered=(reason:'compared'|'lost')=>{
        let entry:ReturnType<NonNullable<typeof drainInputs>['takeNext']>;
        // The buffered comparison snapshots have no linked canonical source.
        // An unchanged ROI is not a persisted physical input: prevent a
        // detailed recording from claiming full pixel replay after disposal.
        if(drainInputs?.size&&debug.exact)try{debug.exact.incomplete('완료 검사 입력 원본을 보관하지 못했습니다.');}
        catch{/* Optional recording failure must not stop capture cleanup. */}
        while((entry=drainInputs?.takeNext())){
          if(reason==='lost')recordRecovery({kind:'lost',inputId:entry.id,reason:'cancelled'});
          let failed=false;try{entry.frame.close();}catch{failed=true;markDrainInputLoss('release-error');}
          recordRecovery({kind:'released',inputId:entry.id,failed,reason});
        }
        if(drainInputs&&!drainInputs.clear())markDrainInputLoss('release-error');
      };
      let verifiedHeader:{snapshot:CompletionHeaderSnapshot;total:InventoryHeaderTotal|null}|undefined;
      if(drainStats){
        drainReservation=new CompletionDrainReservation(reason=>{
          if(reason==='expired')drainStats.expired++;
          else if(reason==='invalidated')drainStats.invalidated++;
          else if(reason==='finished')drainStats.finished++;
          if(drainInputs?.size)markDrainInputLoss(reason==='expired'?'buffer-timeout':'buffer-unverified');
          releaseBuffered('lost');
          verifiedHeader=undefined;
          autoCompletion.reset();
          // An in-flight header OCR keeps exclusive ownership of its reader,
          // but capture may resume immediately after this reservation expires.
          checkingCompletion=primaryOcrReading;
          completionCaptureOpen=primaryOcrReading;
        });
        signal.addEventListener('abort',cancelDrain,{once:true});
      }
      // Bounded, pixel-free sampling only at the existing 100ms completion
      // checks. Production builds do not allocate or update this diagnostic.
      const inputWaitSampler=import.meta.env.DEV?new InputWaitSampler():undefined;
      const currentHeaderSnapshot=()=>{
        if(!finalHeader?.width||!finalHeader.height)return;
        const context=finalHeader.getContext('2d',{willReadFrequently:true});
        if(!context)return;
        try{return snapshotHeader({width:finalHeader.width,height:finalHeader.height,
          pixels:context.getImageData(0,0,finalHeader.width,finalHeader.height).data,
          captureTime:lastLocatedTime,sourceFrame:finalHeaderFrame});}catch{return;}
      };
      const matchesCompletionView=(source:CanvasImageSource,inputId:number,time:number,width:number,height:number):boolean=>{
        if(!pixelStats)return false;
        try{
          const result=pixelFrames?.read((referenceSource,witness)=>{
            if(state.liveInput!=='video'||witness.frame!==finalHeaderFrame||
              width!==witness.sourceWidth||height!==witness.sourceHeight)
              throw Error('현재 공유 화면과 수집된 원본 연결 없음');
            const refStarted=performance.now();let snapshot:CompletionViewSnapshot;
            try{snapshot=new CompletionViewSnapshot(samplePixelView(referenceSource,witness.box,witness.geometry,witness.inputId,witness.captureTime));
              pixelStats.referenceSamples++;pixelStats.roiBytes=witness.box.width*witness.box.height*4;
            }finally{const elapsed=performance.now()-refStarted;pixelStats.referenceMs+=elapsed;pixelStats.referenceMaxMs=Math.max(pixelStats.referenceMaxMs,elapsed);}
            const currentStarted=performance.now();
            try{const current=samplePixelView(source,witness.box,witness.geometry,inputId,time);pixelStats.currentSamples++;
              return currentCompletionViewMatches(snapshot,current,inputId);
            }finally{const elapsed=performance.now()-currentStarted;pixelStats.currentMs+=elapsed;pixelStats.currentMaxMs=Math.max(pixelStats.currentMaxMs,elapsed);}
          });
          if(result===undefined)throw Error('최신 수집 원본을 보관하지 못함');
          if(result){pixelStats.matches++;pixelStats.lastReason=null;}
          else{pixelStats.mismatches++;pixelStats.lastReason='현재 화면 픽셀이 마지막 획득 화면과 다름';}
          return result;
        }catch(error){pixelStats.unavailable++;pixelStats.lastReason=String(error).slice(0,250);return false;}
      };
      const matchesCurrentCompletionView=(inputId:number,time:number):boolean=>video.readyState>=2&&
        matchesCompletionView(video,inputId,time,video.videoWidth,video.videoHeight);
      let lastCompletionCheck=-Infinity;
      let autoUnresolved=0;
      // Encoding/attaching a successful card's optional preview does not read
      // card fields. Reader jobs, acquisition, and the existing source-policy
      // queue guard still gate this boundary; presentation flushes before save.
      const inputWorkSettled=()=>captureInputSettled({collectionBusy:!!liveCollection,readingJobs,
        acquisitionSettled:latestAcquisition.settled,
        queueSettled:sourceQueueSettled(sourceScopedUnknown,queue.length+deferred.length+fullRetries.length)});
      const captureCompletion=()=>({expected:state.expected,finalExpected:state.expected,
        fieldChangesSettled:(()=>{const guard=freshness!.guard('capture'),blocked=obstructionPending();
          autoUnresolved=Math.max(guard.unresolved+blocked+Number(!!state.drainInputLoss),unresolvedObservations());return guard.settled&&blocked===0&&!state.drainInputLoss;})(),
        unresolved:unresolvedObservations(),dropped:state.droppedFrames,
        cards:confirmSortedNames([...cards.values()],[...evidence.values()].flat(),recognizer!.catalog),
        latest:latestIdentityOrder,confirmedNames:confirmedNameOrder,confirmed:confirmedFieldOrder,
        inputSettled:inputWorkSettled(),
        headerAvailable:currentHeaderAvailable(state.located,finalHeader?.width??0,finalHeader?.height??0,lastLocatedTime)});
      const publishCompletion=(next:AutoCompletionDiagnostic)=>{
        if(completionInputDiagnostic)state.completionInputDiagnostic=completionInputDiagnostic.snapshot();
        if(inputWaitSampler){
          if(next.gate==='input'&&next.inputPending)inputWaitSampler.observe({collection:!!liveCollection,
            // Preview may coexist with another blocker, but no longer blocks
            // capture completion by itself. A reader waiting on a preview is
            // still counted by `readingJobs`.
            preview:false,readers:readingJobs>0,acquisition:!latestAcquisition.settled},performance.now());
          const inputWait=inputWaitSampler.snapshot();if(inputWait)next={...next,inputWait};
        }
        const old=state.autoCompletionDiagnostic;
        state.autoCompletionDiagnostic=next;
        if(!old||old.gate!==next.gate||old.unresolved!==next.unresolved||old.headerAttempts!==next.headerAttempts||
          old.headerErrors!==next.headerErrors||old.headerMismatches!==next.headerMismatches){
          if(debug.trace&&state.completionInputDiagnostic)try{
            debug.trace('completion-input-diagnostic',{gate:next.gate,...state.completionInputDiagnostic},(performance.now()-recordingStart)/1000);
          }catch{/* Optional development diagnostics cannot affect completion. */}
          // This is a display-only lane. Publishing through emit() would also
          // refresh inventory/grid and create extra replay evidence facts.
          try{debug.onAutoCompletion?.(next);}catch{/* UI diagnostics cannot stop capture. */}
        }
      };
      const noteCompletion=(input:ReturnType<typeof captureCompletion>,gate:AutoCompletionGate)=>{
        if(drainReservation?.active&&['inventory','names','fields','latest-observations','occluded','input-dropped','header-unavailable','header-mismatch','header-error','completion-error','input-ended'].includes(gate))
          drainReservation.finish(drainReservation.id,'invalidated');
        try{publishCompletion(autoDiagnostics.snapshot(input,autoUnresolved,gate));}catch{/* Diagnostic failure cannot affect completion. */}
      };
      const diagnosticEvidenceGate=(input:ReturnType<typeof captureCompletion>)=>{
        if(input.dropped!==0)return 'input-dropped' as const;
        if(obstructionPending())return 'occluded' as const;
        try{return completionEvidenceGate(input);}catch{return 'completion-error' as const;}
      };
      const tryAutoStop=async(acquisitionIdleHint=false)=>{
        if(!liveScreen||!recognizer||!capturing||signal.aborted||captureError||state.autoStopped)return;
        const now=performance.now();
        // Do not bypass throttling for ordinary scans. The prior diagnostic
        // must already have reached input settling, and all current work must
        // still be idle; every evidence/header check below runs unchanged.
        const urgent=acquisitionIdleHint&&state.autoCompletionDiagnostic?.gate==='input'&&
          !liveCollection&&!primaryOcrReading&&inputWorkSettled();
        if(!urgent&&now-lastCompletionCheck<100)return;
        lastCompletionCheck=now;
        if(state.expected!==latestIdentityOrder.size){
          if(drainReservation?.active)drainReservation.finish(drainReservation.id,'invalidated');
          try{publishCompletion(autoDiagnostics.inventory({expected:state.expected,identities:latestIdentityOrder.size,
            names:state.currentRunNames??0,fields:state.currentRunRead??0,unresolved:state.unresolvedFieldChanges??null,
            inputPending:!inputWorkSettled(),headerAvailable:currentHeaderAvailable(state.located,finalHeader?.width??0,finalHeader?.height??0,lastLocatedTime)}));}
          catch{/* Diagnostic failure cannot affect completion. */}
          if(!primaryOcrReading)void settleMetadata().catch(failed);
          autoCompletion.reset();return;
        }
        // Only field-only retries already covered by same-or-newer confirmed
        // evidence can be retired here. A fuzzy group or matching count cannot
        // prove that a queued image has already been read.
        const retiredRetries=pruneFieldRetries(deferred,confirmedFieldOrder,discardObsoleteRetry,coveredRetry)+
          pruneFieldRetries(fullRetries,confirmedFieldOrder,discardObsoleteRetry,coveredRetry);
        if(retiredRetries){state.queued=queue.length+deferred.length+fullRetries.length;emit();}
        const initial=captureCompletion();
        if(!hasCompleteCaptureEvidence(initial)){
          noteCompletion(initial,diagnosticEvidenceGate(initial)??'inventory');
          // Header/experience OCR must not freeze acquisition and every reader
          // while unseen cards or their latest fields still need observations.
          if(!primaryOcrReading)void settleMetadata().catch(failed);
          autoCompletion.reset();return;
        }
        // Do not block arriving input while a previously accepted frame is in
        // flight. Its eventual evidence may invalidate the apparent completion.
        if(liveCollection) {
          // The hold tracks already-confirmed field values, not queue silence.
          // A changed/unconfirmed observation resets it once processed; the
          // synchronous commit below still requires a genuinely idle boundary.
          const held=autoCompletion.observe({...initial,inputSettled:true},now);
          if(drainStats){drainStats.candidateChecks++;if(held)drainStats.heldChecks++;
            if(metadataWork.pending())drainStats.metadataPendingChecks++;if(primaryOcrReading)drainStats.primaryBlocked++;
            if(readingJobs>0)drainStats.readersBlocked++;
            if(state.liveInput!=='video')drainStats.unsupportedInput++;}
          // DEV-only bounded admission reservation. Existing accepted inputs
          // still drain; no pixel match is treated as new card evidence.
          if(drainReservation&&canReserveCompletionDrain({held,active:drainReservation.active,primaryOcrReading,
            previewWaiting:previews.waiting,readingJobs,queueSettled:sourceQueueSettled(sourceScopedUnknown,queue.length+deferred.length+fullRetries.length),
            video:state.liveInput==='video',callbackClock:drainClockMode==='callback'})){
            if(metadataWork.pending())drainStats!.reservedWithMetadata++;
            drainReservation.start();drainStats!.started++;
          }
          noteCompletion(initial,'input');
          return;
        }
        // Frozen callbacks received during the drain are not independent card
        // evidence. Compare every one in order before final header/stop work.
        if(drainReservation?.active&&drainInputs?.size){
          const id=drainReservation.id,count=drainInputs.size;
          const valid=drainInputs.verify((frame,inputId,time)=>{
            const matched=matchesCompletionView(frame.source,inputId,time,frame.width,frame.height);
            if(matched)recordRecovery({kind:'verified',inputId});
            return matched;
          },
            ()=>!!drainReservation?.valid(id));
          if(!valid){
            // A reservation may have expired during pixel comparison; its
            // release callback already discarded and recorded owned inputs.
            if(!drainReservation.valid(id))return;
            const transferred:{frame:FrozenLiveFrame;at:number;stamp:InputStamp;drainRecovery:true;rawLease?:CanonicalRawLease}[]=[];
            let retained:ReturnType<NonNullable<typeof drainInputs>['takeNext']>;
            let unavailable=false;
            while((retained=drainInputs.takeNext())){
              if(!retained.stamp){unavailable=true;recordRecovery({kind:'lost',inputId:retained.id,reason:'unavailable'});
                let failed=false;try{retained.frame.close();}catch{failed=true;}
                recordRecovery({kind:'released',inputId:retained.id,failed,reason:'lost'});continue;}
              let rawLease:CanonicalRawLease|undefined;
              if(rawLiveSource&&debug.exact&&canonicalSource?.active===true&&debug.recording?.()!==false){
                try{rawLease=rawLiveSource.lease(retained.frame.source);}catch{/* Explicitly record the unavailable original below. */}
                if(!rawLease){unavailable=true;try{debug.exact.incomplete('완료 검사 입력 원본을 보관하지 못했습니다.');}catch{/* Optional recorder. */}}
              }
              transferred.push({frame:retained.frame,stamp:retained.stamp,at:recordingStart+retained.time*1000,drainRecovery:true,...(rawLease?{rawLease}:{})});
            }
            if(unavailable)markDrainInputLoss('buffer-unverified');
            if(!transferred.length||!capturePipeline.offerRecovery(transferred.map(input=>({frame:input,stamp:input.stamp})))){
              markDrainInputLoss('buffer-rejected');
              for(const input of transferred){
                recordRecovery({kind:'lost',inputId:input.stamp.inputId,reason:'capacity'});
                let failed=false;try{input.rawLease?.release();}catch{failed=true;}
                try{input.frame.close();}catch{failed=true;}
                recordRecovery({kind:'released',inputId:input.stamp.inputId,failed,reason:'lost'});
                if(failed)markDrainInputLoss('release-error');
              }
              drainReservation.finish(id,'invalidated');return;
            }
            drainRecoveryActive=true;
            liveCollection=capturePipeline.flush().finally(()=>{
              drainRecoveryActive=false;liveCollection=undefined;
              if(capturing&&!signal.aborted&&!captureError){completionWake.request();readerWake.request();}
            });
            drainReservation.finish(id,'invalidated');return;
          }
          drainStats!.verifiedBufferedFrames+=count;
          releaseBuffered('compared');
          if(state.drainInputLoss){drainReservation.finish(id,'invalidated');return;}
        }
        const beforeMetadata=captureCompletion();
        const beforeMetadataReady=hasCompleteCaptureEvidence(beforeMetadata);
        if(metadataWork.pending()&&beforeMetadataReady)noteCompletion(beforeMetadata,'metadata');
        const metadataDrainId=drainReservation?.id??0;
        if(await deferCompletionForMetadata(beforeMetadataReady,metadataWork,
          paused=>{
            // A late settlement may belong to an expired reservation; it must
            // not clear a later reservation's admission or OCR state.
            if(metadataDrainId&&!drainReservation?.valid(metadataDrainId))return;
            checkingCompletion=paused;completionCaptureOpen=paused;if(!paused)readerWake.request();
          }))return;
        // Even an already-resolved await yields: capture may have started a
        // new metadata job on the primary OCR session in that gap.
        if(metadataWork.pending())return;
        const input=captureCompletion();
        const held=autoCompletion.observe({...input,inputSettled:true},performance.now());
        if(!held||!input.inputSettled||!finalHeader){
          noteCompletion(input,diagnosticEvidenceGate(input)??(!input.inputSettled?'input':!input.headerAvailable?'header-unavailable':'hold'));
          return;
        }
        // An OCR result can be applied only to the same measured header after
        // all currently accepted input/readers have settled. This synchronous
        // branch does not freeze acquisition while waiting for an idle gap.
        if(verifiedHeader) {
          const verified=verifiedHeader,commitDrainId=drainReservation?.id??0;
          if(commitDrainId&&!drainReservation?.valid(commitDrainId))return;
          // An expired reservation clears the header inside its release hook.
          if(!verifiedHeader)return;
          const current=currentHeaderSnapshot();
          if(!current||!headerSnapshotMatches(verified.snapshot,current)) {
            verifiedHeader=undefined;autoCompletion.reset();noteCompletion(input,'header-unavailable');return;
          }
          const headerComparison=checkHeaderTotal(verified.total);
          if(headerComparison!=='matching') {
            if(headerComparison==='different') {
              autoDiagnostics.mismatch();noteCompletion(input,'header-mismatch');emit(true);
            } else noteCompletion(input,'header-error');
            verifiedHeader=undefined;autoCompletion.reset();return;
          }
          const media=video.srcObject as MediaStream|null;
          const live=capturing&&!!media?.getVideoTracks().some(track=>track.readyState==='live');
          if(live&&media&&canStopSharing({...input,finalExpected:verified.total!.owned})) {
            if(commitDrainId&&!drainReservation?.valid(commitDrainId))return;
            if(pixelStats){
              const matched=matchesCurrentCompletionView(inputAdmission.snapshot().lastConsideredId,(performance.now()-recordingStart)/1000);
              if(!matched){if(commitDrainId){markDrainInputLoss('comparison-failed');drainReservation?.finish(commitDrainId,'invalidated');}autoCompletion.reset();noteCompletion(input,'input');return;}
            }
            if(commitDrainId&&!drainReservation?.valid(commitDrainId))return;
            if(commitDrainId)drainReservation!.finish(commitDrainId,'finished');
            if(state.resultPresentation){
              state.resultPresentation.previewAttachmentsAtAutoStop=previewPresentation.waiting;
              state.resultPresentation.previewEncodingAwaitedAtAutoStop=previews.waiting;
              state.resultPresentation.previewCreditWaitAtAutoStop=previews.waitingForCredit;
            }
            state.autoStopped=true;noteCompletion(input,'complete');
            stopCompletedShare(media,()=>{
              if (state.finishTiming) {
                try {state.finishTiming=finishTimer.stopSharing(state.finishTiming,performance.now()-recordingStart);}
                catch {/* Diagnostic clocks must never interrupt capture shutdown. */}
              }
              stopInput?.();stopped();
            });
            state.status='전체 카드 수집 완료 · 화면 공유 자동 종료';emit(true);
          } else {
            if(!live)noteCompletion(input,'input-ended');
            else if(verified.total!.owned!==state.expected){autoDiagnostics.mismatch();noteCompletion(input,'header-mismatch');}
            verifiedHeader=undefined;autoCompletion.reset();
          }
          return;
        }
        const headerSnapshot=currentHeaderSnapshot();
        if(!headerSnapshot){autoCompletion.reset();noteCompletion(input,'header-unavailable');return;}
        const headerCopy=document.createElement('canvas');headerCopy.width=headerSnapshot.width;headerCopy.height=headerSnapshot.height;
        const headerContext=headerCopy.getContext('2d');
        if(!headerContext){autoCompletion.reset();noteCompletion(input,'header-unavailable');return;}
        headerContext.putImageData(new ImageData(headerSnapshot.pixels,headerSnapshot.width,headerSnapshot.height),0,0);
        const headerCopyOrigin=finalHeaderOrigin;
        // Keep readers paused while reserving the primary OCR session; live
        // input remains open and can update freshness and the current header.
        checkingCompletion=true;
        completionCaptureOpen=!drainReservation?.active;
        primaryOcrReading=true;
        const headerDrainId=drainReservation?.id??0;
        let readingHeader=false;
        try {
          autoDiagnostics.attempted();noteCompletion(input,'header-reading');
          readingHeader=true;
          const total=await headerReads.read(headerCopyOrigin,'auto-completion',()=>recognizer!.total(headerCopy,{x:0,y:0,width:headerCopy.width,height:headerCopy.height}));
          readingHeader=false;
          signal.throwIfAborted();
          if(headerDrainId&&!drainReservation?.valid(headerDrainId))return;
          verifiedHeader={snapshot:headerSnapshot,total};
        } catch(error) {
          autoCompletion.reset();
          if(signal.aborted)throw error;
          if(emitOcrResourceNotice(error,state,()=>emit(true)))throw error;
          if(error instanceof OcrImageLimit){state.status='OCR 입력이 너무 큽니다 · 해상도를 낮춰 다시 보여 주세요';emit(true);}
          if(readingHeader){autoDiagnostics.error();noteCompletion(input,'header-error');}
          else noteCompletion(input,'completion-error');
        } finally {completionCaptureOpen=false;primaryOcrReading=false;checkingCompletion=false;headerCopy.width=0;headerCopy.height=0;readerWake.request();}
      };
      const recordSnapshot = (time: number) => {
        if (continuous && (time < lastSnapshotTime || time - lastSnapshotTime >= .25)) {
          lastSnapshotTime = time;
          void collect(false, time).catch(failed);
        }
      };
      if(observationRecorder){inputReplay=new InputDecisionReplay(new AbortController().signal);trace('input-acquisition-contract',{version:1});}
      recordInputDiagnostic('input-loss-contract',()=>({version:1}));
      const inputStats:NonNullable<ScannerState['liveInputPipeline']>&{sourceCapacityDeferred:number}=state.liveInputPipeline={offered:0,processed:0,replaced:0,capacityDropped:0,sourceCapacityDeferred:0,selectionHints:0,selectionMs:0,maxSelectionMs:0,freezeMs:0,maxFreezeMs:0,queueWaitMs:0,maxQueueWaitMs:0};
      // Development comparison only: never combined with an exact input
      // recording, whose decision contract assumes arrival-order ownership.
      // A diagnostic trace stays allowed, but its input-decision stream is
      // skipped below, so such a run cannot be replayed as an input decision log.
      const coverageSelector=import.meta.env.DEV&&liveScreen&&devCoverageSelectorRequested()&&!debug.exact?
        createCoverageFrameSelector():undefined;
      inputStats.selector=coverageSelector?'coverage':'arrival';
      const capturePipeline=createLiveCapturePipeline<{frame:FrozenLiveFrame;at:number;originalId?:number;rawLease?:CanonicalRawLease;stamp:InputStamp;drainRecovery?:true;sourceUnrecorded?:true}>({
        now:()=>performance.now()-recordingStart,
        maxPendingFrames:coverageSelector?4:2,maxRetainedBytes:maxRetainedRasterBytes,
        ...(coverageSelector?{selector:coverageSelector}:{}),
        frameBytes:input=>input.frame.width*input.frame.height*4,
        onRecoveryLifecycle:decision=>{
          if(decision.kind==='started')drainRecovery.start(decision.inputId);
          if(decision.kind==='finished'&&!drainRecovery.verified(decision.inputId,decision.outcome))markDrainInputLoss('buffer-unverified');
          if(decision.kind==='lost'||decision.kind==='released'&&decision.failed)markDrainInputLoss('buffer-unverified');
          if(decision.kind==='released')drainRecovery.release(decision.inputId);
        },
        onRecoveryDecision:recordRecovery,
        onRelease:decision=>{
          const loss=pipelineInputLoss(decision,!signal.aborted&&capturing);
          if(loss)noteInputLoss(loss);
        },
        onOperationalError:()=>{markDrainInputLoss('buffer-unverified');emit(true);},
        onRecoveryInterruption:()=>{markDrainInputLoss('buffer-rejected');emit(true);},
        onDecision:decision=>{
          completionInputDiagnostic?.pipelineDecision(decision);
          if(decision.kind==='replaced')inputStats.replaced++;
          if(decision.kind==='released'&&decision.reason==='capacity')inputStats.capacityDropped++;
          if(observationRecorder&&!coverageSelector)recordInput('input-decision',decision);
        },
        onRecordError:error=>{completionInputDiagnostic?.pipelineRecordError();inputRecordingError(error);},
        yieldTask:()=>yieldForCapture(signal),
        consume:async(input,time)=>{
          signal.throwIfAborted();
          const started=performance.now();
          inputStats.processed++;
          if(frameFlow&&flowLastConsumeEnd!==null)frameFlow.idleMs+=Math.max(0,started-flowLastConsumeEnd);
          const delay=Math.max(0,started-input.at);
          inputStats.queueWaitMs+=(delay-inputStats.queueWaitMs)/inputStats.processed;
          inputStats.maxQueueWaitMs=Math.max(inputStats.maxQueueWaitMs,delay);
          trace('input-accept',{inputId:input.stamp.inputId,time});
          // Only a representative actually entering acquisition becomes a new
          // physical source. A policy backup already has its own exact ID.
          let originalId=input.originalId;
          if(originalId===undefined&&input.rawLease){
            try{
              if(canonicalSource?.active&&debug.recording?.()!==false)
                originalId=rawLiveSource!.commit(input.rawLease,input.frame.source,time,time*1000);
              else input.rawLease.release();
            }catch(error){
              if(!input.drainRecovery)throw error;
              markDrainInputLoss('buffer-unverified');
            }
            if(input.drainRecovery&&originalId===undefined){
              markDrainInputLoss('buffer-unverified');
              try{debug.exact?.incomplete('완료 검사 입력 원본을 보관하지 못했습니다.');}catch{/* Optional recorder. */}
            }
          }
          lastCoverageSlots=undefined;
          try{await collect(true,time,input.frame,input.at,originalId,input.stamp,!!input.drainRecovery,!!input.sourceUnrecorded);}
          finally{
            if(coverageSelector){coverageSelector.outcome(lastCoverageSlots??[]);inputStats.coverage=coverageSelector.snapshot();}
            if(frameFlow){
              const ended=performance.now(),took=ended-started;
              frameFlow.consumed++;frameFlow.consumeMs+=took;frameFlow.maxConsumeMs=Math.max(frameFlow.maxConsumeMs,took);
              flowLastConsumeEnd=ended;reportFlow();
            }
          }
          const completion={kind:'completed' as const,startedAtMs:started-recordingStart,endedAtMs:performance.now()-recordingStart};
          inputAdmission.completed(completion.startedAtMs,completion.endedAtMs);
          recordInput('input-admission',completion);
          state.livePerformance ??= { acquisitionMs: 0, recognized: 0, uniqueCards: 0, firstResultMs: null, lagMs: 0 };
          state.livePerformance.acquisitionMs = inputAdmission.snapshot().acquisitionMs;
          emit();
        },
        release:input=>{
          let error:unknown,failed=false;
          try{input.rawLease?.release();}catch(value){failed=true;error=value;}
          try{preparedSources?.release(input.originalId);}catch(value){failed=true;error??=value;}
          try{input.frame.close();}catch(value){failed=true;error??=value;}
          if(failed)throw error??Error('입력 자원 해제 실패');
        },onError:failed,
      });
      disposeLiveCapture=()=>capturePipeline.dispose();
      signal.addEventListener('abort',disposeLiveCapture,{once:true});
      // Development measurement only (debug.onFrameFlow); never read by the scanner.
      const frameFlow=import.meta.env.DEV&&debug.onFrameFlow?{callbacks:0,missedPresented:0,firstCallbackMs:null as number|null,lastCallbackMs:null as number|null,
        maxCallbackGapMs:0,callbackGapsOver100Ms:0,skips:{} as Record<string,number>,offered:0,consumed:0,consumeMs:0,maxConsumeMs:0,idleMs:0}:undefined;
      let flowLastConsumeEnd:number|null=null;
      const reportFlow=()=>{if(frameFlow)try{debug.onFrameFlow!({...frameFlow,skips:{...frameFlow.skips}});}catch{/* Measurement only. */}};
      const acquireLiveFrame = (time: number, nativeFrame?: VideoFrame, delivered?:Readonly<{mediaTime:number;presentedFrames:number;missedFrames:number}>) => {
        const at=performance.now();
        if(frameFlow){
          const now=at-recordingStart;
          if(frameFlow.lastCallbackMs!==null){
            const gap=now-frameFlow.lastCallbackMs;
            frameFlow.maxCallbackGapMs=Math.max(frameFlow.maxCallbackGapMs,gap);if(gap>100)frameFlow.callbackGapsOver100Ms++;
          }
          frameFlow.firstCallbackMs??=now;frameFlow.lastCallbackMs=now;
          frameFlow.callbacks++;frameFlow.missedPresented+=delivered?.missedFrames??0;
        }
        // Limit source snapshots, independently of the lightweight scrollbar.
        // Slow CPU fallback must not recopy a 60 Hz full screen while busy.
        const stamp=inputAdmission.stamp(time,at-recordingStart);
        let retainedStamp:InputStamp|undefined;
        if(drainReservation?.active){
          if(!delivered||delivered.missedFrames>0){markDrainInputLoss(delivered?'clock-gap':'clock-fallback');drainReservation.finish(drainReservation.id,'invalidated');}
          else if(liveCollection){
            const reservationId=drainReservation.id;
            let frame:FrozenLiveFrame|null=null;
            let failure:DrainInputLossReason='frame-unavailable';
            try{
              frame=freezeLiveFrameTimed(nativeFrame??video).frame;
              if(!drainReservation.valid(reservationId)){failure='buffer-timeout';throw Error('input reservation expired');}
              if(!frame||typeof VideoFrame==='undefined'||!(frame.source instanceof VideoFrame))throw Error('input frame unavailable');
              retainedStamp={...stamp,source:correlateSourceFrame(frame.source.timestamp,delivered)};
              if(!drainInputs?.add(frame,stamp.inputId,time,retainedStamp)){retainedStamp=undefined;failure='buffer-rejected';throw Error('input retention unavailable');}
              frame=null;drainStats!.bufferedFrames++;
              drainStats!.peakBufferedBytes=Math.max(drainStats!.peakBufferedBytes,drainInputs.retainedBytes);
            }catch{
              try{frame?.close();}catch{/* Loss remains visible even if release fails. */}
              drainStats!.bufferFailures++;markDrainInputLoss(failure);
              drainReservation.finish(reservationId,'invalidated');
            }
          }
          else{
            drainStats!.guardedFrames++;
            if(!matchesCurrentCompletionView(stamp.inputId,time)){markDrainInputLoss('comparison-failed');drainReservation.finish(drainReservation.id,'invalidated');}
          }
        }
        // Record callback coordinates even for cadence/verification skips.
        // They are not frozen-pixel evidence and never enter policy stamps.
        recordInputDiagnostic('input-arrival',()=>inputArrival(stamp,nativeFrame?.timestamp,delivered));
        const persistRawInput=!!rawLiveSource&&!!debug.exact&&canonicalSource?.active===true&&debug.recording?.()!==false;
        const gates={capturing,checkingCompletion:!!drainReservation?.active||checkingCompletion&&!completionCaptureOpen,
          ...(debug.minInputIntervalMs===undefined?{}:{minIntervalMs:debug.minInputIntervalMs}),
          ...(import.meta.env.DEV&&debug.inputOfferFloorMs!==undefined?{offerFloorMs:debug.inputOfferFloorMs}:{})};
        const admission=inputAdmission.consider(stamp,gates);
        completionInputDiagnostic?.consider(admission,delivered?.missedFrames);
        recordInput('input-admission',{kind:'consider',stamp,gates,
          expected:admission.kind==='freeze'?'freeze':admission.reason});
        if(retainedStamp){
          if(admission.kind==='skip'&&admission.reason==='verification')recordRecovery({kind:'retained',stamp:retainedStamp});
          else{markDrainInputLoss('buffer-unverified');drainReservation?.finish(drainReservation.id,'invalidated');}
        }else if(admission.kind==='skip'&&admission.reason==='verification'&&drainReservation?.active){
          // The callback's pixels were only compared live and were not saved.
          // Preserve that replay boundary instead of claiming full input.
          recordRecovery({kind:'lost',inputId:stamp.inputId,reason:'unavailable'});
          if(debug.exact)try{debug.exact.incomplete('완료 검사 중 비교한 입력의 원본이 없습니다.');}catch{/* Optional recorder. */}
        }
        if(admission.kind==='skip') {
          if(drainRecoveryActive&&admission.reason!=='ended'){markDrainInputLoss('buffer-unverified');emit(true);}
          if(admission.reason==='source-capacity')inputStats.sourceCapacityDeferred++;
          if(frameFlow){frameFlow.skips[admission.reason]=(frameFlow.skips[admission.reason]??0)+1;reportFlow();}
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
        const rawPlan=persistRawInput?rawLiveSource!.plan(nativeFrame??video):undefined;
        const rawLease=rawPlan?.lease,sourceUnrecorded=rawPlan?.sourceUnrecorded===true;
        let snapshot:ReturnType<typeof freezeLiveFrameTimed>;
        const freezeStarted=performance.now();
        try{snapshot=freezeLiveFrameTimed(nativeFrame??video);}
        catch(error){
          if(!signal.aborted){
            const freezeMs=Math.max(0,performance.now()-freezeStarted);
            noteInputLoss({version:1,inputId:stamp.inputId,captureTime:stamp.captureTime,reason:'freeze-failed'});
            try{inputAdmission.frozen(stamp,{succeeded:false,freezeMs});
              recordInput('input-admission',{kind:'frozen',stamp,succeeded:false,freezeMs});}
            catch(bookkeepingError){inputRecordingError(bookkeepingError);}
          }
          rawLease?.release();throw error;
        }
        const {frame:frozen,freezeMs}=snapshot;
        let handedOff=false,originalId:number|undefined;
        try {
          inputAdmission.frozen(stamp,{succeeded:!!frozen,freezeMs});
          recordInput('input-admission',{kind:'frozen',stamp,succeeded:!!frozen,freezeMs});
          if(!frozen){if(!signal.aborted)noteInputLoss({version:1,inputId:stamp.inputId,captureTime:stamp.captureTime,reason:'freeze-failed'});return liveCollection;}
          // Invalidate older results as soon as a representative is actually
          // frozen, not after its asynchronous acquisition has completed.
          // Skipped raw callbacks never advance this display-only boundary.
          if(liveScreen&&!recovering&&!captureOnly)liveObstructionHint?.begin(stamp.inputId);
          if(sourceUnrecorded)inputStats.sourceCapacityDeferred++;
          if(frozen.width*frozen.height*4>maxRetainedRasterBytes){
            state.captureWarning='공유 화면의 해상도가 입력 보관 한도를 초과했습니다. 화면 공유를 다시 시작해 주세요.';
          }
          if(frameFlow)frameFlow.offered++;
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
          originalId=sourceUnrecorded?undefined:persistRawInput?liveOriginals.capture(frozen.source,time*1000,
            (source,captureTime,elapsed)=>rawLiveSource!.commit(rawLease,source,captureTime,elapsed,'backup')):
            liveOriginals.capture(frozen.source,time*1000);
          recordInputDiagnostic('input-backup-reservation',()=>parseInputBackupReservation({version:1,inputId:stamp.inputId,
            captureTime:stamp.captureTime,store:preparedSources?'prepared-native':'capture-originals',reservationId:originalId??null}));
          preparedSources?.retain(originalId);
          capturePipeline.offer({frame:frozen,at:recordingStart+time*1000,originalId,rawLease,stamp:offeredStamp,...(sourceUnrecorded?{sourceUnrecorded:true as const}:{})},time,offeredStamp,hint);
          handedOff=true;
          if(!liveCollection)liveCollection=capturePipeline.flush().finally(()=>{
            liveCollection=undefined;
            if(capturing&&!signal.aborted&&!captureError&&state.autoCompletionDiagnostic?.gate==='input'){completionWake.request();readerWake.request();}
          });
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
                syncUnresolvedObservations();update({...state});
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
        drainStats?{onObservation:event=>{
          if(event.kind==='mode'){drainClockMode=event.mode;return;}
          const failure=drainClockObservationFailure(event);
          if(drainReservation?.active&&failure){
            markDrainInputLoss(failure);drainReservation.finish(drainReservation.id,'invalidated');
          }
        },onError:()=>{if(drainReservation?.active){markDrainInputLoss('clock-error');drainReservation.finish(drainReservation.id,'invalidated');}}}:undefined,
      );
      stopInput = () => { videoInput(); trackInput?.(); };
      state.workPhase = 'capture';
      state.status = "화면 공유 실시간 수집·판독 중";
      emit();
      // All readers share one UI time budget; four independent 8 ms budgets
      // could otherwise occupy one browser turn for over 32 ms.
      let lastYield=performance.now();
      const readerDispatches=new ReaderDispatches(()=>{if(!capturing)readerWake.request();});
      const assistStats=import.meta.env.DEV&&debug.fastOcrAssist?state.fastOcrAssist={requested:true,dispatches:0,settled:0,wallMs:0}:undefined;
      const consumers = [recognizer, ...extraRecognizers].map(async (reader, index) => {
        const schedule=new LiveReaderSchedule();
        try {
          while (capturing || liveCollection || queue.length || deferred.length || fullRetries.length || readerDispatches.active) {
            signal.throwIfAborted();
            if (captureError) throw captureError;
            const wakeVersion=readerWake.version;
            if(checkingCompletion&&!completionCaptureOpen&&!(index===0&&drainReservation?.active)){await readerWake.wait(signal,wakeVersion);continue;}
            if(index===0)await tryAutoStop(completionWake.consume());
            if(drainReservation?.active){await readerWake.wait(signal,wakeVersion);continue;}
            const job=schedule.next(index,lanePlan,{queued:queue.length,short:deferred.length,full:fullRetries.length,live:capturing||!!liveCollection},
              import.meta.env.DEV&&debug.visualOverflow===true&&!!visuals[index],
              import.meta.env.DEV&&debug.fastOcrAssist===true);
            if (job) {
              const fast=job==='fast';
              const assistStart=assistStats&&index===1&&index<lanePlan.fast&&job==='full'?performance.now():undefined;
              if(assistStart!==undefined)assistStats!.dispatches++;
              // The sole reader must service OCR during sharing, but metadata
              // acquisition cannot enqueue another use of that same session.
              const primaryRetry=!fast&&reader===recognizer;
              if(primaryRetry)primaryOcrReading=true;
              const finishDispatch=readerDispatches.start();
              try {await drainOne(!fast,reader,fast,job==='short',visuals[index] ?? null,job==='full');}
              finally {
                if(assistStart!==undefined){assistStats!.settled++;assistStats!.wallMs+=Math.max(0,performance.now()-assistStart);}
                if(primaryRetry)primaryOcrReading=false;finishDispatch();
              }
              // Small time slices avoid a clamped timer after every cheap card,
              // while still giving video callbacks a turn within about 8ms.
              if(performance.now()-lastYield>=8) {
                await yieldForCapture(signal);lastYield=performance.now();
              }
            } else await readerWake.wait(signal,wakeVersion);
          }
        } catch (error) {
          captureError = error; capturing = false; stopInput?.();readerWake.request();
          throw error;
        }
      });
      // Join all consumers before releasing canvases or their OCR sessions.
      await Promise.allSettled(consumers);
      readerWake.dispose();
      if (captureError) throw captureError;
      signal.throwIfAborted();
      await liveCollection;
      state.workPhase = 'verifying'; emit(true);
      await settleMetadata();
      while(metadata || metadataRead)await settleMetadata();
      const finalCards=recognizer ? confirmSortedNames([...cards.values()], [...evidence.values()].flat(), recognizer.catalog) : [];
      const completionInput={expected:state.expected,finalExpected:state.expected,cards:finalCards,
        fieldChangesSettled:freshness!.guard('recovery').settled&&obstructionPending()===0&&!state.drainInputLoss,
        latest:latestIdentityOrder,confirmed:confirmedFieldOrder,agreed:inventory!.agreedFieldOrder,pending:queue.length+deferred.length+fullRetries.length,
        unresolved:unresolvedObservations(),dropped:state.droppedFrames,
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
          verifiedFinalExpected=checkHeaderTotal(total)==='matching'?total!.owned:null;
          const verifiedTail={...completionInput,finalExpected:verifiedFinalExpected};
          // Input can end before the last live reader finishes. Apply the same
          // current-name/field proof as auto-stop once every accepted job is
          // joined and the fresh final header has independently been read.
          // Unmatched crops remain visible; this does not identify/discard them.
          state.recoverySkipped=canSkipRecovery(verifiedTail)||canFinishEndedCapture({
            ...verifiedTail,confirmedNames:confirmedNameOrder,inputClosed:!capturing,
            headerVerified:verifiedFinalExpected!==null,headerAvailable:!!finalHeader.width,
            inputSettled:completionInput.inputSettled&&!readingJobs&&!metadata&&!metadataRead,
          });
        } catch(error) {
          signal.throwIfAborted();
          if(emitOcrResourceNotice(error,state,()=>emit(true)))throw error;
          if(error instanceof OcrImageLimit){state.status='OCR 입력이 너무 큽니다 · 해상도를 낮춰 다시 보여 주세요';emit(true);}
          // A failed optional completion check must retain the recovery path.
          state.recoverySkipped=false;
        }
      }
      // Recovery may still add newer observations, so this is only the
      // captured header proof, not a completed scan by itself.
      if(liveScreen&&verifiedFinalExpected!==null&&finalHeader?.width&&finalHeader.height&&completionInput.tailFresh){
        finalCaptureHeaderProof={mode:state.autoStopped?'auto':'ended',expected:verifiedFinalExpected,
          tailFresh:completionInput.tailFresh,available:true,time:lastLocatedTime};
      }
      const recording = await continuous?.finish();
      // This gate never ends recovery. The encoder additionally checks each
      // exact receipt (or every remaining receipt) before omitting any pixels.
      // Other queued/active observations and unanalysed video still run.
      const canFinishOriginals=()=>!state.unknownEvidenceLost&&!captureError&&!!recognizer&&canSkipCoveredOriginals({
        ...completionInput,expected:state.expected,finalExpected:verifiedFinalExpected,
        fieldChangesSettled:freshness!.guard('recovery').settled&&obstructionPending()===0&&!state.drainInputLoss,
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
        const owner=canonicalSource;
        const prefetched=preparedSources?preparedRecoveryPrefetch(recoveryInputs,preparedSources,signal,{elapsed:()=>performance.now()-recordingStart,
          ...(import.meta.env.DEV&&debug.restoredHandoff&&owner?{consumeRestoredPixelCapability:async (token,identity,consumeSignal)=>{
            let value:Awaited<ReturnType<typeof owner.consumeRestoredPixelCapability>>;
            try{value=await owner.consumeRestoredPixelCapability(token,identity,consumeSignal);}
            catch(error){if(state.restoredHandoff)state.restoredHandoff.failed++;
              try{trace('restored-handoff',{version:1,outcome:'failed',sourceFrameId:identity.sourceFrameId});}catch{/* Diagnostics only. */}
              throw error;}
            const outcome=value?'consumed':'unavailable';
            if(state.restoredHandoff)state.restoredHandoff[outcome]++;
            try{trace('restored-handoff',{version:1,outcome,sourceFrameId:identity.sourceFrameId});}catch{/* Diagnostics only. */}
            return value;
          }}:{})}):undefined;
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
          // Development measurement: would the proof that lets recovery be skipped at the end of
          // sharing hold right now? Observation only; it never ends or changes recovery.
          if(import.meta.env.DEV&&debug.onRecoveryProbe)try{
            const idle=queue.length+deferred.length+fullRetries.length===0;
            debug.onRecoveryProbe({frame:state.recoveryFrames,time:frameTime,idle,
              completeProof:idle&&!!recognizer&&canSkipRecovery({expected:state.expected,finalExpected:verifiedFinalExpected,
                cards:confirmSortedNames([...cards.values()],[...evidence.values()].flat(),recognizer.catalog),
                fieldChangesSettled:freshness!.peek().settled&&obstructionPending()===0&&!state.drainInputLoss,
                latest:latestIdentityOrder,confirmed:confirmedFieldOrder,agreed:inventory!.agreedFieldOrder,
                pending:0,unresolved:unresolvedObservations(),dropped:state.droppedFrames,inputSettled:true,tailFresh:completionInput.tailFresh}),
              read:confirmedReadingCount({cards:[...cards.values()],latest:latestIdentityOrder,confirmed:confirmedFieldOrder,agreed:inventory!.agreedFieldOrder}),
              unresolved:unresolvedObservations(),expected:state.expected,finalExpected:verifiedFinalExpected,tailFresh:completionInput.tailFresh});
          }catch{/* Measurement only. */}
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
              try {await drainOne(!fast,readers[index],fast,job==='short',visuals[index] ?? null,job==='full');}
              finally {if(primaryRetry)primaryOcrReading=false;}
              if(performance.now()-lastYield>=8){await yieldForCapture(signal);lastYield=performance.now();}
              return true;
            },
          });
        } else for await(const input of recovery) {
          await collectRecovery(input);
          while(queue.length)await drainOne();
        }
        if(prefetched){
          if(state.restoredHandoff)state.restoredHandoff.prefetchTransfers=prefetched.stats.restoredTransfers;
          trace('prepared-recovery-prefetch',prefetched.stats);
        }
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
    const readPreview = async (image:string,id:string) => {
      const blob=await (await fetch(image)).blob();
      const bitmap=await createImageBitmap(blob);
      try {
        const canvas=document.createElement('canvas');
        canvas.width=140;canvas.height=210;
        const context=canvas.getContext('2d',{willReadFrequently:true});
        if(!context)throw Error('preview context unavailable');
        // The stored picture is wider than the field area (crest margin): read the field area.
        const region=previewFieldRegion(bitmap.width,bitmap.height);
        context.drawImage(bitmap,region.x,region.y,region.width,region.height,0,0,140,210);
        const pixels=context.getImageData(0,0,140,210).data;
        const values=await recognizer!.read(canvas,id,true,false);
        return {values,pixels};
      } finally { bitmap.close(); }
    };
    /** Re-read stable review cards from their saved preview. This is the same
     * captured card, not a new observation: only an explicit empty counter on
     * an intact preview can resolve a missing field. */
    const recheckStablePreviewFields = async () => {
      if (!recognizer || signal.aborted) return;
      const resolved = new Set<string>();
      for (let index = 0; index < state.cards.length; index++) {
        const card = state.cards[index];
        // A missing count AND an unconfirmed zero both need the same-capture
        // re-read: only an explicit empty counter on an intact preview resolves
        // either. A confirmed value never re-enters here.
        if (card.awakening === null || !needsPreviewZeroProof(card)) continue;
        const seenImages = new Set<string>();
        // Evidence observations may carry no usable image (thumbnail arrived
        // late or not at all). The finalized representative image is the same
        // captured card, so it is a valid fallback — never a new observation.
        const stored = evidence.get(card.id) ?? [];
        const usable = stored.filter(observation =>
          typeof observation.image === 'string' && observation.image.startsWith('data:image/') &&
          !seenImages.has(observation.image) && (seenImages.add(observation.image), true));
        if (typeof card.image === 'string' && card.image.startsWith('data:image/') && !seenImages.has(card.image))
          usable.push(card);
        const previews = usable
          .sort((a,b) => Number(b.capturePosition?.stable === true) - Number(a.capturePosition?.stable === true) ||
            (b.captureOrder ?? 0) - (a.captureOrder ?? 0))
          .slice(0, 8);
        // Read every candidate before deciding: an empty counter is accepted only when no
        // later capture of this card showed a positive count (selectZeroPreview).
        const readings:{preview:typeof previews[number];order:number;zero:boolean;positive:boolean;diagnostics:NonNullable<ScannedCard['countDiagnostics']>|undefined}[]=[];
        for (const preview of previews) {
          try {
            const {values,pixels}=await readPreview(preview.image,card.id);
            readings.push({preview,order:preview.captureOrder??0,...previewZeroReading({values,packed:packCount(pixels, 140, 0, true),
              card:{awakening:card.awakening,observations:card.observations},stillImage:!!stillImages})});
          } catch { /* Try another captured preview before keeping the review. */ }
        }
        const chosen=readings[selectZeroPreview(readings)];
        if(chosen){
          const review = card.review.filter(reason => !reason.includes('장수') && !reason.includes('각성'));
          const resolvedDiagnostics = chosen.diagnostics ?? { maximum: 15, reason: '', readings: [] };
          state.cards[index] = { ...card, image: chosen.preview.image, extraCopies: 0, countReliable: true, review,
            countDiagnostics: { ...resolvedDiagnostics,
              reason: resolvedDiagnostics.reason || PREVIEW_ZERO_REASON } };
          inventory!.confirmPreviewField(card.id, latestIdentityOrder.get(card.id) ?? card.captureOrder ?? 0);
          resolved.add(card.id);
        }
      }
      if (resolved.size) state.pendingFields = (state.pendingFields ?? []).filter(field => !resolved.has(field.id));
    };
    /** Final identity/duplicate resolution. A missing card needs fixed-row
     * evidence from two distinct frames and readable preview fields. An
     * unidentified observation that strongly matches one already-collected
     * card is retained as a duplicate diagnostic, not as a missing card. */
    const resolveFinalRescue = async () => {
      if (!recognizer || signal.aborted) return;
      const existingIds = new Set(state.cards.map(card => card.id));
      const records = state.fixedRowRescue?.records ?? [];
      const promotedItems = new Set<object>(), promotedIds = new Set<string>();
      for (const record of records) {
        const ids = new Set(record.evidence.map(item => item.id));
        if (ids.size !== 1) continue;
        const id = ids.values().next().value!;
        if (existingIds.has(id)) continue;
        const confirmed = confirmFixedGridRescue({ slot: record.slot, captureTime: record.captureTime,
          records, existingIds });
        if (!confirmed) continue;
        const reference = recognizer.catalog.find(card => card.id === confirmed.id);
        if (!reference) continue;
        const item = state.unidentified.find(entry => entry.captureOrder === record.order) ??
          state.unidentified.find(entry => entry.group === record.group && entry.image.startsWith('data:image/'));
        if (!item || !item.image.startsWith('data:image/')) continue;
        try {
          const { values } = await readPreview(item.image, confirmed.id);
          if (values.awakening === null || values.extraCopies === null) continue;
          const card: ScannedCard = { id: confirmed.id, name: reference.name,
            awakening: values.awakening, extraCopies: values.extraCopies,
            confidence: confirmed.correlation, review: [], image: item.image, time: item.time,
            observations: 1, captureOrder: item.captureOrder ?? record.order,
            identitySource: 'artwork', maxAwakening: reference.maxAwakening,
            countReliable: true, countDiagnostics: values.countDiagnostics,
            nameEvidence: [{ rawText: '', engine: 'artwork', readingId: crypto.randomUUID(),
              fingerprint: 'fixed-row-rescue-final', ocrConfidence: 0, score: confirmed.correlation,
              gap: confirmed.margin, exact: false }] };
          state.cards.push(card);
          existingIds.add(card.id);
          promotedIds.add(card.id);
          promotedItems.add(item);
          inventory!.confirmPreviewCard(card, item.captureOrder ?? record.order);
        } catch { /* Keep the observation unidentified when the preview cannot be read. */ }
      }
      if (promotedItems.size) {
        state.unidentified = state.unidentified.filter(item => !promotedItems.has(item));
        state.cards.sort((a,b) => cardCollator.compare(a.name,b.name));
        state.currentRunNames=confirmedCaptureCount({cards:state.cards,latest:latestIdentityOrder,confirmedNames:confirmedNameOrder});
        state.currentRunRead=confirmedReadingCount({cards:state.cards,latest:latestIdentityOrder,confirmed:confirmedFieldOrder,agreed:inventory!.agreedFieldOrder});
        state.pendingFields=(state.pendingFields??[]).filter(field=>!promotedIds.has(field.id));
      }
      const duplicateItems = new Set<UnidentifiedObservation>();
      for (const item of state.unidentified) {
        const record = records.find(entry => entry.order === item.captureOrder) ??
          records.find(entry => entry.group === item.group);
        if (!record) continue;
        const ids = new Set(record.evidence.map(entry => entry.id));
        if (ids.size !== 1) continue;
        const id = ids.values().next().value!;
        if (!existingIds.has(id)) continue;
        const best = record.evidence.reduce((a,b) => b.correlation > a.correlation ? b : a);
        if (best.correlation < .94 || best.margin < .2) continue;
        duplicateItems.add(item);
      }
      // Final, bounded duplicate re-read. Only a fully accounted inventory is
      // eligible; a missing card must never be demoted by a name-only match.
      const pinnedRecognition=[...recognitionNeeded.values()].filter(slot=>slot.pinned).length;
      if (canClassifyFinalDuplicates(state.cards.length, existingIds.size, state.expected, pinnedRecognition)) {
        let rereads = 0;
        const deadline = performance.now() + 8_000;
        collectFastDuplicateItems(state.unidentified, recognizer.catalog, existingIds, duplicateItems);
        const slow = rankSlowDuplicateCandidates(
          state.unidentified.filter(item => !duplicateItems.has(item)), existingIds);
        for (const {item} of slow) {
          if (rereads >= 20) break;
          if (performance.now() > deadline) break;
          if (!hasCollectedNameCandidate(item, existingIds)) continue;
          const source = item.recognitionImage?.startsWith('data:image/') ? item.recognitionImage : item.image;
          if (!source.startsWith('data:image/')) continue;
          rereads++;
          try {
            const image = await new Promise<HTMLImageElement>((resolve, reject) => {
              const element = new Image();
              element.onload = () => resolve(element);
              element.onerror = () => reject(Error('final duplicate image load failed'));
              element.src = source;
            });
            signal.throwIfAborted();
            const canvas = document.createElement('canvas');
            canvas.width = 140; canvas.height = 210;
            canvas.getContext('2d', {willReadFrequently: true})!.drawImage(image, 0, 0, 140, 210);
            let accepted = false;
            for (const variant of FINAL_DUPLICATE_VARIANTS) {
              const reading = await recognizer.matchFinalName(finalDuplicateCanvas(canvas, variant));
              if (finalDuplicateIdentity(reading, recognizer.catalog, existingIds,
                {requireCollectedCompetitors:false})) { accepted = true; break; }
            }
            if (accepted) duplicateItems.add(item);
            canvas.width = 0; canvas.height = 0;
          } catch { /* Keep unresolved when the bounded final re-read cannot finish. */ }
        }
      }
      if (duplicateItems.size) {
        state.unidentified = state.unidentified.filter(item => !duplicateItems.has(item));
        state.duplicateUnidentifiedObservations = (state.duplicateUnidentifiedObservations ?? 0) + duplicateItems.size;
      }
      const resolved = promotedItems.size + duplicateItems.size;
      if (resolved) state.resolvedUnidentifiedObservations = (state.resolvedUnidentifiedObservations ?? 0) + resolved;
    };
    // App persistence starts after runScanner returns. Join all bounded late
    // presentation attachments before the final cards projection and emit.
    if(previewPresentation.waiting>0){state.status='카드 이미지 정리 중';emit(true);}
    const measurePreviewFlush=previewFlushTimer();
    await previewPresentation.flush();signal.throwIfAborted();
    if(state.resultPresentation)state.resultPresentation.previewFlushMs=measurePreviewFlush();
    // No readers can add an attachment here. Suppress any unrelated late
    // activity-thumbnail callbacks before final projection and cleanup.
    previewPresentation.close();
    beginFinalCardVerification(state); emit(true);
    refreshCards();
    if (recognizer) state.cards = confirmSortedNames([...cards.values()], [...evidence.values()].flat(), recognizer.catalog).sort((a,b) => cardCollator.compare(a.name,b.name));
    state.cards=projectCurrentScanFields(state.cards,fieldEvidence);
    state.pendingFields=pendingFieldDiagnostics();
    await resolveFinalRescue();
    await recheckStablePreviewFields();
    if(import.meta.env.DEV&&debug.onCountCalibration){
      // Development measurement only (see onCountCalibration).
      try{
        const rows:CountCalibrationRow[]=[];
        for(const card of state.cards){
          const seen=new Set<string>(),pool:{image:string;stable:boolean}[]=[];
          for(const observation of evidence.get(card.id)??[]){
            const image=observation.image;
            if(typeof image==='string'&&image.startsWith('data:image/')&&!seen.has(image)){seen.add(image);pool.push({image,stable:observation.capturePosition?.stable===true});}
          }
          if(typeof card.image==='string'&&card.image.startsWith('data:image/')&&!seen.has(card.image))pool.push({image:card.image,stable:false});
          const samples:CountCalibrationRow['samples']=[];
          for(const item of pool.slice(0,12)){
            const bitmap=await createImageBitmap(await (await fetch(item.image)).blob());
            try{
              const canvas=document.createElement('canvas');canvas.width=140;canvas.height=210;
              const context=canvas.getContext('2d',{willReadFrequently:true})!;
              const region=previewFieldRegion(bitmap.width,bitmap.height);
              context.drawImage(bitmap,region.x,region.y,region.width,region.height,0,0,140,210);
              const packed=packCount(context.getImageData(0,0,140,210).data,140,0,true),d=packed.diagnostic;
              samples.push({stable:item.stable,hasIcon:packed.hasIcon,candidate:stablePreviewEmptyCandidate(packed),
                iconColor:!!d?.iconColor,numericEvidence:!!d?.numericEvidence,iconRemnant:!!d?.iconRemnant,emptyFields:!!d?.emptyFields,
                iconFlat:!!d?.iconFlat,digitsFlat:!!d?.digitsFlat,highFrequencyCover:!!d?.highFrequencyCover,flatCover:!!d?.flatCover,
                grayMarker:!!d?.grayMarker,visibleBackground:!!d?.visibleBackground});
              canvas.width=0;canvas.height=0;
            }finally{bitmap.close();}
          }
          rows.push({id:card.id,name:card.name,awakening:card.awakening,extraCopies:card.extraCopies,countReliable:card.countReliable??null,
            observations:card.observations??null,reliability:card.countDiagnostics?.reliability??null,reason:card.countDiagnostics?.reason??null,samples});
        }
        debug.onCountCalibration(rows);
      }catch{/* Measurement only. */}
    }
    syncUnresolvedObservations();
    const currentRunNames=confirmedCaptureCount({cards:state.cards,latest:latestIdentityOrder,confirmedNames:confirmedNameOrder});
    const currentRunRead=confirmedReadingCount({cards:state.cards,latest:latestIdentityOrder,confirmed:confirmedFieldOrder,agreed:inventory!.agreedFieldOrder});
    // Matching counts are not evidence about the observations that stayed unidentified:
    // they are kept and reported as they are, never cleared because the totals agree
    // (docs/scanner-pipeline.md). Only resolveFinalRescue, which checks each observation
    // against the list, may classify one as a duplicate.
    const lossFinal=drainLossFinal({unresolved:freshness!.guard('final').unresolved+obstructionPending(),status:'',warning:state.captureWarning},state.drainInputLoss);
    const identifiedAfterSharing=liveScreen?state.cards.filter(card=>identifiedThisRun.has(card.id)&&!liveIdentities.has(card.id)).map(({id,name})=>({id,name})):undefined;
    refreshGrid=undefined;
    refreshFeedback=undefined;
    const unknownEvidenceLost=state.unknownEvidenceLost===true||unknownSourceSession?.hasEvidenceLoss()===true||unknownLifecycle?.hasLiveEvidenceLoss()===true;
    const resolvedUnidentified=Math.max(0,state.resolvedUnidentifiedObservations??0);
    const unresolvedGroups=Math.max(0,ledger.unresolvedGroups-resolvedUnidentified);
    const unknownSourceUnresolved=Math.max(Number(unknownEvidenceLost),(unknownSourceSession?.unresolved()??0)-resolvedUnidentified);
    orchestrateSessionFinalization({
      state,
      counters: {currentRunNames,currentRunRead,unresolvedFieldChanges:lossFinal.unresolved,
        ...(identifiedAfterSharing===undefined?{}:{identifiedAfterSharing}),unknownEvidenceLost},
      beforeFinalStatus: () => {
        // Re-evaluate all evidence after recovery. A successful auto-stop or an
        // earlier matching count is not sufficient to certify final results.
        state.completionReceipt=liveScreen&&!captureOnly&&!captureError&&!signal.aborted&&finalCaptureHeaderProof?
          issuePositiveCompletionReceipt({mode:finalCaptureHeaderProof.mode,expected:state.expected,
            finalExpected:finalCaptureHeaderProof.expected,cards:state.cards,latest:latestIdentityOrder,
            confirmedNames:confirmedNameOrder,confirmed:confirmedFieldOrder,
            fieldChangesSettled:freshness!.guard('final').settled&&obstructionPending()===0&&!state.drainInputLoss&&!unknownEvidenceLost,
            unresolved:unresolvedObservations(),dropped:state.droppedFrames,
            pending:queue.length+deferred.length+fullRetries.length,
            inputClosed:!capturing,inputSettled:!capturing&&!liveCollection&&!readingJobs&&!metadata&&!metadataRead,
            tailFresh:finalCaptureHeaderProof.tailFresh,headerVerified:true,headerAvailable:finalCaptureHeaderProof.available,
            headerCaptureOrder:timedCaptureOrder(initialCaptureOrder,finalCaptureHeaderProof.time,39)}):undefined;
        if(canConfirmScanGrid({...state,unresolvedGroups,unresolvedSourceEvidence:unknownSourceUnresolved})) {
          grid.confirm(state.cards.map(card=>card.id));
          grid.restoreOrder(inventoryPosition.verifiedOrder());
          grid.restorePositions(observedLayout.resolve(state.cards.map(card=>card.id),inventoryPosition.verifiedPositions()));
        }
      },
      finalStatus: discardedCount => sessionFinalization({
        expected: state.expected,
        cardCount: state.cards.length,
        reviews: state.cards.filter(card => card.review.length).length,
        currentRunNames: state.currentRunNames ?? null,
        currentRunRead: state.currentRunRead ?? null,
        pinnedRecognition: [...recognitionNeeded.values()].filter(slot => slot.pinned).length,
        recognitionNeeded: recognitionNeeded.size,
        discardedCount,
        unresolvedUnidentified: state.unidentified.filter(item => !item.pending).length,
        unresolvedGroups,
        unknownSourceUnresolved,
        unknownEvidenceLost,
        captureOnly,
        drainInputLoss: !!state.drainInputLoss,
        drainStatus: lossFinal.status,
        obstructionPending: obstructionPending() > 0,
        unresolvedFieldChanges: state.unresolvedFieldChanges ?? 0,
      }).status,
      drainInputLoss: !!state.drainInputLoss,
      captureWarning: lossFinal.warning,
      emit: () => emit(true),
    });
  } catch(error) {
    // A non-abort failure also ends this session. Detached callbacks must not
    // mutate cards while cleanup or final checkpoints are being produced.
    previewPresentation.close();
    propagateFailure(error);
  } finally {
    try {
      state.workPhase = 'cleanup'; snapshotReadAttempts(); emit(true);
      stopInput?.();
      disposeCompletionDrain?.();
      disposeLiveCapture?.();
      if(disposeLiveCapture)signal.removeEventListener('abort',disposeLiveCapture);
      await liveCollection?.catch(()=>{});
      disposeCompletionFrames?.();
      if(finalHeader)finalHeader.width=0;
      if(debug.exact&&!canonicalSource)try{await acquisition?.stopRecording();}catch(error){debug.exact.incomplete(String(error));}
      acquisition?.dispose();
      try{await preparedSources?.finish();}catch(error){debug.exact?.incomplete(String(error));}
      preparedSources?.dispose();await sourcePreparation?.dispose();
      for(const visual of visuals) visual?.dispose();
      visualBatch?.dispose();
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
      snapshotReadAttempts();emit(true);
    } catch(error) {
      try{debug.onCleanupFailure?.();}catch{/* Keep original failure. */}
      propagateFailure(error);
    } finally {
      publisher.cancel();
      try {
        if(sourceBindingMetadata){state.sourceBindingMetadata=sourceBindingMetadata.snapshot();
          finalTrace('source-binding-metadata-summary',state.sourceBindingMetadata);}
        closeCoverageTrace?.();
        finalTrace('end',{aborted:signal.aborted,expected:state.expected,read:state.currentRunRead,cards:state.cards.map(({id,name,awakening,extraCopies,review})=>({id,name,awakening,extraCopies,review}))});
        let readersSettled=false;
        try{await disposeReaders();readersSettled=true;}
        finally{if(hiddenRequested){
          const snapshot=hiddenUnknownGuard?.summary()??null;
          const incomplete=hiddenUnknownError||!readersSettled;
          const summary=snapshot&&incomplete?{...snapshot,evidenceLost:true,recording:snapshot.recording==='not-requested'?'not-requested' as const:'partial' as const}:snapshot;
          const report={supported:!!hiddenUnknownGuard,summary,
            ...(hiddenUnknownError?{error:'diagnostic-failed'}:!readersSettled?{error:'cleanup-unverified'}:sourceScopedUnknown?{error:'source-v2-not-supported'}:{})};
          let summaryTraceAdmitted:boolean|null=null;
          if(debug.exact||debug.trace){
            const before=debug.exact?.eventQueueStats;
            try{trace('hidden-unknown-summary',report);summaryTraceAdmitted=obstructionEventAdmitted({attempted:true,
              exactRequested:!!debug.exact,traceRequested:!!debug.trace,before,after:debug.exact?.eventQueueStats,
              traceAck:debug.trace?debug.traceAck?.():undefined});}catch{summaryTraceAdmitted=false;}
          }
          const delivered=summary&&summaryTraceAdmitted===false?{...summary,recording:'partial' as const}:summary;
          try{debug.onHiddenUnknownSummary?.({...report,summary:delivered,summaryTraceAdmitted});}catch{/* Diagnostics cannot change scan cleanup. */}
        }}
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
          if(unknownSourceSession)await unknownSourceSession.checkpoint();
          if(unknownLifecycle){
            const snapshot=unknownLifecycle.snapshot();
            let recorded=false;
            const complete=snapshot.complete&&!unknownLifecycle.hasLiveEvidenceLoss();
            try{recorded=finalTrace('unknown-checkpoint',{version:1,complete,events:snapshot.facts,hash:complete?await hashUnknownLifecycle(snapshot):null});}
            catch{/* An unavailable hash cannot certify the checkpoint. */}
            if(!recorded){unknownLifecycle.markIncomplete('event-sink-failed');finalTrace('unknown-checkpoint',{version:1,complete:false,events:snapshot.facts,hash:null});}
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
          if(obstructionFence&&inventory&&(debug.exact||debug.trace)){
            const snapshot=obstructionFence.snapshot(),events=obstructionNotices;
            const expected=Number.isSafeInteger(state.expected)&&state.expected!>0&&state.expected!<=2000?state.expected:null;
            const latest=inventory.latestIdentityOrder,names=inventory.confirmedNameOrder,fields=inventory.confirmedFieldOrder;
            const pending=obstructionFence.pending(expected,[...latest.keys()],names,fields);
            let hash:string|null=null;
            try{if(obstructionTraceComplete&&!captureRecordingFailed)hash=await hashObstructionEvidence(snapshot,expected,latest,names,fields);}
            catch{obstructionTraceComplete=false;}
            const complete=obstructionTraceComplete&&!captureRecordingFailed&&hash!==null;
            const before=debug.exact?.eventQueueStats;
            const sent=finalTrace('obstruction-checkpoint',{version:1,complete,events,order:snapshot.order,invalid:snapshot.invalid,
              expected,pending,hash:complete?hash:null});
            acknowledgeObstructionTrace(sent,before);
          }
          if(inputReplay) {
            try {
              finalTrace('input-checkpoint',{complete:true,hash:await inputCheckpoint()});
            }catch(error){incompleteFinalRecord('입력 선택 검증점 생성 실패');finalTrace('input-checkpoint',{complete:false,error:String(error)});}
          }
        }
      } finally {sourceBindingMetadata?.close();previewPresentation.close();countSourceProbe?.finish();publisher.dispose();feedbackPublisher.dispose();await previews.dispose();}
    }
  }
}
