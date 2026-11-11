import {createRecordingInputRaster,recordingInputBytes,type RecordingRasterInput} from './recording-input-raster';

const raster=createRecordingInputRaster();
let ready=false,disposed=false;
self.onmessage=(event:MessageEvent)=>{
 const data=event.data;
 if(data?.kind==='init'){if(!disposed){ready=true;self.postMessage({kind:'ready'});}return;}
 if(data?.kind==='dispose'){disposed=true;self.postMessage({kind:'disposed'});return;}
 if(data?.kind!=='raster')return;
 const input:RecordingRasterInput={width:data.width,height:data.height,...(data.bitmap?{bitmap:data.bitmap}:{pixels:data.pixels})};
 let closed=false;
 const close=()=>{if(closed)return;closed=true;try{input.bitmap?.close();}catch{/* This worker owns the transferred source even on conversion failure. */}};
 try{
  if(!ready||disposed||!Number.isSafeInteger(data.id)||data.id<1||!Number.isFinite(data.sentAt)||data.sentAt<0)throw Error('기록 픽셀 작업 요청 오류');
  const bytes=recordingInputBytes(input),start=performance.now(),queueMs=Math.max(0,performance.timeOrigin+start-data.sentAt);
  const pixels=raster.read(input),readbackMs=performance.now()-start;
  if(pixels.byteOffset!==0||pixels.byteLength!==bytes||pixels.buffer.byteLength!==bytes)throw Error('기록 픽셀 변환 크기 오류');
  close();
  self.postMessage({kind:'raster',id:data.id,width:input.width,height:input.height,pixels:pixels.buffer,readbackMs,queueMs},{transfer:[pixels.buffer]});
 }catch(error){self.postMessage({kind:'raster-error',id:data.id,error:String(error).slice(0,2000)});}
 finally{close();}
};
