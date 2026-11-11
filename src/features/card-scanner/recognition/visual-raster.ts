/** A worker-owned canvas for a single synchronous visual read at a time.
 * The returned canvas is borrowed until the next read; the readback pixels
 * belong to this invocation. Inputs above the cache budget use a fresh canvas
 * so an unusual large crop is not retained for the worker's entire lifetime. */
export function createVisualRaster(make:(width:number,height:number)=>OffscreenCanvas =
  (width,height)=>new OffscreenCanvas(width,height)) {
 const maxCachedPixels=1024*1024;
 let cached:OffscreenCanvas|undefined;
 return {
  read(bitmap:ImageBitmap) {
   const {width,height}=bitmap;
   const cacheable=Number.isSafeInteger(width)&&Number.isSafeInteger(height)&&width>0&&height>0&&width*height<=maxCachedPixels;
   const image=cacheable?(cached??=make(width,height)):make(width,height);
   if(image.width!==width)image.width=width;
   if(image.height!==height)image.height=height;
   const ctx=image.getContext('2d',{willReadFrequently:true});
   if(!ctx)throw Error('시각 판독 캔버스 컨텍스트 없음');
   // drawImage uses source-over: without this, transparent parts of the new
   // bitmap would retain pixels from the previous observation.
   if(cacheable)ctx.clearRect(0,0,width,height);
   ctx.drawImage(bitmap,0,0);
   return {image,pixels:ctx.getImageData(0,0,width,height).data};
  },
 };
}
