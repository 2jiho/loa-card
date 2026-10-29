/** Metadata from one sequential decoder iterator. These receipts do not prove
 * original-container frame indices, pixel identity, capture clocks or results. */
export interface MediaSource {
  readonly sourceId: string;
  readonly kind: 'blob-object' | 'url-request';
  readonly bytes: number | null;
  readonly mimeType: string | null;
  readonly integrity: 'object-identity-only';
}

export type MediaRole = 'original-file' | 're-recorded-video' | 'unknown';
interface MediaSequenceIdentity {
  readonly version: 1;
  readonly sequenceId: string;
  readonly sourceId: string;
  readonly role: MediaRole;
}
export interface MediaSequenceStart extends MediaSequenceIdentity {
  readonly kind: 'start';
  readonly source: MediaSource;
  /** Caller label only; it establishes no relation between clocks or frames. */
  readonly parentCaptureSessionId: string | null;
}
export interface MediaDecodedFrame extends MediaSequenceIdentity {
  readonly kind: 'frame';
  /** Count of values yielded by this iterator, never a container frame index. */
  readonly ordinal: number;
  readonly pts: number;
  readonly duration: number | null;
  readonly trackId: number | null;
}
export interface MediaSequenceEnd extends MediaSequenceIdentity {
  readonly kind: 'end';
  readonly frames: number;
  readonly complete: boolean;
  readonly reason: 'eof' | 'returned' | 'aborted' | 'error';
}
export type MediaLineageFact = MediaSequenceStart | MediaDecodedFrame | MediaSequenceEnd;
/** A decoder use receipt. Acquisition identity is supplied by its owner; this
 * does not infer a link by comparing PTS or joining unrelated clocks. */
export interface MediaInputLink extends MediaSequenceIdentity {
  readonly ordinal: number;
  readonly processingFrame: number;
  readonly acquisitionFrameId: number;
  readonly captureTime: number;
  readonly phase: 'input' | 'recovery';
}
export interface MediaLineageOptions {
  readonly role: MediaRole;
  readonly parentCaptureSessionId?: string | null;
  readonly onFact?: (fact: MediaLineageFact) => void;
  readonly onError?: (error: unknown) => void;
}

const MAX_ID_LENGTH = 160;
const MAX_MIME_LENGTH = 128;
const MAX_JSON_BYTES = 8_192;
const encoder = new TextEncoder();
// This map never keeps a Blob alive and never associates equal bytes or URLs.
const blobSourceIds = new WeakMap<Blob, string>();
const identityKeys = ['version', 'sequenceId', 'sourceId', 'role', 'kind'];

function fail(detail: string): never {
  throw new TypeError(`Invalid media lineage: ${detail}`);
}

function record(input: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(input))) fail('plain object required');
  const value = input as Record<string, unknown>;
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.some(key => typeof key !== 'string' || !keys.includes(key)) ||
    keys.some(key => !Object.hasOwn(value, key))) fail('unexpected or missing property');
  for (const key of ownKeys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    if (!('value' in descriptor) || !descriptor.enumerable) fail('own enumerable data required');
  }
  return value;
}

function text(value: unknown, maximum: number, empty = false): string {
  if (typeof value !== 'string' || (!empty && !value.length) || value.length > maximum) fail('text bounds');
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code < 32 || code >= 127 && code <= 159) fail('control character');
  }
  return value;
}

function integer(value: unknown, minimum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) fail('safe integer bounds');
  return value as number;
}

function finite(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) fail('finite number required');
  return value;
}

function duration(value: unknown): number | null {
  if (value === null) return null;
  const result = finite(value);
  if (result < 0) fail('nonnegative duration required');
  return result;
}

function identity(value: Record<string, unknown>): MediaSequenceIdentity {
  if (value.version !== 1) fail('version');
  if (!['original-file', 're-recorded-video', 'unknown'].includes(value.role as string)) fail('role');
  return { version: 1, sequenceId: text(value.sequenceId, MAX_ID_LENGTH),
    sourceId: text(value.sourceId, MAX_ID_LENGTH), role: value.role as MediaRole };
}

function bounded<T extends MediaSource | MediaLineageFact | MediaInputLink>(value: T): T {
  // Serialize only a detached whitelist; caller getters and toJSON never run.
  if (encoder.encode(JSON.stringify(value)).byteLength > MAX_JSON_BYTES) fail('JSON byte limit');
  return Object.freeze(value);
}

export function parseMediaSource(input: unknown): MediaSource {
  const value = record(input, ['sourceId', 'kind', 'bytes', 'mimeType', 'integrity']);
  if (!['blob-object', 'url-request'].includes(value.kind as string)) fail('source kind');
  if (value.integrity !== 'object-identity-only') fail('source integrity');
  if (value.kind === 'url-request' && (value.bytes !== null || value.mimeType !== null)) fail('URL metadata must be unknown');
  if (value.kind === 'blob-object' && value.bytes === null) fail('Blob byte size required');
  return bounded({ sourceId: text(value.sourceId, MAX_ID_LENGTH), kind: value.kind as MediaSource['kind'],
    bytes: value.bytes === null ? null : integer(value.bytes, 1),
    mimeType: value.mimeType === null ? null : text(value.mimeType, MAX_MIME_LENGTH, true),
    integrity: 'object-identity-only' });
}

