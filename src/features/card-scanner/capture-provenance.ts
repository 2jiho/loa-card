import { parseObservationFact } from './observation-execution';
import type { ObservationSource } from './observation-execution';

/** Small diagnostic receipts. These facts carry provenance, never pixels,
 * recognition candidates, inventory evidence or execution-state authority. */
export interface CaptureBox {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface AcquisitionCapture {
  readonly version: 1;
  readonly sessionId: string;
  readonly observationId: string;
  readonly processingFrame: number;
  readonly acquisitionFrameId: number;
  readonly canonicalSourceFrameId: number | null;
  readonly captureTime: number;
  readonly phase: 'input' | 'recovery';
  readonly slot: number;
  readonly pixelKey: string;
  /** Selection signal only; never exact crop identity or physical-source proof. */
  readonly fieldRevision?: string;
  readonly sourceWidth: number;
  readonly sourceHeight: number;
  /** Cached resolved cells can retain analysis without materializing pixels.
   * Legacy v1 receipts omit this field; their dimensions do not verify pixels. */
  readonly cropState?: 'materialized' | 'omitted-resolved';
  readonly cropWidth: number | null;
  readonly cropHeight: number | null;
  readonly nominalBox: CaptureBox;
  readonly contentBox: CaptureBox;
  readonly previewBox: CaptureBox;
  readonly capture: Readonly<{
    stable: boolean;
    stabilitySource: 'still-image' | 'settled-fields' | 'saved-observation';
    complete: boolean | null;
    intact: boolean | null;
    labelVisible: boolean | null;
    borderAlignment: number | null;
    borderSides: readonly [number, number, number, number] | null;
  }>;
  readonly quality: Readonly<{ usable: boolean; reason: string; sharpness: number }>;
}

export interface RecognitionCapture {
  readonly version: 1;
  /** Independent identity-selection ordinal, not an execution attempt or a
   * neural inference count. Source chronology remains in source. */
  readonly invocationId: number;
  readonly source: ObservationSource;
  readonly acquisition: Readonly<{ sessionId: string; observationId: string }> | null;
  readonly processingFrame: number;
  readonly stage: 'visual' | 'short' | 'full';
  readonly stable: boolean;
  readonly borderAlignment: number;
  readonly structural: boolean;
  readonly fullRead: boolean;
  readonly portraitRefinement: boolean;
  readonly grayNameFallback: boolean;
  readonly cropWidth: number;
  readonly cropHeight: number;
  readonly identityPath: 'retained' | 'visual-worker' | 'visual-reader' | 'ocr-reader';
}

const MAX_ID_LENGTH = 160;
const MAX_DIMENSION = 65_536;
const MAX_RASTER_BYTES = 128 * 1024 * 1024;
const MAX_JSON_BYTES = 8_192;
const encoder = new TextEncoder();

function fail(detail: string): never {
  throw new TypeError(`Invalid capture provenance: ${detail}`);
}

function record(value: unknown, keys: readonly string[], required = keys): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail('plain object required');
  const object = value as Record<string, unknown>;
  const ownKeys = Reflect.ownKeys(object);
  if (ownKeys.some(key => typeof key !== 'string' || !keys.includes(key)) ||
    required.some(key => !Object.hasOwn(object, key))) fail('unexpected or missing property');
  for (const key of ownKeys) {
    const descriptor = Object.getOwnPropertyDescriptor(object, key)!;
    if (!('value' in descriptor) || !descriptor.enumerable) fail('own data properties required');
  }
  return object;
}

function identifier(value: unknown): string {
  if (typeof value !== 'string' || !value.length || value.length > MAX_ID_LENGTH) fail('identifier');
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code < 32 || code >= 127 && code <= 159) fail('identifier control character');
  }
  return value;
}

function positive(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) fail('positive safe integer required');
  return value as number;
}

function nonnegative(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) fail('nonnegative finite number required');
  return value;
}

