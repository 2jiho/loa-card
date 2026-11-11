/** Development-only selection experiment. Descriptors are scheduling hints,
 * not evidence of a card, distinct pixels, position or complete coverage. */
export type ThumbnailFrame = Readonly<{id:number; bytes:number; thumbnail:Uint8Array}>;
export type ThumbnailPolicy = 'oldest'|'diversity';
export type ThumbnailChoice = Readonly<{kept:readonly ThumbnailFrame[];distanceEvaluations:number}>;

export function thumbnailDistance(a:Uint8Array,b:Uint8Array):number|null {
 if(a.length===0||a.length!==b.length)return null;
 let total=0;for(let i=0;i<a.length;i++)total+=Math.abs(a[i]-b[i]);
 return total/a.length;
}

/** Mirrors the production 1 active + 2 pending byte/count contract. The
 * caller supplies small grayscale thumbnails derived from frozen frames. */
export function chooseThumbnailFrames(active:ThumbnailFrame|null,pending:readonly ThumbnailFrame[],incoming:ThumbnailFrame,
 budget:number,policy:ThumbnailPolicy):ThumbnailChoice {
 if(!Number.isSafeInteger(budget)||budget<1||pending.length>2||
   [...pending,incoming,...(active?[active]:[])].some(f=>!Number.isSafeInteger(f.bytes)||f.bytes<1))throw Error('invalid frame budget');
 const available=budget-(active?.bytes??0);
 if(incoming.bytes>available)return {kept:[],distanceEvaluations:0};
 const candidates=pending.filter(x=>x.bytes<=available-incoming.bytes);
 if(!candidates.length)return {kept:[incoming],distanceEvaluations:0};
 let best=candidates[0],evaluations=0;
 if(policy==='diversity'){
  let bestScore=-1;
  for(const frame of candidates){
   const references=active?[active,incoming]:[incoming];let score=Infinity,valid=true;
   for(const reference of references){const distance=thumbnailDistance(frame.thumbnail,reference.thumbnail);evaluations++;if(distance===null){valid=false;break;}score=Math.min(score,distance);}
   // A missing/invalid signal makes all comparisons unsafe. Do not silently
   // prefer whichever candidate happened to carry a usable descriptor.
   if(!valid)return {kept:[candidates[0],incoming],distanceEvaluations:evaluations};
   if(score>bestScore){bestScore=score;best=frame;}
  }
 }
 return {kept:[best,incoming],distanceEvaluations:evaluations};
}
