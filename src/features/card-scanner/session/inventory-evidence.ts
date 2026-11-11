import type { CatalogName } from '../recognition/card-dictionary';
import type { CardSort } from '../recognition/capture-metadata';
import type { ScannedCard } from '../recognition/recognizer-types';
import type { ObservationSource } from './observation-execution';
import { parseObservationFact } from './observation-execution';
import { appendObservation } from './observation-history';
import { consensus, consensusWithRepresentative,recordedNameV1Consensus } from '../recognition/consensus';
import {RECORDED_NAME_V1} from '../recognition/consensus-recorded-name-v1';
export {CURRENT_INVENTORY_CONSENSUS_POLICY} from '../recognition/consensus';
import { confirmSortedNames } from '../recognition/name-confirmation';
import { pendingScanFields, projectCurrentScanFields } from './current-scan-fields';

/** The numeric worker frame ID and the existing capture-position frame key are
 * both retained. They are different identifiers and must not be reconstructed. */
export interface InventorySource extends ObservationSource { readonly frame: string }
interface EventBase { readonly version: 1; readonly source: InventorySource }
export type InventoryEvent =
  | (EventBase & { readonly kind: 'identity-accepted' | 'name-confirmed'; readonly id: string })
  | (EventBase & { readonly kind: 'name-confirmed-label'; readonly id: string; readonly name:string })
  | (EventBase & { readonly kind: 'sort-observed'; readonly id: string; readonly sort: CardSort | null })
  | (EventBase & { readonly kind: 'observation-recorded'; readonly card: ScannedCard; readonly borderAlignment: number });
export type InventoryCardData = Omit<ScannedCard, 'image'>;
export type SerializedInventoryEvent =
  | Exclude<InventoryEvent, {kind: 'observation-recorded'}>
  | (EventBase & {readonly kind: 'observation-recorded'; readonly card: InventoryCardData; readonly borderAlignment: number});

export interface CardEvidenceState {
  readonly id: string;
  readonly observations: readonly ScannedCard[];
  readonly card?: ScannedCard;
  readonly latestIdentityOrder?: number;
  readonly latestIdentitySource?: InventorySource;
  readonly ambiguousIdentityOrder?: number;
  readonly acceptedIdentitySources?: readonly InventorySource[];
  readonly rejectedIdentityOrder?: number;
  readonly confirmedNameOrder?: number;
  readonly confirmedNameBinding?: {readonly source:InventorySource;readonly name:string};
  readonly pendingNameConfirmation?: {readonly source:InventorySource;readonly name:string};
  readonly confirmedFieldOrder?: number;
  readonly latestFieldObservation?: {readonly card: ScannedCard; readonly borderAlignment: number};
  readonly countConflictEvidence?: CountConflictEvidence;
}
type CountConflictEvidence=Readonly<{earliestPositive:InventorySource|null;latestEmpty:InventorySource|null;latestSuperseding:InventorySource|null;
  latestTuple?:Readonly<{source:InventorySource;awakening:number;extraCopies:number}>|null;tupleConflict?:boolean}>;
export type InventoryCountConflictPolicy=Readonly<{version:1|2|3;sessionId:string}>;
export interface InventoryChange {
  readonly card?: ScannedCard;
  readonly appended: boolean;
  readonly latestDiagnostic: boolean;
  readonly fieldsConfirmed: boolean;
  readonly diagnosticResolved: boolean;
  readonly sortUpdated: boolean;
  /** Source proof was absent or evicted; caller must request another view. */
  readonly sourceRejected?: boolean;
  /** Present only for an appended observation when presentation tracking is
   * enabled. This session-local token is not a recognition or replay proof. */
  readonly presentationObservation?:PresentationObservation;
}
/** The source is the exact normalized event input. The token distinguishes
 * separate observations even when their source fields are identical. */
export interface PresentationObservation {
  readonly token:symbol;readonly source:InventorySource;
  /** Session-local index into the append-only observation history. It is an
   * optimization only: the retained observation/token is still checked. */
  readonly historyIndex?:number;
}
/** Null observation means source is unknown, e.g. a historical seed. */
export interface PresentationSelection {readonly generation:number;readonly observation:PresentationObservation|null}
export interface InventoryEvidenceSnapshot {
  readonly version: 1;
  readonly scope: 'inventory-evidence';
  readonly cards: readonly InventoryCardData[];
  readonly evidence: readonly (readonly [string, readonly InventoryCardData[]])[];
  readonly latestIdentityOrder: readonly (readonly [string, number])[];
  readonly latestIdentitySources?: readonly (readonly [string, InventorySource])[];
  readonly ambiguousIdentityOrders?: readonly (readonly [string, number])[];
  readonly acceptedIdentitySources?: readonly (readonly [string, readonly InventorySource[]])[];
  readonly rejectedIdentityOrders?: readonly (readonly [string, number])[];
  readonly confirmedNameOrder: readonly (readonly [string, number])[];
  readonly confirmedNameBindings?: readonly (readonly [string, {readonly source:InventorySource;readonly name:string}])[];
  readonly pendingNameConfirmations?: readonly (readonly [string, {readonly source:InventorySource;readonly name:string}])[];
  readonly confirmedFieldOrder: readonly (readonly [string, number])[];
  /** In insertion order: this order controls the bounded diagnostic eviction. */
  readonly latestFieldObservations: readonly (readonly [string, {readonly card: InventoryCardData; readonly borderAlignment: number}])[];
  readonly countConflictPolicy?:InventoryCountConflictPolicy;
  readonly countConflictEvidence?:readonly (readonly [string,CountConflictEvidence])[];
}
/** Version 1 preserves historical reduction semantics. Version 2 records that
 * the seed came from a prior scan and must not lock later observations.
 * Version 3 also binds a newly confirmed name to the selected name.
 * Version 4 additionally binds identity acceptance to the precise input. */
export type InventorySeedPolicy='prior-run'|'prior-run-v2'|'prior-run-v3';
export type InventoryConsensusPolicy=typeof RECORDED_NAME_V1;
export type InventorySeed =
  | {readonly version:1;readonly cards:readonly InventoryCardData[]}
  | {readonly version:2;readonly seedPolicy:'prior-run';readonly cards:readonly InventoryCardData[]}
  | {readonly version:3;readonly seedPolicy:'prior-run-v2';readonly cards:readonly InventoryCardData[]}
  | {readonly version:4;readonly seedPolicy:'prior-run-v3';readonly cards:readonly InventoryCardData[]}
  | {readonly version:5;readonly seedPolicy:'prior-run-v3';readonly consensusPolicy:InventoryConsensusPolicy;readonly cards:readonly InventoryCardData[]}
  | {readonly version:6;readonly seedPolicy:'prior-run-v3';readonly consensusPolicy:InventoryConsensusPolicy;readonly countConflictPolicy:InventoryCountConflictPolicy;readonly cards:readonly InventoryCardData[]};

export const MAX_INVENTORY_EVENT_BYTES = 1_048_576;
export const MAX_INVENTORY_SNAPSHOT_BYTES = 64 * 1024 * 1024;
const DIAGNOSTIC_LIMIT = 1000;
/** Only concurrently unfinished sources are retained per identity. An evicted
 * source is no longer sufficient to confirm a name or field. */
export const MAX_PENDING_IDENTITY_SOURCES = 64;
const collator = new Intl.Collator('ko');
const CARD_KEYS = ['id', 'name', 'awakening', 'extraCopies', 'confidence', 'review', 'image', 'time', 'observations',
  'manual', 'identitySource', 'maxAwakening', 'captureOrder', 'countReliable', 'countDiagnostics', 'nameEvidence',
  'nameConfirmedBy', 'capturePosition'];
