import {InputLossEvidence,acceptInputLossEvent,parseInputLossContract,parseInputLossFact} from '../src/features/card-scanner/session/input-loss-evidence';
import {ScanGrid} from '../src/features/card-scanner/session/scan-grid';
import {
  applyScanGridCommand, hashScanGridReplay, parseScanGridCommand, scanGridReplaySnapshot,
} from '../src/features/card-scanner/session/scan-grid-command';
import type {ScanGridCommand} from '../src/features/card-scanner/session/scan-grid-command';
import {parseObservationFact} from '../src/features/card-scanner/session/observation-execution';
import type {ObservationFact} from '../src/features/card-scanner/session/observation-execution';
import {ObservationExecutionReplay} from '../src/features/card-scanner/reproduction/observation-execution-replay';
import {
  inventoryEventData, parseInventoryEvent, parseInventoryPreviewConfirmation, parseInventorySeed,
} from '../src/features/card-scanner/session/inventory-evidence';
import type {SerializedInventoryEvent} from '../src/features/card-scanner/session/inventory-evidence';
import {InventoryEvidenceReplay, parseInventoryCheckpoint} from '../src/features/card-scanner/reproduction/inventory-evidence-replay';
import type {InventoryCheckpoint} from '../src/features/card-scanner/reproduction/inventory-evidence-replay';
import {parseLiveInputAdmissionFact} from '../src/features/card-scanner/capture/live-input-admission';
import {parseInputArrival,parseInputBackupReservation,parseBackupCapacityDeferral} from '../src/features/card-scanner/capture/input-arrival';
import {parseAcquisitionCapture,parseRecognitionCapture} from '../src/features/card-scanner/capture/capture-provenance';
import {parseScrollCaptureFact,parseInventoryHeaderFact} from '../src/features/card-scanner/session/scroll-capture-diagnostic';
import {parseMediaLineageFact,parseMediaInputLink} from '../src/features/card-scanner/capture/media-lineage';
import {parseMediaPlaybackFact} from './media-playback-observer';
import {parseLiveCaptureDecision} from '../src/features/card-scanner/capture/live-capture-pipeline';
import {InputDecisionReplay,parseInputCheckpoint,parseInputFrameLink,parseInputRecoveryFact} from '../src/features/card-scanner/reproduction/live-input-decision-replay';
import {InputAcquisitionEvidence,acceptInputAcquisitionEvent,parseInputAcquisitionContract,parseInputAcquisitionSkip} from '../src/features/card-scanner/acquisition/input-acquisition-evidence';
import {yieldForCapture} from '../src/features/card-scanner/capture/input-source';
import {parseUnknownCheckpoint,parseUnknownFact} from '../src/features/card-scanner/session/unknown-lifecycle';
import {UnknownLifecycleReplay,parseRecordedUnknownSeed} from '../src/features/card-scanner/reproduction/unknown-lifecycle-replay';
import {parseUnknownRecoveryClaim} from '../src/features/card-scanner/reproduction/unknown-recovery-claim-replay';
import {parseMeasuredSourceRasterReceipt} from '../src/features/card-scanner/acquisition/source-raster-receipt';
import {parseFreshnessSeed,parseFreshnessFact,parseFreshnessCheckpoint} from '../src/features/card-scanner/session/freshness-evidence';
import {FreshnessEvidenceReplay} from '../src/features/card-scanner/reproduction/freshness-evidence-replay';
import {RunStateCompression} from './run-state-compression';
import {ObstructionEvidenceReplay,parseObstructionSeed,parseObstructionEvent,parseObstructionCheckpoint} from '../src/features/card-scanner/reproduction/obstruction-evidence-replay';
import {boundedDrainInputLoss} from '../src/features/card-scanner/session/completion-drain-loss';
import {parseScannerInputProvenance} from '../src/features/card-scanner/capture/scanner-input-frame';
import {parseScrollCoverageDiagnostic} from '../src/features/card-scanner/session/scroll-coverage-diagnostic';

/** Reports exactly what the optional diagnostic summary says. The state trace
 * does not record the drain-loss debt, its clearance or the stop decision.
 * Missing legacy data is unknown, never a claim that no input was lost. */
export function drainReplayScope(requested:unknown,summary:unknown) {
  const source=summary&&typeof summary==='object'&&!Array.isArray(summary)?summary:undefined;
  const property=source?Object.getOwnPropertyDescriptor(source,'drainInputLoss'):undefined;
  const loss=property&&'value' in property?boundedDrainInputLoss(property.value):undefined;
  return {requested:typeof requested==='boolean'?requested:null,
    supported:false as const,matchesCapturedState:null,
    autoStopSupported:false as const,scope:'diagnostic-summary-only' as const,
    lossStatus:!property?'not-recorded' as const:loss?'reported' as const:'invalid' as const,
    reportedLoss:loss?true as const:null,reason:loss?.reason??null};
}

/** Encoded payload bounds, not a claim about the JavaScript heap's size. */
export const MAX_RUN_STATE_TRACE_BYTES = 8 * 1024 * 1024;
export const MAX_RUN_STATE_TRACE_RAW_BYTES = 128 * 1024 * 1024;
export const MAX_RUN_STATE_TRACE_PENDING_BYTES = 2 * 1024 * 1024;
export const MAX_RUN_STATE_TRACE_EVENTS = 250_000;
export const MAX_RUN_STATE_TRACE_BLOB_BYTES = 12 * 1024 * 1024;
// A difficult recorded run reached 101k events and about 60 MiB of source JSON.
// Archive capacity covers that scale; staging remains bounded independently.
// The recorded 48k-event run produced 381 native gzip streams at 32 KiB;
// 128 KiB batches reduced that to 91. A 2 MiB staging cap also accommodates
// short recognition bursts without making capture wait for the compressor.
const MAX_CHUNKS = 2048, BATCH_BYTES = 128 * 1024;
const encoder = new TextEncoder();

/** Optional diagnostic bridge from trace time to the page clock. It does not
 * authorize a capture, card identity, completion, or a reducer transition. */
