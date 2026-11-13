import {useEffect,useRef,useState} from 'react';
import {useReducedMotion} from 'motion/react';
import {CardThumbnail} from '../../../shared/ui/CardThumbnail';
import type {ScanActivityItem} from './scan-activity';
import '../scan-activity.css';

/** Slots on the belt: 0 is the scanner window, 1.. are the cards that came out of it. */
const SLOTS=5,PITCH=64,MAX_BACKLOG=6;
/** Belt pace: a card per 240 ms, faster (120 ms) while more than two wait, so the belt keeps up
 * with a fast scroll instead of lagging behind it. */
const STEP_MS=240,FAST_STEP_MS=120;
const labels={reading:'판독 중',waiting:'판독 대기',read:'완료',review:'확인 필요'} as const;

/** Cards passing through a scanner. Crops waiting to be read stand on the left (a count); each card
 * read enters the window and moves right one slot when the next one comes in, at a steady pace.
 * When cards arrive faster than that, older ones not yet shown are skipped: this is a picture of
 * the work, not a list of it. Presentation only; it never changes the scan. */
export function ScanConveyor({items,queued,reading}:{items:readonly ScanActivityItem[];queued:number;reading:boolean}){
  const reduced=useReducedMotion();
  const seen=useRef(new Set<number>()),backlog=useRef<ScanActivityItem[]>([]);
  const [belt,setBelt]=useState<ScanActivityItem[]>([]);
  // New cards join the backlog in the order they were read.
  useEffect(()=>{
    for(const item of items)if(!seen.current.has(item.id)){seen.current.add(item.id);backlog.current.push(item);}
    if(backlog.current.length>MAX_BACKLOG)backlog.current.splice(0,backlog.current.length-MAX_BACKLOG);
  },[items]);
  // A card's later status (read, to check) shows on the belt as it is now.
  const latest=new Map(items.map(item=>[item.id,item]));
  const shown=belt.map(item=>latest.get(item.id)??item);
  // One step at a time: the next card enters the window and the belt moves right by one slot.
  useEffect(()=>{
    let timer=0;
    const step=()=>{
      const next=backlog.current.shift();
      if(next)setBelt(previous=>[next,...previous.filter(item=>item.id!==next.id)].slice(0,SLOTS+1));
      timer=window.setTimeout(step,reduced?STEP_MS*2:backlog.current.length>2?FAST_STEP_MS:STEP_MS);
    };
    timer=window.setTimeout(step,STEP_MS);
    return ()=>window.clearTimeout(timer);
  },[reduced]);
  const busy=reading||queued>0;
  return <section className="scan-conveyor" aria-label="실시간 카드 판독">
    <div className="scan-conveyor-queue" aria-label={`판독 대기 ${queued}개`}>
      <div className="scan-conveyor-stack" aria-hidden="true">{Array.from({length:Math.max(1,Math.min(3,queued))},(_,index)=><span key={index}/>)}</div>
      <strong>{queued}</strong><small>대기</small>
    </div>
    <div className={`scan-conveyor-belt${reduced?' is-still':''}`}>
      <div className={`scan-conveyor-window${busy?' is-busy':''}`} aria-hidden="true"/>
      <ol aria-label="방금 읽은 카드">
        {shown.map((item,index)=><li key={item.id} className={`is-${item.status}${index===0?' is-entering':''}${index>=SLOTS?' is-leaving':''}`}
          style={{transform:`translateX(${index*PITCH}px)`}}>
          <CardThumbnail src={item.image} alt={item.name??'카드'} width={44} height={66}/>
          <span title={item.name}>{item.name??''}</span><small>{labels[item.status]}</small>
        </li>)}
      </ol>
      {!belt.length&&<p className="scan-conveyor-empty">카드 화면이 잡히면 여기로 지나갑니다.</p>}
    </div>
  </section>;
}
