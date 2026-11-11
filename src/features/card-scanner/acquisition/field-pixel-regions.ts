import type {Box} from './detector';

/** Raw-pixel selection mask for an integer, unscaled 140×210 card. Other
 * sampling phases conservatively receive a new revision; neither a downsampled
 * feature nor matching source pixels prove equivalent Canvas resampling. */
export function fieldPixelRegions(content:Box,width:number,height:number):Box[]|undefined {
  if(![content.x,content.y,content.width,content.height,width,height].every(Number.isSafeInteger)||
    content.width!==140||content.height!==210||width<1||height<1)return;
  const regions=[[6,14,128,36],[56,141,82,31],[14,176,112,24]].map(([x,y,w,h])=>
    ({x:content.x+x,y:content.y+y,width:w,height:h}));
  if(regions.some(box=>box.x<0||box.y<0||box.x+box.width>width||box.y+box.height>height))return;
  return regions;
}