export interface ScannerClockFact {
  readonly version:1;
  readonly clock:'page-performance-now';
  readonly phase:'input-and-recognition';
  readonly originMs:number;
}
export type RunStateTraceEvent = {readonly seq:number;readonly time:number} & (
  | {readonly type:'recording-availability';readonly value:{readonly status:'active'|'disabled'|'failed';readonly liveScreen:boolean}}
  | {readonly type:'scanner-clock';readonly value:ScannerClockFact}
  | {readonly type:'scroll-coverage';readonly value:ReturnType<typeof parseScrollCoverageDiagnostic>}
  | {readonly type:'replay-source-use';readonly value:ReturnType<typeof parseReplaySourceUse>}
  | {readonly type:'grid-command';readonly value:ScanGridCommand}
  | {readonly type:'observation-fact';readonly value:ObservationFact}
  | {readonly type:'inventory-seed';readonly value:ReturnType<typeof parseInventorySeed>}
  | {readonly type:'inventory-event';readonly value:SerializedInventoryEvent}
  | {readonly type:'inventory-preview-confirmation';readonly value:ReturnType<typeof parseInventoryPreviewConfirmation>}
  | {readonly type:'inventory-checkpoint';readonly value:InventoryCheckpoint}
  | {readonly type:'input-admission';readonly value:ReturnType<typeof parseLiveInputAdmissionFact>}
  | {readonly type:'input-arrival';readonly value:ReturnType<typeof parseInputArrival>}
  | {readonly type:'input-backup-reservation';readonly value:ReturnType<typeof parseInputBackupReservation>}
  | {readonly type:'backup-capacity-deferral';readonly value:ReturnType<typeof parseBackupCapacityDeferral>}
  | {readonly type:'acquisition-capture';readonly value:ReturnType<typeof parseAcquisitionCapture>}
  | {readonly type:'recognition-capture';readonly value:ReturnType<typeof parseRecognitionCapture>}
  | {readonly type:'scroll-capture';readonly value:ReturnType<typeof parseScrollCaptureFact>}
  | {readonly type:'inventory-header-read';readonly value:ReturnType<typeof parseInventoryHeaderFact>}
  | {readonly type:'media-lineage';readonly value:ReturnType<typeof parseMediaLineageFact>}
  | {readonly type:'media-input-link';readonly value:ReturnType<typeof parseMediaInputLink>}
  | {readonly type:'source-playback';readonly value:ReturnType<typeof parseMediaPlaybackFact>}
  | {readonly type:'input-decision';readonly value:ReturnType<typeof parseLiveCaptureDecision>}
  | {readonly type:'input-recovery';readonly value:ReturnType<typeof parseInputRecoveryFact>}
  | {readonly type:'input-link';readonly value:ReturnType<typeof parseInputFrameLink>}
  | {readonly type:'input-loss-contract';readonly value:ReturnType<typeof parseInputLossContract>}
  | {readonly type:'input-loss';readonly value:ReturnType<typeof parseInputLossFact>}
  | {readonly type:'input-acquisition-contract';readonly value:ReturnType<typeof parseInputAcquisitionContract>}
  | {readonly type:'input-acquisition-skip';readonly value:ReturnType<typeof parseInputAcquisitionSkip>}
  | {readonly type:'input-checkpoint';readonly value:ReturnType<typeof parseInputCheckpoint>}
  | {readonly type:'unknown-seed';readonly value:ReturnType<typeof parseRecordedUnknownSeed>}
  | {readonly type:'unknown-event';readonly value:ReturnType<typeof parseUnknownFact>}
  | {readonly type:'unknown-recovery-claim';readonly value:ReturnType<typeof parseUnknownRecoveryClaim>}
  | {readonly type:'source-binding-metadata';readonly value:ReturnType<typeof parseSourceBindingMetadata>}
  | {readonly type:'source-binding-metadata-summary';readonly value:ReturnType<typeof parseSourceBindingMetadataSummary>}
  | {readonly type:'unknown-checkpoint';readonly value:ReturnType<typeof parseUnknownCheckpoint>}
  | {readonly type:'obstruction-seed';readonly value:ReturnType<typeof parseObstructionSeed>}
  | {readonly type:'obstruction-event';readonly value:ReturnType<typeof parseObstructionEvent>}
  | {readonly type:'obstruction-checkpoint';readonly value:ReturnType<typeof parseObstructionCheckpoint>}
  | {readonly type:'freshness-seed';readonly value:ReturnType<typeof parseFreshnessSeed>}
  | {readonly type:'freshness-event';readonly value:ReturnType<typeof parseFreshnessFact>}
  | {readonly type:'freshness-checkpoint';readonly value:ReturnType<typeof parseFreshnessCheckpoint>}
);
export interface RunStateTraceSnapshot {
  readonly version:1|2;
  /** All selected state events were retained; not a card accuracy assertion. */
  readonly complete:boolean;
  readonly dropped:number;
  readonly events:readonly RunStateTraceEvent[];
}

/** Join only a parsed, complete trace from one report. This compares recorded
 * metadata, not the physical worker raster, model input, or independent reads.
 * Missing provenance, mixed sessions, and partial traces always stay unknown. */
