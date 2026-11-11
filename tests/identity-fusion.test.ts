import {test} from 'node:test';
import assert from 'node:assert/strict';
import {
  fuseIdentity,
  fusionIdentitySource,
  fusionUnresolvedReason,
  type FusionNameEvidence,
  type FusionPortraitEvidence,
} from '../src/features/card-scanner/recognition/identity-fusion';

const card = (id: string, name: string) => ({id, name});
const strongPortrait = {upper: .96, lower: .96, correlation: .97, margin: .25};
const weakPortrait = {upper: .62, lower: .60, correlation: .64, margin: .04};
const strongArtwork = {
  correlation: .97, margin: .25, visiblePrefix: '바훈투르', mode: 'name-correction' as const,
  textSimilarity: .9, textGap: .2,
};

function name(overrides: Partial<FusionNameEvidence> = {}): FusionNameEvidence {
  return {
    card: card('a', '카멘'), exact: true, score: 1, gap: .5, ocrConfidence: 95,
    ...overrides,
  };
}

function portrait(overrides: Partial<FusionPortraitEvidence['portrait']> = {}): FusionPortraitEvidence {
  return {card: card('a', '카멘'), portrait: {...strongPortrait, ...overrides}};
}

test('a clear exact name wins without artwork', () => {
  const decision = fuseIdentity(name(), null);
  assert.equal(decision.kind, 'confirmed');
  if (decision.kind === 'confirmed') {
    assert.equal(decision.card.id, 'a');
    assert.equal(decision.source, 'name');
    assert.equal(fusionIdentitySource(decision), 'dictionary');
  }
});

test('an exact but substring-ambiguous name needs matching artwork', () => {
  const unresolved = fuseIdentity(name({nameAmbiguous: true}), null);
  assert.deepEqual(unresolved, {kind: 'unresolved', reason: 'ambiguous-name', candidates: ['a']});
  const confirmed = fuseIdentity(name({nameAmbiguous: true}), portrait());
  assert.equal(confirmed.kind, 'confirmed');
  if (confirmed.kind === 'confirmed') assert.equal(confirmed.source, 'name-artwork');
});

test('name and artwork pointing at different cards are a conflict', () => {
  const decision = fuseIdentity(name(), {card: card('b', '다른 카드'), portrait: strongPortrait});
  assert.equal(decision.kind, 'unresolved');
  if (decision.kind === 'unresolved') {
    assert.equal(decision.reason, 'conflicting-evidence');
    assert.deepEqual(decision.candidates, ['a', 'b']);
  }
});

test('artwork-only identity requires the independent portrait gate', () => {
  const confirmed = fuseIdentity(null, portrait());
  assert.equal(confirmed.kind, 'confirmed');
  if (confirmed.kind === 'confirmed') {
    assert.equal(confirmed.source, 'artwork');
    assert.equal(fusionIdentitySource(confirmed), 'artwork');
  }
  assert.deepEqual(fuseIdentity(null, {card: card('a', '카멘'), portrait: weakPortrait}),
    {kind: 'unresolved', reason: 'weak-artwork', candidates: ['a']});
});

test('a correction with independent artwork evidence can be confirmed', () => {
  const decision = fuseIdentity(name({exact: false, score: .89, gap: .22, artwork: strongArtwork}), null);
  assert.equal(decision.kind, 'confirmed');
  if (decision.kind === 'confirmed') assert.equal(decision.source, 'name-artwork');
});

test('a weak name correction without artwork stays unresolved', () => {
  const decision = fuseIdentity(name({exact: false, score: .89, gap: .22}), null);
  assert.deepEqual(decision, {kind: 'unresolved', reason: 'weak-name', candidates: ['a']});
});

test('no name and no artwork is unresolved without inventing a card', () => {
  assert.deepEqual(fuseIdentity(null, null), {kind: 'unresolved', reason: 'no-evidence', candidates: []});
});

