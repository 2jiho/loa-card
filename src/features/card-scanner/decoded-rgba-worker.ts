import {ALL_FORMATS,BlobSource,Input,VideoSampleSink} from 'mediabunny';
import type {InputVideoTrack} from 'mediabunny';
import {MAX_FRAME_BYTES,pixelHash} from './exact-recording-codec';
import type {DecodedRgbaColorSpace,DecodedRgbaMetadata,DecodedRgbaPreference} from './decoded-rgba-client';

const RECIPE='webcodecs-rgba-srgb-v1',MAX_SOURCE_BYTES=256*1024*1024;
const object=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value);
const positive=(value:unknown):value is number=>typeof value==='number'&&Number.isSafeInteger(value)&&value>0;
const time=(value:unknown):value is number=>typeof value==='number'&&Number.isFinite(value)&&value>=0;
export interface RgbaDecodeTrack {id:number;canDecode():Promise<boolean>;computeDuration():Promise<number>;getDisplayWidth():Promise<number>;getDisplayHeight():Promise<number>}
export interface RgbaDecodeInput {getPrimaryVideoTrack():Promise<RgbaDecodeTrack|null>;dispose():void}
export interface RgbaNativeFrame {
 format:string|null;codedWidth:number;codedHeight:number;displayWidth:number;displayHeight:number;
 visibleRect:{x:number;y:number;width:number;height:number}|null;timestamp:number;duration:number|null;colorSpace:{toJSON():VideoColorSpaceInit};
 allocationSize(options:VideoFrameCopyToOptions):number;copyTo(pixels:Uint8Array<ArrayBuffer>,options:VideoFrameCopyToOptions):Promise<PlaneLayout[]>;close():void;
}
export interface RgbaDecodeSample {
 timestamp:number;duration:number;rotation:number;flip:boolean;pixelAspectRatio:{num:number;den:number};colorSpace:{toJSON():VideoColorSpaceInit};
 toVideoFrame():RgbaNativeFrame;close():void;
}
export interface RgbaDecodePlatform {
 createInput(blob:Blob):RgbaDecodeInput;
 createSamples(track:RgbaDecodeTrack,preference:DecodedRgbaPreference):AsyncIterator<RgbaDecodeSample>;
 hash(pixels:Uint8Array<ArrayBuffer>):Promise<string>;
}
export interface RgbaDecodeScope {postMessage(value:unknown,transfer?:Transferable[]):void}
class Unsupported extends Error {}
function unsupported(message:string):never {throw new Unsupported(`표준 RGBA 디코드 미지원: ${message}`);}
function dimensions(width:number,height:number){
 const bytes=width*height*4;if(!positive(width)||!positive(height)||!Number.isSafeInteger(bytes)||bytes>MAX_FRAME_BYTES)unsupported('프레임 크기');return bytes;
}
const color=(value:VideoColorSpaceInit):DecodedRgbaColorSpace=>({primaries:value.primaries??null,transfer:value.transfer??null,matrix:value.matrix??null,fullRange:value.fullRange??null});
const defaultPlatform:RgbaDecodePlatform={
 createInput:blob=>new Input({formats:ALL_FORMATS,source:new BlobSource(blob)}),
 createSamples:(track,preference)=>new VideoSampleSink(track as InputVideoTrack,{hardwareAcceleration:preference}).samples(),
 hash:pixelHash,
};

/** One explicit next request owns one sample/native frame/copy buffer. Library
 * decoder prefetch remains internal and is not advertised as a bounded queue. */
