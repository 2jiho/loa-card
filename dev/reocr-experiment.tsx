import {createRoot} from 'react-dom/client';
import {useEffect,useState} from 'react';
import {createNameReader} from '../src/features/card-scanner/recognition/name-reader';
import {inspectVisual} from '../src/features/card-scanner/recognition/visual-fields';

/** Re-run name OCR on saved unresolved crops under several preprocessing
 * variants. This is a measurement harness: it writes nothing to storage and
 * never feeds its results back into recognition. */
interface Target {captureOrder:number;group:number;confidence:number;text:string;candidate:string;distance:number;crop:string|null}
interface VariantResult {variant:string;text:string;confidence:number;exact:boolean;card:string|null}
interface Row extends Target {variants:VariantResult[]}

const VARIANTS=['identity','unsharp','stretch','up2down','stretch+unsharp','shiftLeft2','shiftLeft4','shiftRight2'] as const;
type Variant=typeof VARIANTS[number];

function loadImage(url:string){
  return new Promise<HTMLImageElement>((resolve,reject)=>{
    const image=new Image();
    image.onload=()=>resolve(image);
    image.onerror=reject;
    image.src=url;
  });
}
function canvasFor(image:HTMLImageElement){
  const canvas=document.createElement('canvas');
  canvas.width=140;canvas.height=210;
  const context=canvas.getContext('2d',{willReadFrequently:true})!;
  context.imageSmoothingQuality='high';
  context.drawImage(image,0,0,140,210);
  return canvas;
}
function stretch(context:CanvasRenderingContext2D){
  const data=context.getImageData(0,0,140,210);
  const values=Array.from({length:256},(_,i)=>i);
  const histogram=new Uint32Array(256);
  for(let i=0;i<data.data.length;i+=4){
    const gray=Math.round(.299*data.data[i]+.587*data.data[i+1]+.114*data.data[i+2]);
    histogram[gray]++;
  }
  const total=data.data.length/4,p2=total*.02,p98=total*.98;
  let acc=0,low=0,high=255;
  for(const value of values){acc+=histogram[value];if(acc>=p2){low=value;break;}}
  acc=0;
  for(const value of values){acc+=histogram[value];if(acc>=p98){high=value;break;}}
  const scale=high>low?255/(high-low):1;
  for(let i=0;i<data.data.length;i+=4){
    for(let c=0;c<3;c++)data.data[i+c]=Math.max(0,Math.min(255,Math.round((data.data[i+c]-low)*scale)));
  }
  context.putImageData(data,0,0);
}
function unsharp(canvas:HTMLCanvasElement){
  const context=canvas.getContext('2d',{willReadFrequently:true})!;
  const source=context.getImageData(0,0,140,210);
  const blurred=document.createElement('canvas');
  blurred.width=140;blurred.height=210;
  const bctx=blurred.getContext('2d',{willReadFrequently:true})!;
  bctx.drawImage(canvas,0,0);
  // Cheap 3x3 box blur then add the difference back.
  const out=new Uint8ClampedArray(source.data);
  for(let y=1;y<209;y++)for(let x=1;x<139;x++){
    for(let c=0;c<3;c++){
      let sum=0;
      for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++){
        sum+=source.data[((y+dy)*140+(x+dx))*4+c];
      }
      const mean=sum/9;
      const index=(y*140+x)*4+c;
      out[index]=Math.max(0,Math.min(255,Math.round(source.data[index]+(source.data[index]-mean))));
    }
  }
  const result=new ImageData(out,140,210);
  context.putImageData(result,0,0);
}
function up2down(image:HTMLImageElement){
  const big=document.createElement('canvas');big.width=280;big.height=420;
  const bctx=big.getContext('2d')!;bctx.imageSmoothingQuality='high';
  bctx.drawImage(image,0,0,280,420);
  const canvas=document.createElement('canvas');canvas.width=140;canvas.height=210;
  const context=canvas.getContext('2d',{willReadFrequently:true})!;
  context.imageSmoothingQuality='high';
  context.drawImage(big,0,0,140,210);
  return canvas;
}
function shift(image:HTMLImageElement,dx:number){
  const canvas=document.createElement('canvas');canvas.width=140;canvas.height=210;
  const context=canvas.getContext('2d',{willReadFrequently:true})!;
  context.imageSmoothingQuality='high';
  context.drawImage(image,dx,0,140,210);
  return canvas;
}
function variantCanvas(image:HTMLImageElement,variant:Variant){
  if(variant==='up2down')return up2down(image);
  if(variant==='shiftLeft2')return shift(image,-2);
  if(variant==='shiftLeft4')return shift(image,-4);
  if(variant==='shiftRight2')return shift(image,2);
  const canvas=canvasFor(image);
  if(variant==='stretch'||variant==='stretch+unsharp')stretch(canvas.getContext('2d',{willReadFrequently:true})!);
  if(variant==='unsharp'||variant==='stretch+unsharp')unsharp(canvas);
  return canvas;
}