function boolean(value: unknown): boolean {
  if (typeof value !== 'boolean') fail('boolean required');
  return value;
}

function nullableBoolean(value: unknown): boolean | null {
  return value === null ? null : boolean(value);
}

function alignment(value: unknown): number {
  const result = nonnegative(value);
  if (result > 1) fail('alignment outside unit interval');
  return result;
}

function raster(width: unknown, height: unknown): readonly [number, number] {
  const w = positive(width), h = positive(height);
  if (w > MAX_DIMENSION || h > MAX_DIMENSION || 4 * w * h > MAX_RASTER_BYTES) fail('raster bounds');
  return [w, h];
}

function boxFrom(value: unknown): CaptureBox {
  const box = record(value, ['x', 'y', 'width', 'height']);
  for (const key of ['x', 'y', 'width', 'height']) {
    const coordinate = box[key];
    if (typeof coordinate !== 'number' || !Number.isFinite(coordinate) ||
      Math.abs(coordinate) > MAX_DIMENSION) fail('box bounds');
  }
  if ((box.width as number) <= 0 || (box.height as number) <= 0) fail('positive box dimensions required');
  // Clipped cells can have negative origins and boxes outside the source.
  return Object.freeze({ x: box.x as number, y: box.y as number,
    width: box.width as number, height: box.height as number });
}

function borderSidesFrom(value: unknown): AcquisitionCapture['capture']['borderSides'] {
  if (value === null) return null;
  if (!Array.isArray(value) || value.length !== 4 || Reflect.ownKeys(value).length !== 5) fail('four border sides required');
  for (let index = 0; index < 4; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) fail('border side data required');
  }
  return Object.freeze([alignment(value[0]), alignment(value[1]), alignment(value[2]), alignment(value[3])]);
}

function bounded<T extends AcquisitionCapture | RecognitionCapture>(value: T): T {
  // Only the detached whitelist is serialized; no caller getters/toJSON run.
  if (encoder.encode(JSON.stringify(value)).byteLength > MAX_JSON_BYTES) fail('JSON byte limit');
  return Object.freeze(value);
}

export function parseAcquisitionCapture(input: unknown): AcquisitionCapture {
  const keys = ['version', 'sessionId', 'observationId', 'processingFrame', 'acquisitionFrameId',
    'canonicalSourceFrameId', 'captureTime', 'phase', 'slot', 'pixelKey', 'sourceWidth', 'sourceHeight',
    'fieldRevision', 'cropState', 'cropWidth', 'cropHeight', 'nominalBox', 'contentBox', 'previewBox', 'capture', 'quality'];
  const value = record(input, keys, keys.filter(key => key !== 'cropState'&&key!=='fieldRevision'));
  if (value.version !== 1) fail('version');
  if (value.phase !== 'input' && value.phase !== 'recovery') fail('phase');
  if (!Number.isSafeInteger(value.slot) || (value.slot as number) < 0 || (value.slot as number) >= 40) fail('slot');
  const [sourceWidth, sourceHeight] = raster(value.sourceWidth, value.sourceHeight);
  const hasCropState = Object.hasOwn(value, 'cropState');
  if (hasCropState && value.cropState !== 'materialized' && value.cropState !== 'omitted-resolved') fail('crop state');
  let cropWidth: number | null = null, cropHeight: number | null = null;
  if (value.cropState === 'omitted-resolved') {
    if (value.cropWidth !== null || value.cropHeight !== null) fail('omitted crop dimensions must be null');
  } else [cropWidth, cropHeight] = raster(value.cropWidth, value.cropHeight);
  const capture = record(value.capture, ['stable', 'stabilitySource', 'complete', 'intact', 'labelVisible',
    'borderAlignment', 'borderSides']);
  if (!['still-image', 'settled-fields', 'saved-observation'].includes(capture.stabilitySource as string)) fail('stability source');
  const quality = record(value.quality, ['usable', 'reason', 'sharpness']);
  if (typeof quality.reason !== 'string' || quality.reason.length > 256) fail('quality reason');
  return bounded({ version: 1, sessionId: identifier(value.sessionId), observationId: identifier(value.observationId),
    processingFrame: positive(value.processingFrame), acquisitionFrameId: positive(value.acquisitionFrameId),
    canonicalSourceFrameId: value.canonicalSourceFrameId === null ? null : positive(value.canonicalSourceFrameId),
    captureTime: nonnegative(value.captureTime), phase: value.phase, slot: value.slot as number,
    pixelKey: identifier(value.pixelKey), sourceWidth, sourceHeight,
    ...(Object.hasOwn(value,'fieldRevision')?{fieldRevision:identifier(value.fieldRevision)}:{}),
    ...(hasCropState ? { cropState: value.cropState as AcquisitionCapture['cropState'] } : {}), cropWidth, cropHeight,
    nominalBox: boxFrom(value.nominalBox), contentBox: boxFrom(value.contentBox), previewBox: boxFrom(value.previewBox),
    capture: Object.freeze({ stable: boolean(capture.stable),
      stabilitySource: capture.stabilitySource as AcquisitionCapture['capture']['stabilitySource'],
      complete: nullableBoolean(capture.complete), intact: nullableBoolean(capture.intact),
      labelVisible: nullableBoolean(capture.labelVisible),
      borderAlignment: capture.borderAlignment === null ? null : alignment(capture.borderAlignment),
      borderSides: borderSidesFrom(capture.borderSides) }),
    quality: Object.freeze({ usable: boolean(quality.usable), reason: quality.reason, sharpness: nonnegative(quality.sharpness) }),
  });
}