const SOURCE_KEYS = ['sessionId', 'frameId', 'observationId', 'captureOrder', 'captureTime', 'phase', 'slot'];
function fail(message: string): never { throw new Error(`Invalid inventory evidence: ${message}`); }
function object(value: unknown, allowed?: readonly string[], required: readonly string[] = []) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail('plain object required');
  const result = value as Record<string, unknown>;
  if (allowed && Object.keys(result).some(key => !allowed.includes(key)) ||
      required.some(key => !Object.hasOwn(result, key))) fail('unexpected or missing property');
  return result;
}
function finite(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) fail('finite number required');
  return value;
}
function integer(value: unknown, minimum = 0): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) fail('integer required');
  return value as number;
}
function text(value: unknown, limit = 160, empty = false): string {
  if (typeof value !== 'string' || (!empty && !value.length) || value.length > limit) fail('string length');
  return value;
}
function strings(value: unknown, limit = 64): void {
  if (!Array.isArray(value) || value.length > limit) fail('string array');
  for (const entry of value) text(entry, 65_536, true);
}
function bool(value: unknown): void { if (typeof value !== 'boolean') fail('boolean required'); }
function oneOf(value: unknown, choices: readonly string[]): void { if (!choices.includes(value as string)) fail('enum value'); }

/** Detach JSON-shaped metadata without changing array order or silently
 * coercing nonfinite numbers, sparse arrays, null fields or unknown values. */
function detached<T>(value: T, keepUndefined = false): T {
  let nodes = 0;
  const copy = (input: unknown, depth: number): unknown => {
    if (++nodes > 20_000 || depth > 16) fail('metadata size');
    if (input === null || typeof input === 'boolean') return input;
    if (typeof input === 'number') return finite(input);
    if (typeof input === 'string') return input;
    if (Array.isArray(input)) {
      if (input.length > 20_000) fail('array size');
      for (let i = 0; i < input.length; i++) if (!Object.hasOwn(input, i)) fail('sparse array');
      return Object.freeze(input.map(entry => copy(entry, depth + 1)));
    }
    const source = object(input), result: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      if (['__proto__', 'prototype', 'constructor'].includes(key)) fail('object key');
      if (source[key] !== undefined) result[key] = copy(source[key], depth + 1);
      else if (keepUndefined) result[key] = undefined;
    }
    return Object.freeze(result);
  };
  return copy(value, 0) as T;
}

function sourceFrom(value: unknown): InventorySource {
  const input = object(value, [...SOURCE_KEYS, 'frame'], [...SOURCE_KEYS, 'frame']);
  const { frame, ...source } = input;
  const parsed = parseObservationFact({version: 1, kind: 'queued', attemptId: 0, source}).source;
  return Object.freeze({...parsed, frame: text(frame)});
}
function sortFrom(value: unknown): CardSort | null {
  if (value === null) return null;
  const sort = object(value, ['kind', 'direction'], ['kind', 'direction']);
  oneOf(sort.kind, ['name', 'default', 'rarity', 'owned', 'awakening']); oneOf(sort.direction, ['asc', 'desc', 'unknown']);
  return Object.freeze({kind: sort.kind, direction: sort.direction}) as CardSort;
}
function cardFrom(value: unknown, omitImage = false): ScannedCard {
  const card = object(value, CARD_KEYS, ['id', 'name', 'awakening', 'extraCopies', 'confidence', 'review', 'time', 'observations']);
  text(card.id); text(card.name, 1024);
  for (const field of ['awakening', 'extraCopies']) if (card[field] !== null) integer(card[field], -Number.MAX_SAFE_INTEGER);
  finite(card.confidence); finite(card.time); integer(card.observations);
  strings(card.review);
  if (card.captureOrder !== undefined) integer(card.captureOrder);
  if (card.countReliable !== undefined) bool(card.countReliable);
  if (card.maxAwakening !== undefined) integer(card.maxAwakening);
  if (card.manual !== undefined) {
    strings(card.manual, 3);
    for (const field of card.manual as string[]) oneOf(field, ['name', 'awakening', 'extraCopies']);
  }
  if (card.identitySource !== undefined) oneOf(card.identitySource, ['name-pattern', 'artwork', 'dictionary']);
  if (card.nameConfirmedBy !== undefined) oneOf(card.nameConfirmedBy, ['repeat', 'sort']);
  if (card.nameEvidence !== undefined) {
    if (!Array.isArray(card.nameEvidence) || card.nameEvidence.length > 256) fail('name evidence size');
    for (const entry of card.nameEvidence) {
      const proof = object(entry, undefined, ['rawText', 'engine', 'readingId', 'fingerprint', 'ocrConfidence', 'score', 'gap', 'exact']);
      for (const key of ['rawText', 'readingId', 'fingerprint']) text(proof[key], 65_536, true);
      for (const key of ['ocrConfidence', 'score', 'gap']) finite(proof[key]);
      bool(proof.exact); oneOf(proof.engine, ['paddle', 'tesseract', 'artwork']);
      for (const key of ['complete', 'stable', 'nameAmbiguous']) if (proof[key] !== undefined) bool(proof[key]);
      if (proof.frame !== undefined) text(proof.frame);
    }
  }
  if (card.capturePosition !== undefined) {
    const position = object(card.capturePosition, ['frame', 'slot', 'stable', 'sort', 'location'], ['frame', 'slot', 'stable', 'sort']);
    text(position.frame); if (integer(position.slot) >= 40) fail('capture slot'); bool(position.stable);
    sortFrom(position.sort);
  }
  if (card.countDiagnostics !== undefined) {
    const diagnostic = object(card.countDiagnostics, undefined, ['maximum', 'reason', 'readings']);
    finite(diagnostic.maximum); text(diagnostic.reason, 65_536, true);
    if (!Array.isArray(diagnostic.readings) || diagnostic.readings.length > 256) fail('count diagnostics size');
    for (const entry of diagnostic.readings) {
      const reading = object(entry, undefined, ['engine', 'text', 'confidence', 'value']);
      text(reading.engine, 1024, true); text(reading.text, 65_536, true); finite(reading.confidence);
      if (reading.value !== null) finite(reading.value);
    }
  }
  if (card.image !== undefined && typeof card.image !== 'string') fail('image string');
  return detached({...card, image: omitImage ? '' : card.image ?? ''}) as ScannedCard;
}
function normalizedEvent(value: unknown, omitImage: boolean): InventoryEvent {
  const event = object(value, ['version', 'kind', 'source', 'id', 'card', 'borderAlignment', 'sort', 'name'], ['version', 'kind', 'source']);
  if (event.version !== 1) fail('version');
  const source = sourceFrom(event.source);
  if (event.kind === 'sort-observed') {
    if (Object.hasOwn(event, 'card') || Object.hasOwn(event, 'borderAlignment') || Object.hasOwn(event,'name')) fail('sort event payload');
    return Object.freeze({version: 1, kind: event.kind, source, id: text(event.id), sort: sortFrom(event.sort)});
  }
  if (Object.hasOwn(event, 'sort')) fail('unexpected sort payload');
  if (event.kind === 'name-confirmed-label') {
    if (Object.hasOwn(event,'card') || Object.hasOwn(event,'borderAlignment')) fail('identity event payload');
    return Object.freeze({version:1,kind:event.kind,source,id:text(event.id),name:text(event.name)});
  }
  if (event.kind === 'identity-accepted' || event.kind === 'name-confirmed') {
    if (Object.hasOwn(event, 'card') || Object.hasOwn(event, 'borderAlignment') || Object.hasOwn(event,'name')) fail('identity event payload');
    return Object.freeze({version: 1, kind: event.kind, source, id: text(event.id)});
  }
  if (event.kind !== 'observation-recorded' || Object.hasOwn(event, 'id') || Object.hasOwn(event,'name')) fail('event kind or payload');
  const card = cardFrom(event.card, omitImage), position = card.capturePosition;
  if (card.captureOrder !== source.captureOrder || card.time !== source.captureTime ||
      !position || position.frame !== source.frame || position.slot !== source.slot) fail('source/card mismatch');
  return Object.freeze({version: 1, kind: 'observation-recorded', source, card, borderAlignment: finite(event.borderAlignment)});
}
function data(card: ScannedCard): InventoryCardData { const {image: _image, ...rest} = card; return detached(rest); }
function wireEvent(event: InventoryEvent): SerializedInventoryEvent {
  if (event.kind !== 'observation-recorded') return event;
  // normalizedEvent already detached/froze all nested metadata; only the root
  // image key needs removal, not a second traversal of every proof.
  const {image: _image, ...card} = event.card;
  return Object.freeze({...event, card: Object.freeze(card)});
}
function boundedJson(value: unknown, maximum: number, label: string): string {
  const json = JSON.stringify(value);
  if (json.length > maximum || new TextEncoder().encode(json).byteLength > maximum) fail(`${label} byte limit`);
  return json;
}