export function summarizeReplaySourceUses(trace:RunStateTraceSnapshot,runId:string) {
  const unknown=(reason:string)=>({status:'unknown' as const,reason,scope:'report-local-source-metadata' as const,
    readerPixelsVerified:false as const,originalCaptureComplete:null,matchedFrames:0});
  if(!trace.complete||trace.dropped!==0)return unknown('partial-trace');
  if(!/^[a-f0-9-]{36}$/.test(runId))return unknown('invalid-run');
  const uses=trace.events.filter(event=>event.type==='replay-source-use');
  const captures=trace.events.filter(event=>event.type==='acquisition-capture');
  if(!uses.length||!captures.length)return unknown('missing-events');
  if(uses.some(event=>event.value.runId!==runId))return unknown('different-run');
  const sessions=new Set(captures.map(event=>event.value.sessionId));
  if(sessions.size!==1)return unknown('mixed-sessions');
  const frames=new Map<number,(typeof uses)[number]>();
  // Archive source IDs identify pixel sources within this recording. Do not
  // conflate them with acquisition canonicalSourceFrameId: that ID belongs to
  // the current producer, and is not necessarily in the archive ID domain.
  const sourceHashes=new Map<number,string>();
  for(const event of uses){
    if(frames.has(event.value.processingFrame))return unknown('duplicate-frame');
    if(event.value.sourceFrameId===null)return unknown('source-frame-unavailable');
    const prior=sourceHashes.get(event.value.sourceFrameId);
    if(prior!==undefined&&prior!==event.value.pixelHash)return unknown('source-pixel-hash-conflict');
    sourceHashes.set(event.value.sourceFrameId,event.value.pixelHash);
    frames.set(event.value.processingFrame,event);
  }
  const matched=new Set<number>();
  for(const event of captures){
    const source=frames.get(event.value.processingFrame);
    if(!source||source.seq>=event.seq||source.value.acquisitionFrameId!==event.value.acquisitionFrameId||
      source.value.captureTime!==event.value.captureTime||source.value.phase!==event.value.phase)
      return unknown('capture-source-unmatched');
    matched.add(event.value.processingFrame);
  }
  // An input without acquisition captures is not automatically a missing
  // frame: the scanner may have failed to locate the growth window. Only
  // classify it when exactly one later scroll diagnostic has matching source
  // metadata in the same session. not-located is a detector outcome, not
  // proof that no game cards were visible in the original frame.
  const unmatched=[...frames.values()].filter(event=>!matched.has(event.value.processingFrame));
  const unmatchedFrames=new Set(unmatched.map(event=>event.value.processingFrame));
  const scrolls=new Map<number,Extract<RunStateTraceEvent,{type:'scroll-capture'}>[]>();
  for(const event of trace.events)if(event.type==='scroll-capture'&&unmatchedFrames.has(event.value.source.processingFrame)){
    const frame=event.value.source.processingFrame,group=scrolls.get(frame)??[];
    group.push(event);scrolls.set(frame,group);
  }
  let notLocated=0,other=0,reason:string|undefined;
  for(const use of unmatched){
    const candidates=scrolls.get(use.value.processingFrame)??[];
    if(candidates.length!==1){reason=candidates.length?'duplicate-scroll-capture':'missing-scroll-capture';break;}
    const scroll=candidates[0],source=scroll.value.source;
    if(scroll.seq<=use.seq||source.sessionId!==[...sessions][0]||
      source.acquisitionFrameId!==use.value.acquisitionFrameId||source.captureTime!==use.value.captureTime||
      source.phase!==use.value.phase){reason='scroll-source-unmatched';break;}
    if(scroll.value.state==='not-located')notLocated++;else other++;
  }
  const unmatchedDetail=reason?{status:'unknown' as const,reason,notLocatedFrames:null,otherStateFrames:null}:
    {status:'matched' as const,notLocatedFrames:notLocated,otherStateFrames:other};
  return {status:'matched-metadata' as const,scope:'report-local-source-metadata' as const,
    readerPixelsVerified:false as const,originalCaptureComplete:null,matchedFrames:matched.size,
    inferredPhaseFrames:[...matched].filter(frame=>frames.get(frame)!.value.phaseInferred).length,
    unmatchedSourceFrames:frames.size-matched.size,unmatchedSourceDetail:unmatchedDetail,
    notLocatedProvesNoCards:false as const,
    canonicalSourceLink:'unverified-separate-id-domain' as const,
    sessionId:[...sessions][0],runId};
}
interface CompressedChunk {readonly bytes:number;readonly events:number;readonly data:string;}
interface CompressedTrace {
  readonly version:2;readonly codec:'gzip';readonly complete:boolean;readonly dropped:number;
  /** Prefix totals are independent of the chunks, so losing a trailing no-op
   * command cannot masquerade as a complete recording with the same grid hash. */
  readonly events:number;readonly chunkCount:number;readonly lastSeq:number;
  readonly chunks:readonly CompressedChunk[];
}
type TraceInput = CompressedTrace | RunStateTraceSnapshot;

function object(value:unknown,keys:readonly string[],ownData=false):Record<string,unknown> {
  if(!value||typeof value!=='object'||Array.isArray(value)||
    ![Object.prototype,null].includes(Object.getPrototypeOf(value)))throw Error('잘못된 상태 기록 객체');
  const result=value as Record<string,unknown>;
  if(ownData){
    const fields=Reflect.ownKeys(result),detached:Record<string,unknown>=Object.create(null);
    if(fields.length!==keys.length||fields.some(key=>typeof key!=='string'||!keys.includes(key)))
      throw Error('잘못된 상태 기록 필드');
    for(const key of keys){
      const property=Object.getOwnPropertyDescriptor(result,key);
      if(!property||!('value' in property)||!property.enumerable)throw Error('상태 기록은 고유 데이터 필드가 필요합니다.');
      detached[key]=property.value;
    }
    return detached;
  }
  if(Object.keys(result).length!==keys.length||keys.some(key=>!Object.hasOwn(result,key)))
    throw Error('잘못된 상태 기록 필드');
  return result;
}
function positive(value:unknown,maximum:number):value is number {
  return Number.isSafeInteger(value)&&(value as number)>0&&(value as number)<=maximum;
}
// Serialized diagnostic claims only. Parsing does not authenticate the two
// sources, the pixels, the reader, or any completion/recognition decision.
export function parseSourceBindingMetadata(value:unknown) {
  const fact=object(value,['scope','pixelsAuthenticated','originalSource','originalGroup','recoverySource','physical','content','preview',
    'path','originalJoinedAtMatch','recoveryJoinedAtMatch'],true);
  if(fact.scope!=='prepared-source-metadata-only'||fact.pixelsAuthenticated!==false||
    (fact.path!=='cached'&&fact.path!=='reacquired')||typeof fact.originalJoinedAtMatch!=='boolean'||
    typeof fact.recoveryJoinedAtMatch!=='boolean'||!positive(fact.originalGroup,Number.MAX_SAFE_INTEGER))throw Error('잘못된 출처 연결 진단');
  const keys=['sessionId','frameId','observationId','captureOrder','captureTime','phase','slot'];
  const original=parseObservationFact({version:1,kind:'queued',attemptId:0,source:object(fact.originalSource,keys,true)}).source;
  const recovery=parseObservationFact({version:1,kind:'queued',attemptId:0,source:object(fact.recoverySource,keys,true)}).source;
  const physical=object(fact.physical,['sourceFrameId','captureTime','width','height','hash'],true);
  const receipt=parseMeasuredSourceRasterReceipt({version:1,kind:'measured',...physical,acquisitionFrameId:original.frameId});
  if(original.phase!=='input'||recovery.phase!=='recovery'||original.sessionId!==recovery.sessionId||
    original.frameId===recovery.frameId||original.observationId===recovery.observationId||original.slot!==recovery.slot||
    original.captureTime!==recovery.captureTime||original.captureOrder!==recovery.captureOrder||original.captureTime!==receipt.captureTime)
    throw Error('출처 연결 진단 값 불일치');
  const box=(value:unknown)=>{
    const b=object(value,['x','y','width','height'],true);
    if(!['x','y','width','height'].every(k=>typeof b[k]==='number'&&Number.isFinite(b[k]))||
      (b.x as number)<0||(b.y as number)<0||(b.width as number)<=0||(b.height as number)<=0||
      (b.x as number)+(b.width as number)>receipt.width||(b.y as number)+(b.height as number)>receipt.height)
      throw Error('잘못된 출처 연결 크롭');
    return Object.freeze({x:b.x as number,y:b.y as number,width:b.width as number,height:b.height as number});
  };
  return Object.freeze({scope:'prepared-source-metadata-only' as const,pixelsAuthenticated:false as const,
    originalSource:original,originalGroup:fact.originalGroup,recoverySource:recovery,
    physical:Object.freeze({sourceFrameId:receipt.sourceFrameId,captureTime:receipt.captureTime,width:receipt.width,height:receipt.height,hash:receipt.hash}),
    content:box(fact.content),preview:box(fact.preview),path:fact.path,
    originalJoinedAtMatch:fact.originalJoinedAtMatch,recoveryJoinedAtMatch:fact.recoveryJoinedAtMatch});
}
const SOURCE_BINDING_COUNT_KEYS=['inputAttempts','inputBound','inputUnavailable','inputUnavailableAtLimit','inputJoinedAtAttempt',
  'recoveryAttempts','recoveryMatched','recoveryUnavailable','recoveryUnavailableAtLimit','cachedAttempts','reacquiredAttempts',
  'cachedMatched','reacquiredMatched','originalJoinedAtMatch','recoveryJoinedAtMatch',
  'bindingsIssuedNotForgotten','observedSources','remainingBindings','capabilities'] as const;
