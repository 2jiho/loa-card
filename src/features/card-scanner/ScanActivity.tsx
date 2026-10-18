import {useEffect,useLayoutEffect,useRef,useState} from 'react';
import {useReducedMotion} from 'motion/react';
import {CardThumbnail} from '../../CardThumbnail';
import type {ScanActivityItem} from './scan-activity';
import {FILM_PITCH,FILM_STEP_MS,ScanFilm} from './scan-film';
import './scan-activity.css';

const labels={reading:'읽는 중',waiting:'추가 판독',read:'판독됨',review:'확인 필요'};
export function ScanActivity({items,queued}:{items:ScanActivityItem[];queued:number}){
  const strip=useRef<HTMLDivElement>(null),track=useRef<HTMLDivElement>(null);
  const film=useRef(new ScanFilm()),animation=useRef<Animation|null>(null);
  const reduced=useReducedMotion();
  const [capacity,setCapacity]=useState(0);
  const [controls,setControls]=useState({automatic:true,hovered:false,focused:false});
  const paused=!controls.automatic||controls.hovered||controls.focused;
  const [view,setView]=useState<{items:ScanActivityItem[];incomingId:number|null;durationMs:number}>({items:[],incomingId:null,durationMs:FILM_STEP_MS});
  const current=useRef({capacity,paused,reduced});
  useLayoutEffect(()=>{current.current={capacity,paused,reduced};});
  const changeMotion=(change:Partial<typeof controls>)=>setControls(previous=>({...previous,...change}));

  useEffect(()=>{
    const element=strip.current;
    if(!element)return;
    const observer=new ResizeObserver(([entry])=>setCapacity(Math.max(1,Math.min(16,Math.floor(entry.contentRect.width/FILM_PITCH)))));
    observer.observe(element);
    return ()=>observer.disconnect();
  },[]);
  useEffect(()=>{
    film.current.ingest(items);
    if(capacity&&!paused)setView(film.current.prepare(capacity,!!reduced));
  },[items,capacity,paused,reduced]);

  // One compositor animation for the strip. Status updates and bursts never
  // retarget it. Rebase the DOM and transform together before painting.
  useLayoutEffect(()=>{
    const element=track.current;
    if(!element||view.incomingId===null||reduced)return;
    const movement=element.animate([{transform:'translateX(0)'},{transform:`translateX(-${FILM_PITCH}px)`}],
      {duration:view.durationMs,easing:'linear',fill:'forwards'});
    animation.current=movement;
    if(current.current.paused)movement.pause();
    let active=true;
    void movement.finished.then(()=>{
      if(!active)return;
      film.current.complete();
      setView(film.current.prepare(current.current.capacity,!!current.current.reduced));
    },()=>{});
    return ()=>{active=false;movement.cancel();if(animation.current===movement)animation.current=null;};
  },[view.incomingId,view.durationMs,capacity,reduced]);
  useLayoutEffect(()=>{
    if(paused)animation.current?.pause();else animation.current?.play();
  },[paused,view.incomingId]);

  return <section className="scan-activity" aria-label="실시간 카드 판독">
    <div className="scan-strip-heading"><strong>카드 읽는 중 <small>{queued>0?`${queued}개 대기`:'새 카드 확인 중'}</small></strong>
      {!!items.length&&<button type="button" className="text-button" aria-pressed={!controls.automatic} onClick={()=>changeMotion({automatic:!controls.automatic})}>{controls.automatic?'흐름 멈춤':'흐름 재생'}</button>}
    </div>
    <div ref={strip} className="scan-film" tabIndex={0} aria-label="최근 판독 카드, 초점을 두면 흐름이 멈춥니다"
      onMouseEnter={()=>changeMotion({hovered:true})} onMouseLeave={()=>changeMotion({hovered:false})} onFocus={()=>changeMotion({focused:true})}
      onBlur={event=>{if(!event.currentTarget.contains(event.relatedTarget as Node|null))changeMotion({focused:false});}}>
      <div className="scan-film-window" style={{maxWidth:capacity*FILM_PITCH}}>
        <div ref={track} className="scan-film-track">
          {view.items.map(item=><figure key={item.id} inert={item.id===view.incomingId} className={`scan-film-card is-${item.status}`}>
            <CardThumbnail src={item.image} alt={item.name??'판독 중인 카드'} width={52} height={78}/>
            <figcaption title={item.name}><span>{item.name??'이름 판독 중'}</span><small>{item.status==='reading'&&<i className="scan-spinner" aria-hidden="true"/>}{labels[item.status]}</small></figcaption>
          </figure>)}
        </div>
      </div>
      {!view.items.length&&<p className="scan-film-empty">카드 화면이 잡히면 여기에 표시됩니다.</p>}
    </div>
  </section>;
}
