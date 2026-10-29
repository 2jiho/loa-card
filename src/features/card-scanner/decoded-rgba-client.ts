import {MAX_FRAME_BYTES} from './exact-recording-codec';

export const DECODED_RGBA_RECIPE='webcodecs-rgba-srgb-v1';
export const MAX_DECODED_RGBA_SOURCE_BYTES=256*1024*1024;
export type DecodedRgbaPreference='no-preference'|'prefer-software';
export interface DecodedRgbaColorSpace {readonly primaries:string|null;readonly transfer:string|null;readonly matrix:string|null;readonly fullRange:boolean|null}
export interface DecodedRgbaMetadata {
 readonly recipe:typeof DECODED_RGBA_RECIPE;readonly ordinal:number;readonly pts:number;readonly duration:number;
 readonly trackId:number;readonly decoderPreference:DecodedRgbaPreference;readonly rgbaSha256:string;
 readonly geometry:Readonly<{codedWidth:number;codedHeight:number;displayWidth:number;displayHeight:number;
  visibleRect:Readonly<{x:number;y:number;width:number;height:number}>;rotation:0;flip:false;pixelAspectRatio:Readonly<{num:1;den:1}>}>;
 readonly nativeFormat:string|null;readonly nativeColorSpace:DecodedRgbaColorSpace;readonly sampleColorSpace:DecodedRgbaColorSpace;
 readonly nativeTimestampMicroseconds:number;readonly nativeDurationMicroseconds:number|null;
 readonly rgbaLayout:Readonly<{format:'RGBA';colorSpace:'srgb';offset:0;stride:number;bytes:number}>;
}
export interface DecodedRgbaInput {
 element:HTMLCanvasElement|OffscreenCanvas;time:number;percent:number;decoded:DecodedRgbaMetadata;
}
export type DecodedRgbaWorker=Pick<Worker,'postMessage'|'terminate'|'onmessage'|'onerror'|'onmessageerror'>;
export interface DecodedRgbaOptions {
 decoderPreference?:DecodedRgbaPreference;
 workerFactory?:()=>DecodedRgbaWorker;
 canvasFactory?:()=>HTMLCanvasElement|OffscreenCanvas;
 imageDataFactory?:(pixels:Uint8ClampedArray<ArrayBuffer>,width:number,height:number)=>ImageData;
 initTimeoutMs?:number;nextTimeoutMs?:number;disposeTimeoutMs?:number;
}
export class DecodedRgbaError extends Error {
 readonly code:'unsupported'|'protocol'|'runtime'|'timeout'|'cleanup';
 constructor(code:DecodedRgbaError['code'],message:string){super(message);this.name='DecodedRgbaError';this.code=code;}
}