export function parseSourceBindingMetadataSummary(value:unknown) {
  const item=object(value,['scope','pixelsAuthenticated',...SOURCE_BINDING_COUNT_KEYS],true);
  if(item.scope!=='prepared-source-metadata-only'||item.pixelsAuthenticated!==false||
    SOURCE_BINDING_COUNT_KEYS.some(key=>!Number.isSafeInteger(item[key])||(item[key] as number)<0))throw Error('잘못된 출처 연결 요약');
  return Object.freeze({scope:'prepared-source-metadata-only' as const,pixelsAuthenticated:false as const,
    ...Object.fromEntries(SOURCE_BINDING_COUNT_KEYS.map(key=>[key,item[key] as number]))});
}
function scannerClock(value:unknown):ScannerClockFact {
  const clock=object(value,['version','clock','phase','originMs'],true);
  if(clock.version!==1||clock.clock!=='page-performance-now'||clock.phase!=='input-and-recognition'||
    typeof clock.originMs!=='number'||!Number.isFinite(clock.originMs)||clock.originMs<0)
    throw Error('잘못된 스캐너 시계 진단');
  return Object.freeze({version:1,clock:'page-performance-now',phase:'input-and-recognition',originMs:clock.originMs});
}

/** Metadata emitted by the current stored-input replay only. The run ID
 * belongs to the dev report, not to the original capture or OCR session.
 * A digest describes decoded source pixels; it does not attest reader crop
 * pixels, OCR input, correctness, or the completeness of the recording. */
export function parseReplaySourceUse(value:unknown) {
  const row=object(value,['version','runId','processingFrame','acquisitionFrameId','sourceFrameId','captureTime','phase','phaseInferred','pixelHash'],true);
  if(row.version!==1||typeof row.runId!=='string'||!/^[a-f0-9-]{36}$/.test(row.runId)||
    !positive(row.processingFrame,Number.MAX_SAFE_INTEGER)||!positive(row.acquisitionFrameId,Number.MAX_SAFE_INTEGER)||
    !(row.sourceFrameId===null||positive(row.sourceFrameId,Number.MAX_SAFE_INTEGER)))throw Error('잘못된 재현 원본 연결');
  const provenance=parseScannerInputProvenance({frameId:row.acquisitionFrameId,
    ...(row.sourceFrameId===null?{}:{sourceFrameId:row.sourceFrameId}),captureTime:row.captureTime,
    phase:row.phase,phaseInferred:row.phaseInferred,pixelHash:row.pixelHash});
  return Object.freeze({version:1 as const,runId:row.runId,processingFrame:row.processingFrame,
    acquisitionFrameId:provenance.frameId,sourceFrameId:provenance.sourceFrameId??null,
    captureTime:provenance.captureTime,phase:provenance.phase,phaseInferred:provenance.phaseInferred,pixelHash:provenance.pixelHash});
}

