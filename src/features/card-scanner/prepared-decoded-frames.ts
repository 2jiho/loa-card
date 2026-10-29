import {ALL_FORMATS,BlobSource,Input,UrlSource,VideoSampleSink} from 'mediabunny';
import type {InputVideoTrack} from 'mediabunny';
import {yieldForCapture} from './input-source';
import {MAX_FRAME_BYTES} from './recording-frame-integrity';

export type PreparedDecodeFallback='sample-orientation'|'sample-pixel-aspect'|'video-frame-api-unavailable';
export interface PreparedDecodedFrame {
  /** A blank size-only placeholder for native input, actual pixels for fallback. */
  readonly element:HTMLCanvasElement;readonly time:number;readonly percent:number;
  readonly decodeSample:{readonly trackId:number|null;readonly duration:number};
  /** Borrowed until next()/return() or abort. Consumers clone before awaiting. */
  readonly nativeFrame?:VideoFrame;readonly fallbackReason?:PreparedDecodeFallback;
}
export interface PreparedDecodeSample {
  readonly timestamp:number;readonly duration:number;readonly rotation:number;readonly flip:boolean;
  readonly pixelAspectRatio:{readonly num:number;readonly den:number};readonly displayWidth:number;readonly displayHeight:number;
  toVideoFrame():VideoFrame;draw(context:CanvasRenderingContext2D,dx:number,dy:number,width:number,height:number):void;close():void;
}
export interface PreparedDecodeTrack {readonly id?:number;canDecode():Promise<boolean>;computeDuration():Promise<number>}
export interface PreparedDecodeInput {getPrimaryVideoTrack():Promise<PreparedDecodeTrack|null>;dispose():void}
export interface PreparedDecodedFramesPlatform {
  createInput(source:Blob|string):PreparedDecodeInput;
  samples(track:PreparedDecodeTrack):AsyncIterator<PreparedDecodeSample>;
  createCanvas():HTMLCanvasElement;nativeAvailable():boolean;yieldTask(signal:AbortSignal):Promise<void>;
  /** Tests may tighten operation deadlines, never increase them. */
  limits?:Partial<{operationTimeoutMs:number;cleanupTimeoutMs:number}>;
}
export const PREPARED_DECODE_LIMITS=Object.freeze({operationTimeoutMs:30_000,cleanupTimeoutMs:5_000});
const defaults:PreparedDecodedFramesPlatform={
  createInput:source=>new Input({formats:ALL_FORMATS,source:typeof source==='string'?new UrlSource(source):new BlobSource(source)}),
  samples:track=>new VideoSampleSink(track as InputVideoTrack,{hardwareAcceleration:'no-preference'}).samples(),
  createCanvas:()=>document.createElement('canvas'),nativeAvailable:()=>typeof VideoFrame!=='undefined',yieldTask:yieldForCapture,
};
function dimensions(width:number,height:number):void {
  if(!Number.isSafeInteger(width)||width<1||!Number.isSafeInteger(height)||height<1||
    !Number.isSafeInteger(width*height*4)||width*height*4>MAX_FRAME_BYTES)throw Error('준비할 영상 프레임 크기 초과');
}

/** Sequential native decoder borrow, not a second CanvasSink pass. Unsupported
 * orientation/aspect is rendered from that very VideoSample; format/color
 * recipe support remains the source preparer's decision. No FPS sampling. */
