import Button from '@mui/material/Button';
import ToggleButton from '@mui/material/ToggleButton';
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup';
import Accordion from '@mui/material/Accordion';
import AccordionSummary from '@mui/material/AccordionSummary';
import AccordionDetails from '@mui/material/AccordionDetails';
import ExpandMore from '@mui/icons-material/ExpandMore';
import ContentCopyOutlined from '@mui/icons-material/ContentCopyOutlined';
import {useId,useMemo,useState} from 'react';
import type {ScannedCard} from '../card-scanner/recognizer';
import {merchantProgress,merchantListText,merchantStatusLabel} from './merchant-progress';
import './merchants.css';
import {cardRarityClass,cardRarityName} from '../../card-rarity';
import {MerchantSchedule} from './MerchantSchedule';
import {useMerchantClock} from './use-merchant-clock';
import {merchantSchedule,relativeKoreanTime,sessionTime} from './merchant-schedule';

export function MerchantAlerts({cards,busy,rarityById,onReview}:{cards:ScannedCard[];busy:boolean;rarityById?:ReadonlyMap<string,number>;onReview?:()=>void}) {
  const now=useMerchantClock();
  const [filter,setFilter]=useState<'needed'|'complete'>('needed');
  const [copyMessage,setCopyMessage]=useState('');
  const groups=useMemo(()=>merchantProgress(cards,busy),[cards,busy]);
  const selected=groups.filter(group=>group.status===filter);
  const held=groups.filter(group=>group.status==='unknown');
  // Includes post-share recovery: recommendations belong to a finished result.
  if(busy || !cards.length)return null;
  return <section className="panel merchant-panel" aria-label="떠돌이 상인">
    <div className="merchant-heading"><div><h2>지역별 수집 현황</h2>
      <p>5각 재료 기준</p></div>
      <Button variant="outlined" startIcon={<ContentCopyOutlined />} disabled={!selected.length} onClick={async()=>{
        try{await navigator.clipboard.writeText(merchantListText(groups,filter));setCopyMessage('목록을 복사했어요.');}
        catch{setCopyMessage('복사하지 못했어요. 아래 지역명을 직접 선택해 복사해 주세요.');}
      }}>{merchantStatusLabel[filter]} 목록 복사</Button></div>
      <MerchantSchedule now={now} />
      <ToggleButtonGroup className="merchant-tabs" value={filter} exclusive size="small" aria-label="떠돌이 상인 수집 현황 필터"
        onChange={(_, value) => { if(value) { setFilter(value); setCopyMessage(''); } }}>
        {(['needed','complete'] as const).map(status=><ToggleButton key={status} value={status}>{merchantStatusLabel[status]} · {groups.filter(g=>g.status===status).length}</ToggleButton>)}
      </ToggleButtonGroup>
      {groups.some(group=>group.unknown.length>0)&&<p className="merchant-guidance">{held.length ? `${held.length}개 지역 확인 필요` : '일부 카드 미확인'} · <a href="#card-results" onClick={onReview}>카드 확인</a></p>}
      <p className="merchant-guidance">{filter==='needed' ? '게임에서 아래 지역의 카드 알림을 켜 주세요.' : '수집 완료 · 카드 알림을 꺼도 됩니다.'}</p>
      <div className="merchant-grid" key={filter}>{[selected.slice(0,Math.ceil(selected.length/2)),selected.slice(Math.ceil(selected.length/2))].map((column,index)=><div className="merchant-column" key={index}>
        {column.map(group=><MerchantRegion key={group.id} group={group} rarityById={rarityById} now={now} />)}
      </div>)}</div>
      {!selected.length&&<p className="merchant-empty">{filter==='complete'?'수집 완료 지역 없음':groups.every(g=>g.status==='complete')?'모든 지역 수집 완료':'부족한 카드 없음 · 미확인 카드는 내 카드에서 확인'}</p>}
      <p role="status" className="merchant-copy-status">{copyMessage}</p>
    <p className="merchant-footnote">각성에 사용한 카드 + 추가 장수 기준 · 알림은 게임에서 직접 설정</p>
  </section>;
}

function MerchantRegion({group,rarityById,now}:{group:ReturnType<typeof merchantProgress>[number];rarityById?:ReadonlyMap<string,number>;now:number}) {
  const [open,setOpen]=useState(false);
  const contentId=useId();
  const schedule=merchantSchedule(group.id,now);
  return <Accordion disableGutters elevation={0} expanded={open} onChange={(_, expanded)=>setOpen(expanded)} className={`merchant-item ${group.status}`} sx={{ border: '1px solid var(--line)', borderRadius: '8px !important', '&:before': { display: 'none' } }}>
    <AccordionSummary className="merchant-toggle" id={`${contentId}-summary`} aria-controls={contentId} expandIcon={<ExpandMore fontSize="small" />}>
      <span className="merchant-name"><strong>{group.region}</strong><small>{group.merchant}{schedule ? ` · ${schedule.group}그룹` : ''}</small>
        <small className={`merchant-region-time ${schedule?.current?'is-active':''}`}>{schedule?.current ? `판매 시간 · ${relativeKoreanTime(schedule.current.end,now)}까지` : schedule?.next ? `다음 · ${relativeKoreanTime(schedule.next.start,now)}` : '시간표 미확인'}</small>
      </span>
      <span className="merchant-result">{group.status==='complete'?'모두 확보':`${group.needed.length}종 · ${group.remaining}장 부족`}
        <small>{group.complete}/{group.items.length}종 확보{group.unknown.length?` · ${group.unknown.length}종 미확인`:''}</small>
      </span>
    </AccordionSummary>
    <AccordionDetails>
      {schedule && <p className="merchant-region-hours">오늘 {schedule.today.map(sessionTime).join(' / ')}</p>}
      <ul>{group.items.map(card=><li key={card.id}><span className={cardRarityClass(rarityById?.get(card.id))}
        title={cardRarityName(rarityById?.get(card.id))} aria-label={`${card.name} · ${cardRarityName(rarityById?.get(card.id))}`}>{card.name}</span>
        <span className={card.remaining===0?'verified':'needs-review'}>{card.remaining===null?'미스캔·판독 확인':card.remaining===0?'재료 확보':`${card.remaining}장 부족`}</span></li>)}</ul>
    </AccordionDetails>
  </Accordion>;
}
