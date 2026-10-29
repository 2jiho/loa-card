import {inspectVisual,readVisual,reusableVisualPixels} from '../src/features/card-scanner/visual-fields';
import {prepareContrastPattern} from '../src/features/card-scanner/count-pattern';
import type {CountPattern} from '../src/features/card-scanner/count-pattern';
const run=document.querySelector<HTMLButtonElement>('#run')!,status=document.querySelector('#status')!,result=document.querySelector('#result')!;
const json=async(path:string)=>{const response=await fetch(path);if(!response.ok)throw Error(`Missing fixture ${path}`);return response.json();};
const hash=async(data:Uint8ClampedArray)=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new Uint8Array(data))),b=>b.toString(16).padStart(2,'0')).join('');
run.onclick=async()=>{
  run.disabled=true;status.textContent='검사 중';result.textContent='';
  try{
    const [stars,counts,samples]=await Promise.all([json('/scanner/stars.json'),json('/scanner/counter-patterns.json'),json('/tests/fixtures/star-samples.json')]);
    const patterns=(counts.patterns as CountPattern[]).map(prepareContrastPattern),templates=[stars.gray[0],stars.gold[0]];
    const cases:{name:string;pixels:Uint8ClampedArray;width:number;height:number;reuse:boolean}[]=[];
    for(const sample of samples){
      const pixels=new Uint8ClampedArray(140*210*4);
      pixels.set(Uint8Array.from(atob(sample.rgba),s=>s.charCodeAt(0)),176*140*4);
      for(let i=3;i<pixels.length;i+=4)pixels[i]=255;
      cases.push({name:sample.name,pixels,width:140,height:210,reuse:true});
    }
    for(const alpha of [255,254,128,0]){
      const pixels=new Uint8ClampedArray(140*210*4);
      for(let i=0;i<pixels.length;i+=4){pixels[i]=(i*17)%256;pixels[i+1]=(i*31+61)%256;pixels[i+2]=(i*53+19)%256;pixels[i+3]=alpha;}
      cases.push({name:`rgba-${alpha}`,pixels,width:140,height:210,reuse:alpha===255});
    }
    cases.push({name:'scaled-280x420',pixels:new Uint8ClampedArray(280*420*4).fill(255),width:280,height:420,reuse:false});
    const rows=[];
    for(const item of cases){
      const source=new OffscreenCanvas(item.width,item.height),sourceContext=source.getContext('2d',{willReadFrequently:true})!;
      sourceContext.putImageData(new ImageData(new Uint8ClampedArray(item.pixels),item.width,item.height),0,0);
      const bitmap=await createImageBitmap(source);
      const image=new OffscreenCanvas(bitmap.width,bitmap.height),ctx=image.getContext('2d',{willReadFrequently:true})!;
      try{ctx.drawImage(bitmap,0,0);}finally{bitmap.close();}
      const pixels=ctx.getImageData(0,0,image.width,image.height).data,snapshot=reusableVisualPixels(pixels,image.width,image.height);
      const normalized=new OffscreenCanvas(140,210),context=normalized.getContext('2d',{willReadFrequently:true})!;
      const legacy=inspectVisual(image,context,templates),legacyPixels=context.getImageData(0,0,140,210).data;
      const modern=inspectVisual(image,context,templates,snapshot);
      const fieldsEqual=JSON.stringify(legacy)===JSON.stringify(modern);
      let valuesEqual=true;
      for(const awakening of [null,0,4,5])for(const hasIcon of [null,false,true]){
        const fields={...legacy,awakening,hasIcon};
        const before=readVisual(image,context,fields,patterns);
        const after=readVisual(image,context,fields,patterns,undefined,snapshot);
        // Transparent images intentionally retain the old drawing path; repeated
        // source-over draws can differ. Only compare independent opaque snapshots.
        if(snapshot&&JSON.stringify(before)!==JSON.stringify(after))valuesEqual=false;
      }
      const pixelEqual=snapshot?await hash(snapshot)===await hash(legacyPixels):null;
      const passed=!!snapshot===item.reuse&&(!snapshot||(fieldsEqual&&valuesEqual&&pixelEqual));
      rows.push({name:item.name,reused:!!snapshot,pixelEqual,fieldsEqual:snapshot?fieldsEqual:null,valuesEqual:snapshot?valuesEqual:null,passed});
    }
    const passed=rows.every(row=>row.passed);
    result.textContent=JSON.stringify({passed,cases:rows.length,rows,scope:'Browser transport and opaque pixel/field parity; fallback eligibility only for transparent/scaled inputs. Not full-video accuracy or a speed benchmark.'},null,2);
    status.textContent=passed?`${rows.length}개 표본 통과`:'불일치 발견';
  }catch(error){status.textContent='검증 실패';result.textContent=String(error);}finally{run.disabled=false;}
};
