import {createDetector,loadCv} from '../src/features/card-scanner/acquisition/detector';
import {openRecordedShareStream} from './recorded-share-frames';

/** Development measurement (docs/dev-recording.md): does a cheaper, lower
 * resolution header search separate "card window present" from "absent" as the
 * current full search does? Per recorded frame it records the full search's best
 * score, its time and verdict, and the best score and time at 1/2, 1/3 and 1/4
 * of the working resolution. It changes no scanner behavior. */
const SCALES=[1,0.85,1.15,0.7,1.3,0.55,1.5],DIVISORS=[2,3,4];
const out=document.querySelector('#out')!;
const params=new URLSearchParams(location.search);
const ids=(params.get('ids')??'').split(',').map(id=>id.trim()).filter(Boolean),stride=Math.max(1,Number(params.get('stride'))||1);

interface Row {rec:string;time:number;located:boolean;oldScore:number|null;oldMs:number;low:Record<number,{score:number;ms:number}>}
const rows:Row[]=[];
(window as unknown as {__rows:Row[]}).__rows=rows;

async function grayAnchor(cv:Awaited<ReturnType<typeof loadCv>>) {
  const response=await fetch(`${import.meta.env.BASE_URL}scanner/header-anchor.png`);
  const bitmap=await createImageBitmap(await response.blob());
  const canvas=document.createElement('canvas');canvas.width=bitmap.width;canvas.height=bitmap.height;
  const context=canvas.getContext('2d',{willReadFrequently:true})!;context.drawImage(bitmap,0,0);bitmap.close();
  const source=cv.imread(canvas),gray=new cv.Mat();cv.cvtColor(source,gray,cv.COLOR_RGBA2GRAY);source.delete();return gray;
}

(async()=>{
  if(!ids.length){out.textContent='ids 파라미터가 필요합니다.';return;}
  const cv=await loadCv(),anchor=await grayAnchor(cv);
  const events:Record<string,unknown>[]=[];
  const detector=await createDetector(undefined,false,event=>events.push(event));
  const work=document.createElement('canvas'),templates=new Map<string,InstanceType<typeof cv.Mat>>();
  const template=(div:number,scale:number,ratio:number)=>{
    const width=Math.round(anchor.cols*scale*ratio/div),height=Math.round(anchor.rows*scale*ratio/div),key=`${width}x${height}`;
    let value=templates.get(key);
    if(!value){value=new cv.Mat();cv.resize(anchor,value,new cv.Size(width,height),0,0,cv.INTER_AREA);templates.set(key,value);}
    return value;
  };
  const lowScore=(canvas:HTMLCanvasElement,div:number)=>{
    const started=performance.now(),ratio=Math.min(1,1280/canvas.width);
    work.width=Math.round(canvas.width*ratio/div);work.height=Math.round(canvas.height*ratio/div);
    const context=work.getContext('2d',{willReadFrequently:true})!;
    context.globalCompositeOperation='copy';context.drawImage(canvas,0,0,work.width,work.height);
    const source=cv.matFromImageData(context.getImageData(0,0,work.width,work.height)),gray=new cv.Mat();
    cv.cvtColor(source,gray,cv.COLOR_RGBA2GRAY);source.delete();
    let best=-1;
    try{
      for(const scale of SCALES){
        const t=template(div,scale,ratio);
        if(t.cols>=gray.cols||t.rows>=gray.rows)continue;
        const result=new cv.Mat();
        try{cv.matchTemplate(gray,t,result,cv.TM_CCOEFF_NORMED);best=Math.max(best,(cv.minMaxLoc as unknown as (m:unknown)=>{maxVal:number})(result).maxVal);}
        finally{result.delete();}
      }
    }finally{gray.delete();}
    return {score:best,ms:performance.now()-started};
  };
  const signal=new AbortController().signal;
  for(const id of ids){
    const probe=await openRecordedShareStream({recordingId:id,signal});
    const lines=(await (await fetch(`/__rec/${encodeURIComponent(id)}/lines`)).json() as {lines:{deliveredAtMs:number}[]}).lines;
    const only=new Set<number>();lines.forEach((line,index)=>{if(index%stride===0)only.add(line.deliveredAtMs/1000);});
    void probe;
    const stream=await openRecordedShareStream({recordingId:id,signal,only});
    for await(const frame of stream.frames()){
      // Reset only the tracking so every frame takes the global search.
      detector.detect({width:0,height:0} as unknown as HTMLCanvasElement);
      events.length=0;
      const started=performance.now(),layout=detector.detect(frame.element),oldMs=performance.now()-started;
      const coarse=events.filter(event=>event.stage==='coarse'&&event.tracked===false).pop();
      const low:Row['low']={};for(const div of DIVISORS)low[div]=lowScore(frame.element,div);
      rows.push({rec:id.slice(-4),time:frame.time,located:!!layout,oldScore:coarse?Number(coarse.score):null,oldMs,low});
      frame.element.width=0;frame.element.height=0;
      if(rows.length%20===0)out.textContent=`${id.slice(-4)} · ${rows.length}프레임 측정`;
    }
  }
  out.textContent=`완료 · ${rows.length}프레임`;
})().catch(error=>{out.textContent='실패: '+String(error);});
