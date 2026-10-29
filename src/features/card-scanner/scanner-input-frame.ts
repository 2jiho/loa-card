import {parseMediaDecodedFrame} from './media-lineage';
import type {MediaDecodedFrame} from './media-lineage';
/** Pixel sources have independent lifetimes; metadata never owns or copies them. */
export type ScannerInputElement = HTMLImageElement | HTMLVideoElement | HTMLCanvasElement | OffscreenCanvas;
export type ScannerInputPhase = 'input' | 'recovery';

/** Replace the unscaled acquisition frame, including transparent pixels.
 * The caller owns source lifetime and canvas size. Keep `copy` active so a
 * reused frame cannot blend with pixels from an earlier input. */
export function copyScannerInput(
  context:Pick<CanvasRenderingContext2D,'globalCompositeOperation'|'drawImage'>,
  source:CanvasImageSource,
):void {
  context.globalCompositeOperation='copy';
  context.drawImage(source,0,0);
}

export interface ScannerInputProvenance {
  /** Recorded processing-use ID (legacy: archive frame ID). Never a new
   * replay attempt/completion ID and never card freshness. */
  frameId: number;
  /** Canonical pixel source referenced by that use, if recorded separately. */
  sourceFrameId?:number;
  /** Source capture time in seconds, on the same clock as ScannerInputFrame.time. */
  captureTime: number;
  phase: ScannerInputPhase;
  /** Legacy recordings omitted phase. The input fallback is not a recorded fact. */
  phaseInferred: boolean;
  /** Verified RGBA pixel digest, not a hash of JPEG or another preview. */
  pixelHash: string;
}

export interface ScannerInputFrame<T extends ScannerInputElement = ScannerInputElement> {
  element: T;
  time: number;
  percent: number;
  image?: string;
  provenance?: ScannerInputProvenance;
  /** Iterator-local decoder origin, separate from canonical pixel provenance. */
  lineage?:MediaDecodedFrame;
}

function invalid(message: string): never { throw new Error(`Invalid scanner input: ${message}`); }
function captureTime(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

/** Normalize only serializable metadata. Missing legacy phase stays explicitly inferred. */
export function parseScannerInputProvenance(input: unknown): ScannerInputProvenance {
  if (!input || typeof input !== 'object' || Array.isArray(input)) invalid('provenance must be an object');
  const value = input as Record<string, unknown>;
  if (!Number.isSafeInteger(value.frameId) || (value.frameId as number) < 1) invalid('frameId');
  if(value.sourceFrameId!==undefined&&(!Number.isSafeInteger(value.sourceFrameId)||(value.sourceFrameId as number)<1))invalid('sourceFrameId');
  if (!captureTime(value.captureTime)) invalid('captureTime');
  if (typeof value.pixelHash !== 'string' || !/^[a-f0-9]{64}$/.test(value.pixelHash)) invalid('pixelHash');
  if (value.phase !== undefined && value.phase !== 'input' && value.phase !== 'recovery') invalid('phase');
  if (value.phaseInferred !== undefined && typeof value.phaseInferred !== 'boolean') invalid('phaseInferred');
  const missingPhase = value.phase === undefined;
  if (missingPhase && value.phaseInferred === false) invalid('missing phase cannot be marked recorded');
  const phase = value.phase ?? 'input';
  const phaseInferred = missingPhase || value.phaseInferred === true;
  if (phaseInferred && phase !== 'input') invalid('only the legacy input fallback can be inferred');
  return { frameId: value.frameId as number,...(value.sourceFrameId===undefined?{}:{sourceFrameId:value.sourceFrameId as number}), captureTime: value.captureTime,
    phase, phaseInferred, pixelHash: value.pixelHash };
}

/** Validate the common envelope without copying pixels or imposing replay-time ordering. */
export function normalizeScannerInputFrame<T extends ScannerInputElement>(frame: ScannerInputFrame<T>): ScannerInputFrame<T> {
  if (!frame || typeof frame !== 'object' || !frame.element) invalid('element');
  if (!captureTime(frame.time)) invalid('time');
  if (!Number.isFinite(frame.percent) || frame.percent < 0 || frame.percent > 100) invalid('percent');
  if (frame.image !== undefined && typeof frame.image !== 'string') invalid('image');
  let normalized=frame;
  if(frame.lineage!==undefined){
    const lineage=parseMediaDecodedFrame(frame.lineage);
    if(lineage.pts!==frame.time)invalid('lineage PTS must equal this source time');
    normalized={...frame,lineage};
  }
  if (frame.provenance === undefined) return normalized;
  const provenance = parseScannerInputProvenance(frame.provenance);
  if (provenance.captureTime !== frame.time) invalid('captureTime must equal source time');
  return { ...normalized, provenance };
}
