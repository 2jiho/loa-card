import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { availableGrowth, raidMembers, raidProgress, nextRaidPlan } from '../src/features/raid/raid-progress';
import type { RaidMaster, RaidOwned } from '../src/features/raid/raid-progress';
import { raidBoost, raidRecommendationChoices, rankRaidSets } from '../src/features/raid/raid-ranking';

const master: RaidMaster = JSON.parse(readFileSync(new URL('../public/raid/master.json', import.meta.url), 'utf8'));
const set = (id: string) => master.sets.find(s => s.id === id)!;
const own = (id: string, awakening = 0, extraCopies = 0): RaidOwned => ({ id, awakening, extraCopies, review: [], countReliable: true });
const inventory = (setId: string, level: number, copies = 0) => set(setId).cardIds.map(id => own(id, level, copies));

test('matching element remains first even when another dealer set is stronger', () => {
  const ranked = rankRaidSets(master, [...inventory('1015', 5), ...inventory('1023', 2)], true, 'dealer', 'dark', false);
  const matching = ranked.find(choice => choice.set.id === '1023')!;
  const result = raidRecommendationChoices(ranked, matching);
  assert.equal(result.primary[0].set.id, '1023');
  assert.equal(result.alternatives[0].set.id, '1015');
  assert.ok(result.alternatives.every(choice => choice.boost > matching.boost));
  assert.equal(raidRecommendationChoices(ranked, ranked[0]).alternatives.length, 0);
});

test('unavailable element set is retained with the strongest available fallback', () => {
  const ranked = rankRaidSets(master, [...inventory('1044', 5), ...inventory('1005', 5)], true, 'support', 'earth', false);
  const missing = { set: set('1054'), total: 0, maximum: 0, boost: 0, cardBoost: 0, xp: 0, uncertain: false };
  const result = raidRecommendationChoices(ranked, missing);
  assert.equal(result.primary[0], missing);
  assert.equal(result.alternatives[0].set.id, '1005');
  assert.equal(result.alternatives.length, 1);
  assert.deepEqual(raidRecommendationChoices([], missing), { primary: [missing], alternatives: [] });
});

test('elemental support ranks by incremental damage over existing weakness', () => {
  for (const bonus of [0, 10, 15]) {
    const current = rankRaidSets(master, inventory('1004', 5), true, 'support', 'holy', false, bonus)[0];
    const growth = rankRaidSets(master, inventory('1004', 0, 15), true, 'support', 'holy', true, bonus)[0];
    assert.ok(Math.abs(current.boost - .035 / (1 + bonus / 100)) < 1e-9);
    assert.equal(current.cardBoost, .035);
    assert.ok(Math.abs(growth.boost - current.boost) < 1e-9);
  }
  assert.equal(raidProgress(set('1004'), master, inventory('1004', 5), true).effects.find(e => e.key === 'party-damage')?.value, 350);
});

test('general support remains independent of weakness and off-element effects stay inactive', () => {
  for (const bonus of [10, 15]) {
    assert.ok(Math.abs(rankRaidSets(master, inventory('1044', 5), true, 'support', 'holy', false, bonus)[0].boost - .015) < 1e-9);
  }
  assert.deepEqual(rankRaidSets(master, inventory('1004', 5), true, 'support', 'dark', false), []);
  assert.deepEqual(rankRaidSets(master, inventory('1004', 5), true, 'support', 'general', false), []);
});

test('weakness adjustment can make a general support bonus better than a larger nominal elemental bonus', () => {
  const effect = (value: number) => [{ key: 'party-damage', label: 'test', value }];
  assert.ok(raidBoost(set('1004'), effect(160), 'holy', 0, 0) > raidBoost(set('1044'), effect(150), 'holy', 0, 0));
  assert.ok(raidBoost(set('1004'), effect(160), 'holy', 10, 0) < raidBoost(set('1044'), effect(150), 'holy', 10, 0));
});

test('only a strictly better alternative is disclosed, with primary recommendation retained', () => {
  const cards = [...inventory('1044', 5), ...inventory('1005', 5)];
  const result = raidRecommendationChoices(rankRaidSets(master, cards, true, 'support', 'earth', false));
  assert.equal(result.primary[0].set.id, '1044');
  assert.equal(result.alternatives[0].set.id, '1005');
  assert.ok(result.alternatives[0].boost > result.primary[0].boost);
  const equal = raidRecommendationChoices(rankRaidSets(master, [...inventory('1044', 5), ...inventory('1005', 4)], true, 'support', 'earth', false));
  assert.equal(equal.alternatives.length, 0);
});

