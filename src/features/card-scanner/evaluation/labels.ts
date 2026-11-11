import type {
  CardLabel,
  CaseLabel,
  FieldEvidenceRef,
  FieldLabel,
  FieldName,
  FieldStatus,
  LabelScope,
} from './types';

export class LabelError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LabelError';
  }
}

const FIELD_NAMES: readonly FieldName[] = ['name', 'awakening', 'extraCopies'];
const FIELD_STATUSES: readonly FieldStatus[] = ['known', 'unreadable', 'unknown'];
const SCOPES: readonly LabelScope[] = ['partial', 'full'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requiredString(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new LabelError(`${path} must be a non-empty string`);
  }
  return value.trim();
}

function optionalString(value: unknown, path: string): string | undefined {
  if (value === undefined) return undefined;
  return requiredString(value, path);
}

function integerInRange(value: unknown, min: number, max: number, path: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new LabelError(`${path} must be an integer in ${min}..${max}`);
  }
  return value;
}

function evidence(value: unknown, path: string): FieldEvidenceRef | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new LabelError(`${path} must be an object`);
  const out: FieldEvidenceRef = {};
  if (value.inputIndex !== undefined) out.inputIndex = integerInRange(value.inputIndex, 0, Number.MAX_SAFE_INTEGER, `${path}.inputIndex`);
  if (value.frame !== undefined) out.frame = integerInRange(value.frame, 0, Number.MAX_SAFE_INTEGER, `${path}.frame`);
  if (value.note !== undefined) out.note = requiredString(value.note, `${path}.note`);
  return out;
}

function parseField(value: unknown, field: FieldName, cardId: string): FieldLabel {
  const path = `cards[${cardId}].fields.${field}`;
  if (!isRecord(value)) throw new LabelError(`${path} must be an object`);
  const status = value.status;
  if (typeof status !== 'string' || !FIELD_STATUSES.includes(status as FieldStatus)) {
    throw new LabelError(`${path}.status must be known, unreadable or unknown`);
  }
  const parsed: FieldLabel = {status: status as FieldStatus};
  if (status === 'known') {
    if (field === 'name') parsed.value = requiredString(value.value, `${path}.value`);
    else parsed.value = integerInRange(value.value, 0, field === 'awakening' ? 5 : 15, `${path}.value`);
  } else {
    if (value.value !== undefined) throw new LabelError(`${path}.value is not allowed when status is ${status}`);
    if (status === 'unreadable') parsed.reason = requiredString(value.reason, `${path}.reason`);
  }
  const parsedEvidence = evidence(value.evidence, `${path}.evidence`);
  if (parsedEvidence) parsed.evidence = parsedEvidence;
  return parsed;
}

function parseFieldScope(value: unknown): FieldName[] {
  if (!Array.isArray(value) || value.length === 0) throw new LabelError('fieldScope must be a non-empty array');
  const included = new Set<FieldName>();
  for (const item of value) {
    if (typeof item !== 'string' || !FIELD_NAMES.includes(item as FieldName)) {
      throw new LabelError(`fieldScope contains an unknown field ${String(item)}`);
    }
    included.add(item as FieldName);
  }
  return FIELD_NAMES.filter(field => included.has(field));
}

function inferFieldScope(cards: unknown[]): FieldName[] {
  const present = new Set<FieldName>();
  for (const card of cards) {
    if (!isRecord(card) || !isRecord(card.fields)) continue;
    for (const field of FIELD_NAMES) if (card.fields[field] !== undefined) present.add(field);
  }
  return FIELD_NAMES.filter(field => present.has(field));
}

function parseCard(value: unknown, index: number, fieldScope: readonly FieldName[], sourceVersion: number): CardLabel {
  if (!isRecord(value)) throw new LabelError(`cards[${index}] must be an object`);
  const id = requiredString(value.id, `cards[${index}].id`);
  if (!isRecord(value.fields)) throw new LabelError(`cards[${index}].fields must be an object`);
  for (const key of Object.keys(value.fields)) {
    if (!FIELD_NAMES.includes(key as FieldName)) throw new LabelError(`cards[${index}].fields has unknown field ${key}`);
  }
  const fields = {} as Record<FieldName, FieldLabel>;
  for (const field of FIELD_NAMES) {
    if (value.fields[field] === undefined) {
      if (sourceVersion === 2 && fieldScope.includes(field)) {
        throw new LabelError(`cards[${index}].fields.${field} is required by fieldScope`);
      }
      fields[field] = {status: 'unknown'};
    } else {
      fields[field] = parseField(value.fields[field], field, id);
    }
  }
  return {id, fields};
}

function parseInputs(value: unknown): CaseLabel['inputs'] {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new LabelError('inputs must be an array');
  const indexes = new Set<number>();
  return value.map((item, index) => {
    if (!isRecord(item)) throw new LabelError(`inputs[${index}] must be an object`);
    const inputIndex = integerInRange(item.index, 0, Number.MAX_SAFE_INTEGER, `inputs[${index}].index`);
    if (indexes.has(inputIndex)) throw new LabelError(`inputs[${index}].index is duplicated`);
    indexes.add(inputIndex);
    return {
      index: inputIndex,
      sha256: requiredString(item.sha256, `inputs[${index}].sha256`),
      bytes: integerInRange(item.bytes, 0, Number.MAX_SAFE_INTEGER, `inputs[${index}].bytes`),
    };
  });
}

