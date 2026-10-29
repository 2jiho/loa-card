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
    <div className="scan-strip-heading"><h2 id="scan-attention-title">추가 확인 항목 <span>{count}</span></h2></div>
    {!!cards.length&&<div className="scan-attention-group">
      <h3>값 확인이 필요한 카드 <span>{cards.length}종</span></h3>
      <p>각성·장수 또는 카드 이름의 확인이 필요한 보유 카드입니다.</p>
      <div className="scan-attention-grid">
        {cards.map(card=><figure key={card.id}>
          <CardThumbnail src={card.image||(artworkById.get(card.id)?`${import.meta.env.BASE_URL}scanner/artwork/${artworkById.get(card.id)}`:'')} alt={card.name} width={68} height={102}/>
          <figcaption><strong title={card.name}>{card.name}</strong><span>{card.review.join(' · ')}</span></figcaption>
        </figure>)}
      </div>
    </div>}
    {!!unresolved.length&&<div className="scan-attention-group">
      <h3>미식별 화면 입력 <span>{unresolved.length}건</span></h3>
      <p>아래 크롭은 아직 카드로 식별되지 않았습니다. 판독된 카드 종류 수와 별개이며, 툴팁·커서를 치우고 해당 구간을 다시 보여 주세요.</p>
      <div className="scan-attention-grid">
        {unresolved.map((item,i)=><figure key={`unknown-${item.group??i}`}>
          <CardThumbnail src={item.image} alt={`미식별 화면 입력 ${i+1}`} width={68} height={102}/>
          <figcaption><strong>카드 식별 필요</strong><span title={item.reason}>{scrollLocationLabel(item.location)||'다시 보여 주세요'}</span></figcaption>
        </figure>)}
      </div>
    </div>}
    {!!missing.length&&<div className="scan-missing"><h3>보유 여부를 확인할 카드 <span>{missing.length}종</span></h3><p>보유 중인 카드만 다시 보여 주세요.</p><ul>{missing.map(card=><li key={card.id}>{card.name}</li>)}</ul></div>}
  </section>;
}
