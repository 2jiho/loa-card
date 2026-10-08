import { createPortraitMatcher } from './portrait-matcher';
import { areaGray } from './area-gray';
import { prepareContrastPattern } from './count-pattern';
import type { CountPattern } from './count-pattern';
import type { Reference } from './recognizer';
import { inspectVisual, portraitIdentity, readVisual } from './visual-fields';
const native=new OffscreenCanvas(140,210),context=native.getContext('2d',{willReadFrequently:true})!;
let preparing:ReturnType<typeof prepare>|undefined;
async function prepare() {
 const base=new URL(import.meta.env.BASE_URL,self.location.href).href;
 const load=async(name:string)=>{const r=await fetch(base+'scanner/'+name);if(!r.ok)throw new Error('시각 판독 자료 로드 실패: '+name);return r.json();};
 const [catalog,atlas,stars,counts,screen]=await Promise.all([load('cards.json'),load('artwork-details.json'),load('stars.json'),load('counter-patterns.json'),load('screen-artwork-details.json')]);
 const cards=catalog.cards as Reference[];
 return {match:createPortraitMatcher(cards,atlas,screen.cards),templates:[stars.gray[0],stars.gold[0]],patterns:(counts.patterns as CountPattern[]).map(prepareContrastPattern)};
}
self.onmessage=async(event:MessageEvent<{id:number;bitmap?:ImageBitmap}>)=>{
 const {id,bitmap}=event.data;
 try {
  const engine=await(preparing??=prepare());
  if(!bitmap){self.postMessage({id,result:null});return;}
  const image=new OffscreenCanvas(bitmap.width,bitmap.height),ctx=image.getContext('2d',{willReadFrequently:true})!;
  ctx.drawImage(bitmap,0,0);
  const pixels=ctx.getImageData(0,0,image.width,image.height).data;
  const artwork=engine.match(areaGray(pixels,image.width,image.height));
  const fields=inspectVisual(image,context,engine.templates);
  const identity=artwork?portraitIdentity(artwork):null;
  const values=identity?readVisual(image,context,fields,engine.patterns,identity.maxAwakening):null;
  self.postMessage({id,result:{identity,fields,values}});
 }catch(error){self.postMessage({id,error:String(error)});}
 finally{bitmap?.close();}
};
