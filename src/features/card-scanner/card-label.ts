import { hasNamePixels } from './name-pattern';
import { rasterContext } from './acquisition-raster';
import type { Raster } from './acquisition-raster';

/** Reuse one small raster; resetting its dimensions per card reallocates it. */
export function createLabelReader<T extends Raster>(make: (width:number,height:number)=>T) {
  const canvas=make(128,36), context=rasterContext(canvas);
  return (image:T) => {
    context.clearRect(0,0,128,36);
    context.drawImage(image,6*image.width/140,14*image.height/210,
      128*image.width/140,36*image.height/210,0,0,128,36);
    const rgba=context.getImageData(0,0,128,36).data;
    return hasNamePixels(rgba);
  };
}
