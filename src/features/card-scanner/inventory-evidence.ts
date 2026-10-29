import type { CatalogName } from './card-dictionary';
import type { CardSort } from './capture-metadata';
import type { ScannedCard } from './recognizer';
import type { ObservationSource } from './observation-execution';
import { parseObservationFact } from './observation-execution';
import { appendObservation } from './observation-history';
import { consensus } from './consensus';
import { confirmSortedNames } from './name-confirmation';
import { pendingScanFields, projectCurrentScanFields } from './current-scan-fields';

/** The numeric worker frame ID and the existing capture-position frame key are
 * both retained. They are different identifiers and must not be reconstructed. */
export interface InventorySource extends ObservationSource { readonly frame: string }
interface EventBase { readonly version: 1; readonly source: InventorySource }
export type InventoryEvent =
  | (EventBase & { readonly kind: 'identity-accepted' | 'name-confirmed'; readonly id: string })
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
  readonly confirmedNameOrder?: number;
  readonly confirmedFieldOrder?: number;
  readonly latestFieldObservation?: {readonly card: ScannedCard; readonly borderAlignment: number};
}
export interface InventoryChange {
  readonly card?: ScannedCard;
  readonly appended: boolean;
  readonly latestDiagnostic: boolean;
  readonly fieldsConfirmed: boolean;
  readonly diagnosticResolved: boolean;
  readonly sortUpdated: boolean;
}
export interface InventoryEvidenceSnapshot {
  readonly version: 1;
  readonly scope: 'inventory-evidence';
  readonly cards: readonly InventoryCardData[];
  readonly evidence: readonly (readonly [string, readonly InventoryCardData[]])[];
  readonly latestIdentityOrder: readonly (readonly [string, number])[];
  readonly confirmedNameOrder: readonly (readonly [string, number])[];
  readonly confirmedFieldOrder: readonly (readonly [string, number])[];
  /** In insertion order: this order controls the bounded diagnostic eviction. */
  readonly latestFieldObservations: readonly (readonly [string, {readonly card: InventoryCardData; readonly borderAlignment: number}])[];
}
export interface InventorySeed { readonly version: 1; readonly cards: readonly InventoryCardData[] }

export const MAX_INVENTORY_EVENT_BYTES = 1_048_576;
export const MAX_INVENTORY_SNAPSHOT_BYTES = 64 * 1024 * 1024;
const DIAGNOSTIC_LIMIT = 1000;
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
      for (const key of ['complete', 'stable']) if (proof[key] !== undefined) bool(proof[key]);
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
  const event = object(value, ['version', 'kind', 'source', 'id', 'card', 'borderAlignment', 'sort'], ['version', 'kind', 'source']);
  if (event.version !== 1) fail('version');
  const source = sourceFrom(event.source);
  if (event.kind === 'sort-observed') {
    if (Object.hasOwn(event, 'card') || Object.hasOwn(event, 'borderAlignment')) fail('sort event payload');
    return Object.freeze({version: 1, kind: event.kind, source, id: text(event.id), sort: sortFrom(event.sort)});
  }
  if (Object.hasOwn(event, 'sort')) fail('unexpected sort payload');
  if (event.kind === 'identity-accepted' || event.kind === 'name-confirmed') {
    if (Object.hasOwn(event, 'card') || Object.hasOwn(event, 'borderAlignment')) fail('identity event payload');
    return Object.freeze({version: 1, kind: event.kind, source, id: text(event.id)});
  }
  if (event.kind !== 'observation-recorded' || Object.hasOwn(event, 'id')) fail('event kind or payload');
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
  const seed = object(value, ['version', 'cards'], ['version', 'cards']);
  if (seed.version !== 1 || !Array.isArray(seed.cards) || seed.cards.length > 10_000) fail('seed version or size');
  const ids = new Set<string>();
  const cards = seed.cards.map(input => {
    const card = cardFrom(input, true);
    if (ids.has(card.id)) fail('duplicate seed identity');
    ids.add(card.id); return data(card);
  });
  for (let i = 0; i < seed.cards.length; i++) if (!Object.hasOwn(seed.cards, i)) fail('sparse seed');
  return Object.freeze({version: 1, cards: Object.freeze(cards)});
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
export function serializeInventorySeed(seed: readonly (ScannedCard | InventoryCardData)[]): string {
  return boundedJson(normalizedSeed({version: 1, cards: seed}), MAX_INVENTORY_SNAPSHOT_BYTES, 'seed');
}

function reduceValidated(previous: CardEvidenceState | undefined, event: InventoryEvent): {state: CardEvidenceState; change: InventoryChange} {
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
    const card = detached(consensus(observations), true);
    return {state: Object.freeze({...before, observations: Object.freeze(observations), card,
      ...(latestFieldObservation ? {latestFieldObservation} : {})}),
    change: Object.freeze({...change, card, sortUpdated: true})};
  }
  if (event.kind === 'identity-accepted') return {
    state: Object.freeze({...before, latestIdentityOrder: Math.max(order, before.latestIdentityOrder ?? -Infinity)}), change,
  };
  if (before.latestIdentityOrder === undefined || before.latestIdentityOrder < order) fail('identity acceptance missing');
  if (event.kind === 'name-confirmed') return {
    state: Object.freeze({...before, confirmedNameOrder: Math.max(order, before.confirmedNameOrder ?? -Infinity)}), change,
  };
  if (event.kind !== 'observation-recorded') fail('observation event required');
  const observation = event.card, observations = [...before.observations];
  const appended = appendObservation(observations, observation);
  const card = detached(consensus(observations), true);
  const latestDiagnostic = order >= (before.latestFieldObservation?.card.captureOrder ?? -Infinity);
  const diagnosticResolved = latestDiagnostic && observation.awakening !== null && observation.extraCopies !== null && observation.countReliable === true;
  const fieldsConfirmed = observation.review.length === 0 && observation.awakening !== null &&
    observation.extraCopies !== null && observation.countReliable === true;
  return {
    state: Object.freeze({...before, observations: Object.freeze(observations), card,
      ...(latestDiagnostic ? {latestFieldObservation: Object.freeze({card: observation, borderAlignment: event.borderAlignment})} : {}),
      ...(fieldsConfirmed ? {confirmedFieldOrder: Math.max(order, before.confirmedFieldOrder ?? -Infinity)} : {})}),
    change: Object.freeze({card, appended, latestDiagnostic, fieldsConfirmed, diagnosticResolved, sortUpdated: false}),
  };
}
/** Per-card deterministic transition. Arrival order is retained intentionally:
 * existing consensus tie-breaking is not claimed to be commutative. */