test('unresolved reasons are explicit for the UI', () => {
  assert.match(fusionUnresolvedReason({kind: 'unresolved', reason: 'ambiguous-name', candidates: []}), /겹침/u);
  assert.match(fusionUnresolvedReason({kind: 'unresolved', reason: 'conflicting-evidence', candidates: []}), /충돌/u);
  assert.match(fusionUnresolvedReason({kind: 'unresolved', reason: 'weak-artwork', candidates: []}), /원화/u);
  assert.match(fusionUnresolvedReason({kind: 'unresolved', reason: 'weak-name', candidates: []}), /이름/u);
});

test('the three known ambiguous synthetic cards stay unresolved under the current gates', () => {
  const setino = {
    card: card('3200119', '세티노'), exact: false, score: .8889, gap: .2222,
    ocrConfidence: 80.97, rawText: '세티도',
  };
  const jakra = {
    card: card('3200703', '자크라'), exact: true, nameAmbiguous: true, score: 1, gap: .2222,
    ocrConfidence: 98.07, rawText: '자크라',
  };
  const behemoth = {
    card: card('3200803', '베히모스'), exact: true, nameAmbiguous: true, score: 1, gap: .3333,
    ocrConfidence: 98.21, rawText: '베히모스',
  };
  assert.deepEqual(fuseIdentity(setino, null), {kind: 'unresolved', reason: 'weak-name', candidates: ['3200119']});
  assert.deepEqual(fuseIdentity(jakra, null), {kind: 'unresolved', reason: 'ambiguous-name', candidates: ['3200703']});
  assert.deepEqual(fuseIdentity(behemoth, null), {kind: 'unresolved', reason: 'ambiguous-name', candidates: ['3200803']});

  // Above-badge is the best available stage, but none clears every independent gate.
  const setinoPortrait = {upper: .9814, lower: .8649, correlation: .9231, margin: .3177};
  const jakraPortrait = {upper: .9999, lower: .9753, correlation: .9876, margin: .1599};
  const behemothPortrait = {upper: .9993, lower: .8189, correlation: .9091, margin: .3596};
  for (const [evidence, portrait, id] of [
    [setino, setinoPortrait, '3200119'],
    [jakra, jakraPortrait, '3200703'],
    [behemoth, behemothPortrait, '3200803'],
  ] as const) {
    assert.deepEqual(fuseIdentity(evidence, {card: evidence.card, portrait}),
      {kind: 'unresolved', reason: 'weak-artwork', candidates: [id]});
  }
});

test('artwork the matcher accepted together with the name text keeps that acceptance', () => {
  // Measured on a real recording: a clear card whose OCR read one character wrong
  // (드렉탈란스). Text-assisted gate passes (correlation .93, margin .3); the
  // independent gate (correlation .94) would not.
  const evidence = {
    card: card('3201105', '드렉탈라스'), exact: false, score: .9333, gap: .4, ocrConfidence: 91.87, complete: true, rawText: '드렉탈란스',
  };
  const textAssisted = {upper: .9374, lower: .9283, correlation: .9328, margin: .5457};
  assert.deepEqual(fuseIdentity(evidence, {card: evidence.card, portrait: textAssisted}),
    {kind: 'unresolved', reason: 'weak-artwork', candidates: ['3201105']},
    'without the flag the independent gate still applies (artwork-only evidence)');
  const accepted = fuseIdentity(evidence, {card: evidence.card, portrait: textAssisted}, {artworkAccepted: true});
  assert.equal(accepted.kind, 'confirmed');
  if (accepted.kind === 'confirmed') assert.equal(accepted.source, 'name-artwork');
  // Acceptance never overrides a conflict between the name and the artwork.
  assert.equal(fuseIdentity(evidence, {card: card('other', '다른 카드'), portrait: textAssisted}, {artworkAccepted: true}).kind, 'unresolved');
});
