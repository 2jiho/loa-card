import {OcrImageLimit} from './card-read-budget';
/** Bounds apply per canvas and are logical RGBA bytes, not physical memory. */
export const OCR_CANVAS_MAX_SIDE=4096,OCR_CANVAS_MAX_PIXELS=1_048_576;
export function validateOcrCanvasSize(width:number,height:number):void {
 if(!Number.isSafeInteger(width)||!Number.isSafeInteger(height)||width<1||height<1||
    width>OCR_CANVAS_MAX_SIDE||height>OCR_CANVAS_MAX_SIDE||width*height>OCR_CANVAS_MAX_PIXELS)throw new OcrImageLimit();
}
/** Capture pixels synchronously once a queue slot is admitted. The caller may
 * dispose its source before a timed-out worker or its decoder actually settles. */
/** Validate the 4x padded fallback before allocating its first canvas. */
export function enlargedOcrSize(width:number,height:number):{width:number;height:number} {
 if(!Number.isSafeInteger(width)||!Number.isSafeInteger(height)||width<1||height<1)throw new OcrImageLimit();
 const next={width:width*4+32,height:height*4+32};validateOcrCanvasSize(next.width,next.height);return next;
}
export function snapshotOcrCanvas(source:HTMLCanvasElement):HTMLCanvasElement {
 validateOcrCanvasSize(source.width,source.height);
 const snapshot=document.createElement('canvas');
 try{
  snapshot.width=source.width;snapshot.height=source.height;
  const context=snapshot.getContext('2d');if(!context)throw Error('OCR 캔버스를 만들 수 없습니다');
  context.drawImage(source,0,0);return snapshot;
 }catch(error){snapshot.width=0;snapshot.height=0;throw error;}
}
export function releaseOcrCanvas(snapshot:HTMLCanvasElement){snapshot.width=0;snapshot.height=0;}