export function reduceInventoryCard(previous: CardEvidenceState | undefined, event: InventoryEvent) {
  return reduceValidated(previous, normalizedEvent(event, false));
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
  private readonly diagnosticMap = new Map<string, {card: ScannedCard; borderAlignment: number}>();
  private readonly onEvent?: (event: InventoryEvent) => void;
  constructor(seed: readonly (ScannedCard | InventoryCardData)[] = [], options: {onEvent?: (event: InventoryEvent) => void} = {}) {
    this.onEvent = options.onEvent;
    for (const input of seed) {
      const card = cardFrom(input), observations = Object.freeze([card]);
      this.states.set(card.id, Object.freeze({id: card.id, card, observations}));
      this.cardMap.set(card.id, card); this.evidenceMap.set(card.id, observations);
    }
  }
  get cards(): ReadonlyMap<string, ScannedCard> { return this.cardMap; }
  get evidence(): ReadonlyMap<string, readonly ScannedCard[]> { return this.evidenceMap; }
  get latestIdentityOrder(): ReadonlyMap<string, number> { return this.latestMap; }
  get confirmedNameOrder(): ReadonlyMap<string, number> { return this.namesMap; }
  get confirmedFieldOrder(): ReadonlyMap<string, number> { return this.fieldsMap; }
  get latestFieldObservations(): ReadonlyMap<string, {card: ScannedCard; borderAlignment: number}> { return this.diagnosticMap; }
  acceptIdentity(source: InventorySource, id: string) { return this.apply({version: 1, kind: 'identity-accepted', source, id}); }
  confirmName(source: InventorySource, id: string) { return this.apply({version: 1, kind: 'name-confirmed', source, id}); }
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
    const {state, change} = reduceValidated(this.states.get(id), event);
    if (event.kind === 'sort-observed' && !change.sortUpdated) return change;
    this.states.set(id, state);
    if (state.card) this.cardMap.set(id, state.card);
    if (state.observations.length) this.evidenceMap.set(id, state.observations);
    if (state.latestIdentityOrder !== undefined) this.latestMap.set(id, state.latestIdentityOrder);
    if (state.confirmedNameOrder !== undefined) this.namesMap.set(id, state.confirmedNameOrder);
    if (state.confirmedFieldOrder !== undefined) this.fieldsMap.set(id, state.confirmedFieldOrder);
    if (change.latestDiagnostic && state.latestFieldObservation) {
      this.diagnosticMap.delete(id); this.diagnosticMap.set(id, state.latestFieldObservation);
      while (this.diagnosticMap.size > DIAGNOSTIC_LIMIT) {
        const oldest = this.diagnosticMap.keys().next().value!;
        this.diagnosticMap.delete(oldest);
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
    return change;
  }
  project(catalog: CatalogName[], options: {confirmNames?: boolean} = {}) {
    const cards = [...this.cardMap.values()].sort((a, b) => collator.compare(a.name, b.name));
    const named = options.confirmNames === false ? cards : confirmSortedNames(cards, [...this.evidenceMap.values()].flat(), catalog);
    return projectCurrentScanFields(named, {latest: this.latestMap, confirmed: this.fieldsMap});
  }
  pendingFields() { return pendingScanFields(this.diagnosticMap.values(), {latest: this.latestMap, confirmed: this.fieldsMap}); }
  snapshot(): InventoryEvidenceSnapshot {
    const ordered = <T>(map: ReadonlyMap<string, T>) => [...map].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
    const snapshot = {
      version: 1 as const, scope: 'inventory-evidence' as const,
      cards: Object.freeze(ordered(this.cardMap).map(([, card]) => data(card))),
      evidence: Object.freeze(ordered(this.evidenceMap).map(([id, cards]) => Object.freeze([id, Object.freeze(cards.map(data))] as const))),
      latestIdentityOrder: Object.freeze(ordered(this.latestMap).map(entry => Object.freeze(entry))),
      confirmedNameOrder: Object.freeze(ordered(this.namesMap).map(entry => Object.freeze(entry))),
      confirmedFieldOrder: Object.freeze(ordered(this.fieldsMap).map(entry => Object.freeze(entry))),
      latestFieldObservations: Object.freeze([...this.diagnosticMap].map(([id, {card, borderAlignment}]) =>
        Object.freeze([id, Object.freeze({card: data(card), borderAlignment})] as const))),
    };
    // Only snapshots traverse the complete history. Hot-path events touch one ID.
    const json = JSON.stringify(snapshot);
    if (new TextEncoder().encode(json).byteLength > MAX_INVENTORY_SNAPSHOT_BYTES) fail('snapshot byte limit');
    return Object.freeze(snapshot);
  }
}

export function replayInventoryEvidence(seed: readonly (ScannedCard | InventoryCardData)[], events: Iterable<unknown>) {
  const inventory = new InventoryEvidence(seed);
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
