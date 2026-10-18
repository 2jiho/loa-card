import {CardThumbnail} from '../../CardThumbnail';
import type {ScannedCard} from './recognizer';
import type {ScannerState} from './scanner';
import {scrollLocationLabel} from './scroll-card-location';
import './scan-activity.css';

export function ScanAttention({cards,unknown,missing,artworkById}:{
  cards:ScannedCard[];unknown:ScannerState['unidentified'];missing:{id:string;name:string}[];artworkById:Map<string,string|undefined>;
}){
  const unresolved=unknown.filter(item=>!item.pending);
  const count=cards.length+unresolved.length+missing.length;
  if(!count)return null;
  return <section id="scan-attention" className="scan-attention panel" aria-labelledby="scan-attention-title">
    <div className="scan-strip-heading"><h2 id="scan-attention-title">확인 필요한 카드 <span>{count}</span></h2></div>
    {(!!cards.length||!!unresolved.length)&&<p>툴팁과 커서를 치우고 이 카드를 다시 보여 주세요.</p>}
    <div className="scan-attention-grid">
      {cards.map(card=><figure key={card.id}>
        <CardThumbnail src={card.image||(artworkById.get(card.id)?`${import.meta.env.BASE_URL}scanner/artwork/${artworkById.get(card.id)}`:'')} alt={card.name} width={68} height={102}/>
        <figcaption><strong title={card.name}>{card.name}</strong><span>{card.review.join(' · ')}</span></figcaption>
      </figure>)}
      {unresolved.map((item,i)=><figure key={`unknown-${item.group??i}`}>
        <CardThumbnail src={item.image} alt={`미식별 카드 ${i+1}`} width={68} height={102}/>
        <figcaption><strong>이름 확인 필요</strong><span title={item.reason}>{scrollLocationLabel(item.location)||'다시 보여 주세요'}</span></figcaption>
      </figure>)}
    </div>
    {!!missing.length&&<div className="scan-missing"><p>보유 여부 미확인 · 보유 중인 카드만 다시 보여 주세요.</p><ul>{missing.map(card=><li key={card.id}>{card.name}</li>)}</ul></div>}
  </section>;
}
