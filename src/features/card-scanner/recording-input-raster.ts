import {MAX_FRAME_BYTES} from './exact-recording-codec';

export interface RecordingRasterInput {
  width:number;height:number;
  bitmap?:ImageBitmap|VideoFrame;
  /** Legacy worker transport; retained for previous recordings and adapters. */
  pixels?:ArrayBuffer;
}
export function recordingInputBytes(input:RecordingRasterInput):number {
  const {width,height}=input,bytes=width*height*4;
  if(!Number.isSafeInteger(width)||!Number.isSafeInteger(height)||width<1||height<1||!Number.isSafeInteger(bytes)||bytes>MAX_FRAME_BYTES)
    throw Error('입력 크기 초과');
  return bytes;
}

/** The same default 2D drawImage/getImageData conversion used by acquisition,
 * moved to the recording worker. The caller retains and closes bitmap once. */
export function createRecordingInputRaster(make:(width:number,height:number)=>OffscreenCanvas=(width,height)=>new OffscreenCanvas(width,height)) {
  let canvas:OffscreenCanvas|undefined,context:OffscreenCanvasRenderingContext2D|undefined;
  return {
    read(input:RecordingRasterInput):Uint8Array<ArrayBuffer>{
      const bytes=recordingInputBytes(input);
      if(input.bitmap){
        const bitmap=input.bitmap,width='displayWidth' in bitmap?bitmap.displayWidth:bitmap.width,
          height='displayHeight' in bitmap?bitmap.displayHeight:bitmap.height;
        if(width!==input.width||height!==input.height)throw Error('기록 원본 크기 불일치');
        if(!canvas){canvas=make(width,height);context=canvas.getContext('2d',{willReadFrequently:true})!;if(!context)throw Error('기록 픽셀 변환 미지원');}
        if(canvas.width!==width||canvas.height!==height){canvas.width=width;canvas.height=height;}
        // Reused canvases must replace the input, including transparent pixels.
        // source-over would blend a later frame with the previous frame.
        context!.globalCompositeOperation='copy';
        context!.drawImage(bitmap,0,0);
        const data=context!.getImageData(0,0,width,height).data;
        if(data.byteLength!==bytes)throw Error('기록 픽셀 크기 불일치');
        return new Uint8Array(data.buffer,data.byteOffset,data.byteLength);
      }
      if(!(input.pixels instanceof ArrayBuffer)||input.pixels.byteLength!==bytes)throw Error('입력 크기 초과');
      return new Uint8Array(input.pixels);
    },
  };
}