/** Extract only the replay provenance from the scanner frame callback. */
export function replaySourceUseFromFrame(value:unknown,runId:string) {
  if(!value||typeof value!=='object'||Array.isArray(value))throw Error('재현 프레임 누락');
  const frame=value as Record<string,unknown>,provenance=parseScannerInputProvenance(frame.provenance);
  if(frame.sourceFrameId!==provenance.frameId||frame.time!==provenance.captureTime||frame.phase!==provenance.phase)
    throw Error('재현 프레임과 원본 연결 불일치');
  return parseReplaySourceUse({version:1,runId,processingFrame:frame.frame,acquisitionFrameId:provenance.frameId,
    sourceFrameId:provenance.sourceFrameId??null,captureTime:provenance.captureTime,phase:provenance.phase,
    phaseInferred:provenance.phaseInferred,pixelHash:provenance.pixelHash});
}
function parseEvent(value:unknown):RunStateTraceEvent {
  const event=object(value,['seq','time','type','value']);
  if(!positive(event.seq,Number.MAX_SAFE_INTEGER)||typeof event.time!=='number'||
    !Number.isFinite(event.time)||event.time<0)throw Error('잘못된 상태 기록 순서 또는 시각');
  const base={seq:event.seq,time:event.time};
  if(event.type==='recording-availability'){
    const value=object(event.value,['status','liveScreen'],true);
    if((value.status!=='active'&&value.status!=='disabled'&&value.status!=='failed')||typeof value.liveScreen!=='boolean')
      throw Error('잘못된 기록 가용성 진단');
    return Object.freeze({...base,type:'recording-availability',value:Object.freeze({status:value.status,liveScreen:value.liveScreen})});
  }
  if(event.type==='scanner-clock')return Object.freeze({...base,type:'scanner-clock',value:scannerClock(event.value)});
  if(event.type==='scroll-coverage')return Object.freeze({...base,type:'scroll-coverage',value:parseScrollCoverageDiagnostic(event.value)});
  if(event.type==='replay-source-use')return Object.freeze({...base,type:'replay-source-use',value:parseReplaySourceUse(event.value)});
  if(event.type==='grid-command')return Object.freeze({...base,type:'grid-command',value:parseScanGridCommand(event.value)});
  if(event.type==='observation-fact')return Object.freeze({...base,type:'observation-fact',value:parseObservationFact(event.value)});
  if(event.type==='inventory-seed')return Object.freeze({...base,type:'inventory-seed',value:parseInventorySeed(event.value)});
  if(event.type==='inventory-event')return Object.freeze({...base,type:'inventory-event',value:inventoryEventData(parseInventoryEvent(event.value))});
  if(event.type==='inventory-preview-confirmation')return Object.freeze({...base,type:'inventory-preview-confirmation',value:parseInventoryPreviewConfirmation(event.value)});
  if(event.type==='inventory-checkpoint')return Object.freeze({...base,type:'inventory-checkpoint',value:parseInventoryCheckpoint(event.value)});
  if(event.type==='input-admission')return Object.freeze({...base,type:'input-admission',value:parseLiveInputAdmissionFact(event.value)});
  if(event.type==='input-arrival')return Object.freeze({...base,type:'input-arrival',value:parseInputArrival(event.value)});
  if(event.type==='input-backup-reservation')return Object.freeze({...base,type:'input-backup-reservation',value:parseInputBackupReservation(event.value)});
  if(event.type==='backup-capacity-deferral')return Object.freeze({...base,type:'backup-capacity-deferral',value:parseBackupCapacityDeferral(event.value)});
  if(event.type==='acquisition-capture')return Object.freeze({...base,type:'acquisition-capture',value:parseAcquisitionCapture(event.value)});
  if(event.type==='recognition-capture')return Object.freeze({...base,type:'recognition-capture',value:parseRecognitionCapture(event.value)});
  if(event.type==='scroll-capture')return Object.freeze({...base,type:'scroll-capture',value:parseScrollCaptureFact(event.value)});
  if(event.type==='inventory-header-read')return Object.freeze({...base,type:'inventory-header-read',value:parseInventoryHeaderFact(event.value)});
  if(event.type==='media-lineage')return Object.freeze({...base,type:'media-lineage',value:parseMediaLineageFact(event.value)});
  if(event.type==='media-input-link')return Object.freeze({...base,type:'media-input-link',value:parseMediaInputLink(event.value)});
  if(event.type==='source-playback')return Object.freeze({...base,type:'source-playback',value:parseMediaPlaybackFact(event.value)});
  if(event.type==='input-decision')return Object.freeze({...base,type:'input-decision',value:parseLiveCaptureDecision(event.value)});
  if(event.type==='input-recovery')return Object.freeze({...base,type:'input-recovery',value:parseInputRecoveryFact(event.value)});
  if(event.type==='input-link')return Object.freeze({...base,type:'input-link',value:parseInputFrameLink(event.value)});
  if(event.type==='input-loss-contract')return Object.freeze({...base,type:'input-loss-contract',value:parseInputLossContract(event.value)});
  if(event.type==='input-loss')return Object.freeze({...base,type:'input-loss',value:parseInputLossFact(event.value)});
  if(event.type==='input-acquisition-contract')return Object.freeze({...base,type:'input-acquisition-contract',value:parseInputAcquisitionContract(event.value)});
  if(event.type==='input-acquisition-skip')return Object.freeze({...base,type:'input-acquisition-skip',value:parseInputAcquisitionSkip(event.value)});
  if(event.type==='input-checkpoint')return Object.freeze({...base,type:'input-checkpoint',value:parseInputCheckpoint(event.value)});
  if(event.type==='unknown-seed')return Object.freeze({...base,type:'unknown-seed',value:parseRecordedUnknownSeed(event.value)});
  if(event.type==='unknown-event')return Object.freeze({...base,type:'unknown-event',value:parseUnknownFact(event.value)});
  if(event.type==='unknown-recovery-claim')return Object.freeze({...base,type:'unknown-recovery-claim',value:parseUnknownRecoveryClaim(event.value)});
  if(event.type==='source-binding-metadata')return Object.freeze({...base,type:'source-binding-metadata',value:parseSourceBindingMetadata(event.value)});
  if(event.type==='source-binding-metadata-summary')return Object.freeze({...base,type:'source-binding-metadata-summary',value:parseSourceBindingMetadataSummary(event.value)});
  if(event.type==='unknown-checkpoint')return Object.freeze({...base,type:'unknown-checkpoint',value:parseUnknownCheckpoint(event.value)});
  if(event.type==='obstruction-seed')return Object.freeze({...base,type:'obstruction-seed',value:parseObstructionSeed(event.value)});
  if(event.type==='obstruction-event')return Object.freeze({...base,type:'obstruction-event',value:parseObstructionEvent(event.value)});
  if(event.type==='obstruction-checkpoint')return Object.freeze({...base,type:'obstruction-checkpoint',value:parseObstructionCheckpoint(event.value)});
  if(event.type==='freshness-seed')return Object.freeze({...base,type:'freshness-seed',value:parseFreshnessSeed(event.value)});
  if(event.type==='freshness-event')return Object.freeze({...base,type:'freshness-event',value:parseFreshnessFact(event.value)});
  if(event.type==='freshness-checkpoint')return Object.freeze({...base,type:'freshness-checkpoint',value:parseFreshnessCheckpoint(event.value)});
  throw Error('지원하지 않는 상태 기록 이벤트');
}
function base64(bytes:Uint8Array):string {
  // No spread or per-byte array: large command chunks cannot overflow the stack.
  let binary='';for(const byte of bytes)binary+=String.fromCharCode(byte);
  return btoa(binary);
}
function compressedSize(value:unknown):number {
  if(typeof value!=='string'||!value.length||value.length%4||
    value.length>Math.ceil(MAX_RUN_STATE_TRACE_BYTES/3)*4||!/^[A-Za-z0-9+/]*={0,2}$/.test(value))
    throw Error('잘못된 상태 기록 압축 데이터');
  return value.length/4*3-(value.endsWith('==')?2:value.endsWith('=')?1:0);
}
function decodeBase64(value:string):Uint8Array<ArrayBuffer> {
  const binary=atob(value);
  if(btoa(binary)!==value)throw Error('잘못된 상태 기록 압축 데이터');
  const bytes=new Uint8Array(binary.length);
  for(let index=0;index<binary.length;index++)bytes[index]=binary.charCodeAt(index);
  return bytes;
}
async function inflate(chunk:CompressedChunk,signal:AbortSignal):Promise<string> {
  signal.throwIfAborted();
  const reader=new Blob([decodeBase64(chunk.data)]).stream().pipeThrough(new DecompressionStream('gzip')).getReader();
  // Allocate only the validated declared size; reject before copying any excess.
  const bytes=new Uint8Array(chunk.bytes);let size=0,finished=false;
  const abort=()=>{void reader.cancel().catch(()=>undefined);};
  signal.addEventListener('abort',abort,{once:true});
  try{
    while(true){
      signal.throwIfAborted();const {done,value}=await reader.read();signal.throwIfAborted();
      if(done){finished=true;break;}
      if(size+value.byteLength>bytes.byteLength)throw Error('상태 기록 압축 해제 용량 한도 초과');
      bytes.set(value,size);size+=value.byteLength;
    }
    if(size!==chunk.bytes)throw Error('상태 기록 압축 해제 크기 불일치');
    return new TextDecoder('utf-8',{fatal:true}).decode(bytes);
  }finally{
    signal.removeEventListener('abort',abort);
    if(!finished)await reader.cancel().catch(()=>undefined);reader.releaseLock();
  }
}

