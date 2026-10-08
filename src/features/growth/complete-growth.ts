import type { ScannerState } from '../card-scanner/scanner';
import type { ScannedCard } from '../card-scanner/recognizer';
import type { GrowthMaster } from './optimizer';
import { trustedInventory } from './optimizer';
import type { GrowthSequenceStep } from './growth-sequence';

export type GrowthCompletion = {
  label: string;
  cardsBefore: ScannedCard[];
  pointsBefore: NonNullable<ScannerState['growthPoints']>;
  estimatedBefore: boolean;
};

/** Commit only the first executable step: later rows assume earlier spending. */
export function completeGrowth(state: ScannerState, master: GrowthMaster, step: GrowthSequenceStep): ScannerState {
  const a = step.available, points = state.growthPoints;
  if (step.status !== 'ready' || a.missingCopies || a.conditional || a.usedXp !== a.xp || !a.cards.length)
    throw new Error('앞의 달성 가능한 단계부터 완료해 주세요.');
  if (!points || !Number.isSafeInteger(points.current) || points.current < a.xp)
    throw new Error('보유 경험치를 다시 확인해 주세요.');
  const { owned, valid } = trustedInventory(master, state.cards);
  const catalog = new Map(valid.map(c => [c.id, c]));
  const changed = new Map<string, ScannedCard>();
  let xp = 0;
  for (const upgrade of a.cards) {
    const card = owned.get(upgrade.id), definition = catalog.get(upgrade.id);
    if (!card || !definition || changed.has(upgrade.id) || upgrade.absent || upgrade.missing ||
        card.awakening !== upgrade.from || !Number.isInteger(upgrade.to) ||
        upgrade.to <= upgrade.from || upgrade.to > definition.steps.length)
      throw new Error('카드 상태가 변경되었습니다. 다시 계산해 주세요.');
    const cost = definition.steps.slice(upgrade.from, upgrade.to).reduce((n, s) =>
      ({ xp: n.xp + s.xp, copies: n.copies + s.copies }), { xp: 0, copies: 0 });
    if (cost.xp !== upgrade.xp || cost.copies !== upgrade.copies || card.extraCopies! < cost.copies)
      throw new Error('성장 비용과 보유 장수가 일치하지 않습니다.');
    xp += cost.xp;
    const original = state.cards.find(c => c.id === upgrade.id)!;
    // Do not set scanner manual-field locks: a later scan must replace these values.
    changed.set(upgrade.id, { ...original, awakening: upgrade.to, extraCopies: card.extraCopies! - cost.copies });
  }
  if (xp !== a.xp || points.current - xp !== a.remainingXp)
    throw new Error('경험치가 변경되었습니다. 다시 계산해 주세요.');
  return { ...state, cards: state.cards.map(c => changed.get(c.id) ?? c),
    growthPoints: { ...points, current: points.current - xp }, growthPointsEstimated: true,
    growthHistory: [...(state.growthHistory ?? []), {
      label: step.books.join(' · '), cardsBefore: state.cards.filter(c => changed.has(c.id)),
      pointsBefore: points, estimatedBefore: state.growthPointsEstimated ?? false,
    }] };
}

export function undoGrowth(state: ScannerState): ScannerState {
  const last = state.growthHistory?.at(-1);
  if (!last) return state;
  const before = new Map(last.cardsBefore.map(c => [c.id, c]));
  return { ...state, cards: state.cards.map(c => before.get(c.id) ?? c), growthPoints: last.pointsBefore,
    growthPointsEstimated: last.estimatedBefore, growthHistory: state.growthHistory!.slice(0, -1) };
}