const object=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value);
const natural=(value:unknown):value is number=>typeof value==='number'&&Number.isSafeInteger(value)&&value>=0;
const positive=(value:unknown):value is number=>natural(value)&&value>0;
const time=(value:unknown):value is number=>typeof value==='number'&&Number.isFinite(value)&&value>=0;
const sha=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
function protocol(message:string):never {throw new DecodedRgbaError('protocol',`표준 RGBA 응답 오류: ${message}`);}
function size(width:unknown,height:unknown){
 if(!positive(width)||!positive(height)||!Number.isSafeInteger(width*height*4)||width*height*4>MAX_FRAME_BYTES)protocol('크기');
 return width*height*4;
}
function color(value:unknown):DecodedRgbaColorSpace {
 if(!object(value)||!['primaries','transfer','matrix'].every(key=>value[key]===null||typeof value[key]==='string'&&(value[key] as string).length<=100)||
  value.fullRange!==null&&typeof value.fullRange!=='boolean')protocol('색 정보');
 return Object.freeze({primaries:value.primaries as string|null,transfer:value.transfer as string|null,matrix:value.matrix as string|null,fullRange:value.fullRange as boolean|null});
}
function metadata(value:unknown,width:number,height:number,timeValue:number,ordinal:number,trackId:number,preference:DecodedRgbaPreference):DecodedRgbaMetadata {
 if(!object(value)||value.recipe!==DECODED_RGBA_RECIPE||value.ordinal!==ordinal||value.pts!==timeValue||!time(value.duration)||
  value.trackId!==trackId||value.decoderPreference!==preference||!sha(value.rgbaSha256)||!object(value.geometry)||!object(value.rgbaLayout))protocol('프레임 근거');
 const geometry=value.geometry,visible=geometry.visibleRect,ratio=geometry.pixelAspectRatio,layout=value.rgbaLayout;
 size(geometry.codedWidth,geometry.codedHeight);
 if(!object(visible)||!natural(visible.x)||!natural(visible.y)||visible.width!==width||visible.height!==height||
  visible.x+width>(geometry.codedWidth as number)||visible.y+height>(geometry.codedHeight as number)||
  geometry.displayWidth!==width||geometry.displayHeight!==height||geometry.rotation!==0||geometry.flip!==false||
  !object(ratio)||ratio.num!==1||ratio.den!==1||layout.format!=='RGBA'||layout.colorSpace!=='srgb'||layout.offset!==0||layout.stride!==width*4||layout.bytes!==width*height*4||
  value.nativeFormat!==null&&(typeof value.nativeFormat!=='string'||value.nativeFormat.length>100)||
  typeof value.nativeTimestampMicroseconds!=='number'||!Number.isSafeInteger(value.nativeTimestampMicroseconds)||
  value.nativeDurationMicroseconds!==null&&!natural(value.nativeDurationMicroseconds))protocol('회전·배율·크롭·배치');
 return Object.freeze({recipe:DECODED_RGBA_RECIPE,ordinal,pts:timeValue,duration:value.duration,trackId,decoderPreference:preference,rgbaSha256:value.rgbaSha256,
  geometry:Object.freeze({codedWidth:geometry.codedWidth as number,codedHeight:geometry.codedHeight as number,displayWidth:width,displayHeight:height,
   visibleRect:Object.freeze({x:visible.x,y:visible.y,width,height}),rotation:0 as const,flip:false as const,pixelAspectRatio:Object.freeze({num:1 as const,den:1 as const})}),
  nativeFormat:value.nativeFormat as string|null,nativeColorSpace:color(value.nativeColorSpace),sampleColorSpace:color(value.sampleColorSpace),
  nativeTimestampMicroseconds:value.nativeTimestampMicroseconds,nativeDurationMicroseconds:value.nativeDurationMicroseconds as number|null,
  rgbaLayout:Object.freeze({format:'RGBA' as const,colorSpace:'srgb' as const,offset:0 as const,stride:width*4,bytes:width*height*4})});
}
const timeout=(value:number|undefined,fallback:number,max:number)=>{
 const result=value??fallback;if(!positive(result)||result>max)throw new RangeError('표준 RGBA 제한 시간 오류');return result;
};

/** Experimental pull decoder. Each yielded canvas is borrowed until the next
 * next()/return(); copy/freeze it before advancing. Ordinals identify decoder
 * samples, never scanner source/use IDs or card freshness. rgbaSha256 covers
 * the transferred RGBA before painting; a recording verifies its own raster
 * independently. No Canvas fallback.
 * The application holds one transferred frame at a time; the decoder library's
 * internal prefetch/GPU queue is not bounded by this client. */
