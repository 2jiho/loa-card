import { useEffect, useId, useState } from 'react';
import { createPortal } from 'react-dom';
import { cardRarityClass, cardRarityName } from './card-rarity';

export function CardName({name,rarity}:{name:string;rarity?:number}) {
  const tooltipId = useId();
  const [position,setPosition] = useState<{left:number;top?:number;bottom?:number}|null>(null);
  const open = (element:HTMLSpanElement) => {
    if (element.scrollWidth <= element.clientWidth) return;
    const rect = element.getBoundingClientRect();
    const width = Math.min(320,window.innerWidth-24);
    setPosition({left:Math.max(12,Math.min(rect.left,window.innerWidth-width-12)),
      ...(rect.bottom+80<window.innerHeight ? {top:rect.bottom+6} : {bottom:window.innerHeight-rect.top+6})});
  };
  const visible = position !== null;
  useEffect(()=>{
    if (!visible) return;
    const close = ()=>setPosition(null);
    window.addEventListener('scroll',close,true);
    window.addEventListener('resize',close);
    return ()=>{window.removeEventListener('scroll',close,true);window.removeEventListener('resize',close);};
  },[visible]);
  return <div className="tile-name">
    <span className={cardRarityClass(rarity)} tabIndex={0}
      aria-label={`${name} · ${cardRarityName(rarity)}`} aria-describedby={visible?tooltipId:undefined}
      onMouseEnter={e=>open(e.currentTarget)} onMouseLeave={()=>setPosition(null)}
      onFocus={e=>open(e.currentTarget)} onBlur={()=>setPosition(null)}
      onKeyDown={e=>{if(e.key==='Escape')setPosition(null);}}>{name}</span>
    {position && createPortal(<div id={tooltipId} role="tooltip" className="card-name-tooltip" style={position}>{name}</div>,document.body)}
  </div>;
}
