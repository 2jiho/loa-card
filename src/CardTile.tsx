import {memo} from 'react';
import {CardThumbnail} from './CardThumbnail';
import {CardName} from './CardName';
import type {ScannedCard} from './features/card-scanner/recognition/recognizer';
import {displayCardFields} from './features/card-scanner/acquisition/card-tile-fields';
import {cardTileImage} from './features/card-scanner/acquisition/card-tile-image';

function reviewMessage(reasons: string[]) {
  return [
    ...new Set(
      reasons.map((reason) =>
        reason.includes("사전") ||
        reason.includes("그림 보조") ||
        reason === "카드 식별 확인"
          ? "이름 확인"
          : reason,
      ),
    ),
  ].join(" · ");
}

type CardTileProps = {card:ScannedCard;rarity?:number;artwork?:string};

// Preserve each untouched tile while live progress and other cards change.
export const CardTile = memo(function CardTile({card,rarity,artwork}:CardTileProps) {
  const fields=displayCardFields(card);
  const image=cardTileImage(card,artwork ? `${import.meta.env.BASE_URL}scanner/artwork/${artwork}` : undefined);
  return <div className={`inventory-card ${card.review.length?'has-issue':''}`} data-identity-source={card.identitySource}>
    <CardThumbnail src={image.src} alt={image.alt} width={80} height={120} />
    {image.label&&<span className="tile-image-reference" title="이미지는 카드 확인을 위한 참고 자료입니다.">{image.label}</span>}
    <CardName name={card.name} rarity={rarity} />
    <div className="tile-counts">
      <span title={fields.awakening===null?'각성 확인 필요':card.maxAwakening===0?'성장·각성이 없는 카드':'각성 단계'} aria-label={`${card.name} 각성 ${fields.awakening??'확인 필요'}`}><b>{fields.awakening??'?'}</b><small>각</small></span>
      <span title={fields.extraCopies===null?'추가 장수 확인 필요':'추가 보유 장수'} aria-label={`${card.name} 추가 장수 ${fields.extraCopies??'확인 필요'}`}><b>{fields.extraCopies??'?'}</b><small>장</small></span>
    </div>
    {card.review.length>0 && <span className="tile-issue" title="화면 공유를 시작하고 이 카드를 다시 보여 주세요.">{reviewMessage(card.review)}</span>}
  </div>;
});

