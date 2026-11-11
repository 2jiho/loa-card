import type {
  CaseLabel,
  EvaluationCard,
  EvaluationReport,
  EvaluationRun,
  FieldMetrics,
  FieldName,
} from './types';

const FIELD_NAMES: readonly FieldName[] = ['name', 'awakening', 'extraCopies'];

function emptyMetrics(): FieldMetrics {
  return {readable: 0, exact: 0, missed: 0, unreadable: 0, unknown: 0, falseConfirm: 0};
}

function fieldValue(card: EvaluationCard, field: FieldName): string | number | null {
  if (field === 'name') return card.name;
  if (field === 'awakening') return card.awakening;
  return card.extraCopies;
}

/** Compare a label with one run without filling missing values or inferring zeros. */
export function evaluateCase(label: CaseLabel, run: EvaluationRun): EvaluationReport {
  const cardsById = new Map(run.cards.map(card => [card.id, card]));
  const labeledIds = new Set(label.cards.map(card => card.id));
  const fieldScope = new Set(label.fieldScope);
  const fields: Record<FieldName, FieldMetrics> = {
    name: emptyMetrics(),
    awakening: emptyMetrics(),
    extraCopies: emptyMetrics(),
  };
  const missingResultCards: string[] = [];
  for (const labelCard of label.cards) {
    const result = cardsById.get(labelCard.id);
    if (!result) missingResultCards.push(labelCard.id);
    for (const field of FIELD_NAMES) {
      if (!fieldScope.has(field)) continue;
      const labelField = labelCard.fields[field];
      const metric = fields[field];
      if (labelField.status === 'unknown') {
        metric.unknown += 1;
        continue;
      }
      if (labelField.status === 'unreadable') {
        metric.unreadable += 1;
        if (result && fieldValue(result, field) !== null) metric.falseConfirm += 1;
        continue;
      }
      metric.readable += 1;
      const observed = result ? fieldValue(result, field) : null;
      if (observed === null) {
        metric.missed += 1;
      } else if (labelField.value !== undefined && observed === labelField.value) {
        metric.exact += 1;
      } else {
        metric.falseConfirm += 1;
      }
    }
  }
  const review = run.cards.filter(card => card.review.length > 0).length;
  const readableReview = label.cards.filter(labelCard => {
    const result = cardsById.get(labelCard.id);
    if (!result || result.review.length === 0) return false;
    return FIELD_NAMES.some(field => fieldScope.has(field) && labelCard.fields[field].status === 'known');
  }).length;
  const unlabeledResultCards = run.cards.map(card => card.id).filter(id => !labeledIds.has(id));
  const unlabeled = FIELD_NAMES.reduce((sum, field) => sum + fields[field].unknown, 0);
  const readableButMissed = FIELD_NAMES.reduce((sum, field) => sum + fields[field].missed, 0);
  const falseConfirm = FIELD_NAMES.reduce((sum, field) => sum + fields[field].falseConfirm, 0);
  const complete = unlabeled === 0;
  const reasons: string[] = [];
  if (!complete) reasons.push(`라벨 미완료 ${unlabeled}필드`);
  if (falseConfirm) reasons.push(`오확정 ${falseConfirm}건`);
  if (readableButMissed) reasons.push(`읽을 수 있는데 놓침 ${readableButMissed}건`);
  if (readableReview) reasons.push(`읽을 수 있는 카드 리뷰 ${readableReview}건`);
  if (label.scope === 'full' && unlabeledResultCards.length) {
    reasons.push(`라벨 없는 결과 카드 ${unlabeledResultCards.length}건`);
  }
  const verdict = !complete ? 'incomplete' : reasons.length ? 'fail' : 'pass';
  return {
    caseId: label.caseId,
    scope: label.scope,
    fieldScope: label.fieldScope,
    fields,
    readableButMissed,
    falseConfirm,
    review,
    readableReview,
    missingResultCards,
    unlabeledResultCards,
    unlabeled,
    complete,
    verdict,
    reasons,
  };
}