/** Development-only recorder. Sync capture just appends serialized facts.
 * Two Worker gzip lanes consume bounded batches independently of scanning.
 * No frames, pixels or mutable input references are retained. */
export class RunStateTrace {
  private readonly maxBytes:number;
  private readonly maxRawBytes:number;
  private readonly maxPendingBytes:number;
  private readonly maxEvents:number;
  private readonly jobs:Promise<CompressedChunk|null>[]=[];
  private commitTail:Promise<unknown>=Promise.resolve();
  private readonly compression:RunStateCompression;
  private batch:string[]=[];
  private batchBytes=0;
  private pendingBytes=0;
  private peakPendingBytes=0;
  private rawBytes=0;
  private compressedBytes=0;
  private events=0;
  private accepted=0;
  private sequence=0;
  private dropped=0;
  private full=false;
  private storageFull=false;

  constructor(options:{maxBytes?:number;maxRawBytes?:number;maxPendingBytes?:number;maxEvents?:number;
    compression?:RunStateCompression}={}) {
    this.maxBytes=options.maxBytes??MAX_RUN_STATE_TRACE_BYTES;
    this.maxRawBytes=options.maxRawBytes??MAX_RUN_STATE_TRACE_RAW_BYTES;
    this.maxPendingBytes=options.maxPendingBytes??MAX_RUN_STATE_TRACE_PENDING_BYTES;
    this.maxEvents=options.maxEvents??MAX_RUN_STATE_TRACE_EVENTS;
    this.compression=options.compression??new RunStateCompression();
    if(!positive(this.maxBytes,MAX_RUN_STATE_TRACE_BYTES)||!positive(this.maxRawBytes,MAX_RUN_STATE_TRACE_RAW_BYTES)||
      !positive(this.maxPendingBytes,MAX_RUN_STATE_TRACE_PENDING_BYTES)||!positive(this.maxEvents,MAX_RUN_STATE_TRACE_EVENTS))
      throw Error('잘못된 상태 기록 한도');
  }

  record(type:string,value:unknown,time:number):boolean {
    if(!['grid-command','observation-fact','inventory-seed','inventory-event','inventory-preview-confirmation','inventory-checkpoint',
      'input-loss-contract','input-loss','input-admission','input-arrival','input-backup-reservation','backup-capacity-deferral','input-decision','input-recovery','input-link','input-acquisition-contract','input-acquisition-skip','input-checkpoint','input-recording-error',
      'acquisition-capture','recognition-capture','scroll-capture','inventory-header-read','capture-recording-error',
      'media-lineage','media-input-link','media-recording-error',
      'source-playback','scanner-clock','recording-availability','replay-source-use','scroll-coverage',
      'unknown-seed','unknown-event','unknown-recovery-claim','unknown-checkpoint','unknown-recording-error',
      'source-binding-metadata','source-binding-metadata-summary',
      'freshness-seed','freshness-event','freshness-checkpoint','freshness-recording-error',
      'obstruction-seed','obstruction-event','obstruction-checkpoint','obstruction-recording-error'].includes(type))return false;
    this.sequence=Math.min(Number.MAX_SAFE_INTEGER,this.sequence+1);
    const drop=()=>{this.dropped=Math.min(Number.MAX_SAFE_INTEGER,this.dropped+1);return false;};
    // A failed optional decision recorder may already have omitted facts before
    // this callback. Never call the remaining selected state a complete run.
    if(type==='input-recording-error'||type==='unknown-recording-error'||type==='capture-recording-error'||type==='media-recording-error'||type==='freshness-recording-error'||type==='obstruction-recording-error')return drop();
    if(this.full||this.accepted>=this.maxEvents||this.jobs.length>=MAX_CHUNKS){this.full=true;return drop();}
    let json:string;
    try{json=JSON.stringify(parseEvent({seq:this.sequence,time,type,value}));}
    catch{return drop();}
    const size=encoder.encode(json).byteLength+1; // NDJSON newline belongs to the batch.
    if(this.rawBytes+size>this.maxRawBytes||this.pendingBytes+size>this.maxPendingBytes){this.full=true;return drop();}
    if(this.batchBytes&&this.batchBytes+size>BATCH_BYTES)this.flush();
    if(this.jobs.length>=MAX_CHUNKS){this.full=true;return drop();}
    this.batch.push(json);this.batchBytes+=size;this.pendingBytes+=size;this.rawBytes+=size;
    this.peakPendingBytes=Math.max(this.peakPendingBytes,this.pendingBytes);this.events++;this.accepted++;
    if(this.batchBytes>=BATCH_BYTES)this.flush();
    return true;
  }

