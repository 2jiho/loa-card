import type { GrowthSequenceStep } from './growth-sequence';

export type GrowthDisplayRow = {
  step: GrowthSequenceStep;
  rank: number;
  stages: { step: GrowthSequenceStep; rank: number }[];
};

/** Combine executable intervals containing repeated cards without changing the
 * optimizer's efficiency order or borrowing XP from unavailable stages. */
export function growthDisplayRows(sequence: GrowthSequenceStep[]): GrowthDisplayRow[] {
  const rows = sequence.map((step, i) => ({ step, rank: i + 1, stages: [{ step, rank: i + 1 }] }));
  const ready = rows.filter(row => row.step.status === 'ready');
  const lastCard = new Map<string, number>();
  ready.forEach((row, i) => row.step.available.cards.forEach(card => lastCard.set(card.id, i)));
  const replacements = new Map<GrowthSequenceStep, GrowthDisplayRow>();
  const hidden = new Set<GrowthSequenceStep>();
  for (let start = 0; start < ready.length;) {
    let end = start;
    for (let i = start; i <= end; i++) {
      for (const card of ready[i].step.available.cards) end = Math.max(end, lastCard.get(card.id)!);
    }
    const group = ready.slice(start, end + 1);
    if (group.length > 1) {
      const merged = mergeReady(group);
      if (merged) {
        replacements.set(group[0].step, merged);
        group.slice(1).forEach(row => hidden.add(row.step));
      }
    }
    start = end + 1;
  }
  return rows.filter(row => !hidden.has(row.step)).map(row => replacements.get(row.step) ?? row);
}

function mergeReady(rows: GrowthDisplayRow[]): GrowthDisplayRow | null {
  const first = rows[0].step, last = rows.at(-1)!.step;
  const cards = new Map<string, GrowthSequenceStep['available']['cards'][number]>();
  let xp = 0, silver = 0, copies = 0, gain = 0;
  for (const { step } of rows) {
    const a = step.available;
    if (a.missingCopies || a.conditional || a.xpShortfall) return null;
    xp += a.xp; silver += a.silver; copies += a.copies; gain += a.gain;
    for (const card of a.cards) {
      const previous = cards.get(card.id);
      if (card.absent || card.missing || (previous && previous.to !== card.from)) return null;
      cards.set(card.id, previous ? { ...previous, to: card.to, xp: previous.xp + card.xp,
        silver: previous.silver + card.silver, copies: previous.copies + card.copies } : { ...card });
    }
  }
  const upgrades = [...cards.values()];
  const requirements = [...new Map(rows.flatMap(({step})=>step.available.requirements)
    .map(requirement=>[JSON.stringify(requirement),requirement])).values()];
  return { rank: rows[0].rank, stages: rows.flatMap(row => row.stages), step: {
    ...first, key: `bundle:${rows.map(row => row.step.key).join('|')}`,
    cards: upgrades, xp, silver, copies, gain, efficiency: xp ? gain * 100 / xp : null,
    books: [...new Set(rows.flatMap(row => row.step.books))],
    bookIds: [...new Set(rows.flatMap(row => row.step.bookIds))],
    // Virtual milestones remain in stages; they are not actual ledger milestones.
    milestones: [], conditional: false, missingCopies: 0, xpShortfall: 0,
    cumulativeXp: last.cumulativeXp, cumulativeGain: last.cumulativeGain,
    cumulativeMissingCopies: last.cumulativeMissingCopies, remainingXp: last.remainingXp,
    available: { ...last.available, cards: upgrades, requirements, xp, silver, copies, gain },
  } };
}
