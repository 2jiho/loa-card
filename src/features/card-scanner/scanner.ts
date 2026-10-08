import { initializeWithin } from './initialization';
import { createVisualClient } from './visual-client';
import type { VisualResult } from './visual-client';
import { decodedFrames } from "./decoded-frames";
import { scanCompletion } from "./completion";
import { retryEligible } from "./retry-quality";
import { imageInputs, startLiveFrames, waitForInput, yieldForCapture } from "./input-source";
import { acquireCards, createCardAcquirer } from "./card-acquisition";
import { createAcquisitionClient } from './acquisition-client';
import type { AcquisitionTiming } from './acquisition-client';
import { tryStartTrackFrames } from './track-frame-source';
import { ScanLedger } from "./scan-ledger";
import type { LedgerSnapshot } from "./scan-ledger";
import { CandidateQueue } from "./candidate-queue";
import { estimateRowShift } from "./grid-motion";
import { CaptureObservations, settledFields, sameCapture } from "./capture-quality";
import type { CardSort } from "./capture-metadata";
import { createDetector } from "./detector";
import {
  createRecognizer,
  crop,
} from "./recognizer";
import type { ScannedCard } from "./recognizer";
import { confirmSortedNames } from "./name-confirmation";
import { consensus } from "./consensus";
import { readScrollGeometry } from "./scroll-position";
import { ScrollCoverage } from './scroll-coverage';
import type { ScrollGap } from './scroll-coverage';
import { countReliability, CountObservations } from "./count-confidence";
import { replayDebugFrames } from "./debug-capture";
import { mergeFrames } from "./merge-frames";
import { createDebugEncoder } from "./debug-encoder";
import { createCaptureOriginals } from "./capture-originals";
import { recordContinuous, recordedFrames } from "./continuous-capture";
import type { ContinuousRecording } from "./continuous-capture";
import type { DebugCapture, DebugFrame } from "./debug-capture";
import { LiveScanCadence, LiveOcrSchedule, LiveRetrySchedule, shiftOcrRetry, retryWorkPriority, timedCaptureOrder, liveLanePlan, liveOcrLane } from "./live-scan-policy";
import { LiveWorkPriority } from './live-work-priority';
import {LiveInventory} from './live-inventory';
import type {LiveInventorySnapshot} from './live-inventory';
import { runJoinedWorkers } from './joined-workers';
import { fieldRetryIdentity, obsoleteFieldRetry, pruneFieldRetries } from './field-retry';
import { canSkipRecovery, confirmedReadingCount } from './recovery-completion';
import {AutoCompletionHold,canStopSharing,confirmedCaptureCount,stopCompletedShare} from './auto-completion';
const cardCollator = new Intl.Collator("ko");