export function parseMediaSequenceStart(input: unknown): MediaSequenceStart {
  const value = record(input, [...identityKeys, 'source', 'parentCaptureSessionId']);
  if (value.kind !== 'start') fail('start kind');
  const ids = identity(value), source = parseMediaSource(value.source);
  if (ids.sourceId !== source.sourceId) fail('source identity mismatch');
  return bounded({ ...ids, kind: 'start', source,
    parentCaptureSessionId: value.parentCaptureSessionId === null ? null : text(value.parentCaptureSessionId, MAX_ID_LENGTH) });
}

export function parseMediaDecodedFrame(input: unknown): MediaDecodedFrame {
  const value = record(input, [...identityKeys, 'ordinal', 'pts', 'duration', 'trackId']);
  if (value.kind !== 'frame') fail('frame kind');
  return bounded({ ...identity(value), kind: 'frame', ordinal: integer(value.ordinal, 1), pts: finite(value.pts),
    duration: duration(value.duration), trackId: value.trackId === null ? null : integer(value.trackId, 0) });
}

export function parseMediaSequenceEnd(input: unknown): MediaSequenceEnd {
  const value = record(input, [...identityKeys, 'frames', 'complete', 'reason']);
  if (value.kind !== 'end') fail('end kind');
  if (!['eof', 'returned', 'aborted', 'error'].includes(value.reason as string)) fail('end reason');
  if (typeof value.complete !== 'boolean' || value.complete !== (value.reason === 'eof')) fail('end completeness');
  return bounded({ ...identity(value), kind: 'end', frames: integer(value.frames, 0),
    complete: value.complete, reason: value.reason as MediaSequenceEnd['reason'] });
}

export function parseMediaLineageFact(input: unknown): MediaLineageFact {
  // Inspect the discriminator without executing accessors. Each branch then
  // checks its complete, exact whitelist, including non-enumerable keys.
  if (!input || typeof input !== 'object') fail('fact object required');
  const descriptor = Object.getOwnPropertyDescriptor(input, 'kind');
  if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) fail('fact discriminator');
  switch (descriptor.value) {
    case 'start': return parseMediaSequenceStart(input);
    case 'frame': return parseMediaDecodedFrame(input);
    case 'end': return parseMediaSequenceEnd(input);
    default: return fail('fact kind');
  }
}

export function parseMediaInputLink(input: unknown): MediaInputLink {
  const value = record(input, ['version', 'sequenceId', 'sourceId', 'role', 'ordinal',
    'processingFrame', 'acquisitionFrameId', 'captureTime', 'phase']);
  if (value.phase !== 'input' && value.phase !== 'recovery') fail('input phase');
  const captureTime = finite(value.captureTime);
  if (captureTime < 0) fail('nonnegative capture time required');
  return bounded({ ...identity(value), ordinal: integer(value.ordinal, 1),
    processingFrame: integer(value.processingFrame, 1), acquisitionFrameId: integer(value.acquisitionFrameId, 1),
    captureTime, phase: value.phase });
}

export function mediaSourceFor(source: Blob | string): MediaSource {
  if (typeof source === 'string') {
    // A new request identity every time: do not store, compare or serialize URLs.
    return parseMediaSource({ sourceId: crypto.randomUUID(), kind: 'url-request', bytes: null,
      mimeType: null, integrity: 'object-identity-only' });
  }
  // Intrinsic getters read immutable Blob state even for a subclass or an own
  // size/type override; never read file names, paths, bytes or caller getters.
  const bytes = Object.getOwnPropertyDescriptor(Blob.prototype, 'size')!.get!.call(source) as number;
  const mimeType = Object.getOwnPropertyDescriptor(Blob.prototype, 'type')!.get!.call(source) as string;
  let sourceId = blobSourceIds.get(source);
  if (!sourceId) { sourceId = crypto.randomUUID(); blobSourceIds.set(source, sourceId); }
  return parseMediaSource({ sourceId, kind: 'blob-object', bytes, mimeType, integrity: 'object-identity-only' });
}

export function createMediaSequenceStart(source: Blob | string,
  options: Pick<MediaLineageOptions, 'role' | 'parentCaptureSessionId'>): MediaSequenceStart {
  const metadata = mediaSourceFor(source);
  return parseMediaSequenceStart({ version: 1, kind: 'start', sequenceId: crypto.randomUUID(),
    sourceId: metadata.sourceId, source: metadata, role: options.role,
    parentCaptureSessionId: options.parentCaptureSessionId ?? null });
}

