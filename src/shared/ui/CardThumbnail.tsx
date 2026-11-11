import { useEffect, useState } from "react";
import { createPortal } from "react-dom";

export function CardThumbnail({ src, alt, width = 44, height = 66 }: {
  src: string; alt: string; width?: number; height?: number;
}) {
  const [failedSource,setFailedSource]=useState<string|null>(null);
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);
  const open = (element: HTMLButtonElement) => {
    const rect = element.getBoundingClientRect();
    const previewWidth = Math.min(280, window.innerWidth - 24);
    const previewHeight = previewWidth * 1.5 + 42;
    const right = rect.right + 12;
    setPosition({
      left: Math.max(12, Math.min(right + previewWidth <= window.innerWidth - 12 ? right : rect.left - previewWidth - 12, window.innerWidth - previewWidth - 12)),
      top: Math.max(12, Math.min(rect.top, window.innerHeight - previewHeight - 12)),
    });
  };
  const visible = position !== null;
  useEffect(() => {
    if (!visible) return;
    const close = () => setPosition(null);
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
    };
  }, [visible]);
  if(!src||failedSource===src)return <span className="card-thumbnail thumbnail-placeholder" role="img" aria-label={`${alt} 이미지 없음`} style={{width,height}}>
    <svg width="28" height="36" viewBox="0 0 28 36" fill="none" stroke="currentColor" aria-hidden="true"><rect x="3" y="2" width="22" height="32" rx="3"/><path d="m14 11 5 7-5 7-5-7 5-7Z"/></svg>
  </span>;
  return <>
    <button type="button" className="card-thumbnail" aria-label={`${alt} 크게 보기`}
      style={{ width, height }}
      onMouseEnter={event => open(event.currentTarget)} onMouseLeave={() => setPosition(null)}
      onFocus={event => open(event.currentTarget)} onBlur={() => setPosition(null)}
      onClick={event => open(event.currentTarget)}
      onKeyDown={event => { if (event.key === "Escape") setPosition(null); }}>
      <img src={src} alt={alt} width={width} height={height} loading="lazy" onError={()=>{setFailedSource(src);setPosition(null);}} />
    </button>
    {position && createPortal(<figure className="card-preview" role="tooltip" aria-label={`${alt} 확대 미리보기`}
      style={position}>
      <img src={src} alt={alt} />
      <figcaption>{alt}</figcaption>
    </figure>, document.body)}
  </>;
}