export interface ScannerState {
  currentRunNames?: number;
  currentRunRead?: number;
  status: string;
  percent: number;
  sampled: number;
  stable: number;
  expected: number | null;
  capacity: number | null;
  cards: ScannedCard[];
  seededCards?: number;
  growthPoints?: { current: number; maximum: number } | null;
  growthPointsEstimated?: boolean;
  growthHistory?: import('../growth/complete-growth').GrowthCompletion[];
  sort?: CardSort | null;
  captureWindows?: number;
  collectedCrops?: number;
  rowShift?: number | null;
  located: boolean;
  unreadable: number;
  queued: number;
  droppedFrames: number;
  liveMissedFrames?: number;
  liveInput?: 'video' | 'track';
  captureWarning?: string;
  ledger?: LedgerSnapshot;
  recoveryFrames?: number;
  recoverySkipped?: boolean;
  autoStopped?: boolean;
  resultPresentation?: { observations: number; updates: number; milliseconds: number };
  liveOcrStarted?: { short: number; full: number };
  retryWork?: { skippedFields:number; reusedIdentities:number };
  identifiedAfterSharing?: { id: string; name: string }[];
  sharingEndedAt?: number;
  shareEndInventory?: LiveInventorySnapshot;
  livePerformance?: { acquisitionMs: number; recognized: number; uniqueCards: number; firstResultMs: number | null; lagMs: number;
    stages?: AcquisitionTiming & { copyMs:number; samples:number };
    stagesByLocation?: Partial<Record<'located'|'unlocated', AcquisitionTiming & {copyMs:number;samples:number}>> };
  unidentified: { image: string; time: number; pending: boolean; group?: number }[];
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
export async function runScanner(
  video: HTMLVideoElement,
  source: "video" | "screen",
  signal: AbortSignal,
  update: (state: ScannerState) => void,
  seed: ScannedCard[] = [],
  onReady?: () => void,
  rowMode: "all" | "top" | "stable" = "all",
  stillImages?: HTMLImageElement[],
  captureOnly = false,
  debug: { nativeAcquisition?: boolean; parallelRecovery?: boolean; trackFrames?: boolean; replay?: DebugCapture; replayInputs?: AsyncIterable<{ element: HTMLImageElement | HTMLVideoElement | HTMLCanvasElement | OffscreenCanvas; image?: string; time: number; percent: number }>; record?: (frame: DebugFrame) => void;
    continuous?: (recording: ContinuousRecording) => void;
    snapshots?: () => AsyncIterable<{ element: HTMLImageElement; image: string; time: number; percent: number }>;
    preview?: (image: string) => void; recording?: () => boolean; recordingError?: (message: string) => void } = {},
) {
  const isStill = !!stillImages || debug.replay?.source === "images";
  const state: ScannerState = {
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
    droppedFrames: 0,
    unidentified: [],
    captureDiagnostics: { acquired: 0, rejected: 0, duplicates: 0, improved: 0, reasons: {}, samples: [] },
  };
  const ledger = new ScanLedger();
  let auditComplete = false;
  let lastEmission = -Infinity;
  let refreshCards: (() => void) | undefined;
  const emit = (force = false) => {
    const now = performance.now();
    if (!force && now - lastEmission < 100) return;
    lastEmission = now;
    refreshCards?.();
    state.ledger = ledger.snapshot(auditComplete);
    update({ ...state, cards: [...state.cards], captureDiagnostics: state.captureDiagnostics ? { ...state.captureDiagnostics, reasons: { ...state.captureDiagnostics.reasons }, samples: [...state.captureDiagnostics.samples] } : undefined });
  };
  emit();
  state.status = '화면 검출 모듈 준비 중'; emit(true);
  const detector = await initializeWithin(createDetector(), signal, value => value.dispose());
  let recognizer: Awaited<ReturnType<typeof createRecognizer>> | undefined,
    stopInput: (() => void) | undefined;
  let encoder: ReturnType<typeof createDebugEncoder> | undefined;
  let originals: ReturnType<typeof createCaptureOriginals> | undefined;
  let recordingFailure = "";
  let continuous: ReturnType<typeof recordContinuous> | undefined;
  let recovering = false;
  let releasePending: (() => void) | undefined;
  let acquisition: ReturnType<typeof createAcquisitionClient> | undefined;
  let finalHeader: HTMLCanvasElement | undefined;
  let lastLocatedTime = -Infinity;
  let checkingCompletion=false;
  let liveCollection: Promise<void> | undefined;
  const visuals: ReturnType<typeof createVisualClient>[] = [];
  const lanePlan=liveLanePlan(navigator.hardwareConcurrency);
  const extraRecognizers: Awaited<ReturnType<typeof createRecognizer>>[] = [];
  try {
    if (source === 'screen' && !debug.replay) acquisition = createAcquisitionClient(signal);
    if (!captureOnly) recognizer = await createRecognizer((message) => {
      state.status = message;
      emit();
    }, signal);
    // Each consumer owns its OCR session: multi-line CTC and adaptive caches
    // cannot safely interleave requests from different cards in one reader.
    if (recognizer && source === 'screen' && !debug.replay)
      for(let i=1;i<lanePlan.readers;i++) {
        signal.throwIfAborted();
        state.status = `병렬 인식 준비 ${i + 1} / ${lanePlan.readers}`; emit(true);
        extraRecognizers.push(await createRecognizer(() => {}, signal));
      }
    if (recognizer && acquisition) for(let i=0;i<lanePlan.fast;i++) visuals.push(createVisualClient(signal));
    await Promise.all([acquisition?.ready(),...visuals.map(worker=>worker?.ready())]);
    signal.throwIfAborted();
    if (source === "screen" && !debug.replay && video.srcObject) {
      try { continuous = recordContinuous(new MediaStream((video.srcObject as MediaStream).getVideoTracks()), message => {
        state.captureWarning = message; emit(true);
      }); }
      catch (error) { state.captureWarning = error instanceof Error ? error.message : "연속 화면 기록을 시작하지 못했습니다."; }
    }
    onReady?.();
    const cards = new Map(seed.map((card) => [card.id, card])),
      evidence = new Map<string, ScannedCard[]>(
        seed.map((card) => [card.id, [card]]),
      );
    const captures = new CaptureObservations();
    const countObservations = new CountObservations();
    let previousVectors: Uint8Array[] = [];
    const captureSession = crypto.randomUUID();
    let metadata:
        | Promise<
            Awaited<ReturnType<NonNullable<typeof recognizer>["metadata"]>>
          >
        | undefined,
      lastMetadataTime = -Infinity;
    let lastMetadataFrame: HTMLVideoElement | HTMLImageElement | HTMLCanvasElement | OffscreenCanvas | undefined;
    type Candidate = {
      needsIdentity?: boolean;
      fieldTarget?: {id:string;order:number};
      knownIdentity?: NonNullable<Awaited<ReturnType<NonNullable<typeof recognizer>['identify']>>>;
      group: number; priorityGroup: number; trace: number; image: HTMLCanvasElement; feature: Uint8Array; time: number; stable: boolean;
      borderAlignment: number; order: number; position: NonNullable<ScannedCard["capturePosition"]>;
      preview: string; previewCanvas?: HTMLCanvasElement; sortReading?: Promise<Awaited<ReturnType<NonNullable<typeof recognizer>["metadata"]>>>;
    };
    const releaseCandidate = (item: Candidate) => { item.image.width = 0; item.image.height = 0; if (item.previewCanvas) item.previewCanvas.width = 0; };
    const queue = new CandidateQueue<Candidate>(1600, item => {
      ledger.finish(item.trace, "superseded", { reason: "같은 관측 묶음의 더 좋은 이미지로 교체", group: item.group });
      releaseCandidate(item);
    });
    const deferred: (Candidate & { feature: Uint8Array })[] = [];
    const fullRetries: (Candidate & { feature: Uint8Array })[] = [];
    releasePending = () => {
      let item: Candidate | undefined;
      while ((item = queue.shift())) { ledger.finish(item.trace, "dropped", { group: item.group, reason: "처리 중지" }); releaseCandidate(item); }
      for (const pending of [...deferred,...fullRetries]) { ledger.finish(pending.trace, "dropped", { group: pending.group, reason: "보조 판독 중지" }); releaseCandidate(pending); }
      deferred.length = 0;fullRetries.length=0;
    };
    const unknownFeatures: Uint8Array[] = [];
    const identifiedFeatures = new Map<string, Uint8Array>();
    let captureOrder = Math.max(
      0,
      ...seed.map((card) => card.captureOrder ?? 0),
    );
    const initialCaptureOrder = captureOrder;
    const liveCadence = new LiveScanCadence();
    const livePriority = new LiveWorkPriority();
    const scrollCoverage = new ScrollCoverage();
    const liveIdentities = new Set<string>();
    const liveInventory = new LiveInventory();
    const confirmedFieldOrder = new Map<string,number>();
    const confirmedNameOrder = new Map<string,number>();
    const latestIdentityOrder = new Map<string,number>();
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
      state.currentRunRead = confirmedReadingCount({cards:state.cards,latest:latestIdentityOrder,confirmed:confirmedFieldOrder});
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
      vector: Uint8Array,
    ) => {
      const existing = unknownFeatures.findIndex(
        (old, i) => (group !== undefined && state.unidentified[i].group === group) || sameCapture(old, vector),
      );
      let changed = false;
      if (existing >= 0) {
        if (!pending && state.unidentified[existing].pending) {
          state.unidentified[existing] = {
            ...state.unidentified[existing],
            pending: false,
          };
          changed = true;
        }
      } else if (
        unknownFeatures.length < 24 &&
        ![...identifiedFeatures.values()].some(
          (old) => sameCapture(old, vector),
        )
      ) {
        unknownFeatures.push(vector);
        state.unidentified.push({
          image: preview ?? image.toDataURL("image/webp", 0.9),
          time,
          pending,
          group,
        });
        changed = true;
      }
      if (changed) emit(true);
    };
    let inputFrame: HTMLVideoElement | HTMLImageElement | HTMLCanvasElement | OffscreenCanvas = video;
    let frameTime = 0;
    const recordingStart = continuous?.startedAt ?? performance.now();
    const directOriginals = !!continuous && !debug.record && !debug.snapshots;
    if (continuous && !debug.snapshots && !directOriginals) originals = createCaptureOriginals({ rowMode, captureOnly }, signal);
    if (debug.record || originals || directOriginals) {
      try { encoder = createDebugEncoder(value => { debug.record?.(value); originals?.add(value); emit(); }, message => {
        recordingFailure = message; state.captureWarning = message; emit(true);
      }); }
      catch { recordingFailure = "원본 캡처 Worker를 시작하지 못했습니다. 연속 영상 판독은 계속됩니다.";
        state.captureWarning = recordingFailure; }
    }
    const collect = async (acquire = true, deliveredTime?: number, nativeFrame?: VideoFrame) => {
      if(acquire&&checkingCompletion)return;
      if (signal.aborted || (!nativeFrame && !recovering && !stillImages && !debug.replay && video.readyState < 2)) return;
      if (!acquire) {
        if (!encoder?.active || debug.recording?.() === false || originals?.active === false) return;
        const elapsed = performance.now() - recordingStart;
        // Freeze the video frame directly. Full-screen pixel readback and raw
        // storage belong to the Worker, independently of source playback.
        encoder.submit(video, elapsed / 1000, elapsed);
        return;
      }
      if (!debug.replay && !recovering && inputFrame === video) frameTime = deliveredTime ?? video.currentTime;
      const width = nativeFrame?.displayWidth ?? ("videoWidth" in inputFrame ? inputFrame.videoWidth : "naturalWidth" in inputFrame ? inputFrame.naturalWidth : inputFrame.width);
      const height = nativeFrame?.displayHeight ?? ("videoHeight" in inputFrame ? inputFrame.videoHeight : "naturalHeight" in inputFrame ? inputFrame.naturalHeight : inputFrame.height);
      if (!width || !height) return;
      const nativeAcquisition=!!(debug.nativeAcquisition&&acquisition?.supportsNative&&continuous&&!recovering);
      const copyStarted=performance.now();
      if (frame.width !== width || frame.height !== height) { frame.width = width; frame.height = height; }
      if(!nativeAcquisition)frameContext.drawImage(nativeFrame ?? inputFrame, 0, 0);
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
      const remote = acquisition && !recovering ? nativeAcquisition
        ? await acquisition.detectNative(nativeFrame??video,currentFrame)
        : await acquisition.detectAndAcquire(currentFrame) : undefined;
      if(continuous&&!recovering&&remote?.timing) {
        state.livePerformance??={acquisitionMs:0,recognized:0,uniqueCards:0,firstResultMs:null,lagMs:0};
        const old=state.livePerformance.stages,samples=(old?.samples??0)+1;
        const stages={...remote.timing,copyMs,samples};
        for(const key of ['copyMs','freezeMs','roundTripMs','workerMs','detectMs','cropMs','materializeMs'] as const)
          stages[key]=(old?.[key]??0)+(stages[key]-(old?.[key]??0))/samples;
        state.livePerformance.stages=stages;
        const locationKind=remote.layout?'located':'unlocated';
        const groups=state.livePerformance.stagesByLocation??={};
        const previousStage=groups[locationKind],groupSamples=(previousStage?.samples??0)+1;
        const groupStage={...remote.timing,copyMs,samples:groupSamples};
        for(const key of ['copyMs','freezeMs','roundTripMs','workerMs','detectMs','cropMs','materializeMs'] as const)
          groupStage[key]=(previousStage?.[key]??0)+(groupStage[key]-(previousStage?.[key]??0))/groupSamples;
        groups[locationKind]=groupStage;
      }
      const layout = remote ? remote.layout : detector.detect(frame);
      state.sampled++;
      ledger.frame(!!layout);
      state.located = !!layout;
      if (!layout) {
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
        if (state.expected === null) header = undefined;
      }
      let frameMetadata: typeof metadata;
      if (
        !captureOnly && !metadata &&
        ((isStill && lastMetadataFrame !== inputFrame) ||
          state.growthPoints == null ||
          state.sort == null ||
          frameTime - lastMetadataTime >= 2)
      ) {
        metadata = recognizer!.metadata(currentFrame, layout);
        frameMetadata = metadata;
        lastMetadataTime = frameTime;
        lastMetadataFrame = inputFrame;
      }
      if (!captureOnly && !header && state.expected === null)
        header = crop(currentFrame, layout.header);
      if (continuous && !recovering && !captureOnly) {
        finalHeader??=document.createElement('canvas');
        const box=layout.header,w=Math.round(box.width),h=Math.round(box.height);
        if(finalHeader.width!==w)finalHeader.width=w;
        if(finalHeader.height!==h)finalHeader.height=h;
        finalHeader.getContext('2d',{willReadFrequently:true})!.drawImage(currentFrame,box.x,box.y,box.width,box.height,0,0,w,h);
        lastLocatedTime=frameTime;
      }
      if (queue.length >= 1600) {
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
        state.scrollPosition=scrollGeometry?.position??null;
        if (state.scrollPosition !== null) {
          state.scrollStartSeen ||= state.scrollPosition <= 0.02;
          state.scrollEndSeen ||= state.scrollPosition >= 0.98;
        }
      } else state.scrollPosition = null;
      const acquired: (ReturnType<typeof acquireCards>[number]&{previewImage?:HTMLCanvasElement})[] = remote?.cells ?? acquireFrame(frame, layout);
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
      for (let i = 0; i < images.length; i++) {
        diagnostics.acquired++;
        const box = alignedCells[i].content;
        const stable = isStill || settledFields(observations[i], i, previous);
        const trace = ledger.acquire({ frame: state.sampled, time: frameTime, slot: i, box, phase: recovering ? "recording" : "input" });
        // The acquisition Worker has already inspected the same uncompressed
        // pixels. Do not read every returned crop back again on the UI thread.
        const quality = acquired[i].quality;
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
        const offered = group.decision;
        if (offered !== "duplicate") {
          collectedThisFrame++;
          if (offered === "better") diagnostics.improved++;
          record(images[i], i, offered === "better" ? "더 좋은 관측으로 갱신" : "판독 후보", true, quality.sharpness);
          state.collectedCrops = (state.collectedCrops ?? 0) + 1;
          const order = continuous ? timedCaptureOrder(initialCaptureOrder, frameTime, i) : ++captureOrder;
          ledger.finish(trace, captureOnly ? "selected" : "queued", { group: group.id });
          if (captureOnly) { coverageSlots[i]=true;images[i].width = 0; continue; }
          const cell=acquired[i];
          const preview = cell.previewImage ?? crop(currentFrame, alignedCells[i].preview);
          cell.previewImage=undefined;
          const enqueued = queue.push({
            group: group.id, trace,
            priorityGroup: continuous && !recovering ? livePriority.group(observations[i],i%10) : -1,
            preview: "", previewCanvas: preview,
            image: images[i],
            feature: observations[i],
            time: frameTime,
            stable,
            borderAlignment: alignedCells[i].alignment,
            order,
            position: { frame: `${captureSession}/${state.sampled}`, slot: i, stable,
              sort: null },
            sortReading: frameMetadata,
          });
          coverageSlots[i]=enqueued;
          if (!enqueued) { ledger.finish(trace, "dropped", { group: group.id, reason: "판독 대기열 용량 초과" }); images[i].width = 0; preview.width = 0; }
        } else { coverageSlots[i]=true;ledger.finish(trace, "duplicate", { group: group.id }); diagnostics.duplicates++; images[i].width = 0; }
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
        const next = await pending;
        const changed =
          state.sort &&
          next.sort &&
          (state.sort.kind !== next.sort.kind ||
            state.sort.direction !== next.sort.direction);
        if (changed) {
          previousVectors = [];
          previous = [];
          scrollCoverage.reset();state.scrollGaps=[];
        }
        if (next.growthPoints) state.growthPoints = next.growthPoints;
        if (next.sort) state.sort = next.sort;
      }
      if (recognizer && header && state.expected === null) {
        const total = await recognizer!.total(
          header,
          {
            x: 0,
            y: 0,
            width: header.width,
            height: header.height,
          },
          isStill,
        );
        if (total) {
          state.expected = total.owned;
          state.capacity = total.capacity;
        } else header = undefined;
      }
    })().finally(() => { metadataRead = undefined; });
    const drainOne = async (includeDeferred = false, reader = recognizer, fast = false, deferredOnly = false, visual = visuals[0], fullOnly = false) => {
      const quick = deferredOnly;
      if (!fast) await settleMetadata();
      else void settleMetadata().catch(error => { captureError=error; capturing=false; });
      const queued = deferredOnly || fullOnly ? undefined : queue.shift(fast ? item=>livePriority.priority(item.priorityGroup) : undefined);
      const retryPriority=continuous&&!recovering ? (item:Candidate)=>
        retryWorkPriority(item,livePriority.retryPriority(item.priorityGroup),confirmedFieldOrder) : undefined;
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
      const finishReading=continuous&&!recovering
        ? ledger.beginRead(item.trace,fast?'visual':quick?'short':'full',(performance.now()-recordingStart)/1000,
          {priorityGroup:item.priorityGroup,priorReads:livePriority.priority(item.priorityGroup),priorOcrAttempts:livePriority.attempts(item.priorityGroup)})
        : undefined;
      if(continuous&&!recovering&&!fast)livePriority.attempted(item.priorityGroup);
      if(continuous&&capturing&&!recovering&&(quick||fullOnly)&&
          (video.srcObject as MediaStream|null)?.getVideoTracks().some(track=>track.readyState==='live')){
        state.liveOcrStarted??={short:0,full:0};
        state.liveOcrStarted[fullOnly?'full':'short']++;
      }
      if (item.previewCanvas) {
        // Preview-only JPEG is much cheaper to encode than WebP. Recognition
        // always uses the untouched crop, never this compressed thumbnail.
        item.preview = item.previewCanvas.toDataURL("image/jpeg", .92);
        item.previewCanvas.width = 0;
        item.previewCanvas = undefined;
      }
      let retained = false;
      let visualResult: VisualResult | undefined;
      let acceptedIdentity: Candidate['knownIdentity'];
      const reject = () => { ledger.finish(item.trace, "unidentified", { group: item.group, reason: "이름 판독 실패", nameAttempts: reader?.nameDiagnostics(item.image) }); reportUnknown(item.image, item.time, false, item.preview, item.group, item.feature); };
      const defer = async (unknown = true, fieldId?:string) => {
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
        const previous = target.findIndex(
          (old) => old.group === item.group || sameCapture(old.feature, feature),
        );
        if (previous >= 0) {
          if (target[previous].stable && !item.stable) return false;
          const old = target[previous];
          ledger.finish(old.trace, "superseded", { group: old.group, reason: "재시도 이미지 개선" });
          old.image.width = 0;
          old.image.height = 0;
          target[previous] = { ...item, feature, needsIdentity: unknown, fieldTarget, knownIdentity };
          retained = true;
        } else if (target.length < 512) {
          target.push({ ...item, feature, needsIdentity: unknown, fieldTarget, knownIdentity });
          retained = true;
        } else if (item.stable) {
          const replace = target.findIndex((old) => !old.stable);
          if (replace >= 0) {
            const old = target[replace];
            ledger.finish(old.trace, "dropped", { group: old.group, reason: "재시도 보관 용량 초과" });
            reportUnknown(old.image, old.time, false, old.preview, old.group, old.feature);
            old.image.width = 0;
            old.image.height = 0;
            target[replace] = { ...item, feature, needsIdentity: unknown, fieldTarget, knownIdentity };
            retained = true;
          }
        }
        if (retained) {
          ledger.finish(item.trace, "deferred", { group: item.group, reason: unknown ? "이름 보조 판독 대기" : "장수·각성 보조 판독 대기" });
          state.queued = queue.length + deferred.length + fullRetries.length;
          if (unknown) reportUnknown(item.image, item.time, true, item.preview, item.group, item.feature);
        }
        return retained;
      };
      try {
        // Full retries use the best retained crop and an independent reader;
        // they can run during sharing without serializing source acquisition.
        if (item.sortReading) {
          const assignSort = (meta: Awaited<NonNullable<typeof item.sortReading>>) => {
            item.position.sort = meta.sort ? { ...meta.sort } : null;
          };
          if (fast) void item.sortReading.then(assignSort).catch(error => { captureError=error; capturing=false; });
          else assignSort(await item.sortReading);
        }
        if (fast && visual) visualResult=await visual.read(item.image);
        const retainedIdentity=fieldRetryIdentity(item);
        if(retainedIdentity){state.retryWork??={skippedFields:0,reusedIdentities:0};state.retryWork.reusedIdentities++;}
        const identity = retainedIdentity ?? (fast ? (visualResult ? visualResult.identity : reader!.identifyVisual(item.image)) : await reader!.identify(
          item.image,
          !quick && (isStill || !queued || deferred.length >= 512),
          item.stable,
          item.borderAlignment >= .8,
        ));
        if (!identity) {
          const inspected = visualResult?.fields ?? await reader!.inspect(item.image);
          const visibleCard =
            inspected?.awakening != null ||
            (item.stable && (inspected?.labelPixels ?? 0) >= 35);
          if (await defer()) return;
          ledger.finish(item.trace, "unidentified", { group: item.group, reason: "이름 판독 실패", nameAttempts: reader!.nameDiagnostics(item.image) });
          if (!queued || visibleCard)
            reportUnknown(item.image, item.time, false, item.preview, item.group, item.feature);
          return;
        }
        if ((queued || quick) && identity.review.includes("이름 확인")) {
          // A stable frame can still have a damaged name. It must receive the
          // same full retry as an uncertain scrolling frame before completion.
          if (await defer()) return;
          if (!item.stable && identity.confidence < .9) { reject(); return; }
        }
        acceptedIdentity=identity;
        latestIdentityOrder.set(identity.id,Math.max(item.order,latestIdentityOrder.get(identity.id)??-Infinity));
        // A failed visual attempt must not make a still-unknown portrait wait
        // behind known cards. Count service only after an identity is accepted,
        // including identities recovered by the independent OCR reader.
        if (continuous && !recovering) livePriority.serviced(item.priorityGroup);
        ledger.finish(item.trace, "identified", { group: item.group, cardId: identity.id, name: identity.name });
        let values = visualResult?.values ?? await reader!.read(item.image, identity.id, false, !fast);
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
        if (!fast && reliability === "unconfirmed" && values.awakening !== null &&
            values.countDiagnostics?.pattern?.value != null && !identity.review.length) {
          values = await reader!.read(item.image, identity.id, true);
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
        const recognizedLive=continuous && capturing && !recovering &&
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
        identifiedFeatures.set(identity.id, identified);
        const previousUnknowns = unknownFeatures.length;
        for (let i = unknownFeatures.length - 1; i >= 0; i--)
          if (state.unidentified[i].group === item.group || sameCapture(unknownFeatures[i], identified)) {
            unknownFeatures.splice(i, 1);
            state.unidentified.splice(i, 1);
          }
        const review = [...identity.review];
        if (values.countDiagnostics) values.countDiagnostics.reliability = reliability;
        if (values.awakening === null) review.push("각성 확인");
        if (values.extraCopies === null) review.push("추가 장수 확인");
        const observations = evidence.get(identity.id) ?? [];
        observations.push({
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
        });
        evidence.set(identity.id, observations);
        if(!identity.review.includes('이름 확인'))
          confirmedNameOrder.set(identity.id,Math.max(item.order,confirmedNameOrder.get(identity.id)??-Infinity));
        if(recognizedLive)liveInventory.record(observations.at(-1)!);
        if(!review.length&&values.awakening!==null&&values.extraCopies!==null&&reliability!=="unconfirmed") {
          confirmedFieldOrder.set(identity.id,Math.max(item.order,confirmedFieldOrder.get(identity.id)??-Infinity));
          pruneFieldRetries(deferred,confirmedFieldOrder,discardObsoleteRetry);
          pruneFieldRetries(fullRetries,confirmedFieldOrder,discardObsoleteRetry);
          state.queued=queue.length+deferred.length+fullRetries.length;
        }
        cards.set(identity.id, consensus(observations));
        state.currentRunNames=confirmedCaptureCount({cards:[...cards.values()],latest:latestIdentityOrder,confirmedNames:confirmedNameOrder});
        cardsDirty = true;
        state.resultPresentation ??= { observations: 0, updates: 0, milliseconds: 0 };
        state.resultPresentation.observations++;
        state.status = recovering ? "연속 기록 정밀 판독 중" :
          state.queued > 0
            ? `카드 스캔 중 · ${state.queued}개 판독 대기`
            : "카드 스캔 중";
        emit(unknownFeatures.length !== previousUnknowns);
        if ((fast || quick) && (reliability === "unconfirmed" || values.awakening === null)) await defer(false,identity.id);
      } catch (error) {
        ledger.finish(item.trace, "dropped", { group: item.group, reason: "판독 처리 오류" });
        throw error;
      } finally {
        finishReading?.((performance.now()-recordingStart)/1000);
        // Release the cropped backing store after the Worker and thumbnail read.
        if (!retained) {
          item.image.width = 0;
          item.image.height = 0;
        }
      }
    };
    if (debug.replay || stillImages || source === "video") {
      const inputs = debug.replay ? debug.replayInputs ?? replayDebugFrames(debug.replay, signal) : stillImages ? imageInputs(stillImages, signal) : decodedFrames(video.currentSrc || video.src, signal);
      for await (const input of inputs) {
        inputFrame = input.element;
        if ("time" in input) frameTime = input.time;
        if (debug.replay && "image" in input && input.image) debug.preview?.(input.image);
        state.percent = input.percent;
        await collect();
        while (queue.length) await drainOne();
        emit();
      }
    } else {
      // Recording and original snapshots continue alongside bounded live
      // acquisition. OCR consumes crops independently while the share is live.
      let lastSnapshotTime = -Infinity;
      const stopped = () => {
        state.sharingEndedAt??=(performance.now()-recordingStart)/1000;
        capturing = false;
        if(continuous&&recognizer)state.shareEndInventory=liveInventory.finish(recognizer.catalog);
        void continuous?.finish();
      };
      const failed = (error: unknown) => { captureError = error; stopped(); };
      const autoCompletion=new AutoCompletionHold();
      let lastCompletionCheck=-Infinity;
      const captureCompletion=()=>({expected:state.expected,finalExpected:state.expected,
        cards:confirmSortedNames([...cards.values()],[...evidence.values()].flat(),recognizer!.catalog),
        latest:latestIdentityOrder,confirmedNames:confirmedNameOrder,
        inputSettled:!liveCollection,headerAvailable:!!finalHeader?.width&&Number.isFinite(lastLocatedTime)});
      const tryAutoStop=async()=>{
        if(!continuous||!recognizer||!capturing||signal.aborted||captureError||state.autoStopped)return;
        if(liveCollection)return;
        if(metadata||metadataRead) {
          checkingCompletion=true;
          try {await settleMetadata();} finally {checkingCompletion=false;}
          return;
        }
        const now=performance.now();
        if(now-lastCompletionCheck<100)return;
        lastCompletionCheck=now;
        if(state.expected!==latestIdentityOrder.size){autoCompletion.reset();return;}
        const input=captureCompletion();
        if(!autoCompletion.observe(input,now)||!finalHeader)return;
        // Reserve the idle OCR session and freeze the header during this final
        // check. Source backup continues until tracks are actually stopped.
        checkingCompletion=true;
        try {
          const total=await recognizer.total(finalHeader,{x:0,y:0,width:finalHeader.width,height:finalHeader.height});
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
      const acquireLiveFrame = (time: number, nativeFrame?: VideoFrame) => {
        const started = performance.now();
        if (!capturing || checkingCompletion || liveCollection || !liveCadence.take(started)) return liveCollection;
        liveCollection = collect(true, time, nativeFrame).then(() => {
          liveCadence.complete(started, performance.now());
          state.livePerformance ??= { acquisitionMs: 0, recognized: 0, uniqueCards: 0, firstResultMs: null, lagMs: 0 };
          state.livePerformance.acquisitionMs = liveCadence.acquisitionMs;
          emit();
        }).catch(failed).finally(() => { liveCollection = undefined; });
        return liveCollection;
      };
      // Experimental opt-in until real-input accuracy and speed are verified.
      const trackInput = debug.trackFrames && continuous ? tryStartTrackFrames(video, signal, async stamp => {
        if (stamp.missedFrames !== undefined)
          state.liveMissedFrames = (state.liveMissedFrames ?? 0) + stamp.missedFrames;
        await acquireLiveFrame(Math.max(0, (stamp.capturedAt - recordingStart) / 1000), stamp.frame);
        if (captureError) throw captureError;
      }, stopped, failed) : undefined;
      state.liveInput = trackInput ? 'track' : 'video';
      const videoInput = startLiveFrames(
        video,
        signal,
        stamp => {
          const time = stamp?.mediaTime ?? video.currentTime;
          recordSnapshot(time);
          if (trackInput) return;
          state.liveMissedFrames = (state.liveMissedFrames ?? 0) + (stamp?.missedFrames ?? 0);
          // The encoder records every delivered source frame independently.
          // A four-row page can pass within one second during fast scrolling.
          // Keep four frozen originals/s without main-thread raster readback.
          if (continuous) {
            const started = performance.now();
            void acquireLiveFrame((started - recordingStart) / 1000);
          } else if (!liveCollection) {
            liveCollection = collect(true, time).catch(error => { captureError = error; capturing = false; })
              .finally(() => { liveCollection = undefined; });
          }
        },
        () => { if (!trackInput) stopped(); },
        failed,
        33,
      );
      stopInput = () => { videoInput(); trackInput?.(); };
      state.status = "화면 공유 실시간 수집·판독 중";
      emit();
      const consumers = [recognizer, ...extraRecognizers].map(async (reader, index) => {
        let lastYield=performance.now();
        const ocrSchedule=new LiveOcrSchedule();
        try {
          while (capturing || liveCollection || queue.length || deferred.length || fullRetries.length) {
            signal.throwIfAborted();
            if (captureError) throw captureError;
            if(checkingCompletion){await waitForInput(signal);continue;}
            if(index===0)await tryAutoStop();
            // Finish the fast lane even after sharing ends; queued crops do not
            // suddenly become expensive OCR jobs at the source boundary.
            // A separate session handles uncertain crops concurrently.
            const fast = index < lanePlan.fast && queue.length > 0;
            // Fast readers also own live metadata work. Their OCR sessions
            // must not overlap metadata while acquisition is still running.
            const retry = !fast && (index >= lanePlan.fast || (!capturing && !liveCollection))
              ? liveOcrLane(deferred.length,fullRetries.length,index-lanePlan.fast,lanePlan.readers-lanePlan.fast,
                capturing||!!liveCollection,ocrSchedule) : undefined;
            if (fast || retry) {
              await drainOne(!fast, reader, fast, retry==='short', visuals[index], retry==='full');
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
      await settleMetadata();
      while(metadata || metadataRead)await settleMetadata();
      const finalCards=recognizer ? confirmSortedNames([...cards.values()], [...evidence.values()].flat(), recognizer.catalog) : [];
      const completionInput={expected:state.expected,finalExpected:state.expected,cards:finalCards,
        latest:latestIdentityOrder,confirmed:confirmedFieldOrder,pending:queue.length+deferred.length+fullRetries.length,
        unresolved:Math.max(state.unidentified.length,ledger.snapshot().unresolvedGroups),dropped:state.droppedFrames,
        inputSettled:!capturing&&!liveCollection,tailFresh:state.located&&state.sharingEndedAt!==undefined&&
          lastLocatedTime>=state.sharingEndedAt-1&&lastLocatedTime<=state.sharingEndedAt};
      // Check the final acquired header again, after OCR sessions are idle.
      // This prevents an initial total or a restored list from certifying completion.
      if(state.autoStopped&&canSkipRecovery(completionInput))state.recoverySkipped=true;
      else if(recognizer&&finalHeader&&canSkipRecovery(completionInput)) {
        try {
          const total=await recognizer.total(finalHeader,{x:0,y:0,width:finalHeader.width,height:finalHeader.height});
          signal.throwIfAborted();
          state.recoverySkipped=canSkipRecovery({...completionInput,finalExpected:total?.owned??null});
        } catch {
          signal.throwIfAborted();
          // A failed optional completion check must retain the recovery path.
          state.recoverySkipped=false;
        }
      }
      const recording = await continuous?.finish();
      const snapshots = directOriginals && encoder ? () => encoder!.frames(signal) : debug.snapshots ?? originals?.frames;
      if(state.recoverySkipped) {
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
        // Reuse the same identity/evidence map, but reacquire every recorded
        // interval. A live timer cannot recover frames blocked by card cropping.
        recovering = true;
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
        const recovery = recording
          ? encoder && snapshots
            ? mergeFrames(recordedFrames(recording, signal), snapshotsSafely(), signal)
            : recordedFrames(recording, signal)
          : snapshotsSafely();
        for await (const input of recovery) {
          inputFrame = input.element; frameTime = input.time;
          state.percent = input.percent;
          await collect();
          // Reuse independent live readers for recovery. All candidates still
          // receive the same evidence checks; uncertain visual reads fall back
          // to OCR. false retains the serial path for controlled comparisons.
          if (debug.parallelRecovery !== false && recognizer && visuals.length) {
            await runJoinedWorkers([recognizer, ...extraRecognizers].map((reader, index) => async stopped => {
              const fast = index < lanePlan.fast;
              while (!stopped() && (fast ? queue.length : deferred.length)) {
                signal.throwIfAborted();
                await drainOne(!fast, reader, fast, !fast, visuals[index]);
              }
            }));
          } else while (queue.length) await drainOne();
          state.recoveryFrames++;
          state.status = `연속 기록 보완 중 · ${state.recoveryFrames}프레임 검사`;
          emit();
        }
      }
    }
    if (debug.parallelRecovery !== false && recovering && recognizer) {
      await runJoinedWorkers([recognizer, ...extraRecognizers].map(reader => async stopped => {
        while (!stopped() && (deferred.length || fullRetries.length)) {
          signal.throwIfAborted();
          await drainOne(true, reader);
        }
      }));
    } else while (deferred.length || fullRetries.length) await drainOne(true);
    if (metadata) await drainOne();
    if (captureError) throw captureError;
    refreshCards();
    if (recognizer) state.cards = confirmSortedNames([...cards.values()], [...evidence.values()].flat(), recognizer.catalog).sort((a,b) => cardCollator.compare(a.name,b.name));
    if(continuous)state.identifiedAfterSharing=state.cards.filter(card=>identifiedThisRun.has(card.id)&&!liveIdentities.has(card.id)).map(({id,name})=>({id,name}));
    state.percent = 100;
    state.status = captureOnly ? "카드 획득·품질 검사 완료 · OCR 실행 안 함"
      : scanCompletion(state.expected, state.cards.length, state.cards.filter(card => card.review.length).length);
    emit(true);
  } finally {
    stopInput?.();
    if(finalHeader)finalHeader.width=0;
    acquisition?.dispose();
    for(const visual of visuals) visual?.dispose();
    await liveCollection;
    releasePending?.();
    auditComplete = true;
    const finalRecording = await continuous?.finish();
    if (finalRecording) debug.continuous?.(finalRecording);
    const finalStatus = state.status;
    // Internal backups have no consumers left, including when recovery failed
    // before its raw iterator started. Never launch an unused PNG export here.
    if(encoder&&!debug.record)await encoder.discard();
    else if(encoder) {
      if(!signal.aborted) { state.status = `카드 판독 종료 · ${encoder.captured}개 캡처 원본 준비 중`; emit(true); }
      await encoder.finish();
    }
    if (originals) {
      try { await originals.dispose(); }
      catch { state.captureWarning = "임시 원본 캡처 정리에 실패했습니다."; }
    }
    state.status = finalStatus;
    if (recordingFailure) debug.recordingError?.(recordingFailure);
    emit(true);
    detector.dispose();
    if (recognizer) await recognizer.dispose();
    await Promise.all(extraRecognizers.map(reader => reader.dispose()));
  }
}
