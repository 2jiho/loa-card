import type { Box } from './detector';
import { observationPixels } from './observation-pixels';

export type Raster = HTMLCanvasElement | OffscreenCanvas;
export type RasterContext = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
export const rasterContext = (canvas: Raster) => canvas.getContext('2d', { willReadFrequently:true }) as RasterContext;

/** Shared raster operations keep Worker and main-thread acquisition identical. */
export function createAcquisitionRaster<T extends Raster>(make: (width:number,height:number)=>T) {
  function crop(source: Raster, box:Box) {
    const result=make(Math.round(box.width),Math.round(box.height));
    rasterContext(result).drawImage(source,box.x,box.y,box.width,box.height,0,0,result.width,result.height);
    return result;
  }
  function features(image:T, pixels?: Uint8ClampedArray) {
    return observationPixels(pixels ?? rasterContext(image).getImageData(0,0,image.width,image.height).data,image.width,image.height);
  }
  return {crop,features};
}