/** Images alone are omitted. Diagnostics and all identity/field evidence remain
 * unchanged; a replay is an inventory-state check, not an image-render replay. */
export function inventoryEventData(event: InventoryEvent): SerializedInventoryEvent {
  return wireEvent(normalizedEvent(event, true));
}
/** A stable-preview re-read changes the field/identity proof without appending
 * an observation. The live reducer and a replay must see the same mutation, so
 * it is recorded as its own fact. This is a state fact, not a recognition claim. */
export type InventoryPreviewConfirmation =
  | Readonly<{version:1;kind:'preview-field';id:string;order:number}>
  | Readonly<{version:1;kind:'preview-card';card:InventoryCardData;order:number}>;
export function parseInventoryPreviewConfirmation(value: unknown): InventoryPreviewConfirmation {
  if (typeof value === 'string') {
    if (value.length > MAX_INVENTORY_EVENT_BYTES) fail('preview confirmation byte limit');
    value = JSON.parse(value);
  }
  const fact = object(value, ['version', 'kind', 'id', 'card', 'order'], ['version', 'kind', 'order']);
  if (fact.version !== 1) fail('preview confirmation version');
  const order = integer(fact.order);
  if (fact.kind === 'preview-field') {
    if (Object.hasOwn(fact, 'card')) fail('preview field payload');
    return Object.freeze({version: 1, kind: 'preview-field', id: text(fact.id), order});
  }
  if (fact.kind !== 'preview-card' || Object.hasOwn(fact, 'id')) fail('preview confirmation kind');
  return Object.freeze({version: 1, kind: 'preview-card', card: data(cardFrom(fact.card, true)), order});
}
export function serializeInventoryEvent(event: InventoryEvent): string {
  return boundedJson(inventoryEventData(event), MAX_INVENTORY_EVENT_BYTES, 'event');
}
export function parseInventoryEvent(value: unknown): InventoryEvent {
  const encoded = typeof value === 'string';
  if (typeof value === 'string') {
    if (value.length > MAX_INVENTORY_EVENT_BYTES || new TextEncoder().encode(value).byteLength > MAX_INVENTORY_EVENT_BYTES) fail('event byte limit');
    value = JSON.parse(value);
  }
  const event = normalizedEvent(value, true);
  // External object callers must obey the same UTF-8 bound as JSON callers.
  // The live apply()/onEvent path does not serialize every card for this check.
  if (!encoded) boundedJson(wireEvent(event), MAX_INVENTORY_EVENT_BYTES, 'event');
  return event;
}
export function inventorySeedSnapshot(seed: readonly ScannedCard[]): readonly InventoryCardData[] {
  return Object.freeze(seed.map(card => data(cardFrom(card, true))));
}
function normalizedSeed(value: unknown): InventorySeed {
  const seed = object(value, ['version', 'cards', 'seedPolicy','consensusPolicy','countConflictPolicy'], ['version', 'cards']);
  if ((seed.version !== 1 && seed.version !== 2 && seed.version !== 3 && seed.version !== 4 && seed.version !== 5 && seed.version !== 6) ||
      (seed.version === 1 && Object.hasOwn(seed,'seedPolicy')) ||
      (seed.version === 2 && seed.seedPolicy !== 'prior-run') ||
      (seed.version === 3 && seed.seedPolicy !== 'prior-run-v2') ||
      (seed.version === 4 && seed.seedPolicy !== 'prior-run-v3') ||
      ((seed.version === 5||seed.version===6) && (seed.seedPolicy !== 'prior-run-v3'||seed.consensusPolicy!==RECORDED_NAME_V1)) ||
      (seed.version !== 5 && seed.version!==6 && Object.hasOwn(seed,'consensusPolicy')) ||
      (seed.version !== 6 && Object.hasOwn(seed,'countConflictPolicy')) ||
      !Array.isArray(seed.cards) || seed.cards.length > 10_000) fail('seed version or size');
  const ids = new Set<string>();
  const cards = seed.cards.map(input => {
    const card = cardFrom(input, true);
    if (ids.has(card.id)) fail('duplicate seed identity');
    ids.add(card.id); return data(card);
  });
  for (let i = 0; i < seed.cards.length; i++) if (!Object.hasOwn(seed.cards, i)) fail('sparse seed');
  return seed.version===6 ? Object.freeze({version:6,seedPolicy:'prior-run-v3',consensusPolicy:RECORDED_NAME_V1,countConflictPolicy:parseCountConflictPolicy(seed.countConflictPolicy),cards:Object.freeze(cards)})
    : seed.version===5 ? Object.freeze({version:5,seedPolicy:'prior-run-v3',consensusPolicy:RECORDED_NAME_V1,cards:Object.freeze(cards)})
    : seed.version===4 ? Object.freeze({version:4,seedPolicy:'prior-run-v3',cards:Object.freeze(cards)})
    : seed.version===3 ? Object.freeze({version:3,seedPolicy:'prior-run-v2',cards:Object.freeze(cards)})
    : seed.version===2 ? Object.freeze({version:2,seedPolicy:'prior-run',cards:Object.freeze(cards)})
    : Object.freeze({version:1,cards:Object.freeze(cards)});
}
export function parseInventorySeed(value: unknown): InventorySeed {
  const encoded = typeof value === 'string';
  if (typeof value === 'string') {
    if (value.length > MAX_INVENTORY_SNAPSHOT_BYTES || new TextEncoder().encode(value).byteLength > MAX_INVENTORY_SNAPSHOT_BYTES)
      fail('seed byte limit');
    value = JSON.parse(value);
  }
  const seed = normalizedSeed(value);
  if (!encoded) boundedJson(seed, MAX_INVENTORY_SNAPSHOT_BYTES, 'seed');
  return seed;
}
export function serializeInventorySeed(seed: readonly (ScannedCard | InventoryCardData)[],seedPolicy?:InventorySeedPolicy,
  consensusPolicy?:InventoryConsensusPolicy,countConflictPolicy?:InventoryCountConflictPolicy): string {
  const value=countConflictPolicy!==undefined?{version:6,seedPolicy,consensusPolicy,countConflictPolicy,cards:seed}:
    consensusPolicy!==undefined?{version:5,seedPolicy,consensusPolicy,cards:seed}:
    seedPolicy?{version:seedPolicy==='prior-run-v3'?4:seedPolicy==='prior-run-v2'?3:2,seedPolicy,cards:seed}:{version:1,cards:seed};
  return boundedJson(normalizedSeed(value), MAX_INVENTORY_SNAPSHOT_BYTES, 'seed');
}

function parseCountConflictPolicy(value:unknown):InventoryCountConflictPolicy {
  const policy=object(value,['version','sessionId'],['version','sessionId']);
  if(policy.version!==1&&policy.version!==2&&policy.version!==3)fail('count conflict policy version');
  return Object.freeze({version:policy.version,sessionId:text(policy.sessionId)});
}

function validObservedFields(card:ScannedCard):boolean {
  const {awakening,extraCopies,maxAwakening}=card;
  return awakening!==null&&Number.isInteger(awakening)&&awakening>=0&&awakening<=5&&
    (maxAwakening===undefined||Number.isInteger(maxAwakening)&&maxAwakening>=0&&maxAwakening<=5&&awakening<=maxAwakening)&&
    extraCopies!==null&&Number.isInteger(extraCopies)&&extraCopies>=0&&extraCopies<=15-awakening*(awakening+1)/2&&
    card.countReliable===true;
}