// oxlint-disable-next-line react/only-export-components -- standalone dev run entry.
function View(){
  const [status,setStatus]=useState('loading');
  const [rows,setRows]=useState<Row[]>([]);
  useEffect(()=>{
    const abort=new AbortController();
    void (async()=>{
      try{
        const targetUrl=new URLSearchParams(location.search).get('targets')??'/work/video3-reocr-targets.json';
        const targets=await (await fetch(targetUrl)).json() as Target[];
        const withCrops=targets.filter(t=>t.crop);
        setStatus(`targets ${targets.length}, with crops ${withCrops.length}`);
        const cards=await (await fetch('/scanner/cards.json')).json();
        const stars=await (await fetch('/scanner/stars.json')).json();
        const templates=[stars.gray[0],stars.gold[0]];
        const reader=createNameReader(cards.cards,()=>{},abort.signal);
        await reader.ready();
        const out:Row[]=[];
        for(const target of withCrops){
          if(abort.signal.aborted)return;
          const image=await loadImage(target.crop!.startsWith('/')?target.crop!:'/'+target.crop!);
          const variants:VariantResult[]=[];
          for(const variant of VARIANTS){
            const canvas=variantCanvas(image,variant);
            let text='',confidence=0,exact=false,card:string|null=null;
            try{
              const context=canvas.getContext('2d',{willReadFrequently:true})!;
              const fields=inspectVisual(canvas,context,templates);
              const reading=await reader.matchForIdentify(canvas,{full:true,offsetY:fields.offsetY,allowRaw:true,
                acceptQuick:()=>true});
              if(reading){text=reading.rawText??'';confidence=reading.ocrConfidence??0;exact=reading.exact===true;card=reading.card?.name??null;}
            }catch{/* OCR failure is recorded as an empty read. */}
            variants.push({variant,text,confidence:Math.round(confidence*10)/10,exact,card});
          }
          out.push({...target,variants});
          setRows([...out]);
          setStatus(`done ${out.length}/${withCrops.length}`);
        }
        await reader.dispose();
        (window as unknown as {__reocrResult?:Row[]}).__reocrResult=out;
        setStatus(`complete ${out.length}`);
      }catch(error){
        const detail=error instanceof Error?error.message:
          (error as Event)?.type?`event ${(error as Event).type} ${(error as unknown as {target?:{src?:string}})?.target?.src??''}`:String(error);
        setStatus('failed: '+detail);
      }
    })();
    return()=>{abort.abort();};
  },[]);
  return <main style={{fontFamily:'monospace',fontSize:12,padding:8}}>
    <h1>Re-OCR preprocessing experiment</h1>
    <p role="status">{status}</p>
    <pre>{JSON.stringify(rows.map(r=>({order:r.captureOrder,text:r.text,d:r.distance,variants:r.variants})),null,1)}</pre>
  </main>;
}
createRoot(document.getElementById('root')!).render(<View/>);
