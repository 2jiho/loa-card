import { nextRaidPlan, raidProgress } from './raid-progress';
import type { Element, RaidEffect, RaidMaster, RaidOwned, RaidSet } from './raid-progress';

type SupportAssumption = { set: RaidSet; boost: number };
export type RaidComparison = { set: RaidSet; total: number; maximum: number; boost: number; cardBoost: number; support?: SupportAssumption; xp: number; uncertain: boolean };
const damageKeys = new Set(['stat:87', 'stat:88', 'stat:89', 'stat:91', 'stat:92', 'stat:93']);
const alternativeSupportSets = new Set(['1020', '1005', '1006', '1016', '1026']);

export function isAlternativeRaidSet(set: RaidSet) {
  return set.role === 'support' && alternativeSupportSets.has(set.id);
}

/** Keep the primary recommendation visible; only strictly better alternatives merit a note. */
export function raidRecommendationChoices(ranked: RaidComparison[], preferred?: RaidComparison) {
  if (preferred) {
    const better = ranked.filter(choice => choice.set.id !== preferred.set.id && choice.boost > preferred.boost + 1e-9);
    return { primary: [preferred], alternatives: better.filter(choice => Math.abs(choice.boost - better[0].boost) < 1e-9) };
  }
  const primary = ranked.filter(choice => !isAlternativeRaidSet(choice.set));
  const alternatives = ranked.filter(choice => isAlternativeRaidSet(choice.set) && choice.boost > (primary[0]?.boost ?? 0) + 1e-9);
  return { primary, alternatives };
}

/** Damage-only comparison for neutral skills, with no other elemental modifiers.
 * Support assumes every party damage hit has the selected attack attribute.
 * Elemental support debuffs add to weakness; general party damage is separate.
 * Empirical model: https://www.inven.co.kr/board/lostark/4821/101866
 * Additional damage is additive with existing additional damage, not a final multiplier. */
export function raidBoost(set: RaidSet, effects: RaidEffect[], weakness: Element, weaknessBonus: number, additionalDamage: number, support?: SupportAssumption) {
  const amount = (key: string) => effects.filter(e => e.key === key).reduce((sum, e) => sum + e.value, 0) / 10000;
  if (set.role === 'support') {
    if (set.element === 'general') return amount('party-damage');
    if (set.element !== weakness) return 0;
    return amount('party-damage') / (1 + weaknessBonus / 100);
  }
  const converted = effects.some(e => e.key === 'conversion');
  const damage = converted ? effects.filter(e => damageKeys.has(e.key)).reduce((sum, e) => sum + e.value, 0) / 10000 : 0;
  const supportElement = converted && support?.set.element === set.element ? support.boost : 0;
  const supportGeneral = support?.set.element === 'general' ? support.boost : 0;
  const elemental = 1 + (converted && set.element === weakness && weakness !== 'general' ? weaknessBonus / 100 : 0) + supportElement;
  const extra = 1 + amount('stat:50') / (1 + additionalDamage / 100);
  return (1 + damage) * elemental * extra * (1 + supportGeneral) - 1;
}

export function rankRaidSets(master: RaidMaster, owned: RaidOwned[], complete: boolean, role: 'dealer' | 'support',
  weakness: Element, grow: boolean, weaknessBonus = 10, additionalDamage = 0,
  prepared?: Map<string, ReturnType<typeof raidProgress>>): RaidComparison[] {
  const results: RaidComparison[] = [];
  for (const set of master.sets.filter(s => s.role === role)) {
    const progress = prepared?.get(set.id) ?? raidProgress(set, master, owned, complete);
    if (progress.selected.length !== set.slots) continue;
    const maximum = grow ? progress.growth.total : progress.total;
    // Do not recommend spending XP between milestones when the effect stays identical.
    const milestone = Math.max(0, ...progress.thresholds.filter(t => t <= maximum));
    const total = grow ? Math.max(progress.total, milestone) : progress.total;
    const stages = set.stages.filter(s => s.count <= set.slots && s.awakening <= total);
    const effects = stages.flatMap(s => s.effects);
    const converted = effects.some(effect => effect.key === 'conversion');
    const cardBoost = role === 'support' ? effects.filter(effect => effect.key === 'party-damage').reduce((sum, effect) => sum + effect.value, 0) / 10000
      : raidBoost(set, effects, 'general', 0, additionalDamage);
    // A partner's card must not make an inactive dealer deck look usable.
    if (cardBoost <= 0 && !converted) continue;
    const support = role === 'dealer' ? master.sets.filter(candidate => candidate.role === 'support' &&
      (candidate.element === 'general' || (converted && candidate.element === set.element))).map(candidate => ({
        set: candidate, boost: candidate.stages.filter(stage => stage.count <= candidate.slots && stage.awakening <= 30)
          .flatMap(stage => stage.effects).filter(effect => effect.key === 'party-damage').reduce((sum, effect) => sum + effect.value, 0) / 10000,
      })).sort((a, b) => raidBoost(set, effects, weakness, weaknessBonus, additionalDamage, b) - raidBoost(set, effects, weakness, weaknessBonus, additionalDamage, a))[0] : undefined;
    const boost = raidBoost(set, effects, weakness, weaknessBonus, additionalDamage, support);
    if (boost <= 0) continue;
    const plan = grow && total > progress.total ? nextRaidPlan(progress.members.filter(m => m.status === 'known')
      .map(m => ({ ...m, copies: m.copies ?? 0 })), total, set.slots) : null;
    results.push({ set, total, maximum, boost, cardBoost, support, xp: plan?.xp ?? 0,
      uncertain: grow ? progress.growth.uncertain : progress.unknown });
  }
  return results.sort((a, b) => b.boost - a.boost || a.xp - b.xp || a.set.name.localeCompare(b.set.name, 'ko'));
}