function inventoryConsensus(observations:ScannedCard[],priorRunSeed:boolean,trackPresentation:boolean,legacyRepeatCandidate:boolean,
  consensusPolicy?:InventoryConsensusPolicy):
  {card:ScannedCard;representativeIndex?:number} {
  const skipHistoricalSeedIdentity=priorRunSeed&&observations.length>1;
  // Keep the original seed in the state/history while preventing its old
  // manual lock or label from overriding this scan's observed identity.
  const inputs=skipHistoricalSeedIdentity
    ? observations.map((value,index)=>index===0?{...value,manual:undefined}:value):observations;
  // An explicit v5 seed must dispatch to its frozen implementation, never a
  // future default wrapper. Legacy candidate mode is separately gated.
  if(consensusPolicy===RECORDED_NAME_V1)return recordedNameV1Consensus(inputs,{skipHistoricalSeedIdentity},trackPresentation);
  return trackPresentation?consensusWithRepresentative(inputs,{skipHistoricalSeedIdentity,legacyRepeatCandidate}):
    {card:consensus(inputs,{skipHistoricalSeedIdentity,legacyRepeatCandidate})};
}

function sameInventorySource(a:InventorySource,b:InventorySource):boolean {
  return a.sessionId===b.sessionId&&a.frameId===b.frameId&&a.observationId===b.observationId&&
    a.captureOrder===b.captureOrder&&a.captureTime===b.captureTime&&a.phase===b.phase&&a.slot===b.slot&&a.frame===b.frame;
}
/** Different attempts of the same acquired frame and slot do not create a
 * capture-time tie. The pixels are still not treated as independent reads. */
function sameAcquiredSlot(a:InventorySource,b:InventorySource):boolean {
  return a.sessionId===b.sessionId&&a.frameId===b.frameId&&a.captureOrder===b.captureOrder&&
    a.captureTime===b.captureTime&&a.phase===b.phase&&a.slot===b.slot&&a.frame===b.frame;
}

/** Capture order is authoritative. Source fields only break ties for a stable
 * snapshot; tied contradictory readings still create a conflict. */
function orderedSource(a:InventorySource,b:InventorySource):number {
  if(a.captureOrder!==b.captureOrder)return a.captureOrder-b.captureOrder;
  const first=JSON.stringify([a.sessionId,a.frameId,a.observationId,a.captureTime,a.phase,a.slot,a.frame]);
  const second=JSON.stringify([b.sessionId,b.frameId,b.observationId,b.captureTime,b.phase,b.slot,b.frame]);
  return first<second?-1:first>second?1:0;
}
function countConflict(value:CountConflictEvidence|undefined):boolean {
  const emptyConflict=!!value?.earliestPositive&&!!value.latestEmpty&&
    value.earliestPositive.captureOrder<=value.latestEmpty.captureOrder&&
    (!value.latestSuperseding||value.latestSuperseding.captureOrder<=value.latestEmpty.captureOrder);
  // Two reliable tuples from the same capture order may not establish which
  // one is newer. A later valid tuple can settle the contradiction.
  return emptyConflict||value?.tupleConflict===true;
}
function nextCountConflict(before:CountConflictEvidence|undefined,source:InventorySource,card:ScannedCard,policy:InventoryCountConflictPolicy):CountConflictEvidence|undefined {
  if(card.review.length||!validObservedFields(card))return before;
  const diagnostic=card.countDiagnostics;
  // Version 1 is frozen: its fixed-zero fast path required the diagnostic.
  // Version 2 also accepts the visual reader's diagnostic-free game-rule path.
  const fixed=card.extraCopies===0&&(card.awakening===5||card.maxAwakening===0)&&
    (policy.version>=2||diagnostic?.reliability==='fixed-zero');
  const empty=card.extraCopies===0&&!fixed&&
    (policy.version===3||diagnostic?.reliability==='empty-counter'||diagnostic?.reliability==='stable-frame'&&diagnostic.iconPresent===false);
  const positive=card.extraCopies!==null&&card.extraCopies>0;
  if(!positive&&!empty&&!fixed)return before;
  const previous=before??{earliestPositive:null,latestEmpty:null,latestSuperseding:null};
  const earliestPositive=positive&&(!previous.earliestPositive||orderedSource(source,previous.earliestPositive)<0)?source:previous.earliestPositive;
  const latestEmpty=empty&&(!previous.latestEmpty||orderedSource(source,previous.latestEmpty)>0)?source:previous.latestEmpty;
  const latestSuperseding=(positive||fixed)&&(!previous.latestSuperseding||orderedSource(source,previous.latestSuperseding)>0)?source:previous.latestSuperseding;
  if(policy.version!==3)return Object.freeze({earliestPositive,latestEmpty,latestSuperseding});
  let latestTuple=previous.latestTuple??null,tupleConflict=previous.tupleConflict??false;
  if(!latestTuple||source.captureOrder>latestTuple.source.captureOrder){
    latestTuple=Object.freeze({source,awakening:card.awakening!,extraCopies:card.extraCopies!});tupleConflict=false;
  }else if(source.captureOrder===latestTuple.source.captureOrder&&
    (card.awakening!==latestTuple.awakening||card.extraCopies!==latestTuple.extraCopies))tupleConflict=true;
  return Object.freeze({earliestPositive,latestEmpty,latestSuperseding,latestTuple,tupleConflict});
}

