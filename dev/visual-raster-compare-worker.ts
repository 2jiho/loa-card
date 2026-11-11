import {createVisualRaster} from '../src/features/card-scanner/recognition/visual-raster';
import {createPortraitMatcher} from '../src/features/card-scanner/recognition/portrait-matcher';
import {areaGray} from '../src/features/card-scanner/acquisition/area-gray';
import {prepareContrastPattern} from '../src/features/card-scanner/recognition/count-pattern';
import type {CountPattern} from '../src/features/card-scanner/recognition/count-pattern';
import type {Reference} from '../src/features/card-scanner/recognition/recognizer';
import {inspectVisual,readVisual,reusableVisualPixels} from '../src/features/card-scanner/recognition/visual-fields';

type Sample={name:string;width:number;height:number;rgba:string};
const json=async(path:string)=>{const response=await fetch(path);if(!response.ok)throw Error(`missing ${path}`);return response.json();};
const bytes=(encoded:string)=>Uint8ClampedArray.from(atob(encoded),value=>value.charCodeAt(0));
function baseline(bitmap:ImageBitmap){
 const image=new OffscreenCanvas(bitmap.width,bitmap.height),ctx=image.getContext('2d',{willReadFrequently:true});
 if(!ctx)throw Error('baseline canvas unavailable');
 ctx.drawImage(bitmap,0,0);return {image,pixels:ctx.getImageData(0,0,image.width,image.height).data};
}
function synthetic(w:number,h:number,alpha:number){
 const source=new OffscreenCanvas(w,h),context=source.getContext('2d');if(!context)throw Error('synthetic canvas unavailable');
 const image=context.createImageData(w,h);for(let i=0;i<image.data.length;i+=4){image.data[i]=(i*17)%256;image.data[i+1]=(i*31+61)%256;image.data[i+2]=(i*53+19)%256;image.data[i+3]=alpha;}context.putImageData(image,0,0);return createImageBitmap(source);
}
self.onmessage=async()=>{
 const bitmaps:ImageBitmap[]=[];
 try{
  const [samples,catalog,atlas,stars,counts,screen]=await Promise.all([
   json('/tests/fixtures/border-integrity-samples.json'),json('/scanner/cards.json'),json('/scanner/artwork-details.json'),
   json('/scanner/stars.json'),json('/scanner/counter-patterns.json'),json('/scanner/screen-artwork-details.json')]);
  const match=createPortraitMatcher(catalog.cards as Reference[],atlas,screen.cards);
  const templates=[stars.gray[0],stars.gold[0]],patterns=(counts.patterns as CountPattern[]).map(prepareContrastPattern);
  const raster=createVisualRaster(),names:string[]=[];
  for(const item of samples as Sample[]){
   const source=new OffscreenCanvas(item.width,item.height),ctx=source.getContext('2d');if(!ctx)throw Error('source canvas unavailable');
   ctx.putImageData(new ImageData(bytes(item.rgba),item.width,item.height),0,0);bitmaps.push(await createImageBitmap(source));names.push(item.name);
  }
  for(const [w,h,a] of [[140,210,255],[140,210,0],[140,210,128],[112,168,64],[140,210,255]] as const){bitmaps.push(await synthetic(w,h,a));names.push(`synthetic ${w}x${h} alpha ${a}`);}
  const normA=new OffscreenCanvas(140,210).getContext('2d',{willReadFrequently:true});
  const normB=new OffscreenCanvas(140,210).getContext('2d',{willReadFrequently:true});
  if(!normA||!normB)throw Error('normalization canvas unavailable');
  let equalBytes=0;const rows=[];
  for(let pass=0;pass<2;pass++)for(let i=0;i<bitmaps.length;i++){
   const bitmap=bitmaps[i],a=baseline(bitmap),b=raster.read(bitmap),pixelEqual=a.pixels.length===b.pixels.length&&a.pixels.every((v,j)=>v===b.pixels[j]);
   if(!pixelEqual)throw Error(`pixels differ: ${names[i]}, pass ${pass}`);equalBytes+=a.pixels.length;
   const artA=match(areaGray(a.pixels,a.image.width,a.image.height));
   const artB=match(areaGray(b.pixels,b.image.width,b.image.height));
   const sa=reusableVisualPixels(a.pixels,a.image.width,a.image.height),sb=reusableVisualPixels(b.pixels,b.image.width,b.image.height);
   // Start each independent computation with identical transparent state.
   normA.clearRect(0,0,140,210);normB.clearRect(0,0,140,210);
   const fieldA=inspectVisual(a.image,normA,templates,sa),fieldB=inspectVisual(b.image,normB,templates,sb);
   const resultA=artA?readVisual(a.image,normA,fieldA,patterns,artA.card.maxAwakening,sa):null;
   const resultB=artB?readVisual(b.image,normB,fieldB,patterns,artB.card.maxAwakening,sb):null;
   const same=JSON.stringify([artA,fieldA,resultA])===JSON.stringify([artB,fieldB,resultB]);
   if(!same)throw Error(`recognition differs: ${names[i]}, pass ${pass}`);
   rows.push({name:names[i],pass,pixelEqual,recognitionEqual:same});
  }
  const timing=[];
  for(let round=0;round<6;round++){
   const row:{freshMs?:number;reuseMs?:number;freshChecksum?:number;reuseChecksum?:number}={};
   for(const useReuse of round%2?[true,false]:[false,true]){
    const start=performance.now();let checksum=0;
    for(let i=0;i<400;i++){const read=useReuse?raster.read(bitmaps[i%bitmaps.length]):baseline(bitmaps[i%bitmaps.length]);checksum+=read.pixels[i%read.pixels.length];}
    if(useReuse){row.reuseMs=performance.now()-start;row.reuseChecksum=checksum;}else{row.freshMs=performance.now()-start;row.freshChecksum=checksum;}
   }
   if(row.freshChecksum!==row.reuseChecksum)throw Error('benchmark checksum mismatch');timing.push(row);
  }
  self.postMessage({status:'passed',cases:rows.length,realCrops:samples.length,equalBytes,rows,timing,
   scope:'Dedicated browser worker, identical supplied crops; matches are algorithm equivalence, not card ground truth. Timings include raster/readback only, not live scanner, OCR, GPU memory or capture.'});
 }catch(error){self.postMessage({status:'failed',error:String(error)});}
 finally{for(const bitmap of bitmaps)bitmap.close();}
};
