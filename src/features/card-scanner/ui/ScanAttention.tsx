import {useEffect,useState} from 'react';
import {CardThumbnail} from '../../../shared/ui/CardThumbnail';
import type {ScannedCard} from '../recognition/recognizer-types';
import type {ScannerState} from '../orchestration/scanner';
import type {PendingCardFields} from '../session/current-scan-fields';
import {attentionCardImage} from './attention-card-image';
import {scrollLocationLabel} from '../session/scroll-card-location';
import {attentionCardAdvice,attentionCountAdvice,attentionScanMode,unidentifiedAttention,unidentifiedDisplayKey,unidentifiedReferenceAdvice,unmatchedPendingFields} from './scan-attention-guidance';
import {recognitionNeededSlotLabel,type RecognitionNeededSlot} from '../session/recognition-needed';
import {ListPositionMap} from './ListPositionMap';
import type {ListGuidanceMap} from '../session/list-guidance';
import '../scan-activity.css';

export function ScanAttention({cards,unknown,discarded=[],missing,artworkById,pendingFields=[],evidenceLost=false,recognitionNeeded=[],guidance,sharing,busy,queued,activeReadings}:{
  cards:ScannedCard[];unknown:ScannerState['unidentified'];discarded?:ScannerState['unidentified'];missing:{id:string;name:string}[];artworkById:Map<string,string|undefined>;
  pendingFields?:PendingCardFields[];
  evidenceLost?:boolean;
  recognitionNeeded?:readonly RecognitionNeededSlot[];
  /** Where to show the list again, from the list table (row-centred scan only). */
  guidance?:{readonly asks:readonly string[];readonly notes:readonly string[];readonly map?:ListGuidanceMap};
  sharing:boolean;busy:boolean;queued?:number;activeReadings?:number;
}){
  const mode=attentionScanMode({sharing,busy,queued,activeReadings});
  const {unresolved,advice,hasLocation}=unidentifiedAttention(unknown,mode,sharing);
  const missingReference=unresolved.some(item=>(!item.reason||item.reason==='이름 확인 필요')&&
    unidentifiedReferenceAdvice(item.portraitDiagnostics)!==null);
  const pendingById=new Map(pendingFields.map(item=>[item.id,item]));
  const hasCountConflict=cards.some(card=>pendingById.get(card.id)?.reason==='각성·장수 판독 확인');
  const unmatched=unmatchedPendingFields(pendingFields,[...cards,...missing]);
  const asks=guidance?.asks??[],notes=guidance?.notes??[],SHOWN_ASKS=12;
  const count=cards.length+unresolved.length+discarded.length+recognitionNeeded.length+missing.length+unmatched.length+asks.length,hasAttention=count>0||evidenceLost;
  // Keep the panel briefly after the last item clears, without retaining stale
  // cards or delaying newly observed issues. A new issue cancels the close.
  const [linger,setLinger]=useState(false);
  useEffect(()=>{
    const timer=window.setTimeout(()=>setLinger(hasAttention),hasAttention?0:1500);
    return ()=>window.clearTimeout(timer);
  },[hasAttention]);
  if(!hasAttention&&!linger)return null;
  return <section id="scan-attention" className="scan-attention panel" aria-labelledby="scan-attention-title" tabIndex={0}>
    <div className="scan-strip-heading"><h2 id="scan-attention-title">추가 확인 항목 <span>{evidenceLost?(count?`${count}+`:'미확인'):count}</span></h2></div>
    {evidenceLost&&<p role="alert">카드 확인에 필요한 근거가 누락됐거나 서로 충돌했습니다. {sharing?'화면 공유를 종료한 뒤 처음부터 다시 스캔해 주세요.':busy?'현재 처리가 끝나면 화면 공유를 다시 시작해 처음부터 스캔해 주세요.':'화면 공유를 다시 시작해 처음부터 스캔해 주세요.'}</p>}
    {!hasAttention&&<p>현재 표시할 확인 항목이 없습니다.</p>}
    {!!cards.length&&<div className="scan-attention-group">
      <h3>값 확인이 필요한 카드 <span>{cards.length}종</span></h3>
      <p>{attentionCardAdvice(mode)}</p>
      {hasCountConflict&&<p>일부 카드의 각성 또는 장수가 다르게 읽혔어요. 다시 보여 주고, 계속 남으면 게임에서 확인한 뒤 새 스캔을 시작해 주세요.</p>}
      <div className="scan-attention-grid">
        {cards.map(card=>{
          const pending=pendingById.get(card.id),artwork=artworkById.get(card.id);
          const image=attentionCardImage(card.image,pending?.image,!!pending,artwork?`${import.meta.env.BASE_URL}scanner/artwork/${artwork}`:undefined);
          const countAdvice=attentionCountAdvice(card,pending);
          return <figure key={card.id}>
            <CardThumbnail src={image.src} alt={`${card.name} · ${image.label}`} width={68} height={102}/>
            <figcaption><strong title={card.name}>{card.name}</strong><span>{card.review.join(' · ')}</span>{pending?.reason==='각성·장수 판독 확인'&&<span>각성·장수 확인</span>}{countAdvice&&<span>{countAdvice}</span>}<span>{image.label}</span></figcaption>
          </figure>;
        })}
      </div>
    </div>}
    {!!unmatched.length&&<div className="scan-attention-group">
      <h3>다시 보여 줄 카드 <span>{unmatched.length}건</span></h3>
      <p>{attentionCardAdvice(mode)}</p>
      <div className="scan-attention-grid">
        {unmatched.map(item=><figure key={`pending-${item.id}`}>
          <CardThumbnail src={item.image||''} alt="확인 필요한 카드 · 최근 화면" width={68} height={102}/>
          <figcaption><strong>카드 확인 필요</strong><span>{mode==='processing'?'판독 후 확인':'카드 화면 확인'}</span><span>{item.image?'최근 확인 화면':'최신 화면 이미지 없음'}</span></figcaption>
        </figure>)}
      </div>
    </div>}
    {!!unresolved.length&&<div className="scan-attention-group">
      <h3>미식별 화면 입력 <span>{unresolved.length}건</span></h3>
      <p>{advice}</p>
      {missingReference&&<p>일부 카드는 유사 카드 자료가 없어 다시 보여도 식별이 어려울 수 있어요.</p>}
      {hasLocation&&<p>위치는 스캔 당시의 추정치이며 정렬이나 필터를 바꾸면 달라질 수 있어요.</p>}
      <div className="scan-attention-grid">
        {unresolved.map((item,i)=>{
          const referenceAdvice=!item.reason||item.reason==='이름 확인 필요'?unidentifiedReferenceAdvice(item.portraitDiagnostics):null;
          return <figure key={unidentifiedDisplayKey(item,i)}>
            <CardThumbnail src={item.image} alt={`미식별 화면 입력 ${i+1}`} width={68} height={102}/>
            <figcaption><strong>카드 식별 필요</strong><span title={referenceAdvice?'다시 보여 줘도 확인이 필요할 수 있어요.':undefined}>{referenceAdvice||item.reason||'이름 확인 필요'}</span><span>{scrollLocationLabel(item.location)||'위치 확인 불가'}</span></figcaption>
          </figure>;
        })}
      </div>
    </div>}
    {!!discarded.length&&<div className="scan-attention-group">
      <h3>인식이 필요한 화면 <span>{discarded.length}건</span></h3>
      <p>판독이 어려워 이번 스캔에서 제외했어요. 해당 화면을 다시 보여 주세요. 값을 추정하지 않았습니다.</p>
      <div className="scan-attention-grid">
        {discarded.map((item,i)=><figure key={unidentifiedDisplayKey(item,i)}>
          <CardThumbnail src={item.image} alt={`인식 필요 화면 ${i+1}`} width={68} height={102}/>
          <figcaption><strong>인식 필요</strong><span>{item.reason||'판독 불가'}</span><span>{scrollLocationLabel(item.location)||'위치 확인 불가'}</span></figcaption>
        </figure>)}
      </div>
    </div>}
    {!!recognitionNeeded.length&&<div className="scan-attention-group">
      <h3>인식이 필요한 칸 <span>{recognitionNeeded.length}칸</span></h3>
      <p>툴팁이나 커서가 카드를 가려 판독하지 못했어요. 최근 수집 화면의 해당 칸을 다시 보여 주세요. 이대로 스캔을 종료해도 됩니다.</p>
      <ul>{recognitionNeeded.map(item=><li key={item.slot}>{recognitionNeededSlotLabel(item.slot)} · {item.reason}</li>)}</ul>
    </div>}
    {!!asks.length&&<div className="scan-attention-group">
      <h3>다시 보여 줄 곳 <span>{asks.length}곳</span></h3>
      <p>{sharing?'아래 위치를 다시 비춰 주세요. 스크롤을 잠깐 멈추면 위치를 더 정확히 알 수 있어요.':'다시 스캔할 때 아래 위치를 비춰 주세요.'}</p>
      {guidance?.map&&<ListPositionMap map={sharing?guidance.map:{...guidance.map,currentRow:null,direction:null}}/>}
      <ul>{asks.slice(0,SHOWN_ASKS).map((line,index)=><li key={index}>{line}</li>)}{asks.length>SHOWN_ASKS&&<li>외 {asks.length-SHOWN_ASKS}곳</li>}</ul>
      {!!notes.length&&<ul className="scan-attention-notes">{notes.map((line,index)=><li key={index}>참고: {line}</li>)}</ul>}
    </div>}
    {!!missing.length&&<div className="scan-missing"><h3>보유 여부를 확인할 카드 <span>{missing.length}종</span></h3><p>{mode==='processing'?'판독 후에도 남으면 보유 중인지 확인해 주세요.':mode==='sharing'?'보유 중인 카드만 다시 보여 주세요.':'화면 공유를 다시 시작하고 보유 중인 카드만 보여 주세요.'}</p><ul>{missing.map(card=><li key={card.id}>{card.name}</li>)}</ul></div>}
  </section>;
}
