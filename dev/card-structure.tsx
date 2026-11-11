import {createRoot} from 'react-dom/client';
import {useEffect,useState} from 'react';

/** Draw the fixed card masks over real crops. This is a structure audit, not
 * recognition: no card identity or field value is inferred here. */
const FILES=[
  ['3201009','구스토','/work/video7-field-review/3201009-gusto.jpg'],
  ['3201018','도철을 다루는 웨이','/work/video7-field-review/3201018-way.jpg'],
  ['3201013','라제니스를 이끄는 니나브','/work/video7-field-review/3201013-nina.jpg'],
  ['3200813','베스칼','/work/video7-field-review/3200813-beskal.jpg'],
];
const NAME={x:6,y:14,w:128,h:36};
const COUNT={x:56,y:141,w:82,h:31};
const BOTTOM={x:14,y:176,w:112,h:24};
const GLYPH={x:89,y:143,w:50,h:22};
const STARS=Array.from({length:5},(_,slot)=>({x:Math.round(140*(0.205+slot*0.143))-8,y:176,w:16,h:20}));
const SCALE=3;
function draw(card:HTMLImageElement,id:string,name:string){
  const canvas=document.createElement('canvas');
  canvas.width=480;canvas.height=700;
  const ctx=canvas.getContext('2d')!;
  ctx.fillStyle='#111';ctx.fillRect(0,0,canvas.width,canvas.height);
  ctx.imageSmoothingEnabled=false;
  ctx.drawImage(card,20,40,140*SCALE,210*SCALE);
  ctx.strokeStyle='#333';ctx.lineWidth=1;
  for(let x=0;x<=140;x+=10){const px=20+x*SCALE;ctx.beginPath();ctx.moveTo(px,40);ctx.lineTo(px,40+210*SCALE);ctx.stroke();}
  for(let y=0;y<=210;y+=10){const py=40+y*SCALE;ctx.beginPath();ctx.moveTo(20,py);ctx.lineTo(20+140*SCALE,py);ctx.stroke();}
  const rect=(box:{x:number;y:number;w:number;h:number},color:string,label:string)=>{
    ctx.strokeStyle=color;ctx.lineWidth=2;
    ctx.strokeRect(20+box.x*SCALE,40+box.y*SCALE,box.w*SCALE,box.h*SCALE);
    ctx.fillStyle=color;ctx.font='13px monospace';
    ctx.fillText(label,20+box.x*SCALE,36+box.y*SCALE);
  };
  rect(NAME,'#ff5b5b','name (6,14,128,36)');
  rect(COUNT,'#ffd84d','count (56,141,82,31)');
  rect(BOTTOM,'#45d6ff','bottom (14,176,112,24)');
  rect(GLYPH,'#ff5bd6','glyph (89,143,50,22)');
  STARS.forEach((box,slot)=>{ctx.strokeStyle='#5bff9b';ctx.lineWidth=2;ctx.strokeRect(20+box.x*SCALE,40+box.y*SCALE,box.w*SCALE,box.h*SCALE);ctx.fillStyle='#5bff9b';ctx.font='11px monospace';ctx.fillText('star '+slot,20+box.x*SCALE,36+box.y*SCALE);});
  ctx.fillStyle='#fff';ctx.font='16px sans-serif';ctx.fillText(id+' '+name,20,24);
  return canvas.toDataURL('image/png');
}
// oxlint-disable-next-line react/only-export-components -- standalone dev run entry.
function View(){
  const [urls,setUrls]=useState<string[]>([]);
  useEffect(()=>{
    let cancelled=false;
    void (async()=>{
      const generated:string[]=[];
      for(const [id,name,url] of FILES){
        const blob=await (await fetch(url)).blob();
        const image=await new Promise<HTMLImageElement>((resolve,reject)=>{const img=new Image();img.onload=()=>resolve(img);img.onerror=reject;img.src=URL.createObjectURL(blob)});
        generated.push(draw(image,id,name));
      }
      if(cancelled)return;
      (window as unknown as {__cardStructureImages?:string[]}).__cardStructureImages=generated;
      setUrls(generated);
    })().catch(error=>{if(!cancelled)document.body.textContent=String(error);});
    return()=>{cancelled=true;};
  },[]);
  return <main style={{padding:'1rem',fontFamily:"'Segoe UI','Malgun Gothic',sans-serif"}}>
    <h1>Card image structure overlay</h1>
    <p>실제 140×210 크롭에 고정 마스크를 그린 구조 확인용 화면입니다. 인식 결과가 아닙니다.</p>
    {FILES.map(([id,name],index)=><figure key={id}><figcaption>{id} {name}</figcaption>{urls[index]&&<img src={urls[index]} width={480} height={700} alt={`${name} mask overlay`} />}</figure>)}
  </main>;
}
createRoot(document.getElementById('root')!).render(<View/>);
