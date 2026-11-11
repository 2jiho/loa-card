import {CURRENT_FIELD_REVIEW} from '../session/current-scan-fields';
import type {ScannedCard} from '../recognition/recognizer-types';

/** A retained crop may carry outdated badges. Its capture time is not linked to
 * the unresolved field here, so identify it only as a reference, never as the
 * latest (or definitively earlier) screen. Artwork is a different reference. */
export function cardTileImage(card:Pick<ScannedCard,'name'|'image'|'review'>, artwork?:string) {
  const src=card.image||artwork||'';
  const label=src&&card.review.includes(CURRENT_FIELD_REVIEW)
    ?card.image?'참고 화면':'참고 이미지':undefined;
  return {src,label,alt:label?`${card.name} · ${label}`:card.name};
}