  private flush():void {
    if(!this.batch.length)return;
    const raw=this.batch.join('\n')+'\n',bytes=this.batchBytes,events=this.batch.length;
    this.batch=[];this.batchBytes=0;
    // Compression starts independently, but storage commits follow input order.
    // A later job must not consume an earlier snapshot's byte budget or make an
    // earlier prefix incomplete. Retain its pending reservation through commit.
    const work=this.compression.compress(raw,bytes,this.maxBytes),previous=this.commitTail;
    const job=(async():Promise<CompressedChunk|null>=>{
      try{
        const compressed=await work;await previous;
        if(this.storageFull)throw Error('상태 기록 압축 한도 도달');
        if(this.compressedBytes+compressed.byteLength>this.maxBytes)throw Error('상태 기록 압축 용량 한도 초과');
        const chunk=Object.freeze({bytes,events,data:base64(compressed)});
        this.compressedBytes+=compressed.byteLength;
        return chunk;
      }catch{
        await previous;
        this.full=true;this.storageFull=true;this.events-=events;this.dropped+=events;return null;
      }finally{this.pendingBytes-=bytes;}
    })();
    this.jobs.push(job);this.commitTail=job;
  }

  /** Release old runs/page resources; already captured prefixes settle partial
   * if their compression was still outstanding. Settled snapshots stay valid. */
  dispose():void {this.flush();this.full=true;this.compression.dispose();}

  get stats(){return Object.freeze({events:this.events,bytes:this.compressedBytes,rawBytes:this.rawBytes,
    compressedBytes:this.compressedBytes,pendingBytes:this.pendingBytes,peakPendingBytes:this.peakPendingBytes,
    dropped:this.dropped,complete:this.dropped===0,compression:this.compression.stats});}

  /** Fix the prefix synchronously before awaiting compression. Future calls to
   * record, including failures/overflow, cannot alter this snapshot's contents. */
  async snapshotBlob():Promise<Blob> {
    this.flush();const prefix=this.jobs.slice(),sequence=this.sequence;
    const chunks=(await Promise.all(prefix)).filter((chunk):chunk is CompressedChunk=>chunk!==null);
    const events=chunks.reduce((count,chunk)=>count+chunk.events,0),dropped=sequence-events;
    const snapshot:CompressedTrace={version:2,codec:'gzip',complete:dropped===0,dropped,
      events,chunkCount:chunks.length,lastSeq:sequence,chunks};
    return new Blob([JSON.stringify(snapshot)],{type:'application/json;charset=utf-8'});
  }
}

async function readTrace(blob:Blob,signal:AbortSignal):Promise<TraceInput> {
  signal.throwIfAborted();
  if(blob.size>MAX_RUN_STATE_TRACE_BLOB_BYTES)throw Error('상태 기록 파일 용량 한도 초과');
  const bytes=await blob.arrayBuffer();signal.throwIfAborted();
  const value:unknown=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
  const version=value&&typeof value==='object'?'version' in value?value.version:undefined:undefined;
  const raw=object(value,version===1?['version','complete','dropped','events']:
    ['version','codec','complete','dropped','events','chunkCount','lastSeq','chunks']);
  if(typeof raw.complete!=='boolean'||!Number.isSafeInteger(raw.dropped)||(raw.dropped as number)<0||raw.complete&&raw.dropped!==0)
    throw Error('잘못된 상태 기록 버전 또는 한도');
  if(version===1){
    if(blob.size>MAX_RUN_STATE_TRACE_BYTES+256||!Array.isArray(raw.events)||raw.events.length>MAX_RUN_STATE_TRACE_EVENTS)
      throw Error('잘못된 상태 기록 버전 또는 한도');
    // Legacy values are strictly parsed on iteration, never trusted by replay.
    return {version:1,complete:raw.complete,dropped:raw.dropped as number,events:raw.events};
  }
  if(version!==2||raw.codec!=='gzip'||!Array.isArray(raw.chunks)||raw.chunks.length>MAX_CHUNKS)
    throw Error('잘못된 상태 기록 버전 또는 한도');
  if(!Number.isSafeInteger(raw.events)||(raw.events as number)<0||(raw.events as number)>MAX_RUN_STATE_TRACE_EVENTS||
    !Number.isSafeInteger(raw.chunkCount)||raw.chunkCount!==raw.chunks.length||
    !Number.isSafeInteger(raw.lastSeq)||(raw.lastSeq as number)<0||
    (raw.events as number)+(raw.dropped as number)!==raw.lastSeq)
    throw Error('상태 기록 전체 이벤트 또는 청크 수 불일치');
  const chunks:CompressedChunk[]=[];let rawBytes=0,compressedBytes=0,events=0;
  for(const value of raw.chunks){
    const chunk=object(value,['bytes','events','data']);
    if(!positive(chunk.bytes,MAX_RUN_STATE_TRACE_PENDING_BYTES)||!positive(chunk.events,MAX_RUN_STATE_TRACE_EVENTS))
      throw Error('잘못된 상태 기록 청크 한도');
    rawBytes+=chunk.bytes;events+=chunk.events;compressedBytes+=compressedSize(chunk.data);
    if(rawBytes>MAX_RUN_STATE_TRACE_RAW_BYTES||compressedBytes>MAX_RUN_STATE_TRACE_BYTES||events>MAX_RUN_STATE_TRACE_EVENTS)
      throw Error('상태 기록 용량 또는 이벤트 한도 초과');
    chunks.push(Object.freeze({bytes:chunk.bytes,events:chunk.events,data:chunk.data as string}));
  }
  if(events!==raw.events)throw Error('상태 기록 전체 이벤트 수 불일치');
  signal.throwIfAborted();
  return {version:2,codec:'gzip',complete:raw.complete,dropped:raw.dropped as number,
    events,chunkCount:raw.chunkCount as number,lastSeq:raw.lastSeq as number,chunks};
}

async function* iterateEvents(trace:TraceInput,signal:AbortSignal):AsyncGenerator<RunStateTraceEvent> {
  let sequence=0,count=0;
  const next=async(value:unknown)=>{
    if(count%256===0)await yieldForCapture(signal);
    const event=parseEvent(value);
    if(event.seq<=sequence||trace.complete&&event.seq!==sequence+1)throw Error('상태 기록 이벤트 순서 오류');
    if('chunks' in trace&&event.seq>trace.lastSeq)throw Error('상태 기록 마지막 순번 불일치');
    sequence=event.seq;if(++count>MAX_RUN_STATE_TRACE_EVENTS)throw Error('상태 기록 이벤트 한도 초과');
    return event;
  };
  if('chunks' in trace){
    for(const chunk of trace.chunks){
      const text=await inflate(chunk,signal),lines=text.split('\n');
      if(lines.pop()!==''||lines.length!==chunk.events)throw Error('상태 기록 청크 이벤트 수 불일치');
      for(const line of lines)yield await next(JSON.parse(line));
    }
    if(count!==trace.events||trace.complete&&sequence!==trace.lastSeq)throw Error('상태 기록 마지막 순번 또는 이벤트 수 불일치');
  }else for(const value of trace.events)yield await next(value);
  signal.throwIfAborted();
}