export async function* decodedRgbaFrames(blob:Blob,signal:AbortSignal,options:DecodedRgbaOptions={}):AsyncGenerator<DecodedRgbaInput> {
 signal.throwIfAborted();
 if(!(blob instanceof Blob)||!blob.size||blob.size>MAX_DECODED_RGBA_SOURCE_BYTES)throw new DecodedRgbaError('unsupported','표준 RGBA 영상 입력 크기를 지원하지 않습니다.');
 const preference=options.decoderPreference??'no-preference';
 if(preference!=='no-preference'&&preference!=='prefer-software')throw new RangeError('표준 RGBA 디코더 힌트 오류');
 const initTimeout=timeout(options.initTimeoutMs,30_000,30_000),nextTimeout=timeout(options.nextTimeoutMs,20_000,30_000),disposeTimeout=timeout(options.disposeTimeoutMs,2000,2000);
 let worker:DecodedRgbaWorker|undefined,canvas:HTMLCanvasElement|OffscreenCanvas|undefined;
 let pending:{id:number;kind:'init'|'next';resolve:(value:Record<string,unknown>)=>void;reject:(error:unknown)=>void;timer:ReturnType<typeof setTimeout>}|undefined;
 let sequence=0,settled=0,closing=false,closed=false,trackId=0,ordinal=0,lastTime=-Infinity;
 let disposeJob:{id:number;resolve:()=>void;timer:ReturnType<typeof setTimeout>}|undefined;
 let cleanupError:unknown,failed=false,failure:unknown,hasTerminalError=false,terminalError:unknown,shutdownJob:Promise<void>|undefined;
 const reject=(error:unknown)=>{if(pending){const job=pending;pending=undefined;clearTimeout(job.timer);job.reject(error);}};
 const fail=(error:unknown)=>{hasTerminalError=true;terminalError=error;reject(error);};
 const abort=()=>{reject(signal.reason??new DOMException('표준 RGBA 디코드 중지','AbortError'));void shutdown();};
 signal.addEventListener('abort',abort,{once:true});
 const request=(kind:'init'|'next',payload:Record<string,unknown>,milliseconds:number)=>new Promise<Record<string,unknown>>((resolve,rejectRequest)=>{
  signal.throwIfAborted();if(hasTerminalError)throw terminalError;if(closing||closed||pending)throw new DecodedRgbaError('protocol','동시 표준 RGBA 요청');
  const id=++sequence,timer=setTimeout(()=>fail(new DecodedRgbaError('timeout',kind==='init'?'표준 RGBA 디코더 준비 시간 초과':'표준 RGBA 프레임 디코드 시간 초과')),milliseconds);
  pending={id,kind,resolve,reject:rejectRequest,timer};
  try{worker!.postMessage({kind,id,...payload});}catch(error){fail(error);}
 });
 const shutdown=()=>shutdownJob??=(async()=>{
  if(closed)return;closing=true;signal.removeEventListener('abort',abort);reject(new DOMException('표준 RGBA 디코더 종료','AbortError'));
  if(worker){
   try{await new Promise<void>(resolve=>{
    const id=++sequence,timer=setTimeout(()=>{cleanupError=new DecodedRgbaError('cleanup','표준 RGBA 종료 응답 시간 초과');resolve();},disposeTimeout);
    disposeJob={id,resolve,timer};
    try{worker!.postMessage({kind:'dispose',id});}catch(error){clearTimeout(timer);cleanupError=error;resolve();}
   });}finally{
    if(disposeJob)clearTimeout(disposeJob.timer);disposeJob=undefined;worker.onmessage=null;worker.onerror=null;worker.onmessageerror=null;worker.terminate();
   }
  }
  closed=true;
 })();
 try{
  signal.throwIfAborted();
  worker=options.workerFactory?options.workerFactory():(()=>{
   if(typeof Worker==='undefined')throw new DecodedRgbaError('unsupported','표준 RGBA 디코더 작업자를 지원하지 않습니다.');
   return new Worker(new URL('./decoded-rgba-worker.ts',import.meta.url),{type:'module'});
  })();
  worker.onmessage=event=>{
   const reply=event.data;
   if(closing){
    if(disposeJob&&reply?.kind==='disposed'&&reply.id===disposeJob.id){clearTimeout(disposeJob.timer);if(reply.error)cleanupError=new DecodedRgbaError('cleanup',String(reply.error));disposeJob.resolve();}
    return;
   }
   if(!pending)return;
   if(object(reply)&&positive(reply.id)&&reply.id<=settled)return;
   try{
    if(!object(reply)||reply.id!==pending.id)protocol('요청 순서');
    if(reply.kind==='error'){
     if(typeof reply.error!=='string'||!reply.error.length||reply.error.length>2000||!['unsupported','runtime','protocol'].includes(String(reply.code)))protocol('오류 응답');
     throw new DecodedRgbaError(reply.code as 'unsupported'|'runtime'|'protocol',reply.error);
    }
    if(pending.kind==='init'){
     if(reply.kind!=='ready'||reply.recipe!==DECODED_RGBA_RECIPE||!positive(reply.trackId)||!time(reply.duration)||reply.sourceBytes!==blob.size||reply.decoderPreference!==preference)protocol('준비 응답');
     size(reply.width,reply.height);trackId=reply.trackId;
    }else if(reply.kind==='end'){
     if(reply.frames!==ordinal||reply.trackId!==trackId||!ordinal)protocol('종료 수량');
    }else{
     if(reply.kind!=='frame'||!time(reply.time)||reply.time<lastTime||typeof reply.percent!=='number'||!Number.isFinite(reply.percent)||reply.percent<0||reply.percent>100)protocol('프레임 시각');
     const bytes=size(reply.width,reply.height);
     if(!(reply.pixels instanceof ArrayBuffer)||reply.pixels.byteLength!==bytes)protocol('픽셀 버퍼');
     reply.decoded=metadata(reply.decoded,reply.width as number,reply.height as number,reply.time,ordinal+1,trackId,preference);
     ordinal++;lastTime=reply.time;
    }
    const job=pending;pending=undefined;settled=job.id;clearTimeout(job.timer);job.resolve(reply);
   }catch(error){fail(error);}
  };
  worker.onerror=event=>{const error=new DecodedRgbaError('runtime',event.message||'표준 RGBA 작업자 오류');if(closing){cleanupError=error;disposeJob?.resolve();}else{fail(error);void shutdown();}};
  worker.onmessageerror=()=>{const error=new DecodedRgbaError('protocol','표준 RGBA 작업자 메시지를 읽지 못했습니다.');if(closing){cleanupError=error;disposeJob?.resolve();}else{fail(error);void shutdown();}};
  signal.throwIfAborted();await request('init',{blob,decoderPreference:preference},initTimeout);signal.throwIfAborted();if(hasTerminalError)throw terminalError;
  canvas=options.canvasFactory?options.canvasFactory():typeof document!=='undefined'?document.createElement('canvas'):
   typeof OffscreenCanvas!=='undefined'?new OffscreenCanvas(1,1):undefined;
  if(!canvas)throw new DecodedRgbaError('unsupported','표준 RGBA 픽셀을 그릴 수 없습니다.');
  const context=canvas.getContext('2d',{willReadFrequently:true,colorSpace:'srgb'}) as CanvasRenderingContext2D|OffscreenCanvasRenderingContext2D|null;
  if(!context)throw new DecodedRgbaError('unsupported','표준 RGBA 픽셀 컨텍스트를 지원하지 않습니다.');
  const imageData=options.imageDataFactory??((pixels,width,height)=>new ImageData(pixels,width,height,{colorSpace:'srgb'}));
  while(true){
   let reply:Record<string,unknown>|undefined=await request('next',{},nextTimeout);signal.throwIfAborted();if(hasTerminalError)throw terminalError;
   if(reply.kind==='end')break;
   const width=reply.width as number,height=reply.height as number;
   if(canvas.width!==width||canvas.height!==height){canvas.width=width;canvas.height=height;}
   context.putImageData(imageData(new Uint8ClampedArray(reply.pixels as ArrayBuffer),width,height),0,0);
   const output:DecodedRgbaInput={element:canvas,time:reply.time as number,percent:reply.percent as number,decoded:reply.decoded as unknown as DecodedRgbaMetadata};
   reply=undefined;signal.throwIfAborted();yield output;
  }
 }catch(error){failed=true;failure=error;}finally{
  await shutdown();if(canvas){canvas.width=canvas.height=0;}
 }
 if(signal.aborted&&!failed){failed=true;failure=signal.reason;}
 if(failed)throw failure;
 if(cleanupError)throw cleanupError;
}
