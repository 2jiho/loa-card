/** Lossless CPU raster transport. ArrayBuffer ownership moves to the receiver. */
export interface PixelRaster { width:number; height:number; data:Uint8ClampedArray<ArrayBuffer> }
export function readPixelRaster(canvas:OffscreenCanvas):PixelRaster {
 const {width,height}=canvas;
 const {data}=canvas.getContext('2d',{willReadFrequently:true})!.getImageData(0,0,width,height);
 return {width,height,data};
}
export function paintPixelRaster(context:CanvasRenderingContext2D,raster:PixelRaster) {
 if(!Number.isInteger(raster.width)||!Number.isInteger(raster.height)||raster.width<=0||raster.height<=0||
  !(raster.data instanceof Uint8ClampedArray)||raster.data.length!==raster.width*raster.height*4)
  throw new Error('잘못된 카드 픽셀 데이터');
 context.putImageData(new ImageData(raster.data,raster.width,raster.height),0,0);
}