/** Explicit full-event inspection can retain up to 128 MiB of source JSON as
 * expanded objects (heap usage can be larger). Use only for deliberate analysis;
 * normal replay below instead decodes and applies one chunk at a time. */
export async function parseRunStateTrace(blob:Blob,signal:AbortSignal):Promise<RunStateTraceSnapshot> {
  const trace=await readTrace(blob,signal),events:RunStateTraceEvent[]=[];
  for await(const event of iterateEvents(trace,signal))events.push(event);
  return Object.freeze({version:trace.version,complete:trace.complete,dropped:trace.dropped,events:Object.freeze(events)});
}

/** Explicit historical hypothesis only. Seed v1 did not record which name
 * consensus policy ran. A matching checkpoint is not policy authentication,
 * OCR accuracy or complete scanner replay, and this result must never feed
 * live state, obstruction/freshness decisions, or archive certification. */
export async function compareLegacyInventoryCandidate(blob:Blob,signal:AbortSignal) {
  const trace=await readTrace(blob,signal);
  if(!trace.complete||trace.dropped)throw Error('불완전한 상태 기록은 과거 정책 비교에 사용할 수 없습니다.');
  const inventory=new InventoryEvidenceReplay(signal,{legacyRepeatCandidate:true});
  for await(const event of iterateEvents(trace,signal)){
    if(event.type==='inventory-seed')inventory.seed(event.value);
    else if(event.type==='inventory-event')inventory.accept(event.value);
    else if(event.type==='inventory-preview-confirmation')inventory.previewConfirmation(event.value);
    else if(event.type==='inventory-checkpoint')inventory.checkpoint(event.value);
  }
  const {matchesCapturedState:matchesCandidateCheckpoint,...result}=await inventory.summary();
  return {policy:'legacy-repeat-candidate' as const,policyAuthenticated:false as const,
    scope:'inventory-state-hypothesis-only' as const,...result,matchesCandidateCheckpoint};
}

/** Reapply command order and common lifecycle reducers without OCR or the live
 * scheduler. Only compressed chunks and bounded reducer state are retained. */
export async function replayRunStateTrace(blob:Blob,signal:AbortSignal) {
  const trace=await readTrace(blob,signal);
  if(!trace.complete||trace.dropped)throw Error('불완전한 상태 기록은 전체 실행 비교에 사용할 수 없습니다.');
  const grid=new ScanGrid(),observations=new ObservationExecutionReplay(signal);let commands=0,events=0;
  const inventory=new InventoryEvidenceReplay(signal);
  const input=new InputDecisionReplay(signal);
  const acquisitionEvidence=new InputAcquisitionEvidence();
  const inputLoss=new InputLossEvidence();
  const unknownLifecycle=new UnknownLifecycleReplay(signal);
  const freshness=new FreshnessEvidenceReplay(signal,()=>inventory.confirmedFieldOrder);
  const obstruction=new ObstructionEvidenceReplay(signal,()=>({latest:inventory.latestIdentityOrder,names:inventory.confirmedNameOrder,fields:inventory.confirmedFieldOrder}));
  for await(const event of iterateEvents(trace,signal)){
    acceptInputAcquisitionEvent(acquisitionEvidence,event.type,event.value);
    acceptInputLossEvent(inputLoss,event.type,event.value);
    if(event.type==='grid-command'){applyScanGridCommand(grid,event.value);commands++;}
    else if(event.type==='observation-fact')observations.accept(event.value);
    else if(event.type==='inventory-seed'){inventory.seed(event.value);freshness.proofsChanged();obstruction.proofsChanged();}
    else if(event.type==='inventory-event'){inventory.accept(event.value);freshness.proofsChanged();obstruction.proofsChanged();}
    else if(event.type==='inventory-preview-confirmation'){inventory.previewConfirmation(event.value);freshness.proofsChanged();obstruction.proofsChanged();}
    else if(event.type==='inventory-checkpoint')inventory.checkpoint(event.value);
    else if(event.type==='acquisition-capture')obstruction.acquisition(event.value);
    else if(event.type==='obstruction-seed')obstruction.seed(event.value);
    else if(event.type==='obstruction-event')obstruction.accept(event.value);
    else if(event.type==='obstruction-checkpoint')obstruction.checkpoint(event.value);
    else if(event.type==='input-admission')input.admission(event.value);
    else if(event.type==='input-decision')input.pipeline(event.value);
    else if(event.type==='input-recovery')input.recovery(event.value);
    else if(event.type==='input-link')input.link(event.value);
    else if(event.type==='input-checkpoint')input.checkpoint(event.value);
    else if(event.type==='unknown-seed')unknownLifecycle.seed(event.value);
    else if(event.type==='unknown-event')unknownLifecycle.accept(event.value);
    else if(event.type==='unknown-recovery-claim')unknownLifecycle.acceptRecoveryClaim(event.value);
    else if(event.type==='unknown-checkpoint')unknownLifecycle.checkpoint(event.value);
    else if(event.type==='freshness-seed')freshness.seed(event.value);
    else if(event.type==='freshness-event')freshness.accept(event.value);
    else if(event.type==='freshness-checkpoint')freshness.checkpoint(event.value);
    // Clock anchors, backup deferral, acquisition/recognition receipts and scroll/header facts
    // are retained/countable metadata, never reducer evidence.
    events++;
  }
  signal.throwIfAborted();
  const hash=commands?await hashScanGridReplay(scanGridReplaySnapshot(grid)):null;
  signal.throwIfAborted();const observationSummary=await observations.summary();signal.throwIfAborted();
  const inventorySummary=await inventory.summary();
  const inputSummary=await input.summary();
  const unknownSummary=await unknownLifecycle.summary();
  const freshnessSummary=await freshness.summary();
  const obstructionSummary=await obstruction.summary();
  signal.throwIfAborted();
  return {version:trace.version,complete:true as const,events,
    grid:{supported:commands>0,commands,hash},observations:observationSummary,
    inventory:inventorySummary,inventoryPolicy:inventory.policy(),input:inputSummary,inputLoss:inputLoss.summary(),...(acquisitionEvidence.summary().supported?{acquisitionEvidence:acquisitionEvidence.summary()}:{}),unknownLifecycle:unknownSummary,freshness:freshnessSummary,obstruction:obstructionSummary};
}