test('current and post-growth alternative notices are evaluated independently', () => {
  const cards = [...inventory('1044', 5), ...inventory('1005', 3, 9)];
  assert.equal(raidRecommendationChoices(rankRaidSets(master, cards, true, 'support', 'earth', false)).alternatives.length, 0);
  assert.equal(raidRecommendationChoices(rankRaidSets(master, cards, true, 'support', 'earth', true)).alternatives[0].set.id, '1005');
});

test('usable alternatives remain disclosed when no primary effect is available', () => {
  const result = raidRecommendationChoices(rankRaidSets(master, inventory('1005', 5), true, 'support', 'earth', false));
  assert.equal(result.primary.length, 0);
  assert.equal(result.alternatives[0].set.id, '1005');
});

test('raid data includes common alternatives and excludes conditional decks', () => {
  assert.equal(master.sets.length, 19);
  assert.ok(set('1005'));
  assert.ok(set('1044'));
  assert.equal(set('1013'), undefined);
  assert.equal(set('1032'), undefined);
  for (const s of master.sets) {
    assert.equal(s.slots, 6);
    assert.equal(new Set(s.cardIds).size, s.cardIds.length);
    assert.deepEqual(s.stages.filter(e => e.awakening).map(e => e.awakening), [12, 18, 24, 30]);
    for (const id of s.cardIds) assert.ok(master.cards.find(c => c.id === id)?.steps.length === 5);
  }
});

test('LoS selects six highest awakened cards, never seven', () => {
  const cards = inventory('1015', 5);
  cards[0] = own(cards[0].id, 0, 15);
  const p = raidProgress(set('1015'), master, cards, true);
  assert.equal(p.total, 30);
  assert.equal(p.selected.length, 6);
  assert.equal(p.selected.some(m => m.card.id === cards[0].id), false);
  assert.equal(p.effects.find(e => e.key === 'stat:93')?.value, 1500);
  assert.equal(p.next, null);
});

test('five cards cannot activate six-card effects despite 25 awakening', () => {
  const p = raidProgress(set('1023'), master, inventory('1023', 5).slice(0, 5), true);
  assert.equal(p.total, 25);
  assert.equal(p.effects.some(e => e.key === 'conversion'), false);
  assert.equal(p.next, 12);
  assert.equal(p.plan?.missing, 1);
});

test('zero additional copies is still registered; growth is not current awakening', () => {
  const p = raidProgress(set('1015'), master, inventory('1015', 0, 15), true);
  assert.equal(p.selected.length, 6);
  assert.equal(p.total, 0);
  assert.equal(p.growth.total, 30);
  assert.ok(p.growth.plan!.xp > 0);
  assert.equal(p.plan!.missing, 0);
});

test('growth counts cumulative copies, not one card per awakening', () => {
  const members = raidMembers(set('1023'), master, inventory('1023', 3, 8), true);
  const growth = availableGrowth(members, 6);
  assert.equal(growth.total, 24); // 3→4 costs 4; 4→5 needs 5 more.
  assert.equal(nextRaidPlan(members, 30)!.missing, 6);
});

test('unknown copy counts retain current effects but never invent potential growth', () => {
  const cards = inventory('1023', 3);
  cards[0] = { ...cards[0], extraCopies: null, review: ['추가 장수 확인'], countReliable: false };
  const p = raidProgress(set('1023'), master, cards, true);
  assert.equal(p.total, 18);
  assert.equal(p.growth.total, 18);
  assert.equal(p.growth.uncertain, true);
  assert.equal(p.plan, null);
});

test('unconfirmed identity, awakening, duplicates and absent partial-scan rows are unknown', () => {
  const cards = inventory('1023', 3);
  cards[0].review = ['이름 확인'];
  cards[1].awakening = 9;
  cards.push(cards[2]);
  const p = raidProgress(set('1023'), master, cards.slice(0, 5).concat(cards[6]), false);
  assert.equal(p.selected.length, 2);
  assert.equal(p.members.filter(m => m.status === 'unknown').length, 4);
  assert.equal(p.plan, null);
});

test('next milestone DP matches brute-force six-slot choice costs', () => {
  const members = raidMembers(set('1015'), master, inventory('1015', 4, 0), true);
  members[0].copies = 5;
  members[1].copies = 5;
  let expected = Infinity;
  for (let excluded = 0; excluded < 7; excluded++) {
    const selected = members.filter((_, i) => i !== excluded);
    const missing = selected.reduce((sum, m) => sum + 5 - m.copies!, 0);
    expected = Math.min(expected, missing);
  }
  assert.equal(nextRaidPlan(members, 30)!.missing, expected);
  assert.equal(nextRaidPlan(members, 30)!.selected.length, 6);
});

