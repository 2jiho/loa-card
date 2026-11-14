import {useEffect,useState} from 'react';
import {CardThumbnail} from '../../../shared/ui/CardThumbnail';
import type {ScannedCard} from '../recognition/recognizer-types';
import type {ScannerState} from '../orchestration/scanner';
import {attentionCardImage} from './attention-card-image';
import {scrollLocationLabel} from '../session/scroll-card-location';
import {attentionCardAdvice,attentionScanMode,unidentifiedAttention,unidentifiedDisplayKey,unidentifiedReferenceAdvice} from './scan-attention-guidance';
import {ListPositionMap} from './ListPositionMap';
import type {ListGuidanceMap} from '../session/list-guidance';
import '../scan-activity.css';

export function ScanAttention({cards,unknown,discarded=[],missing,artworkById,guidance,sharing,busy,queued,activeReadings}:{
  cards:ScannedCard[];unknown:ScannerState['unidentified'];discarded?:ScannerState['unidentified'];missing:{id:string;name:string}[];artworkById:Map<string,string|undefined>;
  /** Where to show the list again, from the list table (row-centred scan only). */
  guidance?:{readonly asks:readonly string[];readonly notes:readonly string[];readonly map?:ListGuidanceMap};
  sharing:boolean;busy:boolean;queued?:number;activeReadings?:number;
}){
  const mode=attentionScanMode({sharing,busy,queued,activeReadings});
  const {unresolved,advice,hasLocation}=unidentifiedAttention(unknown,mode,sharing);
  const missingReference=unresolved.some(item=>(!item.reason||item.reason==='이름 확인 필요')&&
    unidentifiedReferenceAdvice(item.portraitDiagnostics)!==null);
  // While scanning, rows not yet seen are progress, not something to check: the progress window
  // shows them on its list map. What is still missing once reading ends is asked for here.
  // After the share, until reading ends, the rows to show again are not final yet either.
  const asks=sharing||busy?[]:guidance?.asks??[];
  const count=cards.length+unresolved.length+discarded.length+missing.length+(asks.length?1:0),hasAttention=count>0;
  // Keep the panel briefly after the last item clears, without retaining stale
  // cards or delaying newly observed issues. A new issue cancels the close.
  const [linger,setLinger]=useState(false);
  useEffect(()=>{
    const timer=window.setTimeout(()=>setLinger(hasAttention),hasAttention?0:1500);
    return ()=>window.clearTimeout(timer);
  },[hasAttention]);
  if(!hasAttention&&!linger)return null;
  return <section id="scan-attention" className="scan-attention panel" aria-labelledby="scan-attention-title" tabIndex={0}>
    <div className="scan-strip-heading"><h2 id="scan-attention-title">다시 볼 카드 <span>{count}</span></h2></div>
    {!hasAttention&&<p>다시 볼 카드가 없어요.</p>}
    {/* First in the panel, above the card pictures: where to scroll is what is needed while sharing. */}
    {!!asks.length&&guidance?.map&&<ListPositionMap map={{...guidance.map,currentRow:null,direction:null}}/>}
    {!!cards.length&&<div className="scan-attention-group">
      <h3>각성·장수를 못 읽은 카드 <span>{cards.length}종</span></h3>
      <p>{attentionCardAdvice(mode)}</p>
      <div className="scan-attention-grid">
        {cards.map(card=>{
          const artwork=artworkById.get(card.id);
          const image=attentionCardImage(card.image,undefined,false,artwork?`${import.meta.env.BASE_URL}scanner/artwork/${artwork}`:undefined);
          return <figure key={card.id}>
            <CardThumbnail src={image.src} alt={`${card.name} · ${image.label}`} width={68} height={102}/>
            <figcaption><strong title={card.name}>{card.name}</strong><span>{card.review.join(' · ')}</span><span>{image.label}</span></figcaption>
          </figure>;
        })}
      </div>
    </div>}
    {!!unresolved.length&&<div className="scan-attention-group">
      <h3>어떤 카드인지 알아보지 못한 화면 <span>{unresolved.length}개</span></h3>
      <p>{advice}</p>
      {missingReference&&<p>일부 카드는 비슷한 카드와 비교할 자료가 없어서 다시 스캔해도 알아보지 못할 수 있어요.</p>}
      {hasLocation&&<p>위치는 스캔할 때의 대략적인 자리예요. 정렬이나 필터를 바꾸면 달라져요.</p>}
      <div className="scan-attention-grid">
        {unresolved.map((item,i)=>{
          const referenceAdvice=!item.reason||item.reason==='이름 확인 필요'?unidentifiedReferenceAdvice(item.portraitDiagnostics):null;
          return <figure key={unidentifiedDisplayKey(item,i)}>
            <CardThumbnail src={item.image} alt={`알아보지 못한 화면 ${i+1}`} width={68} height={102}/>
            <figcaption><strong>어떤 카드인지 모름</strong><span title={referenceAdvice?'다시 스캔해도 알아보지 못할 수 있어요.':undefined}>{referenceAdvice||(!item.reason||item.reason==='이름 확인 필요'?'이름을 못 읽었어요':item.reason)}</span><span>{scrollLocationLabel(item.location)||'위치 모름'}</span></figcaption>
          </figure>;
        })}
      </div>
    </div>}
    {!!discarded.length&&<div className="scan-attention-group">
      <h3>읽지 못한 화면 <span>{discarded.length}개</span></h3>
      <p>알아보기 어려워 이번 결과에 넣지 않았어요. 값을 짐작해서 채우지도 않았어요. 다시 스캔해 주세요.</p>
      <div className="scan-attention-grid">
        {discarded.map((item,i)=><figure key={unidentifiedDisplayKey(item,i)}>
          <CardThumbnail src={item.image} alt={`읽지 못한 화면 ${i+1}`} width={68} height={102}/>
          <figcaption><strong>읽지 못함</strong><span>{item.reason||'알아보기 어려움'}</span><span>{scrollLocationLabel(item.location)||'위치 모름'}</span></figcaption>
        </figure>)}
      </div>
    </div>}
    {/* Where, not why: the map shows the rows; the reasons stay in the diagnostic report. */}
    {!!asks.length&&<div className="scan-attention-group">
      <h3>다시 스캔할 곳</h3>
      <p>{guidance?.map?.targets.length?'다시 스캔할 때 지도에 표시된 줄을 천천히 보여 주세요.':'다시 스캔할 때 목록을 처음부터 끝까지 천천히 넘겨 주세요.'}</p>
    </div>}
    {!!missing.length&&<div className="scan-missing"><h3>이번 스캔에서 못 본 카드 <span>{missing.length}종</span></h3><p>{mode==='processing'?'다 읽은 뒤에도 남으면 게임에서 이 카드를 가지고 있는지 확인해 주세요.':mode==='sharing'?'가지고 있는 카드라면 화면에 다시 보여 주세요.':'가지고 있는 카드라면 다시 스캔해 주세요.'}</p><ul>{missing.map(card=><li key={card.id}>{card.name}</li>)}</ul></div>}
  </section>;
}
