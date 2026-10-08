import {ExactPixelCache} from './exact-pixel-cache';
type Region = {width:number;height:number;data:Uint8ClampedArray};

/** Memoize successful OCR on an unchanged set of complete pixel regions.
 * Results are copied so consumers cannot mutate later cache hits. */
export class ExactRegionResult<T> {
  private cache:ExactPixelCache<T>;
  private count:number;
  constructor(count:number){this.count=count;this.cache=new ExactPixelCache(count);}
  get(regions:readonly Region[]):T|undefined {
    if(regions.length!==this.count)return;
    let result:T|undefined;
    for(let i=0;i<regions.length;i++) {
      const region=regions[i],next=this.cache.get(i,`${region.width}/${region.height}`,region.data);
      if(next===undefined || (i>0 && next!==result))return;
      result=next;
    }
    return result===undefined ? undefined : structuredClone(result);
  }
  set(regions:readonly Region[],result:T) {
    if(regions.length!==this.count)throw new Error('Unexpected OCR region count');
    const snapshot=structuredClone(result);
    regions.forEach((r,i)=>this.cache.set(i,`${r.width}/${r.height}`,r.data,snapshot));
  }
  async read(regions:readonly Region[],recognize:()=>Promise<T|null>):Promise<T|null> {
    const cached=this.get(regions);
    if(cached!==undefined)return cached;
    const result=await recognize();
    if(result!==null)this.set(regions,result);
    return result;
  }
}