export function parseRecognitionCapture(input: unknown): RecognitionCapture {
  const value = record(input, ['version', 'invocationId', 'source', 'acquisition', 'processingFrame', 'stage', 'stable',
    'borderAlignment', 'structural', 'fullRead', 'portraitRefinement', 'grayNameFallback', 'cropWidth', 'cropHeight', 'identityPath']);
  if (value.version !== 1) fail('version');
  if (!['visual', 'short', 'full'].includes(value.stage as string)) fail('stage');
  if (!['retained', 'visual-worker', 'visual-reader', 'ocr-reader'].includes(value.identityPath as string)) fail('identity path');
  const sourceValue = record(value.source, ['sessionId', 'frameId', 'observationId', 'captureOrder', 'captureTime', 'phase', 'slot']);
  identifier(sourceValue.sessionId); identifier(sourceValue.observationId);
  // Reuse the execution contract's source parser without adding an execution fact.
  const source = parseObservationFact({ version: 1, source: sourceValue, attemptId: 0, kind: 'queued' }).source;
  let acquisition: RecognitionCapture['acquisition'] = null;
  if (value.acquisition !== null) {
    const tuple = record(value.acquisition, ['sessionId', 'observationId']);
    acquisition = Object.freeze({ sessionId: identifier(tuple.sessionId), observationId: identifier(tuple.observationId) });
    if (acquisition.sessionId !== source.sessionId || acquisition.observationId !== source.observationId) fail('acquisition alias mismatch');
  }
  const borderAlignment = alignment(value.borderAlignment), structural = boolean(value.structural);
  if (structural !== (borderAlignment >= 0.8)) fail('structural alignment mismatch');
  const [cropWidth, cropHeight] = raster(value.cropWidth, value.cropHeight);
  return bounded({ version: 1, invocationId: positive(value.invocationId), source, acquisition,
    processingFrame: positive(value.processingFrame), stage: value.stage as RecognitionCapture['stage'],
    stable: boolean(value.stable), borderAlignment, structural, fullRead: boolean(value.fullRead),
    portraitRefinement: boolean(value.portraitRefinement), grayNameFallback: boolean(value.grayNameFallback),
    cropWidth, cropHeight, identityPath: value.identityPath as RecognitionCapture['identityPath'] });
}