function reduceValidated(previous: CardEvidenceState | undefined, event: InventoryEvent,
  policy:{priorRunSeed:boolean;strictFields:boolean;strictNames:boolean;strictSources:boolean;trackPresentation:boolean;legacyRepeatCandidate:boolean;consensusPolicy?:InventoryConsensusPolicy;countConflictPolicy?:InventoryCountConflictPolicy}=
    {priorRunSeed:false,strictFields:false,strictNames:false,strictSources:false,trackPresentation:false,legacyRepeatCandidate:false}):
    {state: CardEvidenceState; change: InventoryChange; representativeIndex?:number} {
  const id = event.kind === 'observation-recorded' ? event.card.id : event.id;
  if (previous && previous.id !== id) fail('card identity changed');
  const before: CardEvidenceState = previous ?? Object.freeze({id, observations: Object.freeze([])});
  const order = event.source.captureOrder;
  const change: InventoryChange = {card: before.card, appended: false, latestDiagnostic: false, fieldsConfirmed: false, diagnosticResolved: false, sortUpdated: false};
  if (event.kind === 'sort-observed') {
    const matches = (card: ScannedCard) => card.id === id && card.captureOrder === order &&
      card.time === event.source.captureTime && card.capturePosition?.frame === event.source.frame &&
      card.capturePosition?.slot === event.source.slot;
    const equal = (sort: CardSort | null | undefined) => sort === event.sort ||
      !!sort && !!event.sort && sort.kind === event.sort.kind && sort.direction === event.sort.direction;
    let changed = false;
    const update = (card: ScannedCard) => {
      if (!matches(card) || equal(card.capturePosition?.sort)) return card;
      changed = true;
      return detached({...card, capturePosition: {...card.capturePosition!, sort: event.sort}}, true);
    };
    const observations = before.observations.map(update);
    // A duplicate observation may be diagnostic-only after append deduplication.
    const diagnostic = before.latestFieldObservation;
    const latestFieldObservation = diagnostic ? Object.freeze({...diagnostic, card: update(diagnostic.card)}) : undefined;
    if (!changed) return {state: before, change};
    const selected = inventoryConsensus(observations,policy.priorRunSeed,policy.trackPresentation,policy.legacyRepeatCandidate,policy.consensusPolicy);
    const card = detached(selected.card, true);
    return {state: Object.freeze({...before, observations: Object.freeze(observations), card,
      ...(latestFieldObservation ? {latestFieldObservation} : {})}),
    change: Object.freeze({...change, card, sortUpdated: true}),representativeIndex:selected.representativeIndex};
  }
  if (event.kind === 'identity-accepted') {
    if(!policy.strictSources)return {
      state: Object.freeze({...before, latestIdentityOrder: Math.max(order, before.latestIdentityOrder ?? -Infinity)}), change,
    };
    const sources=[...(before.acceptedIdentitySources??[])];
    if(!sources.some(source=>sameInventorySource(source,event.source)))sources.push(event.source);
    if(sources.length>MAX_PENDING_IDENTITY_SOURCES)sources.splice(0,sources.length-MAX_PENDING_IDENTITY_SOURCES);
    const latest=before.latestIdentityOrder??-Infinity;
    const newLatest=order>latest;
    const tie=order===latest&&!!before.latestIdentitySource&&!sameAcquiredSlot(before.latestIdentitySource,event.source);
    const ambiguousOrder=newLatest?undefined:tie?order:before.ambiguousIdentityOrder;
    const {latestIdentitySource:_oldSource,ambiguousIdentityOrder:_oldAmbiguity,rejectedIdentityOrder:_oldRejection,
      confirmedNameOrder:_oldName,confirmedNameBinding:_oldBinding,confirmedFieldOrder:_oldField,...rest}=before;
    const keepName=!(tie&&(before.confirmedNameOrder??-Infinity)>=order);
    const keepField=!(tie&&(before.confirmedFieldOrder??-Infinity)>=order);
    return {state:Object.freeze({...rest,latestIdentityOrder:Math.max(order,latest),
      ...(newLatest?{latestIdentitySource:event.source}:before.latestIdentitySource?{latestIdentitySource:before.latestIdentitySource}:{}),
      ...(ambiguousOrder!==undefined?{ambiguousIdentityOrder:ambiguousOrder}:{}),
      ...(before.rejectedIdentityOrder!==undefined&&order<=before.rejectedIdentityOrder?{rejectedIdentityOrder:before.rejectedIdentityOrder}:{}),
      acceptedIdentitySources:Object.freeze(sources),
      ...(keepName&&before.confirmedNameOrder!==undefined?{confirmedNameOrder:before.confirmedNameOrder}:{}),
      ...(keepName&&before.confirmedNameBinding?{confirmedNameBinding:before.confirmedNameBinding}:{}),
      ...(keepField&&before.confirmedFieldOrder!==undefined?{confirmedFieldOrder:before.confirmedFieldOrder}:{})}),change};
  }
  if (before.latestIdentityOrder === undefined || before.latestIdentityOrder < order) fail('identity acceptance missing');
  if(policy.strictSources&&(event.kind==='name-confirmed-label'||event.kind==='observation-recorded')&&
    !before.acceptedIdentitySources?.some(source=>sameInventorySource(source,event.source))){
    // Exact duplicates are idempotent. A reused source cannot introduce a
    // different value or a fresh proof without a new acceptance.
    const binding=before.confirmedNameBinding;
    if(binding&&sameInventorySource(binding.source,event.source)&&before.card?.name===binding.name){
      if(event.kind==='name-confirmed-label'&&event.name===binding.name)return {state:before,change};
      if(event.kind==='observation-recorded'&&event.card.name===binding.name&&
        !appendObservation([...before.observations],event.card))return {state:before,change};
    }
    const {confirmedNameOrder:oldName,confirmedNameBinding:oldBinding,confirmedFieldOrder:oldField,...rest}=before;
    const diagnostic=event.kind==='observation-recorded'&&
      order>=(before.latestFieldObservation?.card.captureOrder??-Infinity)
      ?Object.freeze({card:detached({...event.card,countReliable:false,review:[...event.card.review,'각성·장수 다시 확인']},true),
        borderAlignment:event.borderAlignment}):undefined;
    return {state:Object.freeze({...rest,rejectedIdentityOrder:Math.max(order,before.rejectedIdentityOrder??-Infinity),
      ...(diagnostic?{latestFieldObservation:diagnostic}:{}),
      ...(oldName!==undefined&&oldName!==order?{confirmedNameOrder:oldName,...(oldBinding?{confirmedNameBinding:oldBinding}:{})}:{}),
      ...(oldField!==undefined&&oldField!==order?{confirmedFieldOrder:oldField}:{})}),
      change:Object.freeze({...change,sourceRejected:true,latestDiagnostic:!!diagnostic})};
  }
  if (event.kind === 'name-confirmed') {
    if(policy.strictNames)fail('unbound name confirmation in v3');
    return {
    state: Object.freeze({...before, confirmedNameOrder: Math.max(order, before.confirmedNameOrder ?? -Infinity)}), change,
    };
  }
  if(event.kind==='name-confirmed-label') {
    if(!policy.strictNames)fail('bound name confirmation requires v3');
    const binding=before.confirmedNameBinding;
    if(binding&&before.confirmedNameOrder===order&&binding.name===event.name&&
      before.card?.name===event.name&&sameInventorySource(binding.source,event.source))return {state:before,change};
    const pending=before.pendingNameConfirmation;
    if((pending&&pending.source.captureOrder>order)||(before.confirmedNameOrder??-Infinity)>order)return {state:before,change};
    const {confirmedNameOrder:old,confirmedNameBinding:oldBinding,...rest}=before;
    // A confirmation is not a proof of the displayed name until the same
    // source finishes an observation and consensus selects that exact label.
    return {state:Object.freeze({...rest,...(old!==undefined&&old!==order?{confirmedNameOrder:old,...(oldBinding?{confirmedNameBinding:oldBinding}:{})}:{}),
      pendingNameConfirmation:Object.freeze({source:event.source,name:event.name})}),change};
  }
  if (event.kind !== 'observation-recorded') fail('observation event required');
  const observation = event.card, observations = [...before.observations];
  const appended = appendObservation(observations, observation);
  // Preserve the original seed in history. Only its lock is ignored when
  // choosing values after a new-run observation. An explicit manual event
  // produced during this run keeps its existing precedence.
  const selected = inventoryConsensus(observations,policy.priorRunSeed,policy.trackPresentation,policy.legacyRepeatCandidate,policy.consensusPolicy);
  const card = detached(selected.card, true);
  const latestDiagnostic = order >= (before.latestFieldObservation?.card.captureOrder ?? -Infinity);
  const validFields=policy.strictFields?validObservedFields(observation):
    observation.awakening!==null&&observation.extraCopies!==null&&observation.countReliable===true;
  const tied=policy.strictSources&&(before.ambiguousIdentityOrder===order||
    (before.rejectedIdentityOrder!==undefined&&order<=before.rejectedIdentityOrder));
  const countEvidence=policy.countConflictPolicy?nextCountConflict(before.countConflictEvidence,event.source,observation,policy.countConflictPolicy):undefined;
  const conflict=countConflict(countEvidence);
  const diagnosticResolved = latestDiagnostic && validFields && !tied&&!conflict;
  const fieldsConfirmed = !conflict&&!tied&&observation.review.length === 0 && validFields &&
    (!policy.strictFields||card.awakening===observation.awakening&&card.extraCopies===observation.extraCopies);
  const fieldsChanged=policy.strictFields&&!!before.card&&
    (before.card.awakening!==card.awakening||before.card.extraCopies!==card.extraCopies);
  const priorFields=fieldsChanged?undefined:before.confirmedFieldOrder;
  const candidateFieldProof=fieldsConfirmed?Math.max(order,priorFields??-Infinity):priorFields;
  const conflictOrder=conflict?Math.max(countEvidence?.latestEmpty?.captureOrder??-Infinity,
    countEvidence?.tupleConflict?countEvidence.latestTuple?.source.captureOrder??-Infinity:-Infinity):-Infinity;
  const fieldProof=conflict&&candidateFieldProof!==undefined&&candidateFieldProof>=conflictOrder?undefined:candidateFieldProof;
  const nameChanged=policy.strictFields&&!!before.card&&before.card.name!==card.name;
  // Name proofs carry an order, not a separate selected string. Do not allow a
  // proof of the previous label to certify an older manual label that arrived
  // late. The matching observation can retain its own just-confirmed proof.
  let nameProof=nameChanged?(card.name===observation.name&&before.confirmedNameOrder===order?order:undefined):before.confirmedNameOrder;
  let nameBinding=nameProof===undefined?undefined:before.confirmedNameBinding;
  if(policy.strictNames&&nameProof!==undefined&&(!nameBinding||nameBinding.name!==card.name)){
    nameProof=undefined;nameBinding=undefined;
  }
  const pending=before.pendingNameConfirmation;
  const pendingMatches=policy.strictNames&&!!pending&&sameInventorySource(pending.source,event.source);
  if(!tied&&pendingMatches&&pending.name===observation.name&&card.name===pending.name&&
      !observation.review.includes('이름 확인')&&!observation.review.includes('카드 식별 확인')&&order>=(nameProof??-Infinity)){
    nameProof=order;nameBinding=pending;
  }
  const {confirmedFieldOrder:_oldFields,confirmedNameOrder:_oldName,confirmedNameBinding:_oldBinding,pendingNameConfirmation:_oldPending,
    acceptedIdentitySources:_oldSources,...retained}=before;
  const remainingSources=policy.strictSources?before.acceptedIdentitySources?.filter(source=>!sameInventorySource(source,event.source)):undefined;
  return {
    state: Object.freeze({...retained, observations: Object.freeze(observations), card,
      ...(countEvidence?{countConflictEvidence:countEvidence}:{}),
      ...(latestDiagnostic ? {latestFieldObservation: Object.freeze({card: observation, borderAlignment: event.borderAlignment})} : {}),
      ...(fieldProof!==undefined?{confirmedFieldOrder:fieldProof}:{}),...(nameProof!==undefined?{confirmedNameOrder:nameProof}:{}),
      ...(nameBinding?{confirmedNameBinding:nameBinding}:{}),
      ...(remainingSources?.length?{acceptedIdentitySources:Object.freeze(remainingSources)}:{}),
      ...(!pendingMatches&&pending?{pendingNameConfirmation:pending}:{})}),
    change: Object.freeze({card, appended, latestDiagnostic, fieldsConfirmed, diagnosticResolved, sortUpdated: false}),
    representativeIndex:selected.representativeIndex,
  };
}
/** Per-card deterministic transition. Arrival order is retained intentionally:
 * existing consensus tie-breaking is not claimed to be commutative. */