function parseConfirmation(value: unknown): CaseLabel['confirmation'] {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new LabelError('confirmation must be an object');
  return {
    ...(optionalString(value.authority, 'confirmation.authority') === undefined
      ? {} : {authority: optionalString(value.authority, 'confirmation.authority')}),
    ...(optionalString(value.recordedAt, 'confirmation.recordedAt') === undefined
      ? {} : {recordedAt: optionalString(value.recordedAt, 'confirmation.recordedAt')}),
    ...(optionalString(value.question, 'confirmation.question') === undefined
      ? {} : {question: optionalString(value.question, 'confirmation.question')}),
    ...(optionalString(value.answer, 'confirmation.answer') === undefined
      ? {} : {answer: optionalString(value.answer, 'confirmation.answer')}),
    ...(optionalString(value.wording, 'confirmation.wording') === undefined
      ? {} : {wording: optionalString(value.wording, 'confirmation.wording')}),
  };
}

/** Validate v1 or v2 input and return a normalized v2 label. */
export function parseCaseLabel(input: unknown): CaseLabel {
  if (!isRecord(input)) throw new LabelError('label must be an object');
  if (input.kind !== 'loacard-human-label') throw new LabelError('kind must be loacard-human-label');
  if (input.version !== 1 && input.version !== 2) throw new LabelError('version must be 1 or 2');
  if (input.status !== 'human-confirmed') throw new LabelError('status must be human-confirmed');
  if (typeof input.scope !== 'string' || !SCOPES.includes(input.scope as LabelScope)) {
    throw new LabelError('scope must be partial or full');
  }
  const caseId = requiredString(input.caseId, 'caseId');
  if (!Array.isArray(input.cards) || input.cards.length === 0) throw new LabelError('cards must be a non-empty array');
  const sourceVersion: 1 | 2 = input.version === 1 ? 1 : 2;
  const fieldScope = input.fieldScope !== undefined
    ? parseFieldScope(input.fieldScope)
    : sourceVersion === 1 ? inferFieldScope(input.cards) : [...FIELD_NAMES];
  if (fieldScope.length === 0) throw new LabelError('label must cover at least one field');
  const cards = input.cards.map((card, index) => parseCard(card, index, fieldScope, sourceVersion));
  const ids = new Set<string>();
  for (const card of cards) {
    if (ids.has(card.id)) throw new LabelError(`cards contains duplicate id ${card.id}`);
    ids.add(card.id);
  }
  const inputs = parseInputs(input.inputs);
  const confirmation = parseConfirmation(input.confirmation);
  return {
    kind: 'loacard-human-label',
    version: 2,
    status: 'human-confirmed',
    scope: input.scope as LabelScope,
    caseId,
    fieldScope,
    ...(inputs === undefined ? {} : {inputs}),
    ...(confirmation === undefined ? {} : {confirmation}),
    cards,
  };
}

/** Explicit v1 compatibility entry point. */
export function migrateV1Label(input: unknown): CaseLabel {
  if (!isRecord(input) || input.version !== 1) throw new LabelError('expected a version 1 label');
  return parseCaseLabel(input);
}

function evidenceJson(value: FieldEvidenceRef): Record<string, unknown> {
  return {
    ...(value.inputIndex === undefined ? {} : {inputIndex: value.inputIndex}),
    ...(value.frame === undefined ? {} : {frame: value.frame}),
    ...(value.note === undefined ? {} : {note: value.note}),
  };
}

function fieldJson(value: FieldLabel): Record<string, unknown> {
  return {
    status: value.status,
    ...(value.value === undefined ? {} : {value: value.value}),
    ...(value.reason === undefined ? {} : {reason: value.reason}),
    ...(value.evidence === undefined ? {} : {evidence: evidenceJson(value.evidence)}),
  };
}

/** Deterministic text for hashing and diffing. Card order is by id. */
export function canonicalLabelJson(label: CaseLabel): string {
  return JSON.stringify({
    kind: label.kind,
    version: label.version,
    status: label.status,
    scope: label.scope,
    caseId: label.caseId,
    fieldScope: label.fieldScope,
    ...(label.inputs === undefined ? {} : {
      inputs: [...label.inputs].sort((a, b) => a.index - b.index).map(input => ({
        index: input.index,
        sha256: input.sha256,
        bytes: input.bytes,
      })),
    }),
    ...(label.confirmation === undefined ? {} : {confirmation: label.confirmation}),
    cards: [...label.cards].sort((a, b) => a.id.localeCompare(b.id)).map(card => ({
      id: card.id,
      fields: {
        name: fieldJson(card.fields.name),
        awakening: fieldJson(card.fields.awakening),
        extraCopies: fieldJson(card.fields.extraCopies),
      },
    })),
  });
}