export function createDecodedRgbaWorkerRuntime(scope:RgbaDecodeScope,platform:RgbaDecodePlatform=defaultPlatform){
 let state:'new'|'initializing'|'ready'|'ended'|'failed'|'disposed'='new',closing=false;
 const abort=new AbortController();
 let input:RgbaDecodeInput|undefined,iterator:AsyncIterator<RgbaDecodeSample>|undefined,trackId=0,duration=0,ordinal=0,lastTime=-Infinity;
 let preference:DecodedRgbaPreference='no-preference',running:Promise<void>|undefined,disposal:Promise<string|undefined>|undefined;
 const check=()=>{abort.signal.throwIfAborted();if(closing)throw new DOMException('표준 RGBA 작업자 종료','AbortError');};
 const report=(id:number,error:unknown,protocol=false)=>{
  if(closing||state==='failed'||state==='disposed')return;
  state='failed';abort.abort(error);try{input?.dispose();}catch{/* Disposal acknowledgement handles final cleanup. */}
  try{scope.postMessage({kind:'error',id,code:protocol?'protocol':error instanceof Unsupported?'unsupported':'runtime',error:String(error).slice(0,2000)});}catch{/* Parent always terminates this owned Worker. */}
 };
 const cleanup=()=>disposal??=(async()=>{
  closing=true;abort.abort(new DOMException('표준 RGBA 작업자 종료','AbortError'));
  const errors:string[]=[];
  try{input?.dispose();}catch(error){errors.push(String(error));}
  await running?.catch(()=>{});
  try{await iterator?.return?.();}catch(error){errors.push(String(error));}
  state='disposed';return errors.length?errors.join(' · ').slice(0,2000):undefined;
 })();
 async function initialize(message:Record<string,unknown>){
  if(!(message.blob instanceof Blob)||!message.blob.size||message.blob.size>MAX_SOURCE_BYTES||
   message.decoderPreference!=='no-preference'&&message.decoderPreference!=='prefer-software')unsupported('입력 또는 디코더 힌트');
  preference=message.decoderPreference;
  input=platform.createInput(message.blob);check();
  const track=await input.getPrimaryVideoTrack();check();
  if(!track||!positive(track.id)||!await track.canDecode())unsupported('영상 트랙 또는 WebCodecs');check();
  const [end,width,height]=await Promise.all([track.computeDuration(),track.getDisplayWidth(),track.getDisplayHeight()]);check();
  if(!time(end))unsupported('영상 시간');dimensions(width,height);
  trackId=track.id;duration=end;iterator=platform.createSamples(track,preference);state='ready';
  scope.postMessage({kind:'ready',id:message.id,recipe:RECIPE,trackId,duration,width,height,sourceBytes:message.blob.size,decoderPreference:preference});
 }
 async function next(id:number){
  check();const next=await iterator!.next();
  if(next.done){
   check();if(!ordinal)unsupported('디코드된 프레임 없음');state='ended';
   scope.postMessage({kind:'end',id,frames:ordinal,trackId});return;
  }
  const sample=next.value;let frame:RgbaNativeFrame|undefined,reply:{width:number;height:number;time:number;percent:number;decoded:DecodedRgbaMetadata;pixels:ArrayBuffer}|undefined;
  try{
   check();frame=sample.toVideoFrame();
   const visible=frame.visibleRect;
   if(!visible||!Number.isSafeInteger(visible.x)||visible.x<0||!Number.isSafeInteger(visible.y)||visible.y<0||
    sample.rotation!==0||sample.flip!==false||sample.pixelAspectRatio.num!==1||sample.pixelAspectRatio.den!==1||
    !time(sample.timestamp)||sample.timestamp<lastTime||!time(sample.duration))unsupported('시각·회전·비율·크롭');
   dimensions(frame.codedWidth,frame.codedHeight);const width=visible.width,height=visible.height,bytes=dimensions(width,height);
   if(visible.x+width>frame.codedWidth||visible.y+height>frame.codedHeight||frame.displayWidth!==width||frame.displayHeight!==height)unsupported('표시 크기와 visibleRect 불일치');
   const options:VideoFrameCopyToOptions={format:'RGBA',colorSpace:'srgb'};
   let allocation:number;
   try{allocation=frame.allocationSize(options);}catch(error){unsupported(`RGBA allocationSize: ${String(error)}`);}
   if(allocation!==bytes)unsupported('밀집 RGBA 버퍼 크기');
   const pixels=new Uint8Array(bytes);
   let layout:PlaneLayout[];
   try{layout=await frame.copyTo(pixels,options);}catch(error){unsupported(`RGBA copyTo: ${String(error)}`);}check();
   if(!Array.isArray(layout)||layout.length!==1||layout[0].offset!==0||layout[0].stride!==width*4)unsupported('밀집 RGBA 평면 배치');
   const rgbaSha256=await platform.hash(pixels);check();
   if(!/^[a-f0-9]{64}$/.test(rgbaSha256))throw Error('표준 RGBA 픽셀 해시 오류');
   const decoded:DecodedRgbaMetadata={recipe:RECIPE,ordinal:ordinal+1,pts:sample.timestamp,duration:sample.duration,trackId,decoderPreference:preference,rgbaSha256,
    geometry:{codedWidth:frame.codedWidth,codedHeight:frame.codedHeight,displayWidth:frame.displayWidth,displayHeight:frame.displayHeight,
     visibleRect:{x:visible.x,y:visible.y,width,height},rotation:0,flip:false,pixelAspectRatio:{num:1,den:1}},
    nativeFormat:frame.format,nativeColorSpace:color(frame.colorSpace.toJSON()),sampleColorSpace:color(sample.colorSpace.toJSON()),
    nativeTimestampMicroseconds:frame.timestamp,nativeDurationMicroseconds:frame.duration,
    rgbaLayout:{format:'RGBA',colorSpace:'srgb',offset:0,stride:width*4,bytes}};
   reply={width,height,time:sample.timestamp,percent:duration>0?Math.min(100,Math.max(0,(sample.timestamp+sample.duration)/duration*100)):0,decoded,pixels:pixels.buffer};
  }finally{try{frame?.close();}finally{sample.close();}}
  check();ordinal++;lastTime=reply!.time;
  scope.postMessage({kind:'frame',id,...reply},[reply!.pixels]);
 }
 return {
  async handle(value:unknown){
   if(!object(value)||!positive(value.id))return;
   const id=value.id;
   if(value.kind==='dispose'){
    const error=await cleanup();try{scope.postMessage({kind:'disposed',id,...(error?{error}:{})});}catch{/* Parent termination remains available. */}return;
   }
   if(closing||state==='failed'||state==='disposed')return;
   if(value.kind==='init'&&state==='new'&&!running)state='initializing';
   else if(value.kind!=='next'||state!=='ready'||running){report(id,Error('동시 또는 순서가 잘못된 표준 RGBA 요청'),true);return;}
   const work=value.kind==='init'?initialize(value):next(id);running=work;
   try{await work;}catch(error){report(id,error);}finally{if(running===work)running=undefined;}
  },
 };
}

if(typeof document==='undefined'&&typeof self!=='undefined'){
 const scope=self as unknown as RgbaDecodeScope&{onmessage:((event:MessageEvent)=>void)|null};
 const runtime=createDecodedRgbaWorkerRuntime(scope);scope.onmessage=event=>{void runtime.handle(event.data);};
}