test('support effects accumulate: You Have a Plan 1.5%, master trial 2.5%, new support 3.5%', () => {
  for (const [id, value] of [['1044', 150], ['1005', 250], ['1054', 350], ['1004', 350], ['1058', 350]] as const) {
    assert.equal(raidProgress(set(id), master, inventory(id, 5), true).effects.find(e => e.key === 'party-damage')?.value, value);
  }
});

test('support ranking matches party element and includes general fallback', () => {
  const cards = [...inventory('1044', 5), ...inventory('1005', 4)];
  const unique = [...new Map(cards.map(c => [c.id, c])).values()];
  const earth = rankRaidSets(master, unique, true, 'support', 'earth', false);
  assert.ok(earth.some(r => r.set.id === '1005'));
  assert.ok(earth.some(r => r.set.id === '1044'));
  assert.equal(rankRaidSets(master, unique, true, 'support', 'holy', false)[0].set.id, '1044');
});

test('a fully awakened off-element dealer set can beat a matching 12-awakening set', () => {
  const cards = [...inventory('1015', 5), ...inventory('1023', 2)];
  const rows = rankRaidSets(master, cards, true, 'dealer', 'dark', false);
  assert.equal(rows[0].set.id, '1015');
  assert.ok(Math.abs(rows[0].boost - .19025) < 1e-9);
  assert.ok(Math.abs(rows.find(r => r.set.id === '1023')!.boost - .135) < 1e-9);
});

test('growing with owned copies changes ranking without modifying inventory', () => {
  const cards = inventory('1023', 2, 12);
  const before = JSON.stringify(cards);
  assert.ok(Math.abs(rankRaidSets(master, cards, true, 'dealer', 'dark', true)[0].boost - .30525) < 1e-9);
  assert.equal(rankRaidSets(master, cards, true, 'dealer', 'dark', false)[0].total, 12);
  assert.equal(JSON.stringify(cards), before);
});

test('existing additional damage dilutes the general dealer bonus', () => {
  const cards = inventory('1043', 5);
  const result = rankRaidSets(master, cards, true, 'dealer', 'holy', false, 10, 20)[0];
  assert.ok(Math.abs(result.cardBoost - .1) < 1e-9);
  assert.ok(Math.abs(result.boost - .1165) < 1e-9);
  assert.equal(result.support?.set.id, '1044');
});

test('dealer comparison includes best matching support at 30 regardless of own support inventory', () => {
  for (const [bonus, expected] of [[0, .19025], [10, .30525], [15, .36275]]) {
    const result = rankRaidSets(master, inventory('1015', 5), true, 'dealer', 'holy', false, bonus)[0];
    assert.equal(result.support?.set.id, '1004');
    assert.equal(result.support?.boost, .035);
    assert.ok(Math.abs(result.boost - expected) < 1e-9);
    assert.ok(Math.abs(result.cardBoost - .15) < 1e-9);
  }
});

test('a partner buff does not activate an unawakened deck or a deck missing a card', () => {
  assert.deepEqual(rankRaidSets(master, inventory('1023', 0), true, 'dealer', 'dark', false), []);
  assert.deepEqual(rankRaidSets(master, inventory('1023', 5).slice(0, 5), true, 'dealer', 'dark', false), []);
  const converted = rankRaidSets(master, inventory('1023', 2), true, 'dealer', 'holy', false)[0];
  assert.equal(converted.support?.set.id, '1058');
  assert.ok(Math.abs(converted.boost - .035) < 1e-9);
});

test('growth recommendations stop at effect thresholds instead of wasting XP on 24 to 26', () => {
  const cards = inventory('1023', 4);
  cards[0].extraCopies = 5;
  cards[1].extraCopies = 5;
  const result = rankRaidSets(master, cards, true, 'dealer', 'dark', true)[0];
  assert.equal(result.total, 24);
  assert.equal(result.maximum, 26);
  assert.equal(result.xp, 0);
});

test('growth recommendation minimizes XP to a reachable effect instead of maximum raw awakening', () => {
  const cards = inventory('1023', 0, 10); // Each card can reach 4, total 24.
  cards[0].extraCopies = 15; // Max 25, but 24 effect can use cheaper 4+4+4+4+4+4.
  const result = rankRaidSets(master, cards, true, 'dealer', 'dark', true)[0];
  assert.equal(result.total, 24);
  assert.equal(result.maximum, 25);
  assert.ok(result.xp < raidProgress(set('1023'), master, cards, true).growth.plan!.xp);
});
