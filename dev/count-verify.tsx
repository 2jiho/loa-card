import {createRoot} from 'react-dom/client';
import {useEffect,useState} from 'react';
import {createNameReader} from '../src/features/card-scanner/recognition/name-reader';
import {inspectVisual} from '../src/features/card-scanner/recognition/visual-fields';
import {matchCountPattern,prepareContrastPattern} from '../src/features/card-scanner/recognition/count-pattern';

/** Cross-check the counter field on saved review crops with both readers.
 * Pattern matching and digit OCR are independent paths; agreement is evidence,
 * disagreement keeps the field unresolved. This harness writes nothing. */
interface Row {crop:string;offsetY:number;awakening:number|null;patternValue:number|null;patternCandidate:number|null;patternScore:number;patternGap:number;patternReason:string;ocrValue:number|null;ocrReason:string}

const CROPS=(new URLSearchParams(location.search).get('crops')??'').split(',').filter(Boolean);

// oxlint-disable-next-line react/only-export-components -- standalone dev run entry.
function View(){
  const [status,setStatus]=useState('loading');
  const [rows,setRows]=useState<Row[]>([]);
  useEffect(()=>{
    const abort=new AbortController();
    void (async()=>{
      try{
        const cards=await (await fetch('/scanner/cards.json')).json();
        const stars=await (await fetch('/scanner/stars.json')).json();
        const atlas=await (await fetch('/scanner/counter-patterns.json')).json();
        const patterns=atlas.patterns.map(prepareContrastPattern);
        const reader=createNameReader(cards.cards,()=>{},abort.signal);
        await reader.ready();
        const out:Row[]=[];
        for(const crop of CROPS){
          const image=await new Promise<HTMLImageElement>((resolve,reject)=>{
            const i=new Image();i.onload=()=>resolve(i);i.onerror=reject;
            i.src=crop.startsWith('/')?crop:'/'+crop;
          });
          const canvas=document.createElement('canvas');canvas.width=140;canvas.height=210;
          const context=canvas.getContext('2d',{willReadFrequently:true})!;
          context.imageSmoothingQuality='high';
          context.drawImage(image,0,0,140,210);
          const fields=inspectVisual(canvas,context,[stars.gray[0],stars.gold[0]]);
          const maximum=fields.awakening===null?15:15-fields.awakening*(fields.awakening+1)/2;
          const pattern=matchCountPattern(context.getImageData(0,0,140,210).data,patterns,fields.offsetY,maximum,false);
          const strip=document.createElement('canvas');strip.width=48;strip.height=20;
          strip.getContext('2d')!.drawImage(canvas,90,144+fields.offsetY,48,20,0,0,48,20);
          const diagnostic:{reason?:string}={};
          let ocrValue:number|null=null;
          try{ocrValue=await reader.count(strip,maximum,diagnostic as never);}catch{/* recorded as null */}
          out.push({crop,offsetY:fields.offsetY,awakening:fields.awakening,
            patternValue:pattern.value,patternCandidate:pattern.candidate,
            patternScore:Math.round(pattern.score*1000)/1000,patternGap:Math.round(pattern.gap*1000)/1000,
            patternReason:pattern.reason,ocrValue,ocrReason:diagnostic.reason??''});
          setRows([...out]);setStatus(`done ${out.length}/${CROPS.length}`);
        }
        await reader.dispose();
        (window as unknown as {__countVerify?:Row[]}).__countVerify=out;
        setStatus('complete');
      }catch(error){
        const detail=error instanceof Error?error.message:String(error);
        setStatus('failed: '+detail);
      }
    })();
    return()=>{abort.abort();};
  },[]);
  return <main style={{fontFamily:'monospace',fontSize:12,padding:8}}>
    <h1>Count cross-check</h1>
    <p role="status">{status}</p>
    <pre>{JSON.stringify(rows,null,1)}</pre>
  </main>;
}
createRoot(document.getElementById('root')!).render(<View/>);