export async function* preparedDecodedFrames(source:Blob|string,signal:AbortSignal,
  platform:PreparedDecodedFramesPlatform=defaults):AsyncGenerator<PreparedDecodedFrame> {
  signal.throwIfAborted();
  if(!(source instanceof Blob)&&!(typeof source==='string'&&source.length))throw Error('잘못된 준비 영상 입력');
  const limits={...PREPARED_DECODE_LIMITS,...platform.limits};
  for(const key of ['operationTimeoutMs','cleanupTimeoutMs']as const)
    if(!Number.isFinite(limits[key])||limits[key]<1||limits[key]>PREPARED_DECODE_LIMITS[key])throw Error('잘못된 준비 영상 디코딩 한도');
  let input:PreparedDecodeInput|undefined,iterator:AsyncIterator<PreparedDecodeSample>|undefined,canvas:HTMLCanvasElement|undefined,
    activeSample:PreparedDecodeSample|undefined,activeFrame:VideoFrame|undefined,inputStopped=false,drawn=false,failed=false;
  const closedSamples=new WeakSet<object>(),closedFrames=new WeakSet<object>(),cleanupErrors:string[]=[];
  const closeSample=(sample:PreparedDecodeSample|undefined)=>{if(!sample||typeof sample!=='object'||closedSamples.has(sample))return;
    closedSamples.add(sample);try{sample.close();}catch(error){cleanupErrors.push(String(error));}};
  const closeFrame=(frame:VideoFrame|undefined)=>{if(!frame||typeof frame!=='object'||closedFrames.has(frame))return;
    closedFrames.add(frame);try{frame.close();}catch(error){cleanupErrors.push(String(error));}};
  const stopInput=()=>{if(input&&!inputStopped){inputStopped=true;try{input.dispose();}catch(error){cleanupErrors.push(String(error));}}};
  const abort=()=>{closeFrame(activeFrame);closeSample(activeSample);stopInput();};
  signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();
  /** A native decoder may resolve after cancellation. Keep only one outstanding
   * next() operation; late owned samples close even in a same-turn abort race. */
  async function operation<T>(work:()=>Promise<T>|T,late?:(value:T)=>void,cleanup=false):Promise<T>{
    if(!cleanup)signal.throwIfAborted();
    let abandoned=false,finished=false,handedOff=false,released=false,value:T|undefined,
      timer:ReturnType<typeof setTimeout>|undefined,onAbort:(()=>void)|undefined;
    const release=()=>{if(!released&&finished&&!handedOff){released=true;try{late?.(value as T);}catch(error){cleanupErrors.push(String(error));}}};
    const tracked=Promise.resolve().then(()=>{if(!cleanup)signal.throwIfAborted();return work();});
    void tracked.then(result=>{finished=true;value=result;if(abandoned)release();},()=>{});
    try{
      const result=await Promise.race([tracked,new Promise<never>((_,reject)=>{
        if(!cleanup){onAbort=()=>reject(signal.reason);signal.addEventListener('abort',onAbort,{once:true});if(signal.aborted)onAbort();}
        timer=setTimeout(()=>reject(Error('영상 디코딩 작업 시간 초과')),cleanup?limits.cleanupTimeoutMs:limits.operationTimeoutMs);
      })]);handedOff=true;return result;
    }catch(error){abandoned=true;release();throw error;}
    finally{clearTimeout(timer);if(onAbort)signal.removeEventListener('abort',onAbort);}
  }
  const closeResult=(result:IteratorResult<PreparedDecodeSample>)=>{if(result&&result.value)closeSample(result.value);};
  try{
    input=platform.createInput(source);signal.throwIfAborted();
    const track=await operation(()=>input!.getPrimaryVideoTrack());signal.throwIfAborted();
    if(!track||!await operation(()=>track.canDecode()))throw Error('이 영상의 준비 프레임 디코딩을 지원하지 않습니다.');
    const duration=await operation(()=>track.computeDuration());signal.throwIfAborted();
    if(!Number.isFinite(duration)||duration<0)throw Error('잘못된 영상 재생 시간');
    iterator=platform.samples(track);let count=0,lastPts=-Infinity;
    while(true){
      signal.throwIfAborted();const next=await operation(()=>iterator!.next(),closeResult);
      if(next.done)break;
      activeSample=next.value;signal.throwIfAborted();const sample=activeSample;
      if(!sample||typeof sample!=='object'||typeof sample.close!=='function'||!Number.isFinite(sample.timestamp)||
        sample.timestamp<lastPts||!Number.isFinite(sample.duration)||sample.duration<0)throw Error('잘못된 준비 영상 표본 순서 또는 시각');
      const time=sample.timestamp,percent=duration>0?Math.max(0,Math.min(100,(time+sample.duration)/duration*100)):0;
      dimensions(sample.displayWidth,sample.displayHeight);
      const aspect=sample.pixelAspectRatio;
      const fallbackReason:PreparedDecodeFallback|undefined=sample.rotation!==0||sample.flip!==false?'sample-orientation':
        !aspect||aspect.num!==1||aspect.den!==1?'sample-pixel-aspect':!platform.nativeAvailable()?'video-frame-api-unavailable':undefined;
      canvas??=platform.createCanvas();
      if(fallbackReason){
        canvas.width=sample.displayWidth;canvas.height=sample.displayHeight;
        const context=canvas.getContext('2d',{willReadFrequently:true,alpha:false});if(!context)throw Error('준비 영상 대체 Canvas 미지원');
        context.globalCompositeOperation='copy';sample.draw(context,0,0,canvas.width,canvas.height);drawn=true;
      }else{
        activeFrame=sample.toVideoFrame();signal.throwIfAborted();
        dimensions(activeFrame.displayWidth,activeFrame.displayHeight);
        if(activeFrame.displayWidth!==sample.displayWidth||activeFrame.displayHeight!==sample.displayHeight)throw Error('영상 표본과 native 표시 크기 불일치');
        if(canvas.width!==activeFrame.displayWidth||canvas.height!==activeFrame.displayHeight||drawn){
          canvas.width=activeFrame.displayWidth;canvas.height=activeFrame.displayHeight;drawn=false;
        }
      }
      closeSample(sample);activeSample=undefined;lastPts=time;count++;
      if(cleanupErrors.length)throw Error('준비 영상 표본 자원 해제 실패');
      try{yield {element:canvas,time,percent,decodeSample:{trackId:track.id??null,duration:sample.duration},
        ...(activeFrame?{nativeFrame:activeFrame}:{}),...(fallbackReason?{fallbackReason}:{})};}
      finally{closeFrame(activeFrame);activeFrame=undefined;}
      signal.throwIfAborted();await platform.yieldTask(signal);
    }
    if(!count)throw Error('영상에서 읽을 수 있는 준비 프레임이 없습니다.');
  }catch(error){failed=true;signal.throwIfAborted();throw error;}
  finally{
    closeFrame(activeFrame);closeSample(activeSample);activeFrame=undefined;activeSample=undefined;stopInput();
    if(iterator?.return)try{closeResult(await operation(()=>iterator!.return!(),closeResult,true));}catch(error){cleanupErrors.push(String(error));}
    if(canvas){try{canvas.width=0;canvas.height=0;}catch(error){cleanupErrors.push(String(error));}}
    signal.removeEventListener('abort',abort);
    // Surface cleanup failure on normal finish/return, while retaining the
    // original decoder error or abort whenever one already exists.
    // oxlint-disable-next-line no-unsafe-finally
    if(!failed&&!signal.aborted&&cleanupErrors.length)throw Error(`준비 영상 디코딩 자원 해제 실패: ${cleanupErrors.join(' · ')}`);
  }
}
