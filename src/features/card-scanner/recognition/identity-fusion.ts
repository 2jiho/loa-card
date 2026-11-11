import type {ArtworkEvidence} from './artwork-verifier';
import {confirmName} from './name-confidence';
import {confirmPortrait} from './portrait-matcher';
import type {PortraitEvidence} from './portrait-matcher';

export interface FusionCard {
  id: string;
  name: string;
}

export interface FusionNameEvidence {
  card: FusionCard;
  exact: boolean;
  nameAmbiguous?: boolean;
  score: number;
  gap: number;
  ocrConfidence: number;
  complete?: boolean;
  rawText?: string;
  artwork?: ArtworkEvidence;
  portrait?: PortraitEvidence;
  ctc?: {relativeLikelihood: number; margin: number};
}

export interface FusionPortraitEvidence {
  card: FusionCard;
  portrait: PortraitEvidence;
}

export type IdentityFusionSource = 'name' | 'name-artwork' | 'name-portrait' | 'artwork';

export type IdentityFusionDecision =
  | {kind: 'confirmed'; card: FusionCard; source: IdentityFusionSource; review: string[]}
  | {kind: 'unresolved'; reason: 'no-evidence' | 'ambiguous-name' | 'weak-name' | 'weak-artwork' | 'conflicting-evidence';
    candidates: string[]};

/** Resolve one identity from independent name and artwork evidence.
 *
 * - A clear exact name wins without artwork.
 * - An exact but substring-ambiguous name needs matching artwork.
 * - Artwork-only needs `confirmPortrait`; it cannot be inferred from a weak
 *   similarity or a name candidate alone. Artwork the matcher accepted together
 *   with the name text (`artworkAccepted`) keeps that acceptance.
 * - Name and artwork pointing at different IDs is a conflict, never a vote.
 */
export function fuseIdentity(
  name: FusionNameEvidence | null | undefined,
  artwork: FusionPortraitEvidence | null | undefined,
  options: {stable?: boolean; artworkAccepted?: boolean} = {},
): IdentityFusionDecision {
  if (artwork) {
    // `artworkAccepted`: the matcher already accepted this evidence under its own
    // gate. For artwork read together with the name text that gate is the
    // text-assisted one (correlation .93, margin .3), deliberately looser than the
    // independent gate below. Applying the independent gate again would undo that
    // acceptance (a clearly legible card whose OCR missed one character).
    if (!options.artworkAccepted && !confirmPortrait(artwork.portrait)) {
      return {kind: 'unresolved', reason: 'weak-artwork', candidates: [artwork.card.id]};
    }
    if (name && name.card.id !== artwork.card.id) {
      return {kind: 'unresolved', reason: 'conflicting-evidence', candidates: [name.card.id, artwork.card.id]};
    }
    return {
      kind: 'confirmed',
      card: artwork.card,
      source: name ? 'name-artwork' : 'artwork',
      review: [],
    };
  }
  if (!name) return {kind: 'unresolved', reason: 'no-evidence', candidates: []};
  // Mirror confirmCatalogName: a non-exact name correction needs independent
  // artwork or portrait evidence before it can become a card identity.
  const catalogConfirmed = !!(name.exact || name.artwork || name.portrait) &&
    confirmName({...name, card: name.card}, options.stable ?? false);
  if (catalogConfirmed) {
    return {
      kind: 'confirmed',
      card: name.card,
      source: name.portrait ? 'name-portrait' : name.artwork ? 'name-artwork' : 'name',
      review: [],
    };
  }
  if (name.nameAmbiguous) return {kind: 'unresolved', reason: 'ambiguous-name', candidates: [name.card.id]};
  return {kind: 'unresolved', reason: 'weak-name', candidates: [name.card.id]};
}

export function fusionIdentitySource(decision: Extract<IdentityFusionDecision, {kind: 'confirmed'}>): 'artwork' | 'dictionary' {
  return decision.source === 'name' ? 'dictionary' : 'artwork';
}

export function fusionUnresolvedReason(decision: Extract<IdentityFusionDecision, {kind: 'unresolved'}>): string {
  switch (decision.reason) {
    case 'conflicting-evidence': return '이름·원화 후보 충돌 · 재촬영 필요';
    case 'weak-artwork': return '원화 후보 마진 부족 · 재촬영 필요';
    case 'ambiguous-name': return '이름이 다른 카드와 겹침 · 원화 근거 부족';
    case 'weak-name': return '이름 확정 근거 부족';
    default: return '이름·원화 근거 없음';
  }
}
