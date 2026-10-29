import type { GrowthCard } from '../growth/optimizer';

export const ELEMENTS = { holy: '성', dark: '암', fire: '화', water: '수', earth: '토', lightning: '뇌', general: '범용' } as const;
export type Element = keyof typeof ELEMENTS;
export type RaidEffect = { key: string; label: string; value: number };
export type RaidStage = { count: number; awakening: number; effects: RaidEffect[] };
export type RaidSet = { id: string; name: string; alias: string; role: 'dealer' | 'support'; element: Element; slots: number; cardIds: string[]; stages: RaidStage[] };
export type RaidMaster = { version: string; cards: GrowthCard[]; sets: RaidSet[] };
export type RaidOwned = { id: string; awakening: number | null; extraCopies: number | null; review: string[]; countReliable?: boolean };
export type RaidMember = { card: GrowthCard; status: 'known' | 'missing' | 'unknown'; awakening: number | null; copies: number | null };
export type RaidPlan = { missing: number; xp: number; selected: { id: string; from: number; to: number; register: boolean; missing: number }[] };

const integer = (v: number | null, max: number): v is number => v !== null && Number.isInteger(v) && v >= 0 && v <= max;

/** Identity/jewels determine current effects; only growth planning needs copy counts. */
export function raidMembers(set: RaidSet, master: RaidMaster, owned: RaidOwned[], complete: boolean): RaidMember[] {
  const definitions = new Map(master.cards.map(card => [card.id, card]));
  return set.cardIds.map(id => {
    const card = definitions.get(id)!;
    const observations = owned.filter(row => row.id === id);
    const row = observations[0];
    if (!row) return { card, status: complete ? 'missing' : 'unknown', awakening: complete ? 0 : null, copies: complete ? 0 : null };
    const identityOrAwakeningIssue = row.review.some(reason => /이름|식별|사전|그림 보조|각성/.test(reason));
    if (observations.length !== 1 || identityOrAwakeningIssue || !integer(row.awakening, card.steps.length))
      return { card, status: 'unknown', awakening: null, copies: null };
    const maxCopies = card.steps.slice(row.awakening).reduce((n, step) => n + step.copies, 0);
    const copies = row.countReliable !== false && !row.review.some(reason => /장수/.test(reason)) && integer(row.extraCopies, maxCopies) ? row.extraCopies : null;
    return { card, status: 'known', awakening: row.awakening, copies };
  });
}

function better(a: RaidPlan, b: RaidPlan | undefined) {
  return !b || a.missing < b.missing || (a.missing === b.missing && a.xp < b.xp);
}

/** Exact 6-slot DP: minimize additional copies first, then XP, for one next milestone.
 * Alternatives are independent plans, not a shared spending schedule across sets. */
export function nextRaidPlan(members: RaidMember[], target: number, slots = 6): RaidPlan | null {
  let states = new Map<string, RaidPlan>([['0:0', { missing: 0, xp: 0, selected: [] }]]);
  for (const member of members) {
    if (member.status === 'unknown') continue;
    const next = new Map(states); // Leaving a candidate out consumes no slot.
    const from = member.awakening!;
    const register = member.status === 'missing';
    for (const [key, plan] of states) {
      const [count, total] = key.split(':').map(Number);
      if (count === slots) continue;
      let copies = 0, xp = 0;
      for (let to = from; to <= member.card.steps.length; to++) {
        // An unknown reserve can still contribute its observed awakening; it
        // must not fund upgrades or block the other six confirmed members.
        if (member.copies === null && to > from) break;
        if (to > from) { copies += member.card.steps[to - 1].copies; xp += member.card.steps[to - 1].xp; }
        const missing = Math.max(0, copies - (member.copies ?? 0)) + (register ? 1 : 0);
        const candidate: RaidPlan = { missing: plan.missing + missing, xp: plan.xp + xp,
          selected: [...plan.selected, { id: member.card.id, from, to, register, missing }] };
        const nextKey = `${count + 1}:${Math.min(target, total + to)}`;
        if (better(candidate, next.get(nextKey))) next.set(nextKey, candidate);
      }
    }
    states = next;
  }
  return states.get(`${slots}:${target}`) ?? null;
}

export function availableGrowth(members: RaidMember[], slots: number) {
  const known = members.filter(m => m.status === 'known');
  const grown = known.map(member => {
    let awakening = member.awakening!, copies = member.copies ?? 0;
    while (awakening < member.card.steps.length && copies >= member.card.steps[awakening].copies) {
      copies -= member.card.steps[awakening].copies;
      awakening++;
    }
    return { ...member, awakening, copies };
  }).sort((a, b) => b.awakening - a.awakening).slice(0, slots);
  const total = grown.reduce((sum, m) => sum + m.awakening, 0);
  const plan = nextRaidPlan(known.map(m => ({ ...m, copies: m.copies ?? 0 })), total, Math.min(slots, known.length));
  return { total, plan, uncertain: members.some(m => m.status === 'unknown' || m.copies === null) };
}

export function raidProgress(set: RaidSet, master: RaidMaster, owned: RaidOwned[], complete: boolean) {
  const members = raidMembers(set, master, owned, complete);
  const selected = members.filter(m => m.status === 'known').sort((a, b) => b.awakening! - a.awakening!).slice(0, set.slots);
  const total = selected.reduce((sum, m) => sum + m.awakening!, 0);
  const active = set.stages.filter(stage => selected.length >= stage.count && total >= stage.awakening);
  const effects = new Map<string, RaidEffect>();
  for (const stage of active) for (const effect of stage.effects) {
    const prev = effects.get(effect.key);
    effects.set(effect.key, { ...effect, value: effect.value + (prev?.value ?? 0) });
  }
  const thresholds = [...new Set(set.stages.filter(s => s.awakening > 0).map(s => s.awakening))].sort((a, b) => a - b);
  const next = thresholds.find(threshold => selected.length < set.slots || threshold > total) ?? null;
  return { members, selected, total, active, effects: [...effects.values()], thresholds, next,
    growth: availableGrowth(members, set.slots),
    unknown: members.some(m => m.status === 'unknown'), plan: next === null ? null : nextRaidPlan(members, next, set.slots) };
}

export function effectText(effect: RaidEffect) {
  return effect.key === 'conversion' || effect.key.startsWith('text:') ? effect.label : `${effect.label} +${effect.value / 100}%`;
}

export type RaidProgress = ReturnType<typeof raidProgress>;
