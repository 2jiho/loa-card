import {createRecordingInputRaster} from '../src/features/card-scanner/recording-input-raster';
import {packPixels,fastCompress} from '../src/features/card-scanner/exact-recording-codec';
const raster=createRecordingInputRaster();
const digest=async(pixels:Uint8Array<ArrayBuffer>)=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',pixels)),value=>value.toString(16).padStart(2,'0')).join('');
self.onmessage=async(event:MessageEvent<{port?:MessagePort;kind?:'png-benchmark';id?:number;bitmap?:ImageBitmap}>)=>{
  if(event.data.kind==='png-benchmark'){
    const bitmap=event.data.bitmap!;let decoded:ImageBitmap|undefined,canvas:OffscreenCanvas|undefined;
    try{
      const width=bitmap.width,height=bitmap.height,readStart=performance.now(),pixels=raster.read({width,height,bitmap}),engineReadMs=performance.now()-readStart;
      const engineHash=await digest(pixels);
      canvas=new OffscreenCanvas(width,height);const context=canvas.getContext('2d',{willReadFrequently:true})!;
      context.globalCompositeOperation='copy';const drawStart=performance.now();context.drawImage(bitmap,0,0);const drawMs=performance.now()-drawStart;
      const pngStart=performance.now(),png=await canvas.convertToBlob({type:'image/png'}),pngEncodeMs=performance.now()-pngStart;
      const decodeStart=performance.now();decoded=await createImageBitmap(png);const pngDecodeMs=performance.now()-decodeStart;
      const decodeReadStart=performance.now(),roundTrip=raster.read({width,height,bitmap:decoded}),pngReadMs=performance.now()-decodeReadStart;
      const pngHash=await digest(roundTrip);
      // Keyframe reference only. Real delta costs depend on the preceding
      // captured pixels; this does not substitute for the paced video test.
      const lz4Start=performance.now(),delta=packPixels(pixels),packed=fastCompress(delta),lz4KeyEncodeMs=performance.now()-lz4Start;
      self.postMessage({kind:'png-benchmark',id:event.data.id,width,height,rawBytes:pixels.byteLength,
        engineHash,pngHash,matched:engineHash===pngHash,engineSample:Array.from(pixels.subarray(0,32)),pngSample:Array.from(roundTrip.subarray(0,32)),
        engineReadMs,png:{bytes:png.size,drawMs,encodeMs:pngEncodeMs,decodeMs:pngDecodeMs,readMs:pngReadMs},
        lz4Key:{bytes:packed.byteLength,encodeMs:lz4KeyEncodeMs},scope:'single immutable input; native PNG vs current LZ4 keyframe; not paced capture throughput'});
    }catch(error){self.postMessage({kind:'png-benchmark',id:event.data.id,error:String(error)});}
    finally{decoded?.close();bitmap?.close();if(canvas)canvas.width=0;}
    return;
  }
  const port=event.data.port;
  if(!port)return;
  port.onmessage=async event=>{
    const frame=event.data;
    if(frame.kind!=='frame')return;
    try{
      const pixels=raster.read(frame);
      const hash=await digest(pixels);
      self.postMessage({id:frame.id,hash,sample:Array.from(pixels.subarray(0,32)),time:frame.time,phase:frame.phase});
    }catch(error){self.postMessage({id:frame.id,error:String(error)});}
    finally{frame.bitmap?.close();port.postMessage({kind:'credit',bytes:frame.width*frame.height*4});}
  };
  port.start();
};
