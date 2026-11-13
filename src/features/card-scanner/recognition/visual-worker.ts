import { createPortraitMatcher,screenExtraReferences } from './portrait-matcher';
import {loadPortraitCompetitors} from './portrait-competitors';
import { areaGray } from '../acquisition/area-gray';
import { prepareContrastPattern } from './count-pattern';
import type { CountPattern } from './count-pattern';
import type { Reference } from './reference-types';
import { inspectVisual, portraitIdentity, readVisual, reusableVisualPixels } from './visual-fields';
import { createVisualRaster } from './visual-raster';
const native=new OffscreenCanvas(140,210),context=native.getContext('2d',{willReadFrequently:true})!;
const raster=createVisualRaster();
let preparing:ReturnType<typeof prepare>|undefined;
async function prepare() {
 const base=new URL(import.meta.env.BASE_URL,self.location.href).href;
 const load=async(name:string)=>{const r=await fetch(base+'scanner/'+name);if(!r.ok)throw new Error('시각 판독 자료 로드 실패: '+name);return r.json();};
 const [catalog,atlas,stars,counts,screen,competitors,extra]=await Promise.all([load('cards.json'),load('artwork-details.json'),load('stars.json'),load('counter-patterns.json'),load('screen-artwork-details.json'),loadPortraitCompetitors(base),load('screen-artwork-extra.json')]);
 const cards=catalog.cards as Reference[];
 return {match:createPortraitMatcher(cards,atlas,screen.cards,{competitors,extra:screenExtraReferences(extra)}),templates:[stars.gray[0],stars.gold[0]],patterns:(counts.patterns as CountPattern[]).map(prepareContrastPattern)};
}
/** One crop: the same reading whether it arrives alone or in a batch. */
function readOne(engine:Awaited<ReturnType<typeof prepare>>,bitmap:ImageBitmap) {
 // No await occurs between raster.read and the last use of image, so the
 // worker cannot reuse the borrowed canvas while this observation is read.
 const {image,pixels}=raster.read(bitmap);
 const artwork=engine.match(areaGray(pixels,image.width,image.height));
 const snapshot=reusableVisualPixels(pixels,image.width,image.height);
 const fields=inspectVisual(image,context,engine.templates,snapshot);
 const identity=artwork?portraitIdentity(artwork):null;
 const values=identity?readVisual(image,context,fields,engine.patterns,identity.maxAwakening,snapshot):null;
 return {identity,fields,values};
}
self.onmessage=async(event:MessageEvent<{id:number;bitmap?:ImageBitmap;bitmaps?:ImageBitmap[]}>)=>{
 const {id,bitmap,bitmaps}=event.data;
 try {
  const engine=await(preparing??=prepare());
  if(bitmaps){
   // Several crops of one frame in one message (visual-batch.ts). A crop that cannot be
   // read is null for that crop only; its caller reads it again on the single-crop path.
   self.postMessage({id,results:bitmaps.map(item=>{try{return readOne(engine,item);}catch{return null;}})});
   return;
  }
  if(!bitmap){self.postMessage({id,result:null});return;}
  self.postMessage({id,result:readOne(engine,bitmap)});
 }catch(error){self.postMessage({id,error:String(error)});}
 finally{bitmap?.close();for(const item of bitmaps??[])item.close();}
};
