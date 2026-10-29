import type { PixelRaster } from './pixel-raster';

/** Borrowed actual Canvas readback. This carries pixels, never proof authority.
 * Its owner must not mutate or transfer the buffer during synchronous cropping. */
export type MeasuredRaster = Readonly<PixelRaster>;

export function requireMeasuredRaster(raster:MeasuredRaster,width:number,height:number):MeasuredRaster {
  const {data}=raster;
  if(!Number.isSafeInteger(width)||!Number.isSafeInteger(height)||width<=0||height<=0||
    raster.width!==width||raster.height!==height||!(data instanceof Uint8ClampedArray)||
    !(data.buffer instanceof ArrayBuffer)||(data.buffer as ArrayBuffer&{resizable?:boolean}).resizable===true||data.byteOffset!==0||
    data.byteLength!==width*height*4||data.byteLength!==data.buffer.byteLength)
    throw Error('잘못된 측정 픽셀 크기 또는 소유 버퍼');
  return raster;
}

/** The caller supplies a fresh crop/readback allocation, not a proof/cache view. */
export function ownedCardRaster(data:Uint8ClampedArray,width:number,height:number):PixelRaster {
  const raster={data,width,height} as PixelRaster;
  requireMeasuredRaster(raster,width,height);
  return raster;
}

/** Opaque, integer copies avoid an additional Canvas premultiplication roundtrip.
 * Transparent input retains the actual cropped Canvas readback for transport. */
export function opaqueCardPixels(data:Uint8ClampedArray):boolean {
  for(let i=3;i<data.length;i+=4)if(data[i]!==255)return false;
  return true;
}
