export type FieldName = 'name' | 'awakening' | 'extraCopies';
export type FieldStatus = 'known' | 'unreadable' | 'unknown';
export type LabelScope = 'partial' | 'full';

export interface FieldEvidenceRef {
  inputIndex?: number;
  frame?: number;
  note?: string;
}

export interface FieldLabel {
  status: FieldStatus;
  value?: string | number;
  reason?: string;
  evidence?: FieldEvidenceRef;
}

export interface CardLabel {
  id: string;
  fields: Record<FieldName, FieldLabel>;
}

export interface CaseLabel {
  kind: 'loacard-human-label';
  version: 1 | 2;
  status: 'human-confirmed';
  scope: LabelScope;
  caseId: string;
  /** Fields this label claims to cover. v1 labels infer this from present keys. */
  fieldScope: FieldName[];
  inputs?: {index: number; sha256: string; bytes: number}[];
  confirmation?: {
    authority?: string;
    recordedAt?: string;
    question?: string;
    answer?: string;
    wording?: string;
  };
  cards: CardLabel[];
}

export interface EvaluationCard {
  id: string;
  name: string | null;
  awakening: number | null;
  extraCopies: number | null;
  review: string[];
}

export interface EvaluationRun {
  expected: number | null;
  cards: EvaluationCard[];
  unidentified: number;
  unresolvedObservations: number;
  discardedObservations: number;
  recognitionNeeded: number;
  completionReasons: string[];
}

export interface FieldMetrics {
  readable: number;
  exact: number;
  missed: number;
  unreadable: number;
  unknown: number;
  falseConfirm: number;
}

export interface EvaluationReport {
  caseId: string;
  scope: LabelScope;
  fieldScope: FieldName[];
  fields: Record<FieldName, FieldMetrics>;
  readableButMissed: number;
  falseConfirm: number;
  review: number;
  readableReview: number;
  missingResultCards: string[];
  unlabeledResultCards: string[];
  unlabeled: number;
  complete: boolean;
  verdict: 'pass' | 'fail' | 'incomplete';
  reasons: string[];
}