export function createMediaDecodedFrame(start: MediaSequenceStart, ordinal: number, pts: number,
  decodeSample?: { trackId: number | null; duration: number | null }): MediaDecodedFrame {
  const sample = decodeSample === undefined ? null : record(decodeSample, ['trackId', 'duration']);
  return parseMediaDecodedFrame({ version: 1, kind: 'frame', sequenceId: start.sequenceId,
    sourceId: start.sourceId, role: start.role, ordinal, pts,
    duration: sample ? sample.duration : null, trackId: sample ? sample.trackId : null });
}

export function createMediaSequenceEnd(start: MediaSequenceStart, frames: number,
  reason: MediaSequenceEnd['reason']): MediaSequenceEnd {
  return parseMediaSequenceEnd({ version: 1, kind: 'end', sequenceId: start.sequenceId,
    sourceId: start.sourceId, role: start.role, frames, complete: reason === 'eof', reason });
}

/** A pull-through wrapper: no seek, filtering, sorting, prefetch or native-frame
 * copying. The shallow envelope preserves own descriptors/native references
 * without evaluating unrelated fields such as lazy pixel getters.
 * Diagnostic failures report once and suppress later facts, while valid later
 * frames may still carry lineage. Invalid sample metadata passes through the
 * original frame without fabricating coordinates or changing recognition. */
export async function* withMediaLineage<T extends { time: number;
  decodeSample?: { trackId: number | null; duration: number | null } }>(
  frames: AsyncIterable<T>, source: Blob | string, signal: AbortSignal,
  options: MediaLineageOptions): AsyncGenerator<T & { lineage?: MediaDecodedFrame }> {
  let diagnosticFailed = false;
  const report = (error: unknown) => {
    if (diagnosticFailed) return;
    diagnosticFailed = true;
    try {
      // Async sinks are not awaited and cannot stall recognition; rejected
      // promises are still observed without keeping a growing pending list.
      const result = options.onError?.(error) as unknown;
      if (result !== undefined) void Promise.resolve(result).catch(() => {});
    } catch { /* Diagnostic reporting must never fail recognition. */ }
  };
  const emit = (fact: MediaLineageFact) => {
    if (diagnosticFailed) return;
    try {
      const result = options.onFact?.(fact) as unknown;
      if (result !== undefined) void Promise.resolve(result).catch(report);
    } catch (error) { report(error); }
  };
  let start: MediaSequenceStart | undefined;
  try { start = createMediaSequenceStart(source, options); emit(start); }
  catch (error) { report(error); }
  let iterator: AsyncIterator<T> | undefined;
  let count = 0, reachedEof = false, sourceFailed = false;
  let reason: MediaSequenceEnd['reason'] = 'returned';
  const finish = async () => {
    if (!reachedEof && signal.aborted) reason = 'aborted';
    let cleanupFailed = false, cleanupError: unknown;
    if (iterator && !reachedEof) {
      try { await iterator.return?.(); }
      catch (error) {
        cleanupFailed = true; cleanupError = error;
        reason = signal.aborted ? 'aborted' : 'error';
      }
    }
    if (start) {
      try { emit(createMediaSequenceEnd(start, count, reason)); }
      catch (error) { report(error); }
    }
    // A return-cleanup failure rejects an early return, but never replaces a
    // decoder/consumer error already propagating through the wrapper.
    if (cleanupFailed && !sourceFailed) throw cleanupError;
  };
  try {
    iterator = frames[Symbol.asyncIterator]();
    while (true) {
      signal.throwIfAborted();
      const next = await iterator.next();
      signal.throwIfAborted();
      if (next.done) { reachedEof = true; reason = 'eof'; break; }
      count++;
      let output: T & { lineage?: MediaDecodedFrame } = next.value;
      let lineage: MediaDecodedFrame | undefined;
      try {
        if (start) lineage = createMediaDecodedFrame(start, count, next.value.time, next.value.decodeSample);
      } catch (error) { report(error); }
      try {
        if (lineage || 'lineage' in next.value) {
          const descriptors: PropertyDescriptorMap = Object.getOwnPropertyDescriptors(next.value);
          // An invalid diagnostic can never expose a caller's stale lineage,
          // including an inherited one. Native objects remain referenced only.
          descriptors.lineage = { value: lineage, enumerable: true, configurable: true, writable: true };
          output = Object.create(Object.getPrototypeOf(next.value), descriptors) as T & { lineage: MediaDecodedFrame };
        }
      } catch (error) {
        report(error);
        // If a nonstandard descriptor/prototype trap fails, shadow the reserved
        // property without reading any original pixel fields or stale metadata.
        output = Object.create(next.value, { lineage: { value: undefined, enumerable: true } }) as T;
      }
      if (lineage) emit(lineage);
      yield output;
    }
  } catch (error) {
    sourceFailed = true;
    reason = signal.aborted ? 'aborted' : 'error';
    throw error;
  } finally {
    await finish();
  }
}