export function reduceInventoryCard(previous: CardEvidenceState | undefined, event: InventoryEvent) {
  const {state,change}=reduceValidated(previous, normalizedEvent(event, false));
  return {state,change};
}

/** Stable Map identities let existing scanner queries retain their aliases.
 * Only this facade applies events; UI, queue cleanup and pixels stay outside. */
export class InventoryEvidence {
  private readonly states = new Map<string, CardEvidenceState>();
  private readonly cardMap = new Map<string, ScannedCard>();
  private readonly evidenceMap = new Map<string, readonly ScannedCard[]>();
  private readonly latestMap = new Map<string, number>();
  private readonly namesMap = new Map<string, number>();
  private readonly fieldsMap = new Map<string, number>();
  private readonly agreedMap = new Map<string, number>();
  private readonly diagnosticMap = new Map<string, {card: ScannedCard; borderAlignment: number}>();
  private readonly diagnosticSources = new Map<string, InventorySource>();
  private readonly onEvent?: (event: InventoryEvent) => void;
  private readonly onPreviewConfirmation?: (fact: InventoryPreviewConfirmation) => void;
  private replayingPreview = false;
  private readonly seedPolicy?:InventorySeedPolicy;
  private readonly legacyRepeatCandidate:boolean;
  private readonly consensusPolicy?:InventoryConsensusPolicy;
  private readonly countConflictPolicy?:InventoryCountConflictPolicy;
  private readonly priorSeedIds=new Set<string>();
  /** Presentation data is opt-in, session-local and excluded from snapshots. */
  private readonly presentationOrigins?:WeakMap<ScannedCard,PresentationObservation>;
  private readonly presentationSelections?:Map<string,PresentationSelection>;
  private readonly presentationOverflow=new Set<string>();
  constructor(seed: readonly (ScannedCard | InventoryCardData)[] = [], options: {onEvent?: (event: InventoryEvent) => void;onPreviewConfirmation?: (fact: InventoryPreviewConfirmation) => void;seedPolicy?:InventorySeedPolicy;trackPresentation?:boolean;legacyRepeatCandidate?:boolean;consensusPolicy?:InventoryConsensusPolicy;countConflictPolicy?:InventoryCountConflictPolicy} = {}) {
    this.onEvent = options.onEvent;
    this.onPreviewConfirmation = options.onPreviewConfirmation;
    this.seedPolicy=options.seedPolicy;
    if(options.consensusPolicy!==undefined&&options.consensusPolicy!==RECORDED_NAME_V1)throw Error('Unknown inventory consensus policy');
    if(options.legacyRepeatCandidate&&(options.seedPolicy||options.consensusPolicy))throw Error('Legacy comparison requires a v1 seed');
    this.legacyRepeatCandidate=options.legacyRepeatCandidate===true;
    this.consensusPolicy=options.consensusPolicy;
    if(options.countConflictPolicy!==undefined){
      if(options.seedPolicy!=='prior-run-v3'||options.consensusPolicy!==RECORDED_NAME_V1)throw Error('Count conflict policy requires v6 inventory semantics');
      this.countConflictPolicy=parseCountConflictPolicy(options.countConflictPolicy);
    }
    if(options.trackPresentation){this.presentationOrigins=new WeakMap();this.presentationSelections=new Map();}
    for (const input of seed) {
      const card = cardFrom(input), observations = Object.freeze([card]);
      if(this.seedPolicy)this.priorSeedIds.add(card.id);
      this.states.set(card.id, Object.freeze({id: card.id, card, observations}));
      this.cardMap.set(card.id, card); this.evidenceMap.set(card.id, observations);
      this.presentationSelections?.set(card.id,Object.freeze({generation:0,observation:null}));
    }
  }
  get cards(): ReadonlyMap<string, ScannedCard> { return this.cardMap; }
  get evidence(): ReadonlyMap<string, readonly ScannedCard[]> { return this.evidenceMap; }
  get latestIdentityOrder(): ReadonlyMap<string, number> { return this.latestMap; }
  get confirmedNameOrder(): ReadonlyMap<string, number> { return this.namesMap; }
  get confirmedFieldOrder(): ReadonlyMap<string, number> { return this.fieldsMap; }
  /** Orders whose every later field observation repeated the confirmed pair.
   * The map identity is stable so scanner evidence aliases stay current. */
  get agreedFieldOrder(): ReadonlyMap<string, number> { return this.agreedMap; }
  private refreshAgreed(id: string): void {
    const state = this.states.get(id), confirmed = state?.confirmedFieldOrder, card = state?.card,
      latest = this.latestMap.get(id);
    if (!state || confirmed === undefined || !card || latest === undefined || latest <= confirmed ||
        card.awakening === null || card.extraCopies === null) {
      this.agreedMap.delete(id); return;
    }
    // The confirmed capture must still carry a valid observation of this pair.
    // A later consensus change cannot borrow an unrelated proof.
    const confirmedPair = state.observations.some(observation =>
      observation.captureOrder === confirmed && observation.review.length === 0 &&
      validObservedFields(observation) &&
      observation.awakening === card.awakening && observation.extraCopies === card.extraCopies);
    if (!confirmedPair) { this.agreedMap.delete(id); return; }
    // Later captures may fail to read awakening, but they must not contradict
    // either field. The newest capture must still read the same extra copies.
    let newest: ScannedCard | undefined, repeated = confirmed;
    for (const observation of state.observations) {
      const order = observation.captureOrder;
      if (order === undefined) { this.agreedMap.delete(id); return; }
      if (order <= confirmed) continue;
      if (observation.awakening !== null && observation.awakening !== card.awakening) {
        this.agreedMap.delete(id); return;
      }
      if (observation.extraCopies !== null && observation.extraCopies !== card.extraCopies) {
        this.agreedMap.delete(id); return;
      }
      repeated = Math.max(repeated, order);
      if (!newest || order >= newest.captureOrder!) newest = observation;
    }
    if (!newest || newest.extraCopies !== card.extraCopies || repeated < latest) this.agreedMap.delete(id);
    else this.agreedMap.set(id, repeated);
  }
  /** A stable saved preview is the same captured card, not a new observation.
   * Re-reading it can confirm the field proof for that capture order without
   * adding an observation or changing identity/name evidence. */
  confirmPreviewField(id:string, order:number):void {
    if(typeof id!=='string'||!id||!Number.isSafeInteger(order)||order<0)return;
    const previous=this.fieldsMap.get(id);
    if(previous===undefined||order>=previous)this.fieldsMap.set(id,order);
    this.refreshAgreed(id);
    if(!this.replayingPreview)this.onPreviewConfirmation?.(Object.freeze({version:1,kind:'preview-field',id,order}));
  }
  /** Re-apply a recorded preview confirmation without emitting it again. */
  applyPreviewConfirmation(fact: InventoryPreviewConfirmation): void {
    this.replayingPreview = true;
    try {
      if (fact.kind === 'preview-field') this.confirmPreviewField(fact.id, fact.order);
      else this.confirmPreviewCard(fact.card as ScannedCard, fact.order);
    } finally { this.replayingPreview = false; }
  }
  /** Final fixed-row rescue of a missing card. The card already comes from an
   * observed crop with two-frame artwork evidence; no synthetic observation is
   * appended, but the finalized inventory maps must expose the same identity. */
  confirmPreviewCard(card: ScannedCard, order:number):void {
    if(!card||typeof card.id!=='string'||!card.id||!Number.isSafeInteger(order)||order<0)return;
    const latest=this.latestMap.get(card.id);
    if(latest!==undefined&&order<latest)return;
    const frozen=Object.freeze({...card}), observations=Object.freeze([frozen]);
    this.cardMap.set(card.id,frozen);
    this.evidenceMap.set(card.id,observations);
    this.states.set(card.id,Object.freeze({id:card.id,card:frozen,observations}));
    this.latestMap.set(card.id,Math.max(latest??-1,order));
    this.namesMap.set(card.id,Math.max(this.namesMap.get(card.id)??-1,order));
    this.fieldsMap.set(card.id,Math.max(this.fieldsMap.get(card.id)??-1,order));
    this.refreshAgreed(card.id);
    if(!this.replayingPreview)this.onPreviewConfirmation?.(Object.freeze({version:1,kind:'preview-card',card:data(card),order}));
  }
  hasCountConflict(id:string):boolean {return countConflict(this.states.get(id)?.countConflictEvidence);}
  get latestFieldObservations(): ReadonlyMap<string, {card: ScannedCard; borderAlignment: number}> { return this.diagnosticMap; }
  /** Source of the event which last replaced this diagnostic, not a source
   * inferred from a card's order or capture position. Evicted/seed-only
   * diagnostics have no source; this map is not part of replay snapshots. */
  latestFieldObservationSource(id:string):InventorySource|undefined {return this.diagnosticSources.get(id);}
  /** The actual selected observation, never reconstructed from aggregate card
   * captureOrder/position. Null means its source was not recorded (a seed).
   * Tokens only live in this instance and are not pixel or identity proof. */
  presentationSelection(id:string):PresentationSelection|undefined {return this.presentationSelections?.get(id);}
  /** Attach only the preview produced for this exact appended observation.
   * Images are presentation data: no proof, trace event, or replay hash changes.
   * The caller owns cancellation and must not settle after its scan ends. */
  settlePresentationImage(id:string,origin:PresentationObservation|undefined,image:string):boolean {
    const origins=this.presentationOrigins, selections=this.presentationSelections, state=this.states.get(id);
    if(!origins||!selections||!state||!origin||
      !/^data:image\/(?:jpeg|png|webp);base64,[A-Za-z0-9+/]+={0,2}$/i.test(image))return false;
    const index=origin.historyIndex;
    if(!Number.isSafeInteger(index)||index===undefined||index<0||index>=state.observations.length||
      origins.get(state.observations[index])!==origin)return false;
    const previous=state.observations[index];
    // Never replace an already published observation's pixels with a later
    // retry or invent a source for a historical seed.
    if(previous.image)return false;
    const next=Object.freeze({...previous,image});
    const observations=[...state.observations];observations[index]=next;
    const before=selections.get(id);
    if(!before||!state.card)return false;
    const isSelected=before.observation===origin;
    // `consensus` chooses the representative without looking at image bytes.
    // Guard that invariant before replacing only the selected image; a later
    // evidence event will recompute consensus from the updated history.
    if(isSelected&&state.card.image!==previous.image)return false;
    origins.set(next,origin);
    const card=isSelected?Object.freeze({...state.card,image}):state.card;
    const diagnostic=state.latestFieldObservation?.card===previous
      ?Object.freeze({...state.latestFieldObservation,card:next}):state.latestFieldObservation;
    const frozenObservations=Object.freeze(observations);
    this.states.set(id,Object.freeze({...state,observations:frozenObservations,card,
      ...(diagnostic?{latestFieldObservation:diagnostic}:{})}));
    this.evidenceMap.set(id,frozenObservations);this.cardMap.set(id,card);
    if(diagnostic&&this.diagnosticMap.has(id))this.diagnosticMap.set(id,diagnostic);
    return true;
  }
  /** An already confirmed input can make a verified recovery read redundant.
   * This does not authenticate the recovery raster: the caller must first
   * verify its physical source ID, pixel hash and exact crop geometry. */
  hasConfirmedInputForRecovery(id:string,name:string,recovery:InventorySource):boolean {
    const state=this.states.get(id),source=state?.latestIdentitySource,binding=state?.confirmedNameBinding;
    const card=state?.card,fields=state?.latestFieldObservation?.card,order=state?.latestIdentityOrder;
    return this.seedPolicy==='prior-run-v3'&&!!state&&!!source&&!!binding&&!!card&&!!fields&&
      recovery.phase==='recovery'&&source.phase==='input'&&source.sessionId===recovery.sessionId&&
      source.frame===recovery.frame&&source.slot===recovery.slot&&source.captureTime===recovery.captureTime&&
      source.captureOrder===recovery.captureOrder&&order===recovery.captureOrder&&
      sameInventorySource(source,binding.source)&&binding.name===name&&card.name===name&&fields.name===name&&
      state.confirmedNameOrder===order&&state.confirmedFieldOrder===order&&
      state.ambiguousIdentityOrder===undefined&&state.rejectedIdentityOrder===undefined&&!state.pendingNameConfirmation&&
      card.review.length===0&&fields.review.length===0&&card.countReliable===true&&fields.countReliable===true&&
      fields.captureOrder===order&&card.awakening===fields.awakening&&card.extraCopies===fields.extraCopies;
  }
  acceptIdentity(source: InventorySource, id: string) { return this.apply({version: 1, kind: 'identity-accepted', source, id}); }
  confirmName(source: InventorySource, id: string,name?:string) {
    if(this.seedPolicy==='prior-run-v2'||this.seedPolicy==='prior-run-v3')return this.apply({version:1,kind:'name-confirmed-label',source,id,name:name??''});
    return this.apply({version:1,kind:'name-confirmed',source,id});
  }
  recordObservation(source: InventorySource, card: ScannedCard, borderAlignment: number) {
    return this.apply({version: 1, kind: 'observation-recorded', source, card, borderAlignment});
  }
  /** Before record, callers keep the sort on their pending capture position.
   * After record, only an explicit event may update detached historical data. */
  observeSort(source: InventorySource, id: string, sort: CardSort | null): boolean {
    return this.apply({version: 1, kind: 'sort-observed', source, id, sort}).sortUpdated;
  }
  apply(input: InventoryEvent): InventoryChange {
    const event = normalizedEvent(input, false), id = event.kind === 'observation-recorded' ? event.card.id : event.id;
    if(this.countConflictPolicy&&event.source.sessionId!==this.countConflictPolicy.sessionId)fail('count conflict session mismatch');
    const previous=this.states.get(id);
    const {state, change,representativeIndex} = reduceValidated(previous, event,{priorRunSeed:this.priorSeedIds.has(id),strictFields:!!this.seedPolicy,
      strictNames:this.seedPolicy==='prior-run-v2'||this.seedPolicy==='prior-run-v3',strictSources:this.seedPolicy==='prior-run-v3',
      trackPresentation:!!this.presentationOrigins,legacyRepeatCandidate:this.legacyRepeatCandidate,consensusPolicy:this.consensusPolicy,
      countConflictPolicy:this.countConflictPolicy});
    if (event.kind === 'sort-observed' && !change.sortUpdated) return change;
    let presentationObservation:PresentationObservation|undefined;
    if(this.presentationOrigins&&this.presentationSelections){
      if(event.kind==='observation-recorded'&&change.appended){
        presentationObservation=Object.freeze({token:Symbol('presentation-observation'),source:event.source,
          historyIndex:state.observations.length-1});
        this.presentationOrigins.set(event.card,presentationObservation);
      }
      // Sort updates may clone history entries, but do not produce new pixels.
      if(change.sortUpdated&&previous)for(let i=0;i<previous.observations.length;i++){
        const old=previous.observations[i],next=state.observations[i];
        if(old!==next){const origin=this.presentationOrigins.get(old);if(origin)this.presentationOrigins.set(next,origin);}
      }
      if(representativeIndex!==undefined){
        const observation=this.presentationOrigins.get(state.observations[representativeIndex])??null;
        const prior=this.presentationSelections.get(id);
        if(!prior)this.presentationSelections.set(id,Object.freeze({generation:1,observation}));
        else if(!this.presentationOverflow.has(id)&&prior.observation!==observation){
          if(prior.generation===Number.MAX_SAFE_INTEGER){
            this.presentationOverflow.add(id);
            this.presentationSelections.set(id,Object.freeze({generation:prior.generation,observation:null}));
          }else this.presentationSelections.set(id,Object.freeze({generation:prior.generation+1,observation}));
        }
      }
    }
    this.states.set(id, state);
    if (state.card) this.cardMap.set(id, state.card);
    if (state.observations.length) this.evidenceMap.set(id, state.observations);
    if (state.latestIdentityOrder !== undefined) this.latestMap.set(id, state.latestIdentityOrder);
    if (state.confirmedNameOrder !== undefined) this.namesMap.set(id, state.confirmedNameOrder);
    else this.namesMap.delete(id);
    if (state.confirmedFieldOrder !== undefined) this.fieldsMap.set(id, state.confirmedFieldOrder);
    else this.fieldsMap.delete(id);
    this.refreshAgreed(id);
    if (change.latestDiagnostic && state.latestFieldObservation) {
      this.diagnosticMap.delete(id); this.diagnosticMap.set(id, state.latestFieldObservation);
      this.diagnosticSources.set(id,event.source);
      while (this.diagnosticMap.size > DIAGNOSTIC_LIMIT) {
        const oldest = this.diagnosticMap.keys().next().value!;
        this.diagnosticMap.delete(oldest);
        this.diagnosticSources.delete(oldest);
        // Keep the same eviction semantics as the original diagnostic Map:
        // another observation of an evicted ID can become its diagnostic source.
        const {latestFieldObservation: _removed, ...retained} = this.states.get(oldest)!;
        this.states.set(oldest, Object.freeze(retained));
      }
    }
    if (change.sortUpdated && this.diagnosticMap.has(id) && state.latestFieldObservation)
      this.diagnosticMap.set(id, state.latestFieldObservation);
    // Already detached and deeply frozen; callback failures remain observable.
    this.onEvent?.(event);
    return presentationObservation?Object.freeze({...change,presentationObservation}):change;
  }
  project(catalog: CatalogName[], options: {confirmNames?: boolean} = {}) {
    const cards = [...this.cardMap.values()].sort((a, b) => collator.compare(a.name, b.name));
    const named = options.confirmNames === false ? cards : confirmSortedNames(cards, [...this.evidenceMap.values()].flat(), catalog);
    return projectCurrentScanFields(named, {latest: this.latestMap, confirmed: this.fieldsMap, agreed: this.agreedMap});
  }
  pendingFields() { return pendingScanFields(this.diagnosticMap.values(), {latest: this.latestMap, confirmed: this.fieldsMap}); }
  snapshot(): InventoryEvidenceSnapshot {
    const ordered = <T>(map: ReadonlyMap<string, T>) => [...map].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
    const pending=ordered(new Map([...this.states].flatMap(([id,state])=>state.pendingNameConfirmation?[[id,state.pendingNameConfirmation] as const]:[])));
    const bindings=ordered(new Map([...this.states].flatMap(([id,state])=>state.confirmedNameBinding?[[id,state.confirmedNameBinding] as const]:[])));
    const identitySources=ordered(new Map([...this.states].flatMap(([id,state])=>state.latestIdentitySource?[[id,state.latestIdentitySource] as const]:[])));
    const ambiguities=ordered(new Map([...this.states].flatMap(([id,state])=>state.ambiguousIdentityOrder!==undefined?[[id,state.ambiguousIdentityOrder] as const]:[])));
    const acceptedSources=ordered(new Map([...this.states].flatMap(([id,state])=>state.acceptedIdentitySources?.length?[[id,state.acceptedIdentitySources] as const]:[])));
    const rejected=ordered(new Map([...this.states].flatMap(([id,state])=>state.rejectedIdentityOrder!==undefined?[[id,state.rejectedIdentityOrder] as const]:[])));
    const countEvidence=this.countConflictPolicy?ordered(new Map([...this.states].flatMap(([id,state])=>state.countConflictEvidence?[[id,state.countConflictEvidence] as const]:[]))):undefined;
    const snapshot = {
      version: 1 as const, scope: 'inventory-evidence' as const,
      cards: Object.freeze(ordered(this.cardMap).map(([, card]) => data(card))),
      evidence: Object.freeze(ordered(this.evidenceMap).map(([id, cards]) => Object.freeze([id, Object.freeze(cards.map(data))] as const))),
      latestIdentityOrder: Object.freeze(ordered(this.latestMap).map(entry => Object.freeze(entry))),
      ...(identitySources.length?{latestIdentitySources:Object.freeze(identitySources.map(entry=>Object.freeze(entry)))}:{}),
      ...(ambiguities.length?{ambiguousIdentityOrders:Object.freeze(ambiguities.map(entry=>Object.freeze(entry)))}:{}),
      ...(acceptedSources.length?{acceptedIdentitySources:Object.freeze(acceptedSources.map(entry=>Object.freeze(entry)))}:{}),
      ...(rejected.length?{rejectedIdentityOrders:Object.freeze(rejected.map(entry=>Object.freeze(entry)))}:{}),
      confirmedNameOrder: Object.freeze(ordered(this.namesMap).map(entry => Object.freeze(entry))),
      ...(bindings.length?{confirmedNameBindings:Object.freeze(bindings.map(entry=>Object.freeze(entry)))}:{}),
      ...(pending.length?{pendingNameConfirmations:Object.freeze(pending.map(entry=>Object.freeze(entry)))}:{}),
      confirmedFieldOrder: Object.freeze(ordered(this.fieldsMap).map(entry => Object.freeze(entry))),
      latestFieldObservations: Object.freeze([...this.diagnosticMap].map(([id, {card, borderAlignment}]) =>
        Object.freeze([id, Object.freeze({card: data(card), borderAlignment})] as const))),
      ...(this.countConflictPolicy?{countConflictPolicy:this.countConflictPolicy,countConflictEvidence:Object.freeze(countEvidence!.map(entry=>Object.freeze(entry)))}:{}),
    };
    // Only snapshots traverse the complete history. Hot-path events touch one ID.
    const json = JSON.stringify(snapshot);
    if (new TextEncoder().encode(json).byteLength > MAX_INVENTORY_SNAPSHOT_BYTES) fail('snapshot byte limit');
    return Object.freeze(snapshot);
  }
}

export function replayInventoryEvidence(seed: readonly (ScannedCard | InventoryCardData)[], events: Iterable<unknown>,
  options:{seedPolicy?:InventorySeedPolicy;consensusPolicy?:InventoryConsensusPolicy;countConflictPolicy?:InventoryCountConflictPolicy}={}) {
  const inventory = new InventoryEvidence(seed,options);
  for (const event of events) inventory.apply(parseInventoryEvent(event));
  return inventory;
}
export async function hashInventoryEvidence(snapshot: InventoryEvidenceSnapshot): Promise<string> {
  if (snapshot.version !== 1 || snapshot.scope !== 'inventory-evidence') fail('snapshot version or scope');
  const bytes = new TextEncoder().encode(JSON.stringify(snapshot));
  if (bytes.byteLength > MAX_INVENTORY_SNAPSHOT_BYTES) fail('snapshot byte limit');
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return Array.from(digest, value => value.toString(16).padStart(2, '0')).join('');
}
