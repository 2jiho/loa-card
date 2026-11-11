import type { Box } from './detector';

/** Exact raster subset only. Never approximate fractional Canvas sampling. */
export function integerCropPixels(source:Uint8ClampedArray,width:number,height:number,box:Box):Uint8ClampedArray|undefined {
  if (![width,height,box.x,box.y,box.width,box.height].every(Number.isInteger) ||
      box.x<0 || box.y<0 || box.width<=0 || box.height<=0 ||
      box.x+box.width>width || box.y+box.height>height || source.length!==width*height*4) return;
  const pixels=new Uint8ClampedArray(box.width*box.height*4);
  const rowBytes=box.width*4;
  for(let y=0;y<box.height;y++) {
    const offset=((box.y+y)*width+box.x)*4;
    pixels.set(source.subarray(offset,offset+rowBytes),y*rowBytes);
  }
  return pixels;
}
